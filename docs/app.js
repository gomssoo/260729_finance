/**
 * GitHub Pages 화면 로직.
 *
 * 네이버 API 는 CORS 를 열어주지 않고(Origin 이 붙으면 403), Apps Script 도
 * 응답 헤더를 설정할 수 없어 CORS 를 쓸 수 없다. 그래서 script 태그로 불러오는
 * JSONP 로 Apps Script 웹앱과 통신한다.
 */

var found = [];
var seq = 0;

// 서버 왕복이 2초 넘게 걸려서, 마지막 화면을 저장해뒀다가 즉시 그린다.
var CACHE_KEY = 'npay.stocks.v1';
var RECENT_KEY = 'npay.recent.v1';

// 화면이 시트를 다시 읽는 주기. 서버 트리거 주기를 받아오면 그에 맞춘다.
var POLL_MS = 300000;
var pollTimer = null;

var $ = function (id) {
  return document.getElementById(id);
};

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
  $('refreshBtn').disabled = busy;
  $('addBtn').disabled = busy;
}

// 사용자 동작 직후에는 그 결과 문구를 잠깐 남겨둔다.
var holdMsgUntil = 0;

function notice(text) {
  msg(text);
  holdMsgUntil = Date.now() + 2500;
}

function num(v, digits) {
  if (v === '' || v === null || v === undefined) return '-';
  if (typeof v !== 'number') return String(v);
  return v.toLocaleString('ko-KR', {
    minimumFractionDigits: digits || 0,
    maximumFractionDigits: digits === undefined ? 4 : digits,
  });
}

/** '2026-07-29 16:10:21' → '16:10:21' */
function timePart(s) {
  var m = String(s || '').match(/\d{2}:\d{2}:\d{2}/);
  return m ? m[0] : '';
}

/* ------------------------------------------------------------------ 목록 */

function renderCached() {
  try {
    var cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!cached || !cached.stocks || !cached.stocks.length) return false;

    renderList(cached.stocks);
    setStatus(cached.updatedAt, true);
    return true;
  } catch (e) {
    return false;
  }
}

function saveCache(state) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ stocks: state.stocks, updatedAt: state.updatedAt })
    );
  } catch (e) {
    // 용량 초과 등은 무시 — 캐시는 없어도 동작에 지장이 없다.
  }
}

function load(quiet) {
  return callApi({ action: 'state' })
    .then(function (state) {
      setBusy(false);
      renderList(state.stocks || []);
      setStatus(state.updatedAt, false);
      saveCache(state);
      applyTriggerState(state);
      return state;
    })
    .catch(function (err) {
      // 폴링 실패는 조용히 넘긴다. 화면에 이미 값이 떠 있는데
      // 네트워크가 잠깐 끊겼다고 목록을 지워버리면 더 나쁘다.
      if (quiet) {
        setBusy(false);
        return null;
      }
      if (!$('list').querySelector('.grid')) $('list').innerHTML = '';
      fail(err);
      return null;
    });
}

function applyTriggerState(state) {
  var chk = $('autoChk');
  var mins = state.intervalMinutes || 5;

  // null 이면 트리거 권한이 아직 승인되지 않은 상태다.
  chk.disabled = state.autoRefresh === null;
  chk.checked = state.autoRefresh === true;
  $('autoLabel').textContent = '자동 갱신 (' + mins + '분)';
  chk.parentNode.title =
    state.autoRefresh === null
      ? '자동 갱신을 켜려면 스크립트 권한 승인이 필요합니다'
      : '서버가 ' + mins + '분마다 시세를 갱신합니다';

  setPollInterval(mins * 60000);
}

function setStatus(updatedAt, fromCache) {
  var live = $('live');
  var time = timePart(updatedAt);

  live.hidden = !time;
  if (time) {
    $('liveTime').textContent = (fromCache ? '' : 'LIVE ') + time;
    live.title = updatedAt + (fromCache ? ' (저장된 값)' : '') + ' 기준';
  }

  if (Date.now() < holdMsgUntil) return;
  msg('');
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(function () {
    // 탭이 숨겨져 있으면 굳이 부르지 않는다.
    if (document.hidden) return;
    load(true);
  }, POLL_MS);
}

/** 서버 갱신 주기보다 자주 읽어봐야 같은 값이라 주기를 맞춘다. */
function setPollInterval(ms) {
  if (!ms || ms === POLL_MS) return;
  POLL_MS = ms;
  if (pollTimer) startPolling();
}

/* ------------------------------------------------------------------ 카드 */

function renderList(rows) {
  $('count').textContent = rows.length;

  var box = $('list');
  box.innerHTML = '';

  if (!rows.length) {
    box.innerHTML =
      '<div class="empty">아직 추가한 종목이 없습니다.<br />오른쪽 위 <b>+ 종목 추가</b> 로 시작하세요.</div>';
    return;
  }

  var grid = document.createElement('div');
  grid.className = 'grid';
  rows.forEach(function (r, i) {
    grid.appendChild(stockCard(r, i, rows.length));
  });
  box.appendChild(grid);
}

function stockCard(r, index, total) {
  var chg = r['전일대비'];
  var rate = r['등락률(%)'];
  var isNum = typeof chg === 'number';
  var dir = !isNum || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down';

  var card = el('div', 'card');

  // 순서 이동 / 삭제 — 평소엔 숨었다가 hover 시 나타난다.
  var tools = el('div', 'card-tools');
  tools.appendChild(toolButton('↑', '위로', index === 0, function () {
    move(r['reutersCode'], -1);
  }));
  tools.appendChild(toolButton('↓', '아래로', index === total - 1, function () {
    move(r['reutersCode'], 1);
  }));
  var del = toolButton('×', '삭제', false, function () {
    remove(r['reutersCode'], r['종목명']);
  });
  del.classList.add('del');
  tools.appendChild(del);
  card.appendChild(tools);

  // 종목명 + 코드
  var top = el('div', 'card-top');
  top.appendChild(el('div', 'card-name', r['종목명']));
  top.appendChild(el('div', 'card-code', r['코드']));
  card.appendChild(top);

  // 현재가 — 통화에 따라 소수 자릿수를 다르게 본다.
  var decimals = r['통화'] === 'KRW' ? 0 : 2;
  card.appendChild(el('div', 'card-price', num(r['현재가'], decimals)));

  // 전일대비 + 등락률
  var change = el('div', 'card-change ' + dir);
  if (isNum) {
    change.appendChild(el('span', 'arrow', dir === 'up' ? '▲' : dir === 'down' ? '▼' : '—'));
    change.appendChild(
      el('span', '', (chg > 0 ? '+' : '') + num(chg, decimals))
    );
  }
  if (typeof rate === 'number') {
    change.appendChild(el('span', '', (rate > 0 ? '+' : '') + rate.toFixed(2) + '%'));
  }
  if (!change.childNodes.length) change.appendChild(el('span', '', '-'));
  card.appendChild(change);

  // 시장 · 통화 · 장상태 · 기준시각 — 시안에 없지만 정보는 다 살린다.
  var meta = el('div', 'card-meta');
  var status = String(r['장상태'] || '');
  var badge = el('span', 'badge' + (status === '장중' ? ' open' : ''), status || '-');
  meta.appendChild(badge);
  [r['시장'], r['통화'], timePart(r['기준시각'])].forEach(function (v) {
    if (!v) return;
    meta.appendChild(el('span', 'sep', '·'));
    meta.appendChild(el('span', '', String(v)));
  });
  card.appendChild(meta);

  return card;
}

function toolButton(label, title, disabled, onClick) {
  var b = el('button', 'tool', label);
  b.title = title;
  b.disabled = disabled;
  b.onclick = onClick;
  return b;
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ 모달 */

function openModal() {
  $('modal').hidden = false;
  renderChips();
  $('query').value = '';
  $('query').focus();
  renderResults([]);
  $('results').innerHTML =
    '<div class="empty sm">종목명이나 티커를 입력하세요.<br />국내·해외 모두 찾을 수 있습니다.</div>';
}

function closeModal() {
  $('modal').hidden = true;
  found = [];
}

/** 최근 추가한 종목을 칩으로 보여준다. 자주 쓰는 것을 빨리 다시 찾게. */
function getRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function pushRecent(name) {
  try {
    var list = getRecent().filter(function (n) {
      return n !== name;
    });
    list.unshift(name);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 4)));
  } catch (e) {
    // 저장 실패는 무시 — 편의 기능일 뿐이다.
  }
}

function renderChips() {
  var box = $('chips');
  box.innerHTML = '';

  getRecent().forEach(function (name) {
    var chip = el('button', 'chip', '최근 · ' + name);
    chip.onclick = function () {
      $('query').value = name;
      search();
    };
    box.appendChild(chip);
  });
}

/* ------------------------------------------------------------------ 검색 */

var searchTimer = null;

function scheduleSearch() {
  clearTimeout(searchTimer);
  // 타이핑마다 부르면 GAS 왕복이 2초라 감당이 안 된다.
  searchTimer = setTimeout(search, 350);
}

function search() {
  clearTimeout(searchTimer);
  var q = $('query').value.trim();
  if (!q) {
    renderResults([]);
    return;
  }

  $('ring').classList.add('busy');

  callApi({ action: 'search', query: q })
    .then(function (items) {
      $('ring').classList.remove('busy');
      renderResults(items || []);
    })
    .catch(function (err) {
      $('ring').classList.remove('busy');
      $('results').innerHTML = '';
      fail(err);
    });
}

function renderResults(items) {
  found = items || [];
  $('resultCount').textContent = found.length;

  var box = $('results');
  box.innerHTML = '';

  if (!found.length) {
    if ($('query').value.trim()) {
      box.innerHTML = '<div class="empty sm">검색 결과가 없습니다.</div>';
    }
    return;
  }

  found.forEach(function (s, i) {
    var row = el('div', 'row');

    var main = el('div', 'row-main');
    main.appendChild(el('div', 'row-name', s.name));
    main.appendChild(el('div', 'row-sub', s.code + '  ' + s.market + '  ' + s.nation));
    row.appendChild(main);

    var btn = el('button', 'row-add', '+');
    btn.title = '추가';
    btn.onclick = function () {
      add(i, btn);
    };
    row.appendChild(btn);

    box.appendChild(row);
  });
}

function add(i, btn) {
  var s = found[i];
  if (!s) return;

  btn.disabled = true;

  callApi({ action: 'add', items: JSON.stringify([s]) })
    .then(function (res) {
      // 모달을 닫지 않는다. 여러 종목을 연달아 담을 수 있어야 편하다.
      btn.textContent = '✓';
      btn.classList.add('done');
      notice(res.added ? s.name + ' 추가됨' : s.name + ' 은(는) 이미 있습니다');
      pushRecent(s.name);
      return load(true);
    })
    .catch(function (err) {
      btn.disabled = false;
      fail(err);
    });
}

/* ------------------------------------------------------- 새로고침 / 편집 */

function refresh() {
  setBusy(true);
  notice('시세 갱신 중…');

  callApi({ action: 'refresh' })
    .then(function (res) {
      notice(
        res.failed
          ? res.updated + '개 갱신, ' + res.failed + '개 실패'
          : res.updated + '개 종목 갱신됨'
      );
      return load();
    })
    .catch(fail);
}

function move(code, offset) {
  setBusy(true);
  callApi({ action: 'move', code: code, offset: offset })
    .then(function () {
      return load(true);
    })
    .catch(fail);
}

function remove(code, name) {
  if (!confirm(name + ' 을(를) 삭제할까요?')) return;

  setBusy(true);
  notice('삭제 중…');

  callApi({ action: 'delete', codes: JSON.stringify([code]) })
    .then(function (res) {
      notice(res.deleted ? name + ' 삭제됨' : '삭제할 종목을 찾지 못했습니다');
      return load();
    })
    .catch(fail);
}

/* ------------------------------------------------------------------ 시작 */

$('refreshBtn').onclick = refresh;
$('addBtn').onclick = openModal;
$('closeBtn').onclick = closeModal;
$('backdrop').onclick = closeModal;
$('query').oninput = scheduleSearch;

$('query').onkeydown = function (e) {
  if (e.key === 'Enter') search();
};

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !$('modal').hidden) closeModal();
});

$('autoChk').onchange = function () {
  var on = this.checked;
  this.disabled = true;
  notice(on ? '자동 갱신 켜는 중…' : '자동 갱신 끄는 중…');

  callApi({ action: 'trigger', on: on ? '1' : '0' })
    .then(function () {
      notice(on ? '자동 갱신 켜짐' : '자동 갱신 꺼짐');
      return load(true);
    })
    .catch(function (err) {
      $('autoChk').checked = !on;
      $('autoChk').disabled = false;
      fail(err);
    });
};

// 숨어 있던 탭으로 돌아오면 기다리지 않고 바로 새 값을 읽는다.
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) load(true);
});

// 캐시가 있으면 먼저 그려서 빈 화면을 보이지 않게 하고,
// 그 뒤에 서버 값으로 조용히 덮어쓴다.
var hadCache = renderCached();
if (!hadCache) $('list').innerHTML = '<div class="empty">불러오는 중…</div>';

load(hadCache).then(startPolling);
