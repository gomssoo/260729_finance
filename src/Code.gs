/**
 * NPay증권(stock.naver.com) 기반 포트폴리오 시트
 *
 * 독립(standalone) 스크립트다. 컨테이너에 바인딩되어 있지 않으므로
 * SpreadsheetApp.getActiveSpreadsheet() 대신 openById() 로 타겟 시트를 연다.
 * 조작은 상단 메뉴가 아니라 배포된 웹앱 화면에서 한다.
 *
 * 최초 1회: setTargetSpreadsheet('<스프레드시트ID>') 를 편집기에서 실행하거나,
 *           웹앱 화면의 설정란에 시트 ID 를 입력한다.
 */

var SHEET_NAME = '종목';

// 타겟 스프레드시트. 스크립트 속성에 값이 있으면 그쪽이 우선이라,
// 코드를 고치지 않고도 다른 시트로 바꿔 쓸 수 있다.
var PROP_SPREADSHEET_ID = 'TARGET_SPREADSHEET_ID';
var DEFAULT_SPREADSHEET_ID = '1YU3TvG6WNG29Hx-puRqpe4vvfWeBvo0lGlqyAxgtvXE';

// reutersCode 와 nationCode 는 시세 조회 URL 을 만드는 데 쓰는 내부 값이다.
var HEADERS = [
  '종목명',
  '코드',
  'reutersCode',
  'nationCode',
  '시장',
  '국가',
  '현재가',
  '전일대비',
  '등락률(%)',
  '통화',
  '장상태',
  '기준시각',
  '갱신시각',
];

var COL = {};
HEADERS.forEach(function (h, i) {
  COL[h] = i + 1;
});

// 국내와 해외는 시세 API 호스트가 다르다. 서로 바꿔 호출하면 409/빈 응답이 온다.
//   국내(005930)   → https://m.stock.naver.com/api/stock/005930/basic
//   해외(AAPL.O)   → https://api.stock.naver.com/stock/AAPL.O/basic
var DOMESTIC_BASE = 'https://m.stock.naver.com/api';
var WORLD_BASE = 'https://api.stock.naver.com';
var SEARCH_BASE = 'https://m.stock.naver.com/front-api';

// 네이버 API 는 브라우저 외 요청을 막는 경우가 있어 Referer/UA 를 함께 보낸다.
var REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://m.stock.naver.com/',
  Accept: 'application/json',
};

/* -------------------------------------------------------------- JSON API */

/**
 * GitHub Pages 화면이 호출하는 JSON API.
 *
 *   ?action=list
 *   ?action=search&query=삼성전자
 *   ?action=add&items=<JSON 배열>
 *   ?action=delete&codes=<JSON 배열>
 *   ?action=refresh
 *
 * Apps Script 는 응답 헤더를 설정할 수 없어 CORS 를 열 수 없다.
 * 그래서 callback 파라미터가 오면 JSONP(script 태그 로드)로 응답한다.
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var payload;

  try {
    payload = { ok: true, data: dispatch(params) };
  } catch (err) {
    payload = { ok: false, error: String((err && err.message) || err) };
  }

  return respond(payload, params.callback);
}

// 브라우저가 프리플라이트 없이 보낼 수 있는 요청만 쓰므로 doPost 도 같은 처리를 한다.
function doPost(e) {
  return doGet(e);
}

function dispatch(params) {
  switch (params.action) {
    case 'search':
      return searchStocks(params.query);
    case 'add':
      return addStocks(JSON.parse(params.items || '[]'));
    case 'delete':
      return deleteStocks(JSON.parse(params.codes || '[]'));
    case 'refresh':
      return manualRefresh();
    case 'move':
      return moveStock(params.code, Number(params.offset));
    case 'state':
      return getState();
    case 'trigger':
      if (params.on === '0') return removeTrigger();
      if (params.on === '1') return installTrigger(params.minutes);
      return triggerStatus();
    case 'stats':
      return getRunStats();
    case 'reorder':
      return reorderStocks(JSON.parse(params.codes || '[]'));
    case 'list':
    case undefined:
    case '':
      return listStocks();
    default:
      throw new Error('알 수 없는 action: ' + params.action);
  }
}

function respond(payload, callback) {
  var json = JSON.stringify(payload);

  if (callback) {
    // 콜백 이름은 그대로 코드가 되므로 식별자 형태만 허용한다.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(callback)) {
      throw new Error('잘못된 callback 이름');
    }
    return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(
      ContentService.MimeType.JAVASCRIPT
    );
  }

  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/** 타겟 스프레드시트를 바꾸고 싶을 때 편집기에서 직접 실행한다. */
function setTargetSpreadsheet(id) {
  SpreadsheetApp.openById(id); // 접근 가능한 ID 인지 먼저 확인
  PropertiesService.getScriptProperties().setProperty(PROP_SPREADSHEET_ID, id);
  return id;
}

function getSpreadsheetId() {
  return (
    PropertiesService.getScriptProperties().getProperty(PROP_SPREADSHEET_ID) ||
    DEFAULT_SPREADSHEET_ID
  );
}

/* ------------------------------------------------------------------ 시트 */

function setupSheet() {
  var ss = SpreadsheetApp.openById(getSpreadsheetId());
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

  sheet.clear();

  var header = sheet.getRange(1, 1, 1, HEADERS.length);
  header.setValues([HEADERS]);
  header.setFontWeight('bold').setBackground('#f1f3f4').setVerticalAlignment('middle');
  sheet.setFrozenRows(1);

  // 내부 조회용 열이라 평소에는 감춰둔다.
  sheet.hideColumns(COL['reutersCode'], 2);

  // '005930' 이 숫자 5930 으로 해석되면 앞자리 0 이 날아가 조회가 깨진다.
  // 코드 계열 열은 텍스트 서식으로 고정한다.
  var rows = sheet.getMaxRows() - 1;
  sheet.getRange(2, COL['코드'], rows, 1).setNumberFormat('@');
  sheet.getRange(2, COL['reutersCode'], rows, 2).setNumberFormat('@');

  sheet.getRange(2, COL['현재가'], sheet.getMaxRows() - 1, 2).setNumberFormat('#,##0.####');
  sheet.getRange(2, COL['등락률(%)'], sheet.getMaxRows() - 1, 1).setNumberFormat('0.00');

  HEADERS.forEach(function (_, i) {
    sheet.autoResizeColumn(i + 1);
  });

  return sheet;
}

function getSheet() {
  var sheet = SpreadsheetApp.openById(getSpreadsheetId()).getSheetByName(SHEET_NAME);
  // 헤더가 아직 없는 새 시트라면 초기화부터 한다.
  if (!sheet || sheet.getLastRow() === 0) return setupSheet();
  return sheet;
}

/* ------------------------------------------------------------------ 검색 */

/** 다이얼로그에서 호출: 검색어로 국내/해외 종목을 찾는다. */
function searchStocks(query) {
  query = (query || '').trim();
  if (!query) return [];

  var url =
    SEARCH_BASE + '/search/autoComplete?query=' + encodeURIComponent(query) + '&target=stock';
  var json = fetchJson(url);

  var items = (json && json.result && json.result.items) || [];
  return items.map(function (it) {
    return {
      name: it.name,
      code: it.code,
      reutersCode: it.reutersCode,
      nationCode: it.nationCode,
      market: it.typeName,
      nation: it.nationName,
    };
  });
}

/* ------------------------------------------------------------------ 추가 */

/**
 * 다이얼로그에서 호출: 선택한 종목을 시트에 추가한다.
 * 이미 있는 종목은 건너뛰고, 추가된 종목만 시세를 채운다.
 */
function addStocks(stocks) {
  if (!stocks || !stocks.length) return { added: 0, skipped: 0 };

  var sheet = getSheet();
  var existing = getExistingReutersCodes(sheet);

  var rows = [];
  var skipped = 0;

  stocks.forEach(function (s) {
    if (existing[s.reutersCode]) {
      skipped++;
      return;
    }
    existing[s.reutersCode] = true;

    var row = new Array(HEADERS.length).fill('');
    row[COL['종목명'] - 1] = s.name;
    row[COL['코드'] - 1] = s.code;
    row[COL['reutersCode'] - 1] = s.reutersCode;
    row[COL['nationCode'] - 1] = s.nationCode;
    row[COL['시장'] - 1] = s.market;
    row[COL['국가'] - 1] = s.nation;
    rows.push(row);
  });

  if (rows.length) {
    var start = sheet.getLastRow() + 1;

    // setValues 전에 텍스트 서식을 걸어야 '005930' 이 숫자로 해석되지 않는다.
    sheet.getRange(start, COL['코드'], rows.length, 1).setNumberFormat('@');
    sheet.getRange(start, COL['reutersCode'], rows.length, 2).setNumberFormat('@');

    sheet.getRange(start, 1, rows.length, HEADERS.length).setValues(rows);
    refreshPrices();
  }

  return { added: rows.length, skipped: skipped };
}

function getExistingReutersCodes(sheet) {
  var last = sheet.getLastRow();
  var map = {};
  if (last < 2) return map;

  sheet
    .getRange(2, COL['reutersCode'], last - 1, 2)
    .getValues()
    .forEach(function (r) {
      var code = normalizeCode(r[0], r[1]);
      if (code) map[code] = true;
    });
  return map;
}

/* ------------------------------------------------------------------ 시세 */

function refreshPrices() {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) return { updated: 0, failed: 0 };

  var rows = sheet.getRange(2, COL['reutersCode'], last - 1, 2).getValues();
  var codes = rows.map(function (r) {
    return normalizeCode(r[0], r[1]);
  });

  // 종목별 URL 을 한 번에 묶어 병렬 호출한다. 행 수가 많아도 실행 시간이 크게 늘지 않는다.
  var requests = codes.map(function (code, i) {
    return {
      url: priceUrl(code, String(rows[i][1] || '')),
      headers: REQUEST_HEADERS,
      muteHttpExceptions: true,
    };
  });

  var responses = UrlFetchApp.fetchAll(requests);
  var now = new Date();
  var failed = 0;

  // 현재가~기준시각 6개 열을 한 번에 덮어쓴다.
  var width = COL['기준시각'] - COL['현재가'] + 1;
  var values = responses.map(function (res, i) {
    if (!codes[i]) return new Array(width).fill('');

    var data = null;
    if (res.getResponseCode() === 200) {
      try {
        data = JSON.parse(res.getContentText());
      } catch (e) {
        data = null;
      }
    }

    if (!data || !data.closePrice) {
      failed++;
      return new Array(width).fill('');
    }

    var exchange = data.stockExchangeType || {};
    var signed = signedChange(data);

    return [
      toNumber(data.closePrice),
      signed,
      toNumber(data.fluctuationsRatio),
      currencyOf(exchange),
      marketStatusLabel(data.marketStatus),
      data.localTradedAt ? formatLocalTradedAt(data.localTradedAt) : '',
    ];
  });

  // setupSheet 는 최초 1회만 돌아서, 나중에 늘어난 행에는 서식이 없다.
  // 서식이 없으면 14.94 가 15 로 반올림돼 보이므로 쓰기 직전에 매번 지정한다.
  sheet.getRange(2, COL['현재가'], values.length, 2).setNumberFormat('#,##0.####');
  sheet.getRange(2, COL['등락률(%)'], values.length, 1).setNumberFormat('0.00');

  sheet.getRange(2, COL['현재가'], values.length, width).setValues(values);
  sheet
    .getRange(2, COL['갱신시각'], values.length, 1)
    .setValue(formatDateTime(now));

  applyChangeColors(sheet, last);

  return { updated: codes.length - failed, failed: failed };
}

/**
 * 시트에서 읽은 종목코드를 원래 문자열로 되돌린다.
 * 셀 서식이 텍스트가 아니면 '005930' 이 숫자 5930 으로 읽히므로,
 * 국내 종목(6자리)은 앞을 0 으로 채워 복원한다.
 */
function normalizeCode(value, nationCode) {
  var code = String(value === null || value === undefined ? '' : value).trim();
  if (!code) return '';

  // 6자리 미만 순수 숫자는 앞자리 0 이 날아간 국내 코드로 본다.
  // ('TM' 같은 해외 티커는 숫자가 아니라 여기 걸리지 않는다.)
  if (/^\d{1,5}$/.test(code) && (!nationCode || String(nationCode) === 'KOR')) {
    while (code.length < 6) code = '0' + code;
  }
  return code;
}

/**
 * 국가에 맞는 시세 API URL 을 만든다.
 * nationCode 가 비어 있는 행(수동 입력 등)은 reutersCode 모양으로 판별한다.
 * 국내 코드는 '005930' 처럼 점이 없는 6자리, 해외는 'AAPL.O' 처럼 접미사가 붙는다.
 */
function priceUrl(reutersCode, nationCode) {
  var base = isDomestic(reutersCode, nationCode) ? DOMESTIC_BASE : WORLD_BASE;
  return base + '/stock/' + encodeURIComponent(reutersCode) + '/basic';
}

/**
 * nationCode 가 있으면 그것이 정답이다.
 * 없을 때만 코드 모양으로 추정하는데, 국내 종목코드는 6자리 숫자
 * (또는 '0193W0' 처럼 숫자로 시작하는 6자리)라는 점을 이용한다.
 * 'TM' 같은 해외 티커를 국내로 오인하지 않도록 자릿수까지 본다.
 */
function isDomestic(reutersCode, nationCode) {
  if (nationCode) return String(nationCode) === 'KOR';
  return /^\d[0-9A-Z]{5}$/.test(String(reutersCode));
}

/**
 * 전일대비는 API 가 부호 없는 절대값으로 주는 경우가 있어
 * compareToPreviousPrice.code 로 방향을 판단해 부호를 붙인다.
 * (code: 1·2 = 상승, 4·5 = 하락, 3 = 보합)
 */
function signedChange(data) {
  // toNumber 를 먼저 통과시켜야 값 누락과 실제 보합(0)이 구분된다.
  var raw = toNumber(data.compareToPreviousClosePrice);
  if (raw === '') return '';

  var value = Math.abs(raw);
  var code = String((data.compareToPreviousPrice || {}).code || '');
  if (code === '4' || code === '5') return -value;
  return value;
}

function currencyOf(exchange) {
  var byNation = { KOR: 'KRW', USA: 'USD', JPN: 'JPY', HKG: 'HKD', CHN: 'CNY', VNM: 'VND' };
  return byNation[exchange.nationCode] || exchange.nationCode || '';
}

function marketStatusLabel(status) {
  var labels = {
    OPEN: '장중',
    CLOSE: '장마감',
    PRE: '장전',
    AFTER: '장후',
    EXPIRED: '거래정지',
  };
  return labels[status] || status || '';
}

/** '2026-07-28T12:05:23-04:00' → 현지 시각 문자열 (오프셋은 그대로 보존) */
function formatLocalTradedAt(iso) {
  var m = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] + ' ' + m[2] : String(iso);
}

function applyChangeColors(sheet, lastRow) {
  if (lastRow < 2) return;

  var range = sheet.getRange(2, COL['전일대비'], lastRow - 1, 2);
  var values = range.getValues();

  var colors = values.map(function (r) {
    var v = r[0];
    var color = typeof v === 'number' && v !== 0 ? (v > 0 ? '#d60000' : '#0051c7') : '#333333';
    return [color, color];
  });

  range.setFontColors(colors);
}

/* ------------------------------------------------------------------ 삭제 */

/** 웹앱에서 호출: reutersCode 로 해당 종목 행을 삭제한다. */
function deleteStocks(reutersCodes) {
  if (!reutersCodes || !reutersCodes.length) return { deleted: 0 };

  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) return { deleted: 0 };

  var target = {};
  reutersCodes.forEach(function (c) {
    target[String(c)] = true;
  });

  var codes = sheet.getRange(2, COL['reutersCode'], last - 1, 2).getValues();

  // 아래쪽부터 지워야 위 행을 지운 뒤 행 번호가 밀리지 않는다.
  var deleted = 0;
  for (var i = codes.length - 1; i >= 0; i--) {
    if (target[normalizeCode(codes[i][0], codes[i][1])]) {
      sheet.deleteRow(i + 2);
      deleted++;
    }
  }

  return { deleted: deleted };
}

/* ---------------------------------------------------------------- 트리거 */

// 트리거가 부를 함수. 이름을 바꾸면 기존 트리거가 끊기니 주의.
var TRIGGER_HANDLER = 'scheduledRefresh';

/**
 * 1분마다 자동 실행되는 갱신.
 *
 * 장이 닫혀 있으면 값이 변하지 않으므로 건너뛴다. 트리거는 하루 1,440번
 * 돌아 실행 시간 할당량(무료 90분/일)을 갉아먹는데, 장중에만 돌리면
 * 대부분의 호출을 아낄 수 있다.
 */
function scheduledRefresh() {
  var started = Date.now();
  if (!isAnyMarketOpen()) {
    recordRun(Date.now() - started, true);
    return;
  }
  refreshPrices();
  recordRun(Date.now() - started, false);
}

// 실행 시간 통계. 할당량(무료 90분/일)에 얼마나 근접하는지 보려고 남긴다.
var PROP_RUN_STATS = 'RUN_STATS';

/**
 * 화면의 '시세 새로고침' 버튼용.
 *
 * 트리거와 같은 refreshPrices() 를 부르지만 할당량 항목이 다르다.
 * 트리거 실행은 '트리거 총 실행시간', 웹앱 호출은 '스크립트 실행시간' 에
 * 잡히므로 서로를 잠식하지 않는다. 다만 둘 다 한도가 90분/일이다.
 */
function manualRefresh() {
  var started = Date.now();
  var result = refreshPrices();
  recordRun(Date.now() - started, false, true);
  return result;
}

function recordRun(ms, skipped, manual) {
  try {
    var props = PropertiesService.getScriptProperties();
    var s = JSON.parse(props.getProperty(PROP_RUN_STATS) || '{}');

    if (manual) {
      s.manualRuns = (s.manualRuns || 0) + 1;
      s.manualMs = (s.manualMs || 0) + ms;
    } else {
      s.runs = (s.runs || 0) + 1;
      s.skipped = (s.skipped || 0) + (skipped ? 1 : 0);
      s.totalMs = (s.totalMs || 0) + ms;
    }
    s.maxMs = Math.max(s.maxMs || 0, ms);
    if (!s.since) s.since = formatDateTime(new Date());

    props.setProperty(PROP_RUN_STATS, JSON.stringify(s));
  } catch (e) {
    // 통계는 부가 기능이라 실패해도 갱신 자체를 막지 않는다.
  }
}

function getRunStats() {
  var s = JSON.parse(
    PropertiesService.getScriptProperties().getProperty(PROP_RUN_STATS) || '{}'
  );
  var actual = (s.runs || 0) - (s.skipped || 0);

  var manualRuns = s.manualRuns || 0;

  return {
    since: s.since || '',

    // 트리거 (자동 갱신)
    runs: s.runs || 0,
    skipped: s.skipped || 0,
    actualRefreshes: actual,
    avgActiveMs: actual ? Math.round(s.totalMs / actual) : 0,
    triggerMinutes: Math.round(((s.totalMs || 0) / 60000) * 10) / 10,

    // 수동 (새로고침 버튼)
    manualRuns: manualRuns,
    manualAvgMs: manualRuns ? Math.round(s.manualMs / manualRuns) : 0,
    manualMinutes: Math.round(((s.manualMs || 0) / 60000) * 10) / 10,

    maxMs: s.maxMs || 0,
  };
}

function resetRunStats() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_RUN_STATS);
  return { reset: true };
}

/**
 * 시트에 담긴 종목 중 하나라도 거래 시간대인지 본다.
 * 마지막 조회에서 받은 '장상태' 를 그대로 쓰므로 별도 API 호출이 없다.
 * 판단이 애매하면 (데이터가 없으면) 갱신하는 쪽을 택한다.
 */
function isAnyMarketOpen() {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) return false;

  var statuses = sheet.getRange(2, COL['장상태'], last - 1, 1).getValues();
  var known = 0;
  for (var i = 0; i < statuses.length; i++) {
    var s = String(statuses[i][0] || '').trim();
    if (!s) continue;
    known++;
    if (s === '장중' || s === '장전' || s === '장후') return true;
  }

  // 장상태를 한 번도 받아본 적이 없으면 일단 갱신해서 채운다.
  return known === 0;
}

// Apps Script 는 분 단위 트리거로 1·5·10·15·30 만 받는다. 2분은 없다.
var TRIGGER_MINUTES = [1, 5, 10, 15, 30];
var PROP_INTERVAL = 'REFRESH_INTERVAL_MIN';

/** 시간 기반 트리거를 건다. 이미 있으면 지우고 다시 만든다. */
function installTrigger(minutes) {
  var interval = Number(minutes) || Number(getInterval());
  if (TRIGGER_MINUTES.indexOf(interval) === -1) {
    throw new Error('주기는 ' + TRIGGER_MINUTES.join('/') + '분만 됩니다 (요청: ' + interval + ')');
  }

  removeTrigger();
  ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyMinutes(interval).create();
  PropertiesService.getScriptProperties().setProperty(PROP_INTERVAL, String(interval));

  return { installed: true, minutes: interval };
}

function getInterval() {
  return Number(
    PropertiesService.getScriptProperties().getProperty(PROP_INTERVAL) || 5
  );
}

function removeTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return { removed: removed };
}

function triggerStatus() {
  var count = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === TRIGGER_HANDLER;
  }).length;
  return { installed: count > 0, count: count, minutes: getInterval() };
}

/* ------------------------------------------------------------------ 정렬 */

/**
 * 한 종목을 offset 만큼 위(-1)/아래(+1)로 옮긴다.
 * 목록 밖으로 나가는 이동은 무시한다.
 */
function moveStock(reutersCode, offset) {
  if (!reutersCode || !offset) return { moved: false };

  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 3) return { moved: false }; // 종목이 1개뿐이면 옮길 자리가 없다

  var codes = sheet.getRange(2, COL['reutersCode'], last - 1, 2).getValues();
  var from = -1;
  for (var i = 0; i < codes.length; i++) {
    if (normalizeCode(codes[i][0], codes[i][1]) === String(reutersCode)) {
      from = i;
      break;
    }
  }
  if (from === -1) return { moved: false };

  var to = from + offset;
  if (to < 0 || to >= codes.length) return { moved: false };

  swapRows(sheet, from + 2, to + 2);
  return { moved: true };
}

function swapRows(sheet, rowA, rowB) {
  var width = HEADERS.length;
  var a = sheet.getRange(rowA, 1, 1, width);
  var b = sheet.getRange(rowB, 1, 1, width);

  var aValues = a.getValues();
  var bValues = b.getValues();
  // 서식(코드 열의 텍스트 지정 등)은 행에 그대로 두고 값만 맞바꾼다.
  a.setValues(bValues);
  b.setValues(aValues);
}

/**
 * 국가끼리 붙여 정렬한다. 국가가 처음 등장한 위치를 그 국가의 순서로 삼아,
 * 사용자가 만든 큰 순서(어느 나라를 위에 둘지)는 유지한다.
 */
function groupByNation(rows) {
  var order = [];
  var buckets = {};

  rows.forEach(function (r) {
    var key = String(r[COL['nationCode'] - 1] || '');
    if (!buckets[key]) {
      buckets[key] = [];
      order.push(key);
    }
    buckets[key].push(r);
  });

  var out = [];
  order.forEach(function (key) {
    out = out.concat(buckets[key]);
  });
  return out;
}

/** 화면에서 드래그로 만든 순서를 그대로 시트에 반영한다. */
function reorderStocks(orderedCodes) {
  if (!orderedCodes || !orderedCodes.length) return { reordered: 0 };

  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) return { reordered: 0 };

  var rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();

  var byCode = {};
  rows.forEach(function (r) {
    var code = normalizeCode(r[COL['reutersCode'] - 1], r[COL['nationCode'] - 1]);
    if (code) byCode[code] = r;
  });

  // 요청에 담긴 순서를 먼저 깔고, 빠진 종목은 원래 순서대로 뒤에 붙인다.
  var used = {};
  var ordered = [];
  orderedCodes.forEach(function (c) {
    var row = byCode[String(c)];
    if (row && !used[String(c)]) {
      used[String(c)] = true;
      ordered.push(row);
    }
  });
  rows.forEach(function (r) {
    var code = normalizeCode(r[COL['reutersCode'] - 1], r[COL['nationCode'] - 1]);
    if (code && !used[code]) ordered.push(r);
  });

  if (ordered.length !== rows.length) return { reordered: 0 };

  // 화면이 국가별로 묶어 보여주므로 시트도 같은 순서로 맞춘다.
  // 그렇지 않으면 한 국가가 흩어져 저장되고, 다음 드래그 때
  // 화면 순서와 시트 순서가 어긋나 엉뚱한 결과가 나온다.
  ordered = groupByNation(ordered);

  sheet.getRange(2, 1, ordered.length, HEADERS.length).setValues(ordered);
  return { reordered: ordered.length };
}

/* ------------------------------------------------------------------ 공통 */

function fetchJson(url) {
  var res = UrlFetchApp.fetch(url, {
    headers: REQUEST_HEADERS,
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('네이버 API 호출 실패 (' + res.getResponseCode() + ')');
  }
  return JSON.parse(res.getContentText());
}

/** '220,000' 같은 문자열을 숫자로. 변환할 수 없으면 빈 문자열. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  var n = Number(String(value).replace(/,/g, ''));
  return isNaN(n) ? '' : n;
}

/** 웹앱에서 호출: 시트에 저장된 종목 목록을 그대로 읽어온다. */
function listStocks() {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) return [];

  return sheet
    .getRange(2, 1, last - 1, HEADERS.length)
    .getValues()
    .map(function (r) {
      var o = {};
      HEADERS.forEach(function (h, i) {
        o[h] = r[i] instanceof Date ? formatDateTime(r[i]) : r[i];
      });

      // 앞자리 0 이 날아간 코드를 화면에 그대로 보여주지 않는다.
      o['reutersCode'] = normalizeCode(o['reutersCode'], o['nationCode']);
      o['코드'] = normalizeCode(o['코드'], o['nationCode']);
      return o;
    });
}

/**
 * 목록 + 부가 정보를 한 번에 준다.
 * GAS 는 호출 1회당 2초 넘게 걸려서, 왕복을 나누지 않는 편이 훨씬 빠르다.
 */
function getState() {
  var stocks = listStocks();
  var updatedAt = '';
  for (var i = 0; i < stocks.length; i++) {
    var t = stocks[i]['갱신시각'];
    if (t && String(t) > String(updatedAt)) updatedAt = String(t);
  }

  // 트리거 조회는 별도 권한이 필요하다. 아직 승인 전이어도
  // 목록 자체는 보여줘야 하므로 실패를 삼킨다.
  var autoRefresh = null;
  var interval = 5;
  try {
    var st = triggerStatus();
    autoRefresh = st.installed;
    interval = st.minutes;
  } catch (e) {
    autoRefresh = null;
  }

  return {
    stocks: stocks,
    updatedAt: updatedAt,
    autoRefresh: autoRefresh,
    intervalMinutes: interval,
    marketOpen: stocks.some(function (s) {
      return String(s['장상태']) === '장중';
    }),
  };
}

function formatDateTime(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}
