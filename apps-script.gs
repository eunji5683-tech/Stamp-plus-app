/* ==========================================================================
   풀문지카페 단골 적립 - 구글 시트용 프로그램 (Apps Script)

   ▶ 이 파일은 인터넷에 올리는 파일이 아니에요!
     구글 시트의 'Apps Script' 창에 복사해서 붙여 넣는 용도예요.
     (붙여 넣는 방법은 채팅에서 한 단계씩 안내해 드려요)

   ▶ 하는 일
     - 손님 화면: "이 번호 스탬프 몇 개야?" → 개수만 알려줘요 (전체 목록은 절대 안 줘요)
     - 관리자 화면: 비밀번호를 확인한 뒤 적립 / 취소 / 사용 완료를 시트에 기록해요

   ▶ 관리자 비밀번호는 이 코드에 적지 않아요!
     Apps Script 왼쪽 '프로젝트 설정(톱니바퀴)' → '스크립트 속성' 에서
     속성 이름  ADMIN_PIN  /  값  내가 정한 숫자 4자리  로 넣어요.
   ========================================================================== */

// ───────────── 고치는 곳 ─────────────
// 스탬프 목표 개수 (손님 화면 index.html, 관리자 화면 admin.html 의 STAMP_GOAL 과 똑같이!)
const STAMP_GOAL = 10;

// 시간대 (대한민국). 바꾸지 않아도 돼요.
const TZ = "Asia/Seoul";

// 시트(아래 칸) 이름. 바꾸지 않아도 돼요.
const SHEET_STAMPS = "스탬프";
const SHEET_DAILY = "일별";

// 비밀번호를 이 횟수만큼 틀리면 잠깐 막아요 / 막는 시간(초)
const MAX_PIN_FAILS = 5;
const LOCK_SECONDS = 60;

// 손님 화면 조회가 1분에 이 횟수를 넘으면 잠깐 막아요 (번호를 마구 찍어보는 것을 막는 장치)
const MAX_LOOKUPS_PER_MINUTE = 60;
// ─────────────────────────────────────

/* 처음 한 번 직접 실행하는 함수예요.
   시트를 준비하고, 구글이 '이 프로그램이 시트를 써도 되나요?' 하고 묻는 승인을 받게 해요. */
function setup() {
  getStampSheet();
  getDailySheet();
}

/* ---------- 손님 화면이 부르는 곳: 개수만 알려줘요 ---------- */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action !== "get") return json({ ok: false, error: "bad_request" });

  const num = cleanNum(p.num);
  if (!num) return json({ ok: false, error: "bad_number" });
  if (tooManyLookups()) return json({ ok: false, error: "busy" });

  const row = findStamp(num);
  return json({ ok: true, count: row ? row.count : 0, isNew: !row });
}

/* ---------- 관리자 화면이 부르는 곳: 비밀번호가 맞아야 해요 ---------- */
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: "bad_request" });
  }

  const pinResult = checkPin(String(body.pin || ""));
  if (pinResult !== "ok") return json({ ok: false, error: pinResult });

  const action = body.action;
  if (action === "login") return json({ ok: true });

  const num = cleanNum(body.num);
  if (!num) return json({ ok: false, error: "bad_number" });

  // 두 명이 동시에 눌러도 숫자가 꼬이지 않게 한 명씩 차례로 처리해요
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (err) {
    return json({ ok: false, error: "busy" });
  }

  try {
    const row = findStamp(num);
    const count = row ? row.count : 0;

    if (action === "status") {
      return json({ ok: true, count: count, today: getToday() });
    }

    if (action === "add") {
      if (count >= STAMP_GOAL) return json({ ok: false, error: "full", count: count, today: getToday() });
      writeStamp(num, count + 1, row);
      return json({ ok: true, count: count + 1, today: addToday(+1) });
    }

    if (action === "cancel") {
      if (count <= 0) return json({ ok: false, error: "empty", count: count, today: getToday() });
      writeStamp(num, count - 1, row);
      return json({ ok: true, count: count - 1, today: addToday(-1) });
    }

    if (action === "done") {
      if (count < STAMP_GOAL) return json({ ok: false, error: "not_full", count: count, today: getToday() });
      writeStamp(num, 0, row);
      return json({ ok: true, count: 0, today: getToday() });
    }

    return json({ ok: false, error: "bad_request" });
  } finally {
    lock.releaseLock();
  }
}

/* ===================== 아래는 도우미 함수들이에요 (건드리지 마세요) ===================== */

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 번호 뒤 4자리 확인 (숫자 4개가 아니면 null)
function cleanNum(v) {
  const s = String(v == null ? "" : v).trim();
  return /^\d{4}$/.test(s) ? s : null;
}

// 비밀번호 확인: "ok" 이면 통과, 아니면 이유를 돌려줘요
function checkPin(pin) {
  const real = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!real) return "no_pin_set";

  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("pinfails") || 0);
  if (fails >= MAX_PIN_FAILS) return "locked";

  if (pin === String(real)) {
    cache.remove("pinfails");
    return "ok";
  }
  cache.put("pinfails", String(fails + 1), LOCK_SECONDS);
  return "bad_pin";
}

// 손님 조회가 너무 많으면 true
function tooManyLookups() {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get("lookups") || 0);
  if (n >= MAX_LOOKUPS_PER_MINUTE) return true;
  cache.put("lookups", String(n + 1), 60);
  return false;
}

function clampCount(n) {
  n = Math.floor(Number(n));
  return n > 0 ? Math.min(n, STAMP_GOAL) : 0;
}

/* ----- 시트 준비 ----- */
function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange("A:A").setNumberFormat("@");   // 0042 같은 번호가 42로 바뀌지 않게 '글자'로 저장
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}
function getStampSheet() { return getOrCreateSheet(SHEET_STAMPS, ["번호(뒤 4자리)", "스탬프 개수", "마지막 변경"]); }
function getDailySheet() { return getOrCreateSheet(SHEET_DAILY, ["날짜", "오늘 적립 횟수"]); }

/* ----- 손님 스탬프 찾기 / 쓰기 ----- */
function findStamp(num) {
  const sheet = getStampSheet();
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const values = sheet.getRange(2, 1, last - 1, 2).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).padStart(4, "0") === num) {
      return { row: i + 2, count: clampCount(values[i][1]) };
    }
  }
  return null;
}

function writeStamp(num, count, row) {
  const sheet = getStampSheet();
  const now = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
  if (row) {
    sheet.getRange(row.row, 2, 1, 2).setValues([[count, now]]);
  } else {
    const r = sheet.getLastRow() + 1;
    sheet.getRange(r, 1).setNumberFormat("@").setValue(num);
    sheet.getRange(r, 2, 1, 2).setValues([[count, now]]);
  }
}

/* ----- 오늘 적립 횟수 (날짜별) ----- */
function dateText(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, "yyyy-MM-dd") : String(v);
}
function todayText() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
}
function getToday() {
  const sheet = getDailySheet();
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const values = sheet.getRange(2, 1, last - 1, 2).getValues();
  const t = todayText();
  for (let i = 0; i < values.length; i++) {
    if (dateText(values[i][0]) === t) return Math.max(0, Math.floor(Number(values[i][1]) || 0));
  }
  return 0;
}
function addToday(delta) {
  const sheet = getDailySheet();
  const last = sheet.getLastRow();
  const t = todayText();
  if (last >= 2) {
    const values = sheet.getRange(2, 1, last - 1, 2).getValues();
    for (let i = 0; i < values.length; i++) {
      if (dateText(values[i][0]) === t) {
        const n = Math.max(0, (Math.floor(Number(values[i][1])) || 0) + delta);
        sheet.getRange(i + 2, 2).setValue(n);
        return n;
      }
    }
  }
  const n = Math.max(0, delta);
  const r = last + 1;
  sheet.getRange(r, 1).setNumberFormat("@").setValue(t);
  sheet.getRange(r, 2).setValue(n);
  return n;
}
