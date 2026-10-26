// AFO read-only screen. Plain ES module, no build step. All file names and paths are inserted with textContent only.
const TOKEN_KEY = 'afo-token';
const LIST_LIMIT = 500;
const $ = (id) => document.getElementById(id);

function readToken() {
  const match = /^#t=([A-Za-z0-9_-]{20,256})$/u.exec(location.hash);
  try {
    if (match) sessionStorage.setItem(TOKEN_KEY, match[1]);
  } catch { /* storage blocked: keep the token in memory for this page only */ }
  let token = match ? match[1] : null;
  try { token = sessionStorage.getItem(TOKEN_KEY) ?? token; } catch { /* ignore */ }
  // Remove the token from the address bar and history entry.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return token;
}
const token = readToken();

class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
async function api(channel, payload) {
  let response;
  try {
    response = await fetch(`/api/${channel}`, { method: 'POST', cache: 'no-store', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'X-AFO-Token': token ?? '' }, body: JSON.stringify(payload) });
  } catch { throw new ApiError('OFFLINE', 'AFO 서버에 연결할 수 없습니다. 터미널에서 서버가 실행 중인지 확인하세요.'); }
  let body;
  try { body = await response.json(); } catch { throw new ApiError('INVALID_RESPONSE', '서버 응답을 읽지 못했습니다.'); }
  if (!body || body.ok !== true) {
    const error = body && body.error ? body.error : { code: 'UNKNOWN', message: '요청이 실패했습니다.' };
    if (error.code === 'UNAUTHORIZED') showFatal(error.message);
    throw new ApiError(error.code, error.message);
  }
  return body.data;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function setStatus(id, text, isError = false) {
  const node = $(id);
  node.textContent = text;
  node.classList.toggle('error', isError);
}
function showFatal(message) { const node = $('fatal'); node.textContent = message; node.hidden = false; }
const errorText = (error) => error instanceof ApiError ? `${error.message} (${error.code})` : '요청이 실패했습니다.';

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const short = unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
  return unit === 0 ? short : `${short} (${bytes.toLocaleString('ko-KR')} B)`;
}

const state = { workGrantId: null, referenceGrantId: null, jobId: null, profileId: null, polling: null, busy: false };

function resetResults() {
  if (state.polling) { clearTimeout(state.polling); state.polling = null; }
  state.jobId = null; state.profileId = null;
  $('step-preview').hidden = true; $('step-rules').hidden = true;
  $('rule-list').replaceChildren(); setStatus('rules-status', '');
  $('progress').value = 0;
  refreshButtons();
}
function refreshButtons() {
  const running = state.polling !== null;
  for (const id of ['work-pick', 'work-use', 'ref-pick', 'ref-use', 'ref-skip']) $(id).disabled = running || state.busy;
  $('analyze').disabled = running || state.busy || state.workGrantId === null;
  $('cancel').disabled = !running;
  const checked = $('rule-list').querySelectorAll('input[type=checkbox]:checked').length;
  $('rules-confirm').disabled = running || state.busy || state.jobId === null || checked === 0;
  $('rules-reanalyze').disabled = running || state.busy || state.profileId === null;
}

async function choose(kind, how) {
  const prefix = kind === 'work' ? 'work' : 'ref';
  const statusId = `${prefix}-status`;
  state.busy = true; refreshButtons();
  setStatus(statusId, how === 'pick' ? '폴더 선택 대화상자를 열었습니다. 대화상자에서 폴더를 고르세요…' : '경로를 확인하는 중…');
  try {
    const data = how === 'pick' ? await api('pick-folder', { kind })
      : await api('select-folder', { kind, path: $(`${prefix}-path`).value.trim() });
    if (data.selected === null) { setStatus(statusId, '선택을 취소했습니다. 이전 선택은 그대로입니다.'); return; }
    resetResults();
    if (kind === 'work') state.workGrantId = data.selected.grantId; else state.referenceGrantId = data.selected.grantId;
    setStatus(statusId, `${kind === 'work' ? '작업 폴더' : '참고 폴더(읽기 전용)'}: ${data.selected.path}`);
    setStatus('analyze-status', '분석할 준비가 되었습니다.');
  } catch (error) {
    setStatus(statusId, `선택하지 못했습니다: ${errorText(error)}`, true);
  } finally { state.busy = false; refreshButtons(); }
}
function skipReference() {
  resetResults();
  state.referenceGrantId = null;
  setStatus('ref-status', '참고 폴더 없음(건너뜀).');
}

function describeProgress(p) {
  if (!p) return '분석을 시작했습니다…';
  if (p.phase === 'hash') return `중복 확인(내용 해시): 파일 ${p.hashedFiles}/${p.hashTargets}개, ${formatBytes(p.bytesHashed)} / ${formatBytes(p.bytesToHash)}`;
  return `${p.phase === 'reference' ? '참고 폴더' : '작업 폴더'} 읽는 중: 폴더 ${p.directories}개, 파일 ${p.files}개, 제외 ${p.skipped}개`;
}
function showProgress(p) {
  const bar = $('progress');
  if (p && p.phase === 'hash' && p.bytesToHash > 0) bar.value = Math.min(1, p.bytesHashed / p.bytesToHash);
  else bar.removeAttribute('value'); // indeterminate while walking folders
  setStatus('analyze-status', describeProgress(p));
}

async function startAnalysis(profileId) {
  resetResultsKeepProfile(profileId);
  try {
    const { jobId } = await api('analyze', { rootGrantId: state.workGrantId, referenceGrantId: state.referenceGrantId, profileId });
    state.jobId = jobId;
    showProgress(null);
    state.polling = setTimeout(poll, 150);
  } catch (error) {
    setStatus('analyze-status', `분석을 시작하지 못했습니다: ${errorText(error)}`, true);
  }
  refreshButtons();
}
function resetResultsKeepProfile(profileId) {
  const keep = profileId; resetResults(); state.profileId = keep;
}
async function poll() {
  let status;
  try { status = await api('job', { jobId: state.jobId }); }
  catch (error) { state.polling = null; setStatus('analyze-status', `진행 상황을 읽지 못했습니다: ${errorText(error)}`, true); refreshButtons(); return; }
  if (status.state === 'running') { showProgress(status.progress); state.polling = setTimeout(poll, 250); return; }
  state.polling = null;
  const bar = $('progress');
  if (status.state === 'done') {
    bar.value = 1;
    render(status.result);
  } else if (status.state === 'cancelled') {
    bar.value = 0;
    setStatus('analyze-status', '분석을 취소했습니다. 결과는 표시하지 않습니다.');
  } else {
    bar.value = 0;
    setStatus('analyze-status', `분석하지 못했습니다: ${status.error ? `${status.error.message} (${status.error.code})` : '알 수 없는 오류'}`, true);
  }
  refreshButtons();
}
async function cancelAnalysis() {
  if (!state.jobId) return;
  try { await api('cancel', { jobId: state.jobId }); setStatus('analyze-status', '취소를 요청했습니다…'); }
  catch (error) { setStatus('analyze-status', `취소하지 못했습니다: ${errorText(error)}`, true); }
}

function fillList(listId, summaryId, label, entries, renderEntry) {
  const list = $(listId);
  list.replaceChildren();
  $(summaryId).textContent = `${label} (${entries.length}개)`;
  if (entries.length === 0) { list.append(el('li', '없음', 'empty')); return; }
  for (const entry of entries.slice(0, LIST_LIMIT)) list.append(renderEntry(entry));
  if (entries.length > LIST_LIMIT) list.append(el('li', `… 외 ${entries.length - LIST_LIMIT}개 (목록이 길어 생략)`, 'empty'));
}
function itemNode(item) {
  const li = el('li');
  const line = el('div', null, 'path');
  line.append(el('span', item.source));
  if (item.destination) { line.append(el('span', ' → ', 'arrow')); line.append(el('span', item.destination)); }
  li.append(line, el('div', item.reason, 'reason'));
  return li;
}

function render(result) {
  const { preview, suggestedProfile } = result;
  const byAction = { move: [], keep: [], review: [] };
  for (const item of preview.items) byAction[item.action].push(item);
  $('step-preview').hidden = false;
  const parts = [`파일 ${preview.items.length}개 분석`, `스캔 ${preview.scanComplete ? '완료' : '일부 미완료'}`,
    `제외·오류 ${preview.skipped.length}개`, preview.profileRevision ? `확인된 규칙 적용(버전 ${preview.profileRevision})` : '기본 규칙만 적용'];
  $('preview-summary').textContent = parts.join(' · ');
  setStatus('analyze-status', '분석을 마쳤습니다. 파일은 바뀌지 않았습니다.');
  fillList('list-move', 's-move', '이동 제안', byAction.move, itemNode);
  fillList('list-keep', 's-keep', '유지', byAction.keep, itemNode);
  fillList('list-review', 's-review', '검토 필요', byAction.review, itemNode);
  fillList('list-dup', 's-dup', '중복 후보', preview.duplicates, (group) => {
    const li = el('li');
    li.append(el('div', `남길 파일 제안: ${group.suggestedKeep}`, 'path'));
    if (group.keepReason) li.append(el('div', group.keepReason, 'reason'));
    const sub = el('ul');
    for (const candidate of group.candidates) sub.append(el('li', candidate, 'path'));
    li.append(el('div', `확인할 같은 내용 파일 ${group.candidates.length}개:`, 'reason'), sub);
    li.append(el('div', `논리 크기 ${formatBytes(group.logicalCandidateBytes)} — 확보량 아님`, 'reason'));
    return li;
  });
  fillList('list-large', 's-large', '큰 파일', preview.largeFiles, (file) => el('li', file, 'path'));
  fillList('list-skip', 's-skip', '제외·오류', preview.skipped, (entry) => {
    const li = el('li');
    li.append(el('div', entry.relativePath, 'path'), el('div', `${entry.reason}${entry.code ? ` (${entry.code})` : ''}`, 'reason'));
    return li;
  });
  renderRules(suggestedProfile, result.profileId);
}

function renderRules(profile, appliedProfileId) {
  const list = $('rule-list');
  list.replaceChildren();
  if (!profile) { $('step-rules').hidden = true; return; }
  $('step-rules').hidden = false;
  if (profile.rules.length === 0) {
    list.append(el('li', '참고 폴더에서 규칙 후보를 찾지 못했습니다(같은 폴더에 같은 확장자 파일이 2개 이상 있어야 합니다).', 'empty'));
  }
  for (const rule of profile.rules) {
    const li = el('li');
    const id = `rule-${rule.id}`;
    const box = el('input'); box.type = 'checkbox'; box.id = id; box.value = rule.id;
    box.addEventListener('change', refreshButtons);
    const label = el('label'); label.htmlFor = id;
    label.append(el('span', `${rule.extension} 파일${rule.keyword ? `(이름에 "${rule.keyword}" 포함)` : ''} → `),
      el('span', rule.targetDirectory, 'path'));
    const evidence = el('ul', null, 'evidence');
    for (const file of rule.evidence) evidence.append(el('li', file, 'path'));
    li.append(box, label, el('div', `근거: 참고 폴더의 파일 ${rule.evidence.length}개`, 'reason'), evidence);
    list.append(li);
  }
  setStatus('rules-status', appliedProfileId ? '확인된 규칙으로 만든 미리보기입니다. 규칙 저장은 후속 작업입니다.' :
    '규칙을 체크하고 "선택한 규칙 확인"을 누르세요. 규칙 저장은 후속 작업입니다.');
}

async function confirmRules() {
  const ruleIds = [...$('rule-list').querySelectorAll('input[type=checkbox]:checked')].map((box) => box.value);
  state.busy = true; refreshButtons();
  try {
    const data = await api('confirm-rules', { jobId: state.jobId, ruleIds });
    state.profileId = data.profileId;
    setStatus('rules-status', `규칙 ${data.profile.rules.length}개를 확인했습니다(이번 실행에서만 사용, 저장은 후속). "확인된 규칙으로 다시 미리보기"를 누르세요.`);
  } catch (error) {
    setStatus('rules-status', `규칙을 확인하지 못했습니다: ${errorText(error)}`, true);
  } finally { state.busy = false; refreshButtons(); }
}

function init() {
  if (!token) showFatal('화면 토큰이 없습니다. 터미널에 표시된 주소(#t=…)로 다시 여세요.');
  $('work-pick').addEventListener('click', () => choose('work', 'pick'));
  $('work-use').addEventListener('click', () => choose('work', 'path'));
  $('ref-pick').addEventListener('click', () => choose('reference', 'pick'));
  $('ref-use').addEventListener('click', () => choose('reference', 'path'));
  $('ref-skip').addEventListener('click', skipReference);
  for (const [input, button] of [['work-path', 'work-use'], ['ref-path', 'ref-use']])
    $(input).addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $(button).click(); } });
  $('analyze').addEventListener('click', () => startAnalysis(null));
  $('cancel').addEventListener('click', cancelAnalysis);
  $('rules-confirm').addEventListener('click', confirmRules);
  $('rules-reanalyze').addEventListener('click', () => startAnalysis(state.profileId));
  refreshButtons();
}
init();
