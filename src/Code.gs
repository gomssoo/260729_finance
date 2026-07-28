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
      return refreshPrices();
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

function formatDateTime(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}
