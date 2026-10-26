// AFO read-only screen. Plain ES module, no build step. All file names and paths are inserted with textContent only.
import { analysisRequest, applySelection, canAnalyze, confirmRules as withRules, initialState, keepReasonForScreen, releaseRules,
  ruleText } from './state.js';

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

let selection = initialState();
// pending: what the folder steps are waiting for ('pick' = OS dialog open, 'path' = checking a typed path).
const ui = { jobId: null, polling: null, pending: null };

function clearResults() {
  if (ui.polling) { clearTimeout(ui.polling); ui.polling = null; }
  ui.jobId = null;
  $('step-preview').hidden = true; $('step-rules').hidden = true;
  $('rule-list').replaceChildren(); setStatus('rules-status', '');
  $('progress').value = 0;
}
function refreshButtons() {
  const running = ui.polling !== null;
  const blocked = running || ui.pending !== null;
  // Folder controls stay focusable and announce why they are unavailable (aria-disabled + status text) instead of
  // silently ignoring Enter/clicks; the handlers check `blocked` themselves.
  for (const button of document.querySelectorAll('button.choose')) button.setAttribute('aria-disabled', String(blocked));
  for (const id of ['step-work', 'step-ref']) $(id).setAttribute('aria-busy', String(ui.pending !== null));
  $('analyze').disabled = blocked || !canAnalyze(selection);
  $('cancel').disabled = !running;
  const checked = $('rule-list').querySelectorAll('input[type=checkbox]:checked').length;
  $('rules-confirm').disabled = blocked || ui.jobId === null || checked === 0;
  $('rules-reanalyze').disabled = blocked || selection.profileId === null || !canAnalyze(selection);
  $('rules-release').disabled = blocked || selection.profileId === null;
}
function blockedReason() {
  if (ui.polling !== null) return '분석이 진행 중입니다. 끝나거나 취소한 뒤 폴더를 바꿀 수 있습니다.';
  if (ui.pending === 'pick') return '폴더 선택 대화상자가 열려 있습니다(다른 창 뒤에 있을 수 있음). 대화상자에서 고르거나 취소한 뒤 다시 시도하세요.';
  return '이전 요청을 처리하는 중입니다. 끝난 뒤 다시 시도하세요.';
}
const isBlocked = () => ui.polling !== null || ui.pending !== null;

function showSelection(kind, result) {
  selection = result.state;
  setStatus(kind === 'work' ? 'work-status' : 'ref-status', result.message, result.error);
  setStatus('analyze-status', canAnalyze(selection) ? '분석할 준비가 되었습니다.' : '작업 폴더를 선택하면 분석할 수 있습니다.');
}
async function choose(kind, how) {
  const prefix = kind === 'work' ? 'work' : 'ref';
  const statusId = `${prefix}-status`;
  if (isBlocked()) { setStatus(statusId, blockedReason(), true); return; }
  const typed = $(`${prefix}-path`).value.trim();
  if (how === 'path' && typed === '') { setStatus(statusId, '경로를 입력한 뒤 "이 경로 사용"을 누르세요(Enter도 됩니다).', true); return; }
  ui.pending = how; refreshButtons();
  setStatus(statusId, how === 'pick' ? '폴더 선택 대화상자를 열었습니다. 대화상자에서 폴더를 고르세요(다른 창 뒤에 있을 수 있음)…' : '경로를 확인하는 중…');
  let outcome;
  try {
    const data = how === 'pick' ? await api('pick-folder', { kind }) : await api('select-folder', { kind, path: typed });
    outcome = data.selected === null ? { type: 'cancelled' } : { type: 'selected', grantId: data.selected.grantId, path: data.selected.path };
  } catch (error) {
    outcome = { type: 'refused', code: error instanceof ApiError ? error.code : 'UNKNOWN', message: error instanceof ApiError ? error.message : '요청이 실패했습니다.' };
  } finally { ui.pending = null; }
  const result = applySelection(selection, kind, outcome);
  if (result.state !== selection) clearResults();
  showSelection(kind, result);
  refreshButtons();
}
function skipReference() {
  if (isBlocked()) { setStatus('ref-status', blockedReason(), true); return; }
  clearResults();
  showSelection('reference', applySelection(selection, 'reference', { type: 'skipped' }));
  refreshButtons();
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

async function startAnalysis() {
  if (!canAnalyze(selection) || isBlocked()) return;
  clearResults();
  try {
    const { jobId } = await api('analyze', analysisRequest(selection));
    ui.jobId = jobId;
    showProgress(null);
    if (selection.profileId) setStatus('analyze-status', `분석을 시작했습니다. 확인한 규칙 ${selection.appliedRuleIds.length}개를 계속 적용합니다(폴더를 바꾸면 해제).`);
    ui.polling = setTimeout(poll, 150);
  } catch (error) {
    setStatus('analyze-status', `분석을 시작하지 못했습니다: ${errorText(error)}`, true);
    if (error instanceof ApiError && (error.code === 'UNKNOWN_PROFILE' || error.code === 'PROFILE_CHANGED')) {
      selection = releaseRules(selection);
      setStatus('rules-status', '확인한 규칙을 더 쓸 수 없어 해제했습니다. 다시 분석한 뒤 규칙을 확인하세요.', true);
    }
  }
  refreshButtons();
}
async function poll() {
  let status;
  try { status = await api('job', { jobId: ui.jobId }); }
  catch (error) { ui.polling = null; setStatus('analyze-status', `진행 상황을 읽지 못했습니다: ${errorText(error)}`, true); refreshButtons(); return; }
  if (status.state === 'running') { showProgress(status.progress); ui.polling = setTimeout(poll, 250); return; }
  ui.polling = null;
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
  if (!ui.jobId) return;
  try { await api('cancel', { jobId: ui.jobId }); setStatus('analyze-status', '취소를 요청했습니다…'); }
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
    `제외·오류 ${preview.skipped.length}개`,
    preview.profileRevision ? `확인한 규칙 ${result.appliedRuleIds.length}개 적용(버전 ${preview.profileRevision})` : '기본 규칙만 적용'];
  $('preview-summary').textContent = parts.join(' · ');
  setStatus('analyze-status', '분석을 마쳤습니다. 파일은 바뀌지 않았습니다.');
  fillList('list-move', 's-move', '이동 제안', byAction.move, itemNode);
  fillList('list-keep', 's-keep', '유지', byAction.keep, itemNode);
  fillList('list-review', 's-review', '검토 필요', byAction.review, itemNode);
  fillList('list-dup', 's-dup', '중복 후보', preview.duplicates, (group) => {
    const li = el('li');
    li.append(el('div', `남길 파일 제안: ${group.suggestedKeep}`, 'path'));
    li.append(el('div', keepReasonForScreen(group.keepReason), 'reason'));
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
  renderRules(suggestedProfile, result.appliedRuleIds);
}

function renderRules(profile, appliedRuleIds) {
  const list = $('rule-list');
  list.replaceChildren();
  if (!profile) { $('step-rules').hidden = true; return; }
  $('step-rules').hidden = false;
  if (profile.rules.length === 0) {
    list.append(el('li', '참고 폴더에서 규칙 후보를 찾지 못했습니다(같은 폴더에 같은 확장자 파일이 2개 이상 있어야 합니다).', 'empty'));
  }
  profile.rules.forEach((rule, index) => {
    const li = el('li');
    const evidenceId = `rule-evidence-${index}`;
    // The checkbox sits inside its label, and also gets an explicit name, so it is announced as the rule, not its ID.
    const label = el('label', null, 'rule');
    const box = el('input'); box.type = 'checkbox'; box.value = rule.id; box.checked = appliedRuleIds.includes(rule.id);
    box.setAttribute('aria-label', ruleText(rule));
    box.setAttribute('aria-describedby', evidenceId);
    box.addEventListener('change', refreshButtons);
    label.append(box, el('span', ruleText(rule), 'path'));
    const evidence = el('div', null, 'reason');
    evidence.id = evidenceId;
    evidence.append(el('span', `근거: 참고 폴더의 파일 ${rule.evidence.length}개 — `));
    rule.evidence.forEach((file, i) => { if (i > 0) evidence.append(el('span', ', ')); evidence.append(el('span', file, 'path')); });
    li.append(label, evidence);
    list.append(li);
  });
  setStatus('rules-status', appliedRuleIds.length
    ? `확인한 규칙 ${appliedRuleIds.length}개를 적용한 미리보기입니다. 같은 폴더로 다시 분석해도 계속 적용되며, 폴더를 바꾸거나 "확인한 규칙 해제"를 누르면 해제됩니다. 저장은 후속 작업입니다.`
    : '규칙을 체크하고 "선택한 규칙 확인"을 누르세요. 규칙 저장은 후속 작업입니다.');
}

async function confirmRules() {
  const ruleIds = [...$('rule-list').querySelectorAll('input[type=checkbox]:checked')].map((box) => box.value);
  ui.pending = 'path'; refreshButtons();
  try {
    const data = await api('confirm-rules', { jobId: ui.jobId, ruleIds });
    selection = withRules(selection, data.profileId, data.profile.rules.map((r) => r.id));
    setStatus('rules-status', `규칙 ${data.profile.rules.length}개를 확인했습니다(이번 실행에서만 사용, 저장은 후속). "확인된 규칙으로 다시 미리보기"를 누르세요. 같은 폴더로 다시 분석할 때도 계속 적용됩니다.`);
  } catch (error) {
    setStatus('rules-status', `규칙을 확인하지 못했습니다: ${errorText(error)}`, true);
  } finally { ui.pending = null; refreshButtons(); }
}
function releaseConfirmedRules() {
  selection = releaseRules(selection);
  setStatus('rules-status', '확인한 규칙을 해제했습니다. 다음 분석은 기본 규칙만 적용합니다.');
  refreshButtons();
}

function init() {
  if (!token) showFatal('화면 토큰이 없습니다. 터미널에 표시된 주소(#t=…)로 다시 여세요.');
  $('work-pick').addEventListener('click', () => choose('work', 'pick'));
  $('ref-pick').addEventListener('click', () => choose('reference', 'pick'));
  $('ref-skip').addEventListener('click', skipReference);
  // Enter in a path field submits its form (implicit submission); the submit is handled here, never sent as a form.
  $('work-form').addEventListener('submit', (event) => { event.preventDefault(); choose('work', 'path'); });
  $('ref-form').addEventListener('submit', (event) => { event.preventDefault(); choose('reference', 'path'); });
  $('analyze').addEventListener('click', startAnalysis);
  $('cancel').addEventListener('click', cancelAnalysis);
  $('rules-confirm').addEventListener('click', confirmRules);
  $('rules-reanalyze').addEventListener('click', startAnalysis);
  $('rules-release').addEventListener('click', releaseConfirmedRules);
  refreshButtons();
}
init();
