#!/usr/bin/env node
// AFO 과업 상태 관리 CLI. 상태 파일을 손으로 고치지 말고 이 명령을 쓴다.
//
//   status [--brief]                       현재 과업·다음 후보·사람 작업·위반 요약
//   next                                   다음에 할 과업(에이전트 과업 우선, 막고 있는 사람 작업 표시)
//   show <ID>                              과업 상세(JSON)
//   start <ID> [--force] [--sync]          과업 시작: current-task.json(작업 패킷) 작성, 기준 SHA 기록, 브랜치 이름 제안
//   review <ID>                            검토 차수 증가, 보고서 경로 출력
//   result <ID> pass|fail [--note "…"]     검토 결과 기록. fail 3회면 자동 blocked
//   done <ID> --summary "…" --tests "…" [--commit SHA] [--review 경로] [--by user] [--external-pending] [--sync]
//   block <ID> --reason "…"  /  unblock <ID>
//   set <ID> --issue N | --branch 이름 | --note "…"
//   add --json '{"id":"…","title":"…",…}'  새 과업 추가(사용자 지시 과업)
//   violations                             범위 밖 변경·검사 미해결 기록
//   render                                 STATUS.md 다시 만들기
//
// 상태의 정본은 GitHub Issue다(HARNESS.md). 이 파일들은 과업(작업 패킷) 단위 진행과 세션 재개를 위한 기록이며,
// --sync를 주면 start/done 때 연결된 Issue에 REST API로 코멘트를 남긴다(gh 필요, 실패해도 상태 기록은 유지).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { P, readJson, writeJson, appendLine, projectDir, abs, nowIso } from './lib/core.mjs';

const root = projectDir();
const TIER_RANK = { MVD: 0, MVP: 1, '권장': 2, '하네스': -1 };
// '후속'·'제외(MVD-B)'·'결정필요' 등 순위가 없는 tier는 next가 자동으로 고르지 않는다(사용자 결정 필요).
// externalOwner가 있는 과업(예: 별도 코드 세션 소유)은 이 하네스가 자동으로 고르지 않는다.
const selectable = (t) => Object.hasOwn(TIER_RANK, t.tier) && !t.externalOwner;
const AGENT = (t) => t.executor === 'agent';
const MAX_FAILS = 3;

function load() {
  const db = readJson(P.tasks, null, root);
  if (!db) { console.error(`${P.tasks}가 없습니다.`); process.exit(2); }
  return db;
}
function save(db) {
  db.updatedAt = nowIso();
  writeJson(P.tasks, db, root);
  render(db);
}
function find(db, id) {
  const t = db.tasks.find((x) => x.id.toLowerCase() === String(id).toLowerCase());
  if (!t) { console.error(`과업 ${id}를 찾을 수 없습니다.`); process.exit(2); }
  return t;
}
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes(`--${name}`);
const isDone = (t) => t.status === 'done';
const depsDone = (db, t) => (t.deps || []).every((d) => { const x = db.tasks.find((y) => y.id === d); return x && isDone(x); });
const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** origin 원격에서 owner/repo를 읽는다. */
function repoSlug() {
  const url = git(['remote', 'get-url', 'origin']) || '';
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** 연결된 Issue마다 코멘트(REST). 실패는 경고만 하고 상태 기록은 계속한다. */
function syncIssues(t, body) {
  const slug = repoSlug();
  const issues = (t.issues || []).filter((n) => Number.isInteger(n));
  if (!slug || issues.length === 0) { console.warn('동기화 건너뜀: origin 원격 또는 연결된 Issue 없음'); return; }
  for (const n of issues) {
    const r = spawnSync('gh', ['api', '--method', 'POST', `repos/${slug}/issues/${n}/comments`, '-f', `body=${body}`], { cwd: root, encoding: 'utf8' });
    console.log(r.status === 0 ? `Issue #${n}에 코멘트 남김` : `경고: Issue #${n} 코멘트 실패 — ${(r.stderr || r.error?.message || '').trim().split('\n')[0]}`);
  }
}

function candidates(db) {
  const ready = db.tasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.status === 'todo' && selectable(t) && depsDone(db, t))
    .sort((a, b) => (TIER_RANK[a.t.tier] ?? 9) - (TIER_RANK[b.t.tier] ?? 9) || String(a.t.plannedDate || '').localeCompare(String(b.t.plannedDate || '')) || a.i - b.i)
    .map(({ t }) => t);
  return { agent: ready.filter(AGENT), human: ready.filter((t) => !AGENT(t)) };
}

/** 아직 시작할 수 없는 가장 이른 에이전트 과업과 그것을 막는 미완료 선행 과업. */
function firstBlockedAgent(db) {
  const pending = db.tasks.filter((t) => AGENT(t) && selectable(t) && t.status === 'todo' && !depsDone(db, t));
  pending.sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9));
  const t = pending[0];
  if (!t) return null;
  const missing = (t.deps || []).filter((d) => { const x = db.tasks.find((y) => y.id === d); return !x || !isDone(x); });
  return { task: t, missing };
}

function violations() {
  const f = abs(P.violations, root);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
}

function render(db) {
  const cur = readJson(P.current, null, root);
  const done = db.tasks.filter(isDone).sort((a, b) => String(b.result?.completedAt || '').localeCompare(String(a.result?.completedAt || '')));
  const { agent, human } = candidates(db);
  const blocked = db.tasks.filter((t) => t.status === 'blocked');
  const active = db.tasks.filter((t) => ['in_progress', 'review', 'verified'].includes(t.status));
  const fb = firstBlockedAgent(db);
  const v = violations();
  const lastChecks = readJson('.afo/last-checks.json', null, root);
  const count = (s) => db.tasks.filter((t) => t.status === s).length;
  const lines = [
    '# AFO 작업 상태',
    '',
    `> 자동 생성 파일입니다(\`node scripts/harness/task.mjs render\`). 직접 고치지 마세요. 갱신: ${kst(db.updatedAt || nowIso())} KST`,
    '> 진행 상태의 정본은 GitHub Issue입니다(docs/HARNESS.md). 이 파일은 과업(작업 패킷) 단위 재개용 요약입니다.',
    '',
    '## 현재 과업',
    '',
    cur ? `- **${cur.id} ${cur.title}** · 역할 ${cur.role || '-'} · Issue ${(cur.issues || []).map((n) => '#' + n).join(' ') || '-'} · 상태 ${db.tasks.find((t) => t.id === cur.id)?.status} · 검토 ${cur.reviewRound}차 · 실패 ${cur.fails ?? 0}회 · 브랜치 \`${cur.branch}\` · Issue ${cur.issue ?? '미생성'}` : '- 없음',
    '',
    '## 다음 후보',
    '',
    agent.length ? agent.slice(0, 3).map((t) => `- ${t.id} ${t.title} (${t.tier}, ${t.role || t.owner}, Issue ${(t.issues || []).map((n) => '#' + n).join(' ') || '-'})`).join('\n') : '- 바로 시작할 수 있는 에이전트 과업 없음',
    fb && !agent.length ? `- 가장 이른 에이전트 과업 ${fb.task.id}은 선행 ${fb.missing.join(', ')} 완료가 필요` : '',
    '',
    '## 사용자(사람) 작업 대기',
    '',
    human.length ? human.map((t) => `- ${t.id} ${t.title} (${t.owner}${t.plannedDate ? `, ${t.plannedDate}` : ''})`).join('\n') : '- 없음',
    '',
    '## 막힌 과업 · 미해결 오류',
    '',
    blocked.length ? blocked.map((t) => `- ${t.id}: ${t.blockedReason || '사유 미기록'}`).join('\n') : '- 없음',
    lastChecks && !lastChecks.ok ? `- 마지막 검사 실패(${kst(lastChecks.at)}, ${lastChecks.mode}) — \`node scripts/harness/run-checks.mjs\`로 확인` : '',
    v.length ? `- 범위 밖 변경·검사 미해결 기록 ${v.length}건 — \`node scripts/harness/task.mjs violations\`` : '',
    '',
    '## 최근 완료',
    '',
    done.length ? done.slice(0, 5).map((t) => `- ${t.id} ${t.title} — ${t.result?.summary || ''} (${t.result?.completedAt ? kst(t.result.completedAt) : ''})`).join('\n') : '- 없음',
    '',
  ];
  fs.writeFileSync(abs(P.status, root), lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'));
}

const [cmd, id, third] = process.argv.slice(2);
const db = load();

switch (cmd) {
  case 'status': {
    render(db);
    if (flag('brief')) {
      const cur = readJson(P.current, null, root);
      const { agent, human } = candidates(db);
      const fb = firstBlockedAgent(db);
      const lastDone = db.tasks.filter(isDone).sort((a, b) => String(b.result?.completedAt || '').localeCompare(String(a.result?.completedAt || '')))[0];
      console.log(`현재 과업: ${cur ? `${cur.id} ${cur.title} (${db.tasks.find((t) => t.id === cur.id)?.status}, 검토 ${cur.reviewRound}차)` : '없음'}`);
      console.log(`최근 완료: ${lastDone ? `${lastDone.id} ${lastDone.title}` : '없음'}`);
      console.log(`다음 에이전트 과업: ${agent[0] ? `${agent[0].id} ${agent[0].title}` : fb ? `없음(가장 이른 ${fb.task.id}은 ${fb.missing.join(', ')} 필요)` : '없음'}`);
      console.log(`사람 작업 대기: ${human.map((t) => t.id).join(', ') || '없음'}`);
      console.log(`막힘: ${db.tasks.filter((t) => t.status === 'blocked').map((t) => t.id).join(', ') || '없음'} · 위반 기록: ${violations().length}건`);
    } else {
      console.log(fs.readFileSync(abs(P.status, root), 'utf8'));
    }
    break;
  }
  case 'next': {
    const cur = readJson(P.current, null, root);
    if (cur) { console.log(`진행 중인 과업이 있습니다: ${cur.id} ${cur.title} — 이것을 먼저 끝내세요.`); break; }
    const { agent, human } = candidates(db);
    if (agent[0]) console.log(`NEXT ${agent[0].id} ${agent[0].title} (${agent[0].tier})`);
    else {
      const fb = firstBlockedAgent(db);
      console.log(`NEXT 없음 — 시작 가능한 에이전트 과업이 없습니다.${fb ? ` 가장 이른 ${fb.task.id}(${fb.task.title})은 선행 ${fb.missing.join(', ')}이(가) 끝나야 합니다.` : ''}`);
    }
    if (human.length) console.log(`사람 작업 대기: ${human.map((t) => `${t.id}(${t.owner})`).join(', ')}`);
    break;
  }
  case 'show': console.log(JSON.stringify(find(db, id), null, 2)); break;
  case 'start': {
    const t = find(db, id);
    const cur = readJson(P.current, null, root);
    if (cur && cur.id !== t.id) { console.error(`이미 진행 중: ${cur.id}. 먼저 끝내거나 block 하세요.`); process.exit(1); }
    if (!depsDone(db, t) && !flag('force')) { console.error(`선행 과업 미완료: ${(t.deps || []).join(', ')}`); process.exit(1); }
    if (!AGENT(t)) console.warn(`주의: ${t.id}는 executor=${t.executor} 과업입니다(사람 참여 필요).`);
    t.status = 'in_progress';
    t.startedAt = t.startedAt || nowIso();
    t.branch = t.branch || `feat/${t.id.toLowerCase()}-${t.slug || 'task'}`;
    const baseSha = git(['rev-parse', 'HEAD']);
    writeJson(P.current, {
      id: t.id, title: t.title, role: t.role || null, issues: t.issues || [], baseSha,
      branch: t.branch, issue: t.issue ?? null,
      acceptance: t.acceptance || [], allowedPaths: t.allowedPaths || [], protectedPaths: t.protectedPaths || [],
      tests: t.tests || [], needsExternalReview: !!t.needsExternalReview,
      reviewRound: 0, fails: t.fails || 0, startedAt: t.startedAt, history: [{ at: nowIso(), event: 'start' }],
    }, root);
    save(db);
    console.log(`시작: ${t.id} ${t.title} · 역할 ${t.role || '-'} · Issue ${(t.issues || []).map((n) => '#' + n).join(' ') || '-'} · 기준 SHA ${baseSha ? baseSha.slice(0, 7) : '-'}\n브랜치: ${t.branch}  (git switch -c ${t.branch} 또는 git switch ${t.branch})`);
    if (flag('sync')) syncIssues(t, `작업 시작(하네스): **${t.id} ${t.title}** · 역할 ${t.role || '-'} · 브랜치 \`${t.branch}\` · 기준 SHA \`${baseSha || '-'}\`\n수용 기준:\n${(t.acceptance || []).map((a) => '- [ ] ' + a).join('\n')}`);
    break;
  }
  case 'review': {
    const t = find(db, id);
    const cur = readJson(P.current, null, root);
    if (!cur || cur.id !== t.id) { console.error('current-task가 이 과업이 아닙니다.'); process.exit(1); }
    cur.reviewRound += 1;
    cur.history.push({ at: nowIso(), event: `review r${cur.reviewRound}` });
    writeJson(P.current, cur, root);
    t.status = 'review';
    t.reviewRounds = cur.reviewRound;
    save(db);
    console.log(`검토 ${cur.reviewRound}차 — verifier 보고서 경로: docs/reviews/${t.id}-r${cur.reviewRound}.md`);
    break;
  }
  case 'result': {
    const t = find(db, id);
    const cur = readJson(P.current, null, root);
    if (!cur || cur.id !== t.id) { console.error('current-task가 이 과업이 아닙니다.'); process.exit(1); }
    const verdict = String(third || '').toLowerCase();
    if (!['pass', 'fail'].includes(verdict)) { console.error('result <ID> pass|fail'); process.exit(2); }
    cur.history.push({ at: nowIso(), event: `review r${cur.reviewRound} ${verdict}`, note: arg('note') });
    if (verdict === 'fail') {
      cur.fails = (cur.fails || 0) + 1;
      t.fails = cur.fails;
      t.status = cur.fails >= MAX_FAILS ? 'blocked' : 'in_progress';
      if (t.status === 'blocked') t.blockedReason = `verifier FAIL ${cur.fails}회: ${arg('note') || ''}`.trim();
    } else {
      t.status = 'verified';
    }
    writeJson(P.current, cur, root);
    save(db);
    console.log(t.status === 'blocked' ? `BLOCKED: FAIL ${cur.fails}회 — 사용자에게 해결 불가로 보고하세요.` : `기록: ${verdict} (누적 FAIL ${cur.fails || 0}회)`);
    break;
  }
  case 'done': {
    const t = find(db, id);
    const byUser = flag('by') && arg('by') === 'user';
    if (AGENT(t) && t.status !== 'verified' && !flag('force')) { console.error(`${t.id}는 verifier PASS(verified) 전입니다.`); process.exit(1); }
    t.status = 'done';
    t.result = {
      summary: arg('summary') || '', tests: arg('tests') || '', commit: arg('commit') || null,
      review: arg('review') || null, by: byUser ? 'user' : 'agent', completedAt: nowIso(),
      externalReview: t.needsExternalReview ? (flag('external-pending') ? 'pending' : 'recorded') : 'n/a',
    };
    const cur = readJson(P.current, null, root);
    if (cur && cur.id === t.id) fs.rmSync(abs(P.current, root));
    appendLine(P.log, [
      `## ${kst(t.result.completedAt)} KST · ${t.id} ${t.title} — 완료${byUser ? '(사용자 작업)' : ''}`,
      `- 요약: ${t.result.summary || '-'}`,
      `- 검증: ${t.result.tests || '-'}`,
      `- 검토: ${t.result.review || '-'} · 외부 검토: ${t.result.externalReview}`,
      `- 커밋: ${t.result.commit || '-'} · 브랜치: ${t.branch || '-'} · Issue: ${t.issue ?? '-'}`,
      '',
    ].join('\n'), root);
    save(db);
    console.log(`완료 기록: ${t.id}`);
    if (flag('sync')) syncIssues(t, `과업 완료(하네스): **${t.id} ${t.title}**\n- 요약: ${t.result.summary || '-'}\n- 검증: ${t.result.tests || '-'}\n- 검토: ${t.result.review || '-'} · 외부 검토: ${t.result.externalReview}\n- 커밋: ${t.result.commit || '-'}\n이 코멘트는 과업 단위 기록입니다. Issue를 닫는 것은 사람이 완료 조건을 확인한 뒤 합니다.`);
    break;
  }
  case 'block': {
    const t = find(db, id);
    t.status = 'blocked';
    t.blockedReason = arg('reason') || '사유 미기록';
    save(db);
    console.log(`막힘 기록: ${t.id} — ${t.blockedReason}`);
    break;
  }
  case 'unblock': {
    const t = find(db, id);
    const cur = readJson(P.current, null, root);
    t.status = cur && cur.id === t.id ? 'in_progress' : 'todo';
    delete t.blockedReason;
    save(db);
    console.log(`막힘 해제: ${t.id} → ${t.status}`);
    break;
  }
  case 'set': {
    const t = find(db, id);
    if (arg('issue')) t.issue = Number(arg('issue')) || arg('issue');
    if (arg('branch')) t.branch = arg('branch');
    if (arg('note')) (t.notes ||= []).push({ at: nowIso(), text: arg('note') });
    const cur = readJson(P.current, null, root);
    if (cur && cur.id === t.id) { cur.issue = t.issue ?? cur.issue; cur.branch = t.branch; writeJson(P.current, cur, root); }
    save(db);
    console.log(`갱신: ${t.id}`);
    break;
  }
  case 'add': {
    const t = JSON.parse(arg('json') || '{}');
    if (!t.id || !t.title) { console.error('id와 title은 필수입니다.'); process.exit(2); }
    if (db.tasks.some((x) => x.id === t.id)) { console.error(`이미 있는 ID: ${t.id}`); process.exit(2); }
    db.tasks.push({ tier: 'MVP', executor: 'agent', owner: '미정', deps: [], allowedPaths: [], acceptance: [], tests: [], status: 'todo', ...t });
    save(db);
    console.log(`추가: ${t.id} ${t.title}`);
    break;
  }
  case 'violations': {
    const v = violations();
    console.log(v.length ? v.map((x) => JSON.stringify(x)).join('\n') : '기록 없음');
    break;
  }
  case 'render': render(db); console.log(`갱신: ${P.status}`); break;
  default:
    console.log('사용법: node scripts/harness/task.mjs <status|next|show|start|review|result|done|block|unblock|set|add|violations|render> …');
    process.exit(cmd ? 2 : 0);
}
