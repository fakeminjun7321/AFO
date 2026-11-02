/**
 * Static page for `gui` (#9), embedded so `npm run build` needs no bundler or asset copy.
 * The page renders every file name with textContent (never innerHTML): names in a scanned folder are untrusted input.
 * File changes happen only after an in-page confirmation listing the operations (trash also needs a checkbox); see gui.ts.
 * Keep appJs free of backticks and dollar-brace sequences: it lives inside a String.raw template.
 */
export const pageHtml = String.raw`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AFO 정리 화면</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header class="top">
  <div class="brand"><span class="logo">AFO</span><span class="sub">로컬 화면 · 이 컴퓨터에서만 열립니다</span></div>
  <span class="badge safe">확인한 작업만 실행해요 · 영구 삭제는 터미널에서만</span>
</header>
<section class="controls" aria-label="폴더 선택">
  <label class="field grow"><span>작업 폴더(절대 경로)</span><input id="folder" type="text" spellcheck="false" autocomplete="off" placeholder="/Users/me/정리할-폴더"></label>
  <details class="more"><summary>참고 폴더·규칙 옵션</summary>
    <label class="field"><span>참고 폴더(선택, 읽기만 함)</span><input id="reference" type="text" spellcheck="false" autocomplete="off" placeholder="비워 두면 사용하지 않음"></label>
    <label class="check"><input id="noSaved" type="checkbox"> 저장된 개인 규칙을 쓰지 않고 기본 분류로 보기</label>
  </details>
  <div class="actions"><button id="analyze" class="primary" type="button">분석</button></div>
  <p id="status" class="status" role="status" aria-live="polite"></p>
</section>
<nav class="tabs" role="tablist" aria-label="화면">
  <button role="tab" data-tab="preview" aria-selected="true">미리보기</button>
  <button role="tab" data-tab="plan" aria-selected="false">정리 계획</button>
  <button role="tab" data-tab="rules" aria-selected="false">개인 규칙</button>
  <button role="tab" data-tab="runs" aria-selected="false">실행 기록</button>
  <button role="tab" data-tab="recover" aria-selected="false">복구 점검</button>
</nav>
<main id="view" tabindex="-1"></main>
<footer class="foot" id="foot"></footer>
</body>
</html>`;

export const appCss = String.raw`:root{--bg:#f6f5f2;--panel:#fff;--ink:#16140f;--muted:#6b665c;--line:#e3dfd6;--accent:#e8590c;--accent-ink:#fff;
--ok:#2b8a3e;--warn:#b35c00;--bad:#c92a2a;--chip:#f1eee8;--code:#f3f1ec;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121110;--panel:#1c1b19;--ink:#f1efe9;--muted:#a59f93;--line:#34312c;
--accent:#ff7a2f;--accent-ink:#121110;--ok:#69db7c;--warn:#ffa94d;--bad:#ff8787;--chip:#2a2825;--code:#25231f;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#121110;--panel:#1c1b19;--ink:#f1efe9;--muted:#a59f93;--line:#34312c;--accent:#ff7a2f;--accent-ink:#121110;
--ok:#69db7c;--warn:#ffa94d;--bad:#ff8787;--chip:#2a2825;--code:#25231f;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Segoe UI",sans-serif}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:16px clamp(16px,4vw,40px);border-bottom:1px solid var(--line);background:var(--panel)}
.brand{display:flex;gap:12px;align-items:baseline}.logo{font-weight:800;font-size:22px;letter-spacing:.04em}.logo::after{content:"";display:inline-block;width:8px;height:8px;margin-left:4px;border-radius:50%;background:var(--accent)}
.sub{color:var(--muted);font-size:13px}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:var(--chip);color:var(--muted)}
.badge.safe{color:var(--ok)}.badge.move{color:var(--accent)}.badge.keep{color:var(--muted)}.badge.review{color:var(--warn)}.badge.bad{color:var(--bad)}
.controls{display:grid;grid-template-columns:1fr auto;gap:10px 16px;align-items:end;padding:16px clamp(16px,4vw,40px);background:var(--panel);border-bottom:1px solid var(--line)}
.controls .more{grid-column:1/-1;color:var(--muted)}.controls .more summary{cursor:pointer;font-size:13px}.controls .more[open]{display:grid;gap:8px}
.field{display:grid;gap:4px;font-size:13px;color:var(--muted)}.field input,select{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 11px;min-width:0;width:100%}
.field input:focus,select:focus,button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.check{display:flex;gap:8px;align-items:center;font-size:14px;color:var(--ink)}
.actions{display:flex;gap:8px}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:9px 16px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:700}
button:disabled{opacity:.5;cursor:not-allowed}
.status{grid-column:1/-1;margin:0;min-height:1.4em;font-size:13px;color:var(--muted)}.status.err{color:var(--bad)}
.tabs{display:flex;gap:4px;overflow-x:auto;padding:0 clamp(16px,4vw,40px);border-bottom:1px solid var(--line);background:var(--panel)}
.tabs button{border:0;border-bottom:3px solid transparent;border-radius:0;background:none;padding:12px 14px;color:var(--muted);white-space:nowrap}
.tabs button[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--accent);font-weight:700}
main{padding:20px clamp(16px,4vw,40px) 40px;display:grid;gap:16px;max-width:1280px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;min-width:0}
.card h2{font-size:16px;margin:0 0 10px}.card h3{font-size:14px;margin:14px 0 6px}
.muted{color:var(--muted)}.small{font-size:13px}.warn{color:var(--warn)}.bad{color:var(--bad)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.stat b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.stat span{font-size:13px;color:var(--muted)}
.toolbar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin-bottom:10px}.toolbar input[type=search],.toolbar select{width:auto;flex:1 1 200px}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;white-space:nowrap}td.path{word-break:break-all}tr.click{cursor:pointer}tr.click:hover td{background:var(--chip)}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
.cmd{display:flex;gap:8px;align-items:stretch;margin:8px 0}.cmd code{flex:1;display:block;padding:9px 11px;background:var(--code);border-radius:8px;word-break:break-all}
.code{font-size:22px;font-weight:800;letter-spacing:.12em;font-family:ui-monospace,Menlo,Consolas,monospace}
details.folder{border-bottom:1px solid var(--line);padding:6px 0}details.folder summary{cursor:pointer}details.folder ul{margin:6px 0 4px;padding-left:20px;word-break:break-all}
.empty{color:var(--muted);text-align:center;padding:28px 10px}
.note{border-left:3px solid var(--accent);padding:6px 12px;background:var(--chip);border-radius:0 8px 8px 0;font-size:13.5px}
.note.danger{border-left-color:var(--bad)}
.confirm{display:grid;gap:8px;margin:10px 0;padding:12px 14px;border:2px solid var(--accent);border-radius:10px}.confirm.danger{border-color:var(--bad)}
.confirm p{margin:0}.confirm ul{margin:0;padding-left:20px;word-break:break-all;max-height:320px;overflow:auto}
details.hint{margin:8px 0 4px;font-size:13px;color:var(--muted)}details.hint summary{cursor:pointer}
.result{border-left:4px solid var(--ok)}.result.partial{border-left-color:var(--warn)}
.foot{padding:0 clamp(16px,4vw,40px) 28px;color:var(--muted);font-size:12px}
@media (max-width:640px){.controls{grid-template-columns:1fr}.actions button{flex:1}}`;

export const appJs = String.raw`(function () {
  'use strict';
  var token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  var state = { info: null, tab: 'preview', preview: null, plan: null, busy: false, filter: '', action: 'all',
    deleteMode: 'trash', deleteDuplicates: false, runDetail: null,
    confirm: null, confirmChecked: false, done: {}, result: null, runConfirm: null, lastUndo: null };
  var SHOW = 20;
  var LIMIT = 500;
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = String(v);
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  function bytes(n) {
    if (n === null || n === undefined) return '알 수 없음';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? String(v) : v.toFixed(v < 10 ? 1 : 0)) + ' ' + u[i];
  }
  function when(iso) { try { return new Date(iso).toLocaleString('ko-KR'); } catch (e) { return iso; } }
  function dirOf(p) { var i = p.lastIndexOf('/'); return i < 0 ? '(작업 폴더 바로 아래)' : p.slice(0, i); }
  function card(title) { var c = el('section', { class: 'card' }, el('h2', { text: title })); for (var i = 1; i < arguments.length; i++) append(c, arguments[i]); return c; }
  function stat(n, label) { return el('div', { class: 'stat' }, el('b', { text: n }), el('span', { text: label })); }
  function empty(text) { return el('p', { class: 'empty', text: text }); }
  function table(head, rows) {
    return el('div', { class: 'tablewrap' }, el('table', null, el('thead', null, el('tr', null, head.map(function (h) { return el('th', { text: h }); }))),
      el('tbody', null, rows)));
  }
  function copyButton(text) {
    return el('button', { type: 'button', onclick: function (ev) {
      var b = ev.currentTarget;
      var done = function () { b.textContent = '복사됨'; setTimeout(function () { b.textContent = '복사'; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { b.textContent = '직접 선택하세요'; });
      else b.textContent = '직접 선택하세요';
    } }, '복사');
  }
  function command(text) { return el('div', { class: 'cmd' }, el('code', { text: text }), copyButton(text)); }
  function terminalHint(text, extra) {
    return el('details', { class: 'hint' }, el('summary', { text: '터미널로 하려면' }), extra ? el('p', { class: 'small', text: extra }) : null, command(text));
  }
  function cliOf() { return state.info ? state.info.cli : 'afo'; }
  function shortList(items, line) {
    return el('ul', { class: 'small' }, items.slice(0, SHOW).map(function (x) { return el('li', { class: 'path', text: line(x) }); }),
      items.length > SHOW ? el('li', { class: 'muted', text: '… 외 ' + (items.length - SHOW) + '개' }) : null);
  }

  function setStatus(text, isError) { var s = $('status'); s.textContent = text || ''; s.className = 'status' + (isError ? ' err' : ''); }
  function api(method, url, body) {
    var opts = { method: method, headers: { 'x-afo-token': token } };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error((data.error && data.error.message) || ('요청 실패 (' + r.status + ')')); e.code = data.error && data.error.code; throw e; }
        return data;
      });
    });
  }
  function errText(e) { return (e.code ? '[' + e.code + '] ' : '') + e.message; }
  function options() {
    var body = { folder: $('folder').value.trim() };
    var ref = $('reference').value.trim();
    if (ref) body.reference = ref;
    if ($('noSaved').checked) body.noSavedRules = true;
    return body;
  }
  function setBusy(on, text) {
    state.busy = on;
    Array.prototype.forEach.call(document.querySelectorAll('button.run'), function (b) { b.disabled = on; });
    $('analyze').disabled = on;
    if (text !== undefined) setStatus(text);
  }

  var profileText = function (info) {
    if (!info) return '';
    switch (info.source) {
      case 'saved': return info.status === 'disabled' ? '저장된 개인 규칙이 꺼져 있어 기본 분류를 썼습니다.' : '저장된 개인 규칙(revision ' + info.revision + ')을 적용했습니다.';
      case 'stale': return '참고 폴더가 바뀐 것 같아 저장된 개인 규칙을 이번에는 적용하지 않았습니다.';
      case 'skipped': return '옵션에 따라 저장된 개인 규칙 없이 기본 분류로 봤습니다.';
      case 'corrupt': return '저장된 개인 규칙 파일이 손상돼 기본 분류를 썼습니다.';
      case 'none': return '저장된 개인 규칙이 없어 기본 분류를 썼습니다.';
      default: return '규칙 파일을 적용했습니다.';
    }
  };

  function analyze() {
    var body = options();
    if (!body.folder) { setStatus('작업 폴더의 절대 경로를 입력하세요.', true); $('folder').focus(); return; }
    setBusy(true, '분석 중… 파일 이름·크기를 읽고 같은 크기 파일의 내용 해시를 비교해요(파일은 바꾸지 않아요).');
    state.plan = null; state.confirm = null; state.result = null;
    api('POST', '/api/preview', body).then(function (data) {
      state.preview = data; setBusy(false, '분석 완료 · ' + when(new Date().toISOString())); select('preview');
    }, function (e) { setBusy(false); setStatus(errText(e), true); });
  }
  function makePlan() {
    var body = options();
    if (!body.folder) { setStatus('작업 폴더의 절대 경로를 입력하세요.', true); return; }
    body.deleteMode = state.deleteMode; body.deleteDuplicates = state.deleteDuplicates ? 'all' : 'none';
    setBusy(true, '정리 계획을 만드는 중… 계획은 앱 상태 폴더에만 저장하고 파일은 바꾸지 않아요.');
    api('POST', '/api/plan', body).then(function (data) {
      state.plan = data; state.preview = { preview: data.preview, profile: data.profile };
      state.done = {}; state.confirm = null; state.result = null;
      setBusy(false, '계획 저장 완료 · 만료 ' + when(data.plan.expiresAt)); render();
    }, function (e) { setBusy(false); setStatus(errText(e), true); });
  }

  /* ---------- 미리보기 ---------- */
  function renderPreview(view) {
    if (!state.preview) { view.appendChild(card('미리보기', empty('작업 폴더를 입력하고 [분석]을 누르세요. 분석은 읽기만 하며 파일을 바꾸지 않습니다.'))); return; }
    var p = state.preview.preview, items = p.items;
    var counts = { move: 0, keep: 0, review: 0 };
    items.forEach(function (i) { counts[i.action]++; });
    var dupBytes = p.duplicates.reduce(function (s, g) { return s + g.logicalCandidateBytes; }, 0);
    view.appendChild(el('div', { class: 'stats' }, stat(items.length, '분석한 파일'), stat(counts.move, '이동 제안'), stat(counts.keep, '그대로 유지'),
      stat(counts.review, '검토 필요'), stat(p.duplicates.length, '중복 묶음 · 후보 ' + bytes(dupBytes)), stat(p.skipped.length, '제외·오류')));
    view.appendChild(el('p', { class: 'note' }, (p.scanComplete ? '스캔 완료. ' : '스캔 일부 미완료(한도·취소·오류). ') + profileText(state.preview.profile) +
      (p.profileNotice ? ' ' + p.profileNotice.reason : '') + ' 크기는 논리 크기이며 실제 확보량이 아닙니다.'));

    // 정리 후 폴더 구조: 이동 제안을 목적지 폴더별로 묶는다.
    var groups = {};
    items.forEach(function (i) { if (i.action === 'move' && i.destination) { var d = dirOf(i.destination); (groups[d] = groups[d] || []).push(i); } });
    var names = Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length || (a < b ? -1 : 1); });
    view.appendChild(card('정리하면 이렇게 모입니다', names.length ? names.map(function (d) {
      return el('details', { class: 'folder' }, el('summary', null, el('b', { text: d + '/' }), ' ', el('span', { class: 'muted', text: groups[d].length + '개' })),
        el('ul', null, groups[d].slice(0, 200).map(function (i) { return el('li', { text: i.source }); }), groups[d].length > 200 ? el('li', { class: 'muted', text: '… 외 ' + (groups[d].length - 200) + '개' }) : null));
    }) : empty('옮길 파일이 없습니다.')));

    var q = state.filter.toLowerCase();
    var shown = items.filter(function (i) {
      return (state.action === 'all' || i.action === state.action) && (!q || (i.source + ' ' + (i.destination || '') + ' ' + i.reason).toLowerCase().indexOf(q) >= 0);
    });
    var labels = { move: '이동 제안', keep: '유지', review: '검토 필요' };
    var search = el('input', { type: 'search', placeholder: '파일 이름·폴더·이유 검색', value: state.filter, 'aria-label': '파일 검색' });
    search.addEventListener('input', function () { state.filter = search.value; rerenderKeepFocus('fileSearch'); });
    search.id = 'fileSearch';
    var pick = el('select', { 'aria-label': '상태로 거르기' }, [['all', '전체'], ['move', '이동 제안'], ['keep', '유지'], ['review', '검토 필요']].map(function (o) {
      return el('option', { value: o[0], selected: state.action === o[0] }, o[1]);
    }));
    pick.addEventListener('change', function () { state.action = pick.value; render(); });
    view.appendChild(card('파일별 제안', el('div', { class: 'toolbar' }, search, pick),
      shown.length ? table(['상태', '지금 위치', '제안 위치', '이유'], shown.slice(0, LIMIT).map(function (i) {
        return el('tr', null, el('td', null, el('span', { class: 'badge ' + i.action, text: labels[i.action] })), el('td', { class: 'path', text: i.source }),
          el('td', { class: 'path', text: i.destination || '—' }), el('td', { class: 'small', text: i.reason }));
      })) : empty('조건에 맞는 파일이 없습니다.'),
      shown.length > LIMIT ? el('p', { class: 'muted small', text: shown.length + '개 중 ' + LIMIT + '개만 표시합니다. 검색으로 좁히세요.' }) : null));

    view.appendChild(card('중복 후보(내용이 같은 파일)', p.duplicates.length ? p.duplicates.map(function (g) {
      return el('div', null, el('h3', null, el('span', { class: 'mono', text: g.sha256.slice(0, 12) }), ' · 후보 ' + g.candidates.length + '개 · ' + bytes(g.logicalCandidateBytes)),
        el('p', { class: 'small' }, '남길 파일 제안: ', el('b', { text: g.suggestedKeep }), g.keepReason ? el('span', { class: 'muted', text: ' (' + g.keepReason + ')' }) : null),
        el('ul', { class: 'small' }, g.candidates.map(function (c) { return el('li', { class: 'path', text: c }); })));
    }) : empty('내용이 같은 파일이 없습니다.'), el('p', { class: 'muted small', text: '이름이 같아도 내용이 다르면 중복이 아니에요. 휴지통으로 보내려면 [정리 계획]에서 중복 후보를 넣어 계획을 만든 뒤 확인하고 실행해요.' })));

    if (p.skipped.length) view.appendChild(card('제외·오류 ' + p.skipped.length + '개', el('details', null, el('summary', { text: '목록 보기' }),
      table(['경로', '이유'], p.skipped.slice(0, LIMIT).map(function (s) { return el('tr', null, el('td', { class: 'path', text: s.relativePath || '(루트)' }), el('td', { class: 'small', text: s.reason })); })))));
  }

  /* ---------- 정리 계획 ---------- */
  var modeLabel = { organize: '이동', trash: '휴지통으로 이동', 'permanent-delete': '영구 삭제 — 되돌릴 수 없음' };
  var kindLabel = { move: '이동', trash: '휴지통', delete: '영구 삭제' };
  var modeKind = { organize: 'move', trash: 'trash', 'permanent-delete': 'delete' };
  function renderPlan(view) {
    var mode = el('select', { 'aria-label': '삭제 방식' }, el('option', { value: 'trash', selected: state.deleteMode === 'trash' }, '삭제는 휴지통으로(복원 가능)'),
      el('option', { value: 'permanent', selected: state.deleteMode === 'permanent' }, '삭제는 영구 삭제(되돌릴 수 없음)'));
    mode.addEventListener('change', function () { state.deleteMode = mode.value; render(); });
    var dup = el('input', { type: 'checkbox', checked: state.deleteDuplicates });
    dup.addEventListener('change', function () { state.deleteDuplicates = dup.checked; });
    view.appendChild(card('정리 계획 만들기', el('p', { class: 'small muted', text: '같은 폴더를 다시 분석해 계획을 앱 상태 폴더에 저장해요. 계획은 1시간 뒤 만료돼요. 만든 뒤 아래에서 목록을 확인하고 실행해요.' }),
      el('div', { class: 'toolbar' }, mode, el('label', { class: 'check' }, dup, '중복 후보도 삭제 계획에 넣기(남길 파일은 유지)')),
      state.deleteMode === 'permanent' ? el('p', { class: 'note danger', text: '영구 삭제는 휴지통을 거치지 않고 되돌릴 수 없어요. 이 화면에서는 실행하지 않고, 터미널에서 승인 코드와 확인 문구 "영구 삭제"를 모두 입력해야 해요.' }) : null,
      el('div', { class: 'actions' }, el('button', { class: 'primary run', type: 'button', onclick: makePlan, disabled: state.busy }, '계획 만들기'))));
    if (!state.plan) return;
    var plan = state.plan.plan, cli = cliOf();
    view.appendChild(el('div', { class: 'stats' }, stat(plan.summary.move, '이동'), stat(plan.summary.trash, '휴지통'), stat(plan.summary.delete, '영구 삭제'),
      stat(plan.reviewItems.length, '검토·유지(계획 밖)')));
    view.appendChild(el('p', { class: 'note' }, '계획 ID ', el('span', { class: 'mono', text: plan.id }), ' · 만료 ' + when(plan.expiresAt) + '. ' + profileText(state.plan.profile)));
    if (state.result && state.result.planId === plan.id) view.appendChild(applyResultCard(state.result));
    if (!state.plan.approvalChoices.length) view.appendChild(card('실행할 작업 없음', empty('이 계획에는 옮기거나 지울 파일이 없어요.')));
    state.plan.approvalChoices.forEach(function (c) {
      var ops = plan.operations.filter(function (op) { return op.kind === modeKind[c.mode]; });
      var size = ops.reduce(function (s, op) { return s + op.expected.size; }, 0);
      var danger = c.mode === 'permanent-delete';
      var line = cli + ' apply ' + plan.id + ' --mode ' + c.mode;
      var action;
      if (danger) action = [el('p', { class: 'note danger', text: '영구 삭제는 되돌릴 수 없어서 이 화면에서는 실행하지 않아요. 터미널에서 아래 명령을 실행하면 목록을 다시 보여 주고 승인 코드와 확인 문구 "영구 삭제"를 물어봐요.' }),
        el('p', null, '승인 코드 ', el('span', { class: 'code', text: c.code })), command(line)];
      else if (state.done[c.mode]) action = el('p', { class: 'note', text: '이 작업은 실행했어요(실행 ' + state.done[c.mode].slice(0, 8) + '). 같은 계획은 다시 실행할 수 없어요. 다시 정리하려면 [분석] 뒤 계획을 새로 만드세요.' });
      else if (state.confirm === c.mode) action = confirmApply(c, ops);
      else action = [el('div', { class: 'actions' }, el('button', { class: 'primary run', type: 'button', disabled: state.busy,
          onclick: function () { if (state.busy) return; state.confirm = c.mode; state.confirmChecked = false; render(); } }, c.mode === 'organize' ? '정리하기' : '중복 사본 휴지통으로 보내기')),
        el('p', { class: 'small muted', text: '누르면 실행할 목록을 한 번 더 보여 주고 확인을 받아요.' })];
      view.appendChild(card('[' + modeLabel[c.mode] + '] ' + ops.length + '개' + (c.mode === 'organize' ? '' : ' · 논리 크기 ' + bytes(size) + ' (확보량 아님)'),
        action, danger || state.done[c.mode] ? null : terminalHint(line, '승인 코드 ' + c.code + ' — 이 명령은 작업 목록을 다시 보여 주고 이 코드를 물어봐요.'),
        table(['작업', '파일', c.mode === 'organize' ? '옮길 위치' : '남길 파일', '이유'], ops.slice(0, LIMIT).map(function (op) {
          return el('tr', null, el('td', { class: 'mono', text: op.id.slice(0, 8) }), el('td', { class: 'path', text: op.source }),
            el('td', { class: 'path', text: op.kind === 'move' ? op.destination : (op.keeper || '직접 고른 파일') }), el('td', { class: 'small', text: op.reason }));
        })), ops.length > LIMIT ? el('p', { class: 'muted small', text: ops.length + '개 중 ' + LIMIT + '개만 표시합니다. 전체는 CLI plan 출력에서 봅니다.' }) : null));
    });
    var groups = {};
    plan.reviewItems.forEach(function (r) { var k = r.status + '|' + r.reason; (groups[k] = groups[k] || { status: r.status, reason: r.reason, items: [] }).items.push(r.source); });
    var keys = Object.keys(groups);
    view.appendChild(card('검토·유지 항목 ' + plan.reviewItems.length + '개 (계획에 넣지 않음)', keys.length ? keys.map(function (k) {
      var g = groups[k];
      return el('details', { class: 'folder' }, el('summary', null, el('span', { class: 'badge ' + g.status, text: g.status === 'keep' ? '유지' : '검토 필요' }), ' ' + g.items.length + '개 · ' + g.reason),
        el('ul', { class: 'small' }, g.items.slice(0, 200).map(function (s) { return el('li', { text: s }); })));
    }) : empty('없습니다.')));
  }

  function confirmApply(c, ops) {
    var organize = c.mode === 'organize';
    var go = el('button', { class: 'primary run', type: 'button', disabled: state.busy || (!organize && !state.confirmChecked),
      onclick: function () { runApply(c.mode, go); } }, organize ? '이대로 정리하기' : '휴지통으로 보내기');
    var check = null;
    if (!organize) {
      check = el('input', { type: 'checkbox', checked: state.confirmChecked });
      check.addEventListener('change', function () { state.confirmChecked = check.checked; go.disabled = state.busy || !check.checked; });
    }
    return el('div', { class: 'confirm' + (organize ? '' : ' danger'), role: 'group', 'aria-label': '실행 확인' },
      el('p', null, el('b', { text: organize ? '파일 ' + ops.length + '개를 아래처럼 옮길까요?' : '중복 사본 ' + ops.length + '개를 휴지통으로 보낼까요?' })),
      shortList(ops, function (op) { return organize ? op.source + ' → ' + op.destination : op.source + (op.keeper ? ' (남길 파일: ' + op.keeper + ')' : ''); }),
      el('p', { class: 'note' + (organize ? '' : ' danger'), text: organize
        ? '되돌릴 수 있어요([실행 기록]의 되돌리기 버튼). 실행 직전에 파일을 다시 확인하고, 그사이 바뀐 파일이나 이미 같은 이름이 있는 곳은 건너뛰어요(덮어쓰지 않아요).'
        : '휴지통에서 직접 꺼낼 수 있어요. 되돌리기 버튼으로는 안 돼요. 남길 파일은 그대로 두고, 실행 직전에 내용이 같은지 다시 확인해요.' }),
      check ? el('label', { class: 'check' }, check, '확인했어요: 위 사본을 휴지통으로 보내요') : null,
      el('div', { class: 'actions' }, go, el('button', { class: 'run', type: 'button', disabled: state.busy,
        onclick: function () { state.confirm = null; render(); } }, '취소')));
  }
  function runApply(mode, button) {
    if (state.busy || !state.plan) return;
    button.disabled = true;
    var planId = state.plan.plan.id;
    setBusy(true, (mode === 'organize' ? '정리하는 중' : '휴지통으로 보내는 중') + '… 끝날 때까지 기다려 주세요.');
    api('POST', '/api/apply', { planId: planId, mode: mode }).then(function (data) {
      state.done[mode] = data.runId; state.confirm = null; state.result = { planId: planId, mode: mode, data: data };
      setBusy(false, '실행 완료 · 실행 ID ' + data.runId.slice(0, 8)); render();
    }, function (e) { state.confirm = null; setBusy(false); setStatus(errText(e), true); render(); });
  }
  function tally(report) {
    var n = { moved: 0, trashed: 0, deleted: 0, skipped: 0, failed: 0, unknown: 0 };
    report.results.forEach(function (r) { n[r.status] = (n[r.status] || 0) + 1; });
    return n;
  }
  function applyResultCard(result) {
    var report = result.data.report, n = tally(report), ops = {};
    state.plan.plan.operations.forEach(function (op) { ops[op.id] = op; });
    var bad = report.results.filter(function (r) { return r.status !== 'moved' && r.status !== 'trashed'; });
    var organize = result.mode === 'organize';
    return el('section', { class: 'card result' + (bad.length ? ' partial' : '') }, el('h2', { text: organize ? '정리 결과' : '휴지통 보내기 결과' }),
      el('div', { class: 'stats' }, stat(organize ? n.moved : n.trashed, organize ? '옮김' : '휴지통으로 보냄'), stat(n.skipped, '건너뜀'), stat(n.failed, '실패'),
        n.unknown ? stat(n.unknown, '결과 확인 못 함') : null),
      bad.length ? [el('h3', { text: '옮기지 않은 파일과 이유' }), shortList(bad, function (r) {
        var op = ops[r.opId]; return (op ? op.source : r.opId.slice(0, 12)) + ' — ' + statusLabel[r.status] + (r.errorCode ? ' [' + r.errorCode + ']' : '') + ': ' + r.detail;
      })] : null,
      n.unknown ? el('p', { class: 'note danger', text: '결과를 확인하지 못한 파일이 있어요. 다시 실행하지 말고 [복구 점검]을 확인하세요.' }) : null,
      result.data.exitCode === 130 ? el('p', { class: 'note', text: '중간에 취소됐어요. 실행하지 않은 파일은 그대로예요.' }) : null,
      organize && n.moved ? el('div', { class: 'actions' }, el('button', { class: 'run', type: 'button', disabled: state.busy,
        onclick: function () { state.runConfirm = result.data.runId; select('runs'); } }, '되돌리기…')) : null,
      el('p', { class: 'small muted', text: organize ? '실행 ID ' + report.runId + ' · [실행 기록]에서 언제든 되돌릴 수 있어요.'
        : '실행 ID ' + report.runId + ' · 휴지통으로 보낸 파일은 Finder·Windows 휴지통에서 직접 꺼내요. ' + report.space.note }));
  }

  /* ---------- 개인 규칙 ---------- */
  function renderRules(view) {
    var box = card('개인 규칙', el('p', { class: 'muted', text: '불러오는 중…' }));
    view.appendChild(box);
    api('GET', '/api/rules').then(function (data) {
      box.replaceChildren(el('h2', { text: '개인 규칙' }));
      var cli = cliOf();
      if (data.state === 'none') {
        box.append(empty('저장된 개인 규칙이 없습니다. 미리보기는 기본 분류를 씁니다.'),
          el('p', { class: 'small', text: '기존에 정리해 둔 폴더를 참고해 규칙을 만들려면 터미널에서:' }),
          command(cli + ' suggest-rules <참고 폴더> > 초안.json'), command(cli + ' rules save 초안.json --select <규칙ID,...>'));
        return;
      }
      if (data.state === 'corrupt') { box.append(el('p', { class: 'note danger', text: '저장된 규칙 파일이 손상돼 적용하지 않습니다: ' + data.reason }), command(cli + ' rules reset')); return; }
      var p = data.profile;
      box.append(el('p', null, el('span', { class: 'badge ' + (p.status === 'confirmed' ? 'safe' : 'keep'), text: p.status === 'confirmed' ? '켜짐' : '꺼짐' }),
        ' revision ' + p.revision + ' · 참고 폴더 ' + (p.referenceRootLabel || '(없음)') + ' · 갱신 ' + when(p.updatedAt)),
        p.rules.length ? table(['상태', '규칙', '목적지', '근거'], p.rules.map(function (r) {
          return el('tr', null, el('td', null, el('span', { class: 'badge ' + (r.enabled ? 'safe' : 'keep'), text: r.enabled ? '켜짐' : '꺼짐' })),
            el('td', null, el('span', { class: 'mono', text: r.extension }), r.keyword ? ' + 이름에 "' + r.keyword + '"' : '', el('div', { class: 'muted small mono', text: r.id })),
            el('td', { class: 'path', text: r.targetDirectory }), el('td', { class: 'small path', text: (r.evidenceCount || r.evidence.length) + '개 · 예: ' + r.evidence.slice(0, 3).join(', ') }));
        })) : empty('규칙이 없습니다.'),
        el('h3', { text: '저장한 수정(이후에도 적용) ' + p.corrections.length + '개' }),
        p.corrections.length ? table(['ID', '조건', '목적지'], p.corrections.map(function (c) {
          return el('tr', null, el('td', { class: 'mono', text: c.id }), el('td', { class: 'path', text: c.match.type === 'file-name' ? '파일 이름 "' + c.match.name + '"' : c.match.extension + (c.match.keyword ? ' + 이름에 "' + c.match.keyword + '"' : '') }),
            el('td', { class: 'path', text: c.targetDirectory }));
        })) : null,
        el('p', { class: 'small muted', text: '켜기·끄기·초기화는 CLI에서 합니다: rules enable|disable <규칙ID>, rules enable-all|disable-all, rules forget <수정ID>, rules reset' }));
    }, function (e) { box.replaceChildren(el('h2', { text: '개인 규칙' }), el('p', { class: 'bad', text: errText(e) })); });
  }

  /* ---------- 실행 기록 ---------- */
  var statusLabel = { moved: '이동함', trashed: '휴지통으로 보냄', deleted: '영구 삭제함', skipped: '건너뜀', failed: '실패', unknown: '결과 불명', restored: '되돌림' };
  var runMode = { organize: '이동', trash: '휴지통', 'permanent-delete': '영구 삭제' };
  function renderRuns(view) {
    var box = card('실행 기록', el('p', { class: 'muted', text: '불러오는 중…' }));
    view.appendChild(box);
    if (state.lastUndo) view.insertBefore(undoResultCard(state.lastUndo), box);
    var detail = el('div');
    view.appendChild(detail);
    api('GET', '/api/runs').then(function (data) {
      box.replaceChildren(el('h2', { text: '실행 기록 ' + data.runs.length + '개' }));
      if (!data.runs.length) { box.append(empty('아직 실행한 기록이 없어요.')); return; }
      box.append(table(['시작', '방식', '결과', '되돌리기', ''], data.runs.slice().reverse().map(function (r) {
        if (r.error) return el('tr', null, el('td', { class: 'mono', text: r.runId }), el('td', { colspan: 4, class: 'bad', text: '읽을 수 없음: ' + r.error }));
        var res = r.results;
        return el('tr', { class: 'click', tabindex: 0, onclick: function () { showRun(r.runId, detail); }, onkeydown: function (ev) { if (ev.key === 'Enter' && ev.target === ev.currentTarget) showRun(r.runId, detail); } },
          el('td', { text: when(r.startedAt) }), el('td', { text: runMode[r.mode] || r.mode }),
          el('td', { text: res === null ? '끝나지 않음 — 복구 점검 확인' : '성공 ' + (res.moved + res.trashed + res.deleted) + ' · 건너뜀 ' + res.skipped + ' · 실패 ' + res.failed + ' · 불명 ' + res.unknown }),
          el('td', null, r.undos + '회 ', r.undoable ? el('button', { class: 'run', type: 'button', disabled: state.busy, onclick: function (ev) {
            ev.stopPropagation(); if (state.busy) return; state.runConfirm = r.runId; showRun(r.runId, detail);
          } }, '되돌리기') : null), el('td', { class: 'muted small', text: '자세히 ›' }));
      })));
      if (state.runConfirm) showRun(state.runConfirm, detail);
    }, function (e) { box.replaceChildren(el('h2', { text: '실행 기록' }), el('p', { class: 'bad', text: errText(e) })); });
  }
  function confirmUndo(run, candidates, name, target) {
    var go = el('button', { class: 'primary run', type: 'button', disabled: state.busy, onclick: function () { runUndo(run.runId, go, name); } }, '이대로 되돌리기');
    return el('div', { class: 'confirm', role: 'group', 'aria-label': '되돌리기 확인' },
      el('p', null, el('b', { text: when(run.startedAt) + '에 정리한 파일 ' + candidates.length + '개를 원래 자리로 되돌릴까요?' })),
      shortList(candidates, function (r) { return name(r.opId, true); }),
      el('p', { class: 'note', text: '원래 자리에 다른 파일이 있거나 정리한 뒤 바뀐 파일은 덮어쓰지 않고 건너뛰어요. 정리할 때 새로 만든 폴더는 비어 있으면 지워요.' }),
      run.report.results.some(function (r) { return r.status === 'unknown'; }) ? el('p', { class: 'small warn', text: '결과를 확인하지 못한 파일은 건드리지 않아요([복구 점검]에서 확인).' }) : null,
      el('div', { class: 'actions' }, go, el('button', { class: 'run', type: 'button', disabled: state.busy,
        onclick: function () { state.runConfirm = null; showRun(run.runId, target); } }, '취소')));
  }
  function runUndo(runId, button, name) {
    if (state.busy) return;
    button.disabled = true;
    setBusy(true, '되돌리는 중… 끝날 때까지 기다려 주세요.');
    api('POST', '/api/undo', { runId: runId }).then(function (data) {
      state.runConfirm = null; state.lastUndo = { runId: runId, data: data, name: name };
      setBusy(false, '되돌리기 완료'); render();
    }, function (e) { state.runConfirm = null; setBusy(false); setStatus(errText(e), true); render(); });
  }
  function undoResultCard(u) {
    var report = u.data.report;
    if (!report) return el('section', { class: 'card result' }, el('h2', { text: '되돌리기 결과' }), el('p', { text: u.data.message || '되돌릴 항목이 없었어요.' }));
    var back = report.results.filter(function (r) { return r.status === 'moved'; }).length;
    var rest = report.results.filter(function (r) { return r.status !== 'moved'; });
    var dirs = report.directories;
    return el('section', { class: 'card result' + (rest.length ? ' partial' : '') }, el('h2', { text: '되돌리기 결과 · 실행 ' + u.runId.slice(0, 8) }),
      el('div', { class: 'stats' }, stat(back, '원래 자리로 되돌림'), stat(rest.length, '되돌리지 않음')),
      rest.length ? [el('h3', { text: '되돌리지 않은 파일과 이유' }), shortList(rest, function (r) {
        return u.name(r.opId, true) + ' — ' + (r.status === 'unknown' ? '결과 확인 못 함' : '건너뜀') + (r.errorCode ? ' [' + r.errorCode + ']' : '') + ': ' + r.detail;
      })] : null,
      dirs && dirs.removed.length ? el('p', { class: 'small', text: '정리할 때 만든 빈 폴더 ' + dirs.removed.length + '개도 지웠어요.' }) : null,
      dirs && dirs.kept.length ? shortList(dirs.kept, function (k) { return '그대로 둔 폴더 ' + k.path + ' — ' + k.reason; }) : null);
  }
  function showRun(runId, target) {
    target.replaceChildren(card('실행 ' + runId, el('p', { class: 'muted', text: '불러오는 중…' })));
    api('GET', '/api/runs/' + encodeURIComponent(runId)).then(function (data) {
      var run = data.run, ops = {};
      (data.operations || []).forEach(function (op) { ops[op.id] = op; });
      var cli = cliOf();
      var name = function (id, reverse) {
        var op = ops[id];
        if (!op) return id.slice(0, 12) + '… (계획 파일이 없어 이름을 표시하지 못함)';
        return op.destination ? (reverse ? op.destination + ' → ' + op.source : op.source + ' → ' + op.destination) : op.source;
      };
      var c = card('실행 ' + runId.slice(0, 8) + ' · ' + (runMode[run.mode] || run.mode),
        el('p', { class: 'small muted', text: '시작 ' + when(run.startedAt) + ' · 끝 ' + (run.finishedAt ? when(run.finishedAt) : '기록 없음') + ' · 계획 ' + run.planId.slice(0, 12) + '…' }));
      if (run.report === null) c.append(el('p', { class: 'note danger', text: '결과 기록이 없습니다(중단된 실행일 수 있음). 다시 실행하지 말고 [복구 점검]을 확인하세요.' }));
      else {
        c.append(table(['결과', '파일', '오류', '설명'], run.report.results.map(function (x) {
          return el('tr', null, el('td', null, el('span', { class: 'badge ' + (x.status === 'failed' || x.status === 'unknown' ? 'bad' : x.status === 'skipped' ? 'review' : 'safe'), text: statusLabel[x.status] || x.status })),
            el('td', { class: 'path', text: name(x.opId) }), el('td', { class: 'mono', text: x.errorCode || '' }), el('td', { class: 'small', text: x.detail }));
        })), el('p', { class: 'small muted', text: run.report.space.note }));
        if (run.mode === 'organize') {
          var undone = {};
          data.undos.forEach(function (u) { u.report.results.forEach(function (x) { if (x.status === 'moved') undone[x.opId] = true; }); });
          var candidates = run.report.results.filter(function (x) { return x.status === 'moved' && !undone[x.opId]; });
          if (!candidates.length) c.append(el('p', { class: 'small muted', text: '되돌릴 이동 항목이 없어요' + (Object.keys(undone).length ? '(이미 되돌렸어요).' : '.') }));
          else if (state.runConfirm === runId) c.append(confirmUndo(run, candidates, name, target));
          else c.append(el('div', { class: 'actions' }, el('button', { class: 'run', type: 'button', disabled: state.busy,
            onclick: function () { if (state.busy) return; state.runConfirm = runId; showRun(runId, target); } }, '되돌리기…')));
          if (candidates.length) c.append(terminalHint(cli + ' undo ' + runId, '확인 코드는 실행 ID 앞 8자(' + runId.slice(0, 8) + ')예요.'));
        }
        else if (run.mode === 'trash') c.append(el('p', { class: 'small muted', text: '휴지통으로 보낸 파일은 Finder·Windows 휴지통에서 직접 꺼내요. 되돌리기 버튼으로는 안 돼요.' }));
        else c.append(el('p', { class: 'small bad', text: '영구 삭제는 되돌릴 수 없습니다.' }));
      }
      data.undos.forEach(function (u) {
        c.append(el('h3', { text: '되돌리기 ' + u.undoIndex + '회차 · ' + when(u.finishedAt) }),
          u.report.results.length ? table(['결과', '파일', '오류'], u.report.results.map(function (x) {
            return el('tr', null, el('td', { text: statusLabel[x.status] || x.status }), el('td', { class: 'path', text: name(x.opId) }), el('td', { class: 'mono', text: x.errorCode || '' }));
          })) : el('p', { class: 'muted small', text: '되돌릴 항목이 없었습니다.' }));
      });
      target.replaceChildren(c);
      c.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, function (e) { target.replaceChildren(card('실행 ' + runId, el('p', { class: 'bad', text: errText(e) }))); });
  }

  /* ---------- 복구 점검 ---------- */
  function renderRecover(view) {
    var box = card('복구 점검', el('p', { class: 'muted', text: '확인 중…' }));
    view.appendChild(box);
    var label = { active: '진행 중', unfinished: '끝나지 않음', corrupt: '저널 손상', unreadable: '읽을 수 없음' };
    api('GET', '/api/recover').then(function (data) {
      box.replaceChildren(el('h2', { text: '복구 점검' }), el('p', { class: 'small muted', text: '보고만 합니다. 자동으로 다시 실행·원복·삭제하지 않습니다. 저널 ' + data.checked + '개 확인.' }));
      if (!data.runs.length) { box.append(empty('끝나지 않은 실행이 없습니다.')); return; }
      data.runs.forEach(function (r) {
        box.append(el('h3', null, el('span', { class: 'badge ' + (r.status === 'active' ? 'review' : 'bad'), text: label[r.status] || r.status }), ' 실행 ', el('span', { class: 'mono', text: r.runId }), ' · 끝난 작업 ' + r.finished + '개'),
          r.problem ? el('p', { class: 'small bad', text: r.problem }) : null,
          r.unfinished.length ? table(['작업', '파일', '관측 상태', '할 일'], r.unfinished.map(function (u) {
            return el('tr', null, el('td', { text: (kindLabel[u.kind] || u.kind) + (u.phase === 'undo-intent' ? '(되돌리기)' : '') }),
              el('td', { class: 'path', text: u.source + (u.destination ? ' → ' + u.destination : '') }), el('td', { class: 'small', text: u.state + (u.detail ? ' (' + u.detail + ')' : '') }),
              el('td', { class: 'small', text: u.action }));
          })) : null);
      });
    }, function (e) { box.replaceChildren(el('h2', { text: '복구 점검' }), el('p', { class: 'bad', text: errText(e) })); });
  }

  /* ---------- 공통 ---------- */
  function render() {
    var view = $('view');
    view.replaceChildren();
    if (!token) { view.appendChild(card('주소를 확인하세요', el('p', { class: 'bad', text: '터미널에 나온 주소(#token=… 포함)로 열어야 합니다. afo gui를 다시 실행하면 새 주소가 나옵니다.' }))); return; }
    ({ preview: renderPreview, plan: renderPlan, rules: renderRules, runs: renderRuns, recover: renderRecover })[state.tab](view);
  }
  function rerenderKeepFocus(id) {
    var pos = document.activeElement && document.activeElement.id === id ? document.activeElement.selectionStart : null;
    render();
    var again = $(id);
    if (again && pos !== null) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* search inputs */ } }
  }
  function select(tab) {
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('[role=tab]'), function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === tab)); });
    render();
  }

  /* ---------- 화면이 열려 있음을 알리기(--exit-when-closed) ---------- */
  function ping() { api('POST', '/api/ping', {}).catch(function () { /* the presence stream reports a lost server */ }); }
  function keepAlive() {
    setInterval(ping, 10000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) ping(); });
    presence(0);
  }
  /* An open request survives background-tab timer throttling; it ends when the tab closes or the server stops. */
  function presence(tries) {
    var lost = function () {
      if (tries < 2) setTimeout(function () { presence(tries + 1); }, 2000);
      else setStatus('AFO 화면 서버가 끝났어요. 다시 쓰려면 afo gui를 다시 실행하거나 Finder에서 다시 여세요.', true);
    };
    fetch('/api/presence', { headers: { 'x-afo-token': token }, cache: 'no-store' }).then(function (r) {
      if (!r.ok || !r.body) throw new Error('presence');
      tries = 0;
      var reader = r.body.getReader();
      var pump = function () { return reader.read().then(function (x) { if (!x.done) return pump(); }); };
      return pump();
    }).then(lost, lost);
  }

  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.forEach.call(document.querySelectorAll('[role=tab]'), function (b) { b.addEventListener('click', function () { select(b.getAttribute('data-tab')); }); });
    $('analyze').addEventListener('click', analyze);
    $('folder').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') analyze(); });
    render();
    if (!token) return;
    api('GET', '/api/info').then(function (info) {
      state.info = info;
      $('foot').textContent = '상태 폴더: ' + info.stateDir + ' · 정리·휴지통 보내기·되돌리기는 목록을 확인한 뒤에만 실행해요. 영구 삭제는 터미널에서만 해요.' +
        (info.exitWhenClosed ? ' 이 창을 닫으면 잠시 뒤 AFO도 저절로 끝나요.' : '');
      keepAlive();
      if (info.initialFolder) { $('folder').value = info.initialFolder; analyze(); }
      else $('folder').focus();
    }, function (e) { setStatus(errText(e), true); });
  });
})();`;
