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

    renderIndices(cached.indices);
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
      JSON.stringify({
        stocks: state.stocks,
        indices: state.indices,
        updatedAt: state.updatedAt,
      })
    );
  } catch (e) {
    // 용량 초과 등은 무시 — 캐시는 없어도 동작에 지장이 없다.
  }
}

function load(quiet) {
  return callApi({ action: 'state' })
    .then(function (state) {
      setBusy(false);
      renderIndices(state.indices);
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

// 국가 코드 → 표시 라벨. 목록에 없는 나라는 코드를 그대로 쓴다.
var NATION_LABEL = {
  KOR: { code: 'KR', name: '국내' },
  USA: { code: 'US', name: '미국' },
  JPN: { code: 'JP', name: '일본' },
  HKG: { code: 'HK', name: '홍콩' },
  CHN: { code: 'CN', name: '중국' },
  VNM: { code: 'VN', name: '베트남' },
};

function renderList(rows) {
  $('count').textContent = rows.length;

  var box = $('list');
  box.innerHTML = '';

  if (!rows.length) {
    box.innerHTML =
      '<div class="empty">아직 추가한 종목이 없습니다.<br />오른쪽 위 <b>+ 종목 추가</b> 로 시작하세요.</div>';
    return;
  }

  // 시트 순서를 유지한 채 국가별로 묶는다.
  // 순서 이동은 전체 목록 기준이라 원래 인덱스를 함께 넘긴다.
  var groups = [];
  var byNation = {};

  rows.forEach(function (r, i) {
    var key = String(r['nationCode'] || '기타');
    if (!byNation[key]) {
      byNation[key] = { key: key, items: [] };
      groups.push(byNation[key]);
    }
    byNation[key].items.push({ row: r, index: i });
  });

  groups.forEach(function (g) {
    box.appendChild(groupHeader(g.key, g.items.length));

    var grid = el('div', 'grid');
    g.items.forEach(function (it) {
      grid.appendChild(stockCard(it.row, it.index, rows.length));
    });
    box.appendChild(grid);
  });
}

/** 관심 종목 위에 띄우는 주요 지수. 카드보다 납작한 띠 형태로 둔다. */
function renderIndices(list) {
  var box = $('indices');
  box.innerHTML = '';
  if (!list || !list.length) return;

  var strip = el('div', 'index-strip');

  list.forEach(function (ix) {
    var item = el('div', 'index-item');
    item.appendChild(el('div', 'index-label', ix.label));

    if (!ix.ok) {
      item.appendChild(el('div', 'index-price muted', '조회 실패'));
      strip.appendChild(item);
      return;
    }

    var dir = typeof ix.change !== 'number' || ix.change === 0 ? 'flat' : ix.change > 0 ? 'up' : 'down';

    var line = el('div', 'index-line');
    line.appendChild(el('span', 'index-price', num(ix.price, 2)));

    var chg = el('span', 'index-change ' + dir);
    if (typeof ix.rate === 'number') {
      chg.textContent =
        (dir === 'up' ? '▲' : dir === 'down' ? '▼' : '') +
        ' ' +
        (ix.rate > 0 ? '+' : '') +
        ix.rate.toFixed(2) +
        '%';
    }
    line.appendChild(chg);
    item.appendChild(line);

    if (ix.chart) {
      var ic = el('div', 'index-chart');
      var iimg = document.createElement('img');
      iimg.src = ix.chart;
      iimg.alt = '';
      iimg.loading = 'lazy';
      iimg.onerror = function () {
        ic.remove();
      };
      ic.appendChild(iimg);
      item.appendChild(ic);
    }

    if (ix.status !== '장중') item.classList.add('closed');
    item.title = ix.status + ' · ' + ix.tradedAt + ' 기준';

    strip.appendChild(item);
  });

  box.appendChild(strip);
}

function groupHeader(nationCode, count) {
  var info = NATION_LABEL[nationCode] || { code: nationCode, name: '' };

  var head = el('div', 'group-head');
  head.appendChild(el('span', 'group-code', info.code));
  if (info.name) head.appendChild(el('span', 'group-name', info.name));
  head.appendChild(el('span', 'group-count', String(count)));
  return head;
}

function stockCard(r, index, total) {
  var chg = r['전일대비'];
  var rate = r['등락률(%)'];
  var isNum = typeof chg === 'number';
  var dir = !isNum || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down';

  var card = el('div', 'card');
  card.draggable = true;
  card.dataset.code = r['reutersCode'];
  card.dataset.nation = r['nationCode'] || '';
  card.dataset.name = r['종목명'];
  attachDrag(card);

  // 삭제 — 평소엔 숨었다가 hover 시 나타난다.
  // 순서 변경은 카드를 끌어서 한다.
  var tools = el('div', 'card-tools');
  var del = toolButton('×', '삭제', false, function () {
    remove(r['reutersCode'], r['종목명']);
  });
  del.classList.add('del');
  tools.appendChild(del);
  card.appendChild(tools);

  // 국내는 '종목명 + 코드', 해외는 티커만. 해외 ETF 는 이름이 40자를
  // 넘는데 티커만으로 충분히 알아본다. 시장·통화는 아래 메타 줄에 있다.
  var domestic = r['nationCode'] === 'KOR';

  var top = el('div', 'card-top');
  var titles = el('div', 'card-titles');
  titles.appendChild(
    el('div', 'card-name' + (domestic ? '' : ' ticker'), domestic ? r['종목명'] : r['코드'])
  );
  if (domestic) titles.appendChild(el('div', 'card-sub', r['코드']));
  top.appendChild(titles);
  card.appendChild(top);

  // 원래 이름은 툴팁으로 남겨둔다. 티커가 헷갈릴 때 확인할 수 있게.
  if (!domestic) card.title = r['종목명'];

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

  // 장마감은 배지 대신 카드 전체를 흐리게 해서 한눈에 구분한다.
  var status = String(r['장상태'] || '');
  if (status && status !== '장중') card.classList.add('closed');
  card.title =
    (card.title ? card.title + '\n' : '') + status + ' · ' + r['시장'] + ' · ' + r['통화'];

  // 스파크라인 — 네이버가 주는 150x64 투명 PNG 를 그대로 쓴다.
  // 이미지 안에 가격 데이터가 없어 호버 툴팁은 만들 수 없다.
  // 대신 누르면 네이버 해당 종목 페이지로 보낸다.
  if (r['차트']) {
    var chart = el('a', 'card-chart ' + dir);
    chart.href = naverUrl(r);
    chart.target = '_blank';
    chart.rel = 'noopener';
    chart.title = r['종목명'] + ' — 네이버에서 자세히 보기';

    // 링크는 기본적으로 드래그가 걸려서, 카드 순서 이동을 방해한다.
    chart.draggable = false;

    var img = document.createElement('img');
    img.src = r['차트'];
    img.alt = '';
    img.loading = 'lazy';
    img.draggable = false;
    // 이미지가 없거나 막히면 영역째 지워 빈 칸이 남지 않게 한다.
    img.onerror = function () {
      chart.remove();
    };
    chart.appendChild(img);
    card.appendChild(chart);
  }

  // 시간외(NXT) 거래가 있으면 정규장 아래에 덧붙인다.
  if (typeof r['시간외'] === 'number' && r['시간외'] > 0) {
    var oChg = r['시간외대비'];
    var oRate = r['시간외등락률'];
    var oDir = typeof oChg !== 'number' || oChg === 0 ? 'flat' : oChg > 0 ? 'up' : 'down';

    var over = el('div', 'card-over');
    over.appendChild(el('span', 'over-tag', '시간외'));
    over.appendChild(el('span', 'over-price', num(r['시간외'], decimals)));

    var oc = el('span', 'over-change ' + oDir);
    if (typeof oRate === 'number') {
      oc.textContent = (oRate > 0 ? '+' : '') + oRate.toFixed(2) + '%';
    }
    over.appendChild(oc);
    over.title = '시간외 ' + timePart(r['시간외시각']) + ' 기준';
    card.appendChild(over);
  }

  // 기준시각 + 추세. 시장명과 통화는 국가 그룹으로 이미 드러난다.
  var meta = el('div', 'card-meta');
  meta.appendChild(el('span', '', timePart(r['기준시각'])));

  // '상향 +1.23' 형태로 저장돼 있다. 방향과 폭을 나눠 보여준다.
  var trend = String(r['추세'] || '').trim();
  if (trend && trend !== '-') {
    var parts = trend.split(/\s+/);
    var label = parts[0];
    var pct = parts[1];

    var cls = label === '상향' ? 'up' : label === '하향' ? 'down' : 'flat';
    var tag = el('span', 'trend ' + cls);
    tag.appendChild(el('span', '', label));
    if (pct) tag.appendChild(el('span', 'trend-pct', pct + '%'));

    // 값이 적으면 판정이 흔들린다. 몇 개로 본 것인지 알려준다.
    tag.title = '최근 ' + (r['이력수'] || 0) + '개 시세 기준 누적 변동';
    meta.appendChild(tag);
  }
  card.appendChild(meta);

  return card;
}

/* -------------------------------------------------------------- 드래그 */

var dragging = null;

function attachDrag(card) {
  card.addEventListener('dragstart', function (e) {
    dragging = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox 는 데이터가 없으면 드래그를 시작하지 않는다.
    e.dataTransfer.setData('text/plain', card.dataset.code);
  });

  card.addEventListener('dragend', function () {
    card.classList.remove('dragging');
    clearDropMarks();
    dragging = null;
  });

  card.addEventListener('dragover', function (e) {
    if (!dragging || dragging === card) return;
    e.preventDefault();

    // 국가가 다르면 놓을 수 없다는 것을 커서와 표시로 알린다.
    if (card.dataset.nation !== dragging.dataset.nation) {
      e.dataTransfer.dropEffect = 'none';
      clearDropMarks();
      card.classList.add('drop-deny');
      return;
    }

    e.dataTransfer.dropEffect = 'move';

    // 카드 중앙을 기준으로 앞/뒤 어느 쪽에 놓을지 정한다.
    var box = card.getBoundingClientRect();
    var after = e.clientX > box.left + box.width / 2;

    clearDropMarks();
    card.classList.add(after ? 'drop-after' : 'drop-before');
  });

  card.addEventListener('dragleave', function () {
    card.classList.remove('drop-before', 'drop-after', 'drop-deny');
  });

  card.addEventListener('drop', function (e) {
    if (!dragging || dragging === card) return;
    e.preventDefault();
    e.stopPropagation();

    // 국가별로 묶어 보여주므로 그룹을 넘나드는 이동은 받지 않는다.
    if (card.dataset.nation !== dragging.dataset.nation) {
      clearDropMarks();
      alertNationMismatch(dragging, card);
      return;
    }

    var after = card.classList.contains('drop-after');
    clearDropMarks();
    card.parentNode.insertBefore(dragging, after ? card.nextSibling : card);

    commitOrder();
  });
}

function clearDropMarks() {
  var marked = document.querySelectorAll('.drop-before, .drop-after, .drop-deny');
  Array.prototype.forEach.call(marked, function (n) {
    n.classList.remove('drop-before', 'drop-after', 'drop-deny');
  });
}

function nationCodeOf(nation) {
  var info = NATION_LABEL[nation];
  return info ? info.code : nation || '기타';
}

function alertNationMismatch(from, to) {
  alert(
    from.dataset.name + ' 은(는) ' + nationCodeOf(from.dataset.nation) + ' 종목입니다.\n' +
      nationCodeOf(to.dataset.nation) + ' 영역으로는 옮길 수 없습니다.\n\n' +
      '순서 변경은 같은 국가 안에서만 가능합니다.'
  );
}

/** 화면에 보이는 카드 순서를 그대로 서버에 보낸다. */
function commitOrder() {
  var cards = document.querySelectorAll('#list .card');
  var codes = Array.prototype.map.call(cards, function (c) {
    return c.dataset.code;
  });
  if (!codes.length) return;

  notice('순서 저장 중…');

  callApi({ action: 'reorder', codes: JSON.stringify(codes) })
    .then(function () {
      notice('순서를 바꿨습니다');
      // 국가 그룹을 넘나든 경우 그룹 머리글이 어긋나므로 다시 그린다.
      return load(true);
    })
    .catch(fail);
}

/** 네이버 증권의 해당 종목 페이지. 국내와 해외가 경로가 다르다. */
function naverUrl(r) {
  var base = 'https://m.stock.naver.com/';
  return r['nationCode'] === 'KOR'
    ? base + 'domestic/stock/' + r['reutersCode'] + '/total'
    : base + 'worldstock/stock/' + r['reutersCode'] + '/total';
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

/* ---------------------------------------------------------------- 테마 */

var THEME_KEY = 'npay.theme';

// system 은 저장하지 않는다. 값이 없으면 OS 설정을 따른다는 뜻.
var THEMES = ['system', 'light', 'dark'];
var THEME_ICON = { system: '◐', light: '☀', dark: '☾' };
var THEME_NAME = { system: '시스템 설정', light: '라이트', dark: '다크' };

function currentTheme() {
  var saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch (e) {}
  return THEMES.indexOf(saved) > 0 ? saved : 'system';
}

function applyTheme(theme) {
  var root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;

  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch (e) {}

  var btn = $('themeBtn');
  btn.textContent = THEME_ICON[theme];
  btn.title = '테마: ' + THEME_NAME[theme] + ' (눌러서 변경)';
}

function cycleTheme() {
  var next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  applyTheme(next);
}

/* ------------------------------------------------------------------ 시작 */

applyTheme(currentTheme());
$('themeBtn').onclick = cycleTheme;

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
