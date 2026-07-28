/**
 * GitHub Pages 화면 로직.
 *
 * 네이버 API 는 CORS 를 열어주지 않고(Origin 이 붙으면 403), Apps Script 도
 * 응답 헤더를 설정할 수 없어 CORS 를 쓸 수 없다. 그래서 script 태그로 불러오는
 * JSONP 로 Apps Script 웹앱과 통신한다.
 */

var found = [];
var seq = 0;

/* ------------------------------------------------------------------ 통신 */

function callApi(params) {
  return new Promise(function (resolve, reject) {
    if (!window.API_URL || window.API_URL.indexOf('PLACEHOLDER') !== -1) {
      reject(new Error('config.js 의 API_URL 이 설정되지 않았습니다'));
      return;
    }

    var name = '__cb' + ++seq;
    var script = document.createElement('script');
    var timer;

    function cleanup() {
      clearTimeout(timer);
      delete window[name];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[name] = function (res) {
      cleanup();
      // 서버가 담아 보낸 에러를 그대로 드러낸다.
      if (res && res.ok) resolve(res.data);
      else reject(new Error((res && res.error) || '알 수 없는 오류'));
    };

    var query = Object.keys(params)
      .map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      })
      .join('&');

    script.src = window.API_URL + '?' + query + '&callback=' + name;

    // JSONP 는 script 로드 실패를 상세히 알 수 없어 타임아웃으로 처리한다.
    script.onerror = function () {
      cleanup();
      reject(new Error('요청 실패 — 배포 URL 과 접근 권한을 확인하세요'));
    };
    timer = setTimeout(function () {
      cleanup();
      reject(new Error('응답 시간 초과'));
    }, 60000);

    document.body.appendChild(script);
  });
}

/* -------------------------------------------------------------- 화면 유틸 */

var $ = function (id) {
  return document.getElementById(id);
};

function msg(text, isError) {
  var el = $('msg');
  el.textContent = text || '';
  el.className = isError ? 'error' : '';
}

function fail(err) {
  msg(err && err.message ? err.message : String(err), true);
  setBusy(false);
}

function setBusy(busy) {
  $('searchBtn').disabled = busy;
  $('refreshBtn').disabled = busy;
}

function num(v) {
  if (v === '' || v === null || v === undefined) return '-';
  return typeof v === 'number' ? v.toLocaleString('ko-KR', { maximumFractionDigits: 4 }) : String(v);
}

/* ------------------------------------------------------------------ 검색 */

function search() {
  var q = $('query').value.trim();
  if (!q) return;

  setBusy(true);
  msg('검색 중…');
  $('results').innerHTML = '';

  callApi({ action: 'search', query: q })
    .then(function (items) {
      setBusy(false);
      msg('');
      renderResults(items || []);
    })
    .catch(fail);
}

function renderResults(items) {
  found = items;
  var box = $('results');
  box.innerHTML = '';

  if (!found.length) {
    box.innerHTML = '<div class="empty">검색 결과가 없습니다.</div>';
    return;
  }

  found.forEach(function (s, i) {
    var row = document.createElement('div');
    row.className = 'item';

    var info = document.createElement('div');
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.name;
    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = s.code + ' · ' + s.market + ' · ' + s.nation;
    info.appendChild(name);
    info.appendChild(meta);

    var btn = document.createElement('button');
    btn.textContent = '추가';
    btn.onclick = function () {
      add(i);
    };

    row.appendChild(info);
    row.appendChild(btn);
    box.appendChild(row);
  });
}

function add(i) {
  var s = found[i];
  if (!s) return;

  setBusy(true);
  msg(s.name + ' 추가 중…');

  callApi({ action: 'add', items: JSON.stringify([s]) })
    .then(function (res) {
      msg(res.added ? s.name + ' 추가됨' : s.name + ' 은(는) 이미 있습니다');
      $('results').innerHTML = '';
      $('query').value = '';
      return load();
    })
    .catch(fail);
}

/* ------------------------------------------------------------------ 목록 */

function load() {
  return callApi({ action: 'list' })
    .then(function (rows) {
      setBusy(false);
      renderList(rows || []);
    })
    .catch(function (err) {
      $('list').innerHTML = '';
      fail(err);
    });
}

function renderList(rows) {
  $('count').textContent = rows.length ? '(' + rows.length + ')' : '';

  var box = $('list');
  box.innerHTML = '';

  if (!rows.length) {
    box.innerHTML =
      '<div class="empty">아직 추가한 종목이 없습니다.<br />위에서 검색해 추가해보세요.</div>';
    return;
  }

  var table = document.createElement('table');
  table.appendChild(
    headerRow(['종목명', '현재가', '전일대비', '등락률', '통화', '장상태', '기준시각', ''])
  );
  rows.forEach(function (r) {
    table.appendChild(stockRow(r));
  });

  var wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  wrap.appendChild(table);
  box.appendChild(wrap);
}

function headerRow(labels) {
  var tr = document.createElement('tr');
  labels.forEach(function (label) {
    var th = document.createElement('th');
    th.textContent = label;
    tr.appendChild(th);
  });
  return tr;
}

function stockRow(r) {
  var chg = r['전일대비'];
  var isNum = typeof chg === 'number';
  var cls = isNum && chg !== 0 ? (chg > 0 ? 'up' : 'down') : '';
  var sign = isNum && chg > 0 ? '+' : '';

  var tr = document.createElement('tr');

  var nameTd = document.createElement('td');
  var name = document.createElement('div');
  name.className = 'name';
  name.textContent = r['종목명'];
  var meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = r['코드'] + ' · ' + r['시장'];
  nameTd.appendChild(name);
  nameTd.appendChild(meta);
  tr.appendChild(nameTd);

  tr.appendChild(cell(num(r['현재가'])));
  tr.appendChild(cell(isNum ? sign + num(chg) : '-', cls));
  tr.appendChild(
    cell(typeof r['등락률(%)'] === 'number' ? sign + r['등락률(%)'].toFixed(2) + '%' : '-', cls)
  );
  tr.appendChild(cell(r['통화']));
  tr.appendChild(cell(r['장상태']));
  tr.appendChild(cell(r['기준시각'], 'meta'));

  var btnTd = document.createElement('td');
  var btn = document.createElement('button');
  btn.className = 'danger';
  btn.textContent = '삭제';
  btn.onclick = function () {
    del(r['reutersCode'], r['종목명']);
  };
  btnTd.appendChild(btn);
  tr.appendChild(btnTd);

  return tr;
}

function cell(text, cls) {
  var td = document.createElement('td');
  td.textContent = text === null || text === undefined || text === '' ? '-' : text;
  if (cls) td.className = cls;
  return td;
}

/* ------------------------------------------------------- 새로고침 / 삭제 */

function refresh() {
  setBusy(true);
  msg('시세 갱신 중…');

  callApi({ action: 'refresh' })
    .then(function (res) {
      msg(
        res.failed
          ? res.updated + '개 갱신, ' + res.failed + '개 실패'
          : res.updated + '개 종목 갱신됨'
      );
      return load();
    })
    .catch(fail);
}

function del(code, name) {
  if (!confirm(name + ' 을(를) 삭제할까요?')) return;

  setBusy(true);
  msg('삭제 중…');

  callApi({ action: 'delete', codes: JSON.stringify([code]) })
    .then(function (res) {
      msg(res.deleted ? name + ' 삭제됨' : '삭제할 종목을 찾지 못했습니다');
      return load();
    })
    .catch(fail);
}

/* ------------------------------------------------------------------ 시작 */

$('searchBtn').onclick = search;
$('refreshBtn').onclick = refresh;
$('query').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') search();
});

load();
