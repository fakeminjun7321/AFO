import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AfoError, OpaqueIdSchema, OperationPlanSchema, RelativePathSchema } from '../../contracts/src/index.js';
import type { JournalEntry, OperationKind, OperationPlan, PlanOperation } from '../../contracts/src/index.js';
import { readJournal, statePaths } from './state.js';
import type { JournalRead } from './state.js';
import { classifyMoveState, fileIdentity, fileMatchesExpected } from './platform.js';
import type { MoveState } from './platform.js';
import { readRootLock } from './lock.js';
import type { RootLockState } from './lock.js';

/**
 * Report-only inspection of interrupted runs (#13, DESIGN 실행 규칙 7). It reads journals, plans and lstat results only:
 * it never renames, links, unlinks, writes, re-runs, rolls back or deletes anything under the root or the state folder.
 * The root lock is only read (readRootLock), never acquired or removed. A held lock is per root, so every run of that root is 'active'.
 * Plans come only from the injected `loadPlan` (to be wired to approvals.ts loadSavedPlan, plans/<planId>.json, after #8 lands);
 * without it nothing is resolved against a root and every open op is 'unknown' (PLAN_UNAVAILABLE).
 */
export type RecoveryState = MoveState | 'unknown';
export interface UnfinishedOp {
  opId: string; state: RecoveryState; action: string;
  kind: OperationKind; phase: 'intent' | 'undo-intent'; source: string; destination: string | null;
  /** File state actually observed, also when `state` is 'unknown' because the journal or plan cannot be trusted. */
  observed: MoveState | null; detail: string | null;
}
export interface RunInspection {
  runId: string; planId: string; rootGrantId: string | null; rootPath: string | null;
  status: 'active' | 'clean' | 'unfinished' | 'corrupt' | 'unreadable'; problem: string | null;
  corrupt: { line: number; reason: string }[]; finished: number; unfinished: UnfinishedOp[];
  /** Root lock as seen now; null when the root is unknown or the lock could not be read (see `problem`). */
  lock: { state: RootLockState; pid: number | null; startedAt: string | null } | null;
}
/** `grant` is the RootGrant identity saved with the plan; when given, the root must still be that same folder. */
export interface SavedPlan { plan: OperationPlan; grant?: { canonicalPath: string; device: string; inode: string } }
export interface InspectOptions { loadPlan?: (planId: string) => Promise<SavedPlan | null> }

const KEEP = ' AFO는 자동으로 다시 실행·원복·삭제하지 않습니다.';
const CHECK = ' 사용자가 원래 경로와 목적지를 직접 확인해야 합니다.' + KEEP;
const LINKED = '원래 경로와 목적지가 같은 파일(하드링크 2개)입니다. 데이터 손실은 없으며 사용자가 확인한 뒤 한쪽 이름만 정리해야 합니다. AFO는 자동으로 지우지 않습니다.';
const actions: Record<'move' | 'undo' | 'trash' | 'delete', Partial<Record<MoveState, string>>> = {
  move: {
    'not-started': '이동이 시작되지 않아 파일이 원래 경로에 그대로 있습니다. 필요하면 새 계획과 승인으로 다시 정리하세요.' + KEEP,
    'linked-both': LINKED,
    moved: '이동은 완료됐지만 저널 완료 기록이 없습니다. 다시 실행하지 않습니다. 목적지의 파일을 확인하세요.',
    missing: '원래 경로와 목적지 모두에 파일이 없습니다. 다른 프로그램이 옮기거나 지웠을 수 있으며 AFO는 위치를 추측하지 않습니다.' + CHECK,
    conflict: '원래 경로나 목적지에 승인 때와 다른 파일(또는 링크)이 있습니다. AFO는 어느 쪽도 바꾸지 않습니다.' + CHECK,
  },
  undo: {
    'not-started': '되돌리기가 시작되지 않아 파일이 정리된 위치(목적지)에 그대로 있습니다. 필요하면 되돌리기를 다시 요청하세요.' + KEEP,
    'linked-both': LINKED,
    moved: '되돌리기는 완료돼 파일이 원래 경로에 있지만 저널 완료 기록이 없습니다. 다시 실행하지 않습니다.',
    missing: '되돌리던 파일이 목적지와 원래 경로 모두에 없습니다. 다른 프로그램이 옮기거나 지웠을 수 있습니다.' + CHECK,
    conflict: '되돌리던 목적지나 원래 경로에 승인 때와 다른 파일(또는 링크)이 있습니다. AFO는 어느 쪽도 바꾸지 않습니다.' + CHECK,
  },
  trash: {
    'not-started': '휴지통 이동이 시작되지 않아 파일이 원래 경로에 그대로 있습니다. 필요하면 새 승인으로 다시 요청하세요.' + KEEP,
    missing: '원래 경로에 파일이 없습니다. 휴지통으로 이동됐는지 알 수 없으니 OS 휴지통(Finder 휴지통·Windows 휴지통)에서 확인하세요. 다시 실행하지 않습니다.',
    conflict: '원래 경로에 승인 때와 다른 파일(또는 링크·하드링크)이 있습니다. AFO는 이 파일을 휴지통으로 보내지 않으며 사용자가 확인해야 합니다.',
  },
  delete: {
    'not-started': '영구 삭제가 시작되지 않아 파일이 원래 경로에 그대로 있습니다. 다시 삭제하려면 새 승인이 필요합니다.' + KEEP,
    missing: '원래 경로에 파일이 없습니다. 영구 삭제가 끝났는지 다른 프로그램이 옮겼는지 알 수 없습니다. 영구 삭제는 되돌릴 수 없으며 다시 실행하지 않습니다.',
    conflict: '원래 경로에 승인 때와 다른 파일(또는 링크·하드링크)이 있습니다. AFO는 이 파일을 삭제하지 않으며 사용자가 확인해야 합니다.',
  },
};
const PLAN_MISSING = '계획 파일이 없어 실제 상태를 확인할 수 없음.' + CHECK;
const PLAN_UNAVAILABLE = '계획을 불러올 수단이 없어 실제 파일 상태를 확인하지 않았습니다.' + CHECK;
const ROOT_CHANGED = '작업 폴더가 승인 때의 폴더와 다릅니다(경로 또는 폴더 식별 변경). 실제 상태를 확인하지 않았습니다.' + CHECK;

const errorCode = (error: unknown): string => {
  if (error === null || typeof error !== 'object' || !('code' in error)) return 'UNKNOWN';
  const detail = 'detail' in error && typeof error.detail === 'string' ? `:${error.detail}` : '';
  return `${String(error.code)}${detail}`;
};
const lstatOrNull = (p: string) => lstat(p).catch((error: unknown) => {
  if (errorCode(error) === 'ENOENT') return null;
  throw error;
});
const sameBefore = (a: JournalEntry['before'], b: JournalEntry['before']): boolean => a.device === b.device &&
  a.inode === b.inode && a.size === b.size && (a.sha256 === null || b.sha256 === null || a.sha256 === b.sha256);
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Work root must still be the same real, non-link directory the plan names. */
async function checkRoot(rootPath: string): Promise<void> {
  if (!path.isAbsolute(rootPath)) throw new AfoError('ROOT_FORBIDDEN', '이 OS의 절대 경로가 아닙니다.');
  const stat = await lstatOrNull(rootPath);
  if (!stat) throw new AfoError('SOURCE_MISSING', '작업 폴더가 없습니다.');
  if (stat.isSymbolicLink()) throw new AfoError('LINK_REJECTED', '작업 폴더가 링크입니다.');
  if (!stat.isDirectory() || await realpath(rootPath) !== rootPath)
    throw new AfoError('ROOT_FORBIDDEN', '작업 폴더의 실제 경로가 계획과 다릅니다.');
}

/** Absolute path under the root; rejects escapes and any existing link or non-folder among the parent components. */
async function inside(root: string, relative: string): Promise<string> {
  const parsed = RelativePathSchema.safeParse(relative);
  if (!parsed.success) throw new AfoError('PATH_OUTSIDE_ROOT', '지원하지 않는 상대 경로입니다.');
  const parts = parsed.data.split('/');
  const abs = path.join(root, ...parts);
  const back = path.relative(root, abs);
  if (back === '' || path.isAbsolute(back) || back === '..' || back.startsWith(`..${path.sep}`))
    throw new AfoError('PATH_OUTSIDE_ROOT', '경로가 작업 폴더 밖을 가리킵니다.');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new AfoError('LINK_REJECTED', '경로 중간에 링크·junction이 있어 따라가지 않았습니다.');
    if (!stat.isDirectory()) throw new AfoError('FILE_CHANGED', '경로 중간이 폴더가 아닙니다.');
  }
  return abs;
}

async function observe(root: string, open: JournalEntry, planned: PlanOperation): Promise<MoveState> {
  const expected = planned.expected;
  const source = await inside(root, open.source);
  if (open.kind === 'move') {
    const destination = await inside(root, open.destination!);
    return open.phase === 'undo-intent' ? classifyMoveState(destination, source, expected) : classifyMoveState(source, destination, expected);
  }
  const now = await fileIdentity(source);
  if (!now) return 'missing';
  return now.kind === 'file' && now.nlink === 1 && await fileMatchesExpected(source, expected)
    ? 'not-started' : 'conflict';
}

interface Track { first: JournalEntry; open: JournalEntry | null; lastClose: JournalEntry['phase'] | null; bad: string | null }
/** Walks one run's valid entries per op: intent → done|failed|skipped, then optionally undo-intent → undone|failed|skipped. */
function track(entries: JournalEntry[]): Map<string, Track> {
  const ops = new Map<string, Track>();
  for (const e of entries) {
    let t = ops.get(e.opId);
    const fresh = !t;
    if (!t) { t = { first: e, open: null, lastClose: null, bad: null }; ops.set(e.opId, t); }
    if (e.kind !== t.first.kind || e.source !== t.first.source || e.destination !== t.first.destination || !sameBefore(e.before, t.first.before))
      t.bad ??= '같은 작업의 기록끼리 종류·경로·식별이 다릅니다.';
    if (e.phase === 'intent' || e.phase === 'undo-intent') {
      if (e.phase === 'intent' ? !fresh : t.open !== null || t.lastClose !== 'done')
        t.bad ??= e.phase === 'intent' ? '같은 작업의 시작 기록이 다시 나옵니다.' : '완료되지 않은 이동을 되돌리기 시작했습니다.';
      t.open = e;
      continue;
    }
    const needs = e.phase === 'done' ? 'intent' : e.phase === 'undone' ? 'undo-intent' : null;
    // A lone failed/skipped as the first record means the op was refused before anything started.
    if (t.open ? needs !== null && t.open.phase !== needs : !(fresh && needs === null))
      t.bad ??= '시작 기록과 맞지 않는 완료 기록입니다.';
    t.open = null; t.lastClose = e.phase;
  }
  return ops;
}

type Issue = { detail: string; text: string };
/** Plan of the run, validated and matched to the journal, with its work root re-checked. */
async function loadRunPlan(report: RunInspection, options: InspectOptions): Promise<{ plan: OperationPlan | null; issue: Issue | null }> {
  let plan: OperationPlan | null = null;
  if (!options.loadPlan) return { plan, issue: { detail: 'PLAN_UNAVAILABLE', text: PLAN_UNAVAILABLE } };
  try {
    const loaded = await options.loadPlan(report.planId);
    if (loaded === null) return { plan, issue: { detail: 'PLAN_MISSING', text: PLAN_MISSING } };
    const parsed = OperationPlanSchema.safeParse(loaded.plan);
    if (!parsed.success) return { plan, issue: { detail: 'STATE_CORRUPT', text: '계획 파일이 계약과 달라 실제 상태를 확인할 수 없습니다.' + CHECK } };
    if (parsed.data.id !== report.planId || parsed.data.rootGrantId !== report.rootGrantId)
      return { plan, issue: { detail: 'PLAN_MISMATCH', text: '계획 파일의 ID·작업 폴더가 이 실행의 저널과 맞지 않아 실제 상태를 확인할 수 없습니다.' + CHECK } };
    plan = parsed.data; report.rootPath = plan.rootPath;
    const grant = loaded.grant;
    if (grant && grant.canonicalPath !== plan.rootPath) return { plan: null, issue: { detail: 'ROOT_CHANGED', text: ROOT_CHANGED } };
    await checkRoot(plan.rootPath);
    if (grant) {
      const now = await lstat(plan.rootPath, { bigint: true });
      if (String(now.dev) !== grant.device || String(now.ino) !== grant.inode) return { plan: null, issue: { detail: 'ROOT_CHANGED', text: ROOT_CHANGED } };
    }
    return { plan, issue: null };
  } catch (error) {
    const code = errorCode(error);
    return { plan: null, issue: { detail: code, text: (plan ? `작업 폴더를 확인할 수 없어(${code}) 실제 상태를 알 수 없습니다.`
      : `계획 파일을 읽지 못해(${code}) 실제 상태를 확인할 수 없습니다.`) + CHECK } };
  }
}

async function inspectFile(stateDir: string, name: string, options: InspectOptions): Promise<RunInspection> {
  const runId = name.slice(0, -'.jsonl'.length);
  const report: RunInspection = { runId, planId: '', rootGrantId: null, rootPath: null, status: 'unreadable', problem: null,
    corrupt: [], finished: 0, unfinished: [], lock: null };
  const unreadable = (problem: string): RunInspection => ({ ...report, problem });
  if (!OpaqueIdSchema.safeParse(runId).success) return unreadable('실행 ID 형식이 아닌 저널 파일 이름이라 읽지 않았습니다.');
  const file = path.join(statePaths(stateDir).journal, name);
  let read: JournalRead | null;
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) return unreadable('저널 파일이 링크라서 따라가지 않았습니다.');
    if (!stat.isFile()) return unreadable('저널 경로가 일반 파일이 아닙니다.');
    read = await readJournal(file);
  } catch (error) { return unreadable(`저널을 읽지 못했습니다(${errorCode(error)}).`); }
  if (!read) return unreadable('저널 파일이 사라졌습니다.');

  const first = read.entries[0];
  report.corrupt = read.corrupt;
  report.planId = first?.planId ?? '';
  report.rootGrantId = first?.rootGrantId ?? null;
  let problem: Issue | null = read.corrupt.length === 0 ? null : { detail: 'JOURNAL_DAMAGED',
    text: `저널 ${read.corrupt.map((c) => c.line).join(', ')}번째 줄이 손상돼 이 작업의 완료 기록이 사라졌을 수 있습니다.` };
  if (read.entries.some((e) => e.runId !== runId)) problem = { detail: 'JOURNAL_INCONSISTENT', text: '저널 안의 실행 ID가 파일 이름과 다릅니다.' };
  else if (read.entries.some((e) => e.planId !== first!.planId || e.rootGrantId !== first!.rootGrantId))
    problem = { detail: 'JOURNAL_INCONSISTENT', text: '한 실행의 저널에 서로 다른 계획·작업 폴더 기록이 섞여 있습니다.' };
  // A grant ID is per selection; resolve the verified physical root before consulting its shared lock.
  const { plan, issue: planIssue } = !first || problem?.detail === 'JOURNAL_INCONSISTENT'
    ? { plan: null, issue: null } : await loadRunPlan(report, options);
  const notes = problem ? [problem.text] : [];
  let host: string | null = null;
  if (plan) {
    try {
      const rootStat = await lstat(plan.rootPath, { bigint: true });
      const { state, holder } = await readRootLock(stateDir, { device: String(rootStat.dev), inode: String(rootStat.ino) });
      report.lock = { state, pid: holder?.pid ?? null, startedAt: holder?.startedAt ?? null };
      host = holder?.hostname ?? null;
      if (state === 'stale') notes.push(`이전 실행(pid ${holder?.pid ?? '?'})이 비정상 종료돼 잠금 파일이 남아 있습니다. AFO는 이 점검에서 잠금을 지우지 않았습니다.`);
      if (state === 'corrupt') notes.push('잠금 파일을 해석할 수 없습니다. AFO는 이 점검에서 잠금을 지우지 않았습니다.');
    } catch (error) { notes.push(`잠금 상태를 읽지 못했습니다(${errorCode(error)}). 다른 실행이 진행 중인지 확인할 수 없습니다.`); }
  }
  const active = report.lock?.state === 'held' || report.lock?.state === 'foreign-host';
  const ACTIVE = `${report.lock?.state === 'foreign-host' ? `다른 컴퓨터(${host ?? '?'})의 ` : '다른 '}AFO 실행(pid ${report.lock?.pid ?? '?'}, ` +
    `${report.lock?.startedAt ?? '?'} 시작)이 이 작업 폴더에서 아직 진행 중일 수 있습니다. 그 실행이 끝난 뒤 다시 확인하세요. 이 점검은 아무것도 바꾸지 않았습니다.`;
  if (active) notes.unshift(ACTIVE);
  report.problem = notes.length > 0 ? notes.join(' ') : null;

  const ops = track(read.entries);
  const open = [...ops.entries()].filter(([, t]) => t.bad !== null || t.open !== null);
  report.finished = ops.size - open.length;
  for (const [opId, t] of open) {
    const entry = t.open ?? t.first;
    const base = { opId, kind: entry.kind, phase: entry.phase === 'undo-intent' ? 'undo-intent' as const : 'intent' as const,
      source: entry.source, destination: entry.destination };
    const unknown = (detail: string, text: string, observed: MoveState | null = null): UnfinishedOp =>
      ({ ...base, state: 'unknown', action: text, detail, observed });
    // First reason the journal or plan cannot be trusted for this op; null means the file state can be classified.
    const planned = plan?.operations.find((op) => op.id === opId);
    let blocked: Issue | null = t.bad ? { detail: 'JOURNAL_INCONSISTENT', text: `저널 기록이 서로 맞지 않습니다(${t.bad}).` + CHECK }
      : problem?.detail === 'JOURNAL_INCONSISTENT' ? { detail: problem.detail, text: problem.text + CHECK }
      : !plan ? planIssue
      : !planned || planned.kind !== entry.kind || planned.source !== entry.source || planned.destination !== entry.destination || !sameBefore(entry.before, planned.expected)
        ? { detail: 'PLAN_MISMATCH', text: '계획 파일에 이 작업이 없거나 저널과 경로·종류가 다릅니다.' + CHECK } : null;
    let observed: MoveState | null = null;
    if (!blocked) {
      try { observed = await observe(plan!.rootPath, entry, planned!); }
      catch (error) {
        const code = errorCode(error);
        blocked = { detail: code, text: `실제 파일 상태를 확인하는 중 문제가 있었습니다(${code}). 링크나 폴더 밖 경로는 따라가지 않았습니다.` + CHECK };
      }
    }
    if (active) report.unfinished.push(unknown('LOCKED_BY_OTHER', ACTIVE, observed));
    else if (blocked || observed === null) report.unfinished.push(unknown(blocked?.detail ?? 'UNKNOWN', blocked?.text ?? CHECK.trim()));
    else if (problem) report.unfinished.push(unknown(problem.detail, `${problem.text} 관측한 파일 상태(${observed})만 참고하세요.` + CHECK, observed));
    else {
      const group = entry.kind === 'move' ? (entry.phase === 'undo-intent' ? 'undo' : 'move') : entry.kind;
      report.unfinished.push({ ...base, state: observed, observed, detail: null,
        action: actions[group][observed] ?? `예상하지 못한 상태(${observed})입니다.` + CHECK });
    }
  }
  // A held lock wins over a damaged last line: the running process may still be writing it.
  report.status = active ? 'active' : problem ? 'corrupt' : report.unfinished.length > 0 ? 'unfinished' : 'clean';
  return report;
}

/** Lists every run journal under the state folder with its unfinished ops compared against the real files. Report only. */
export async function inspectRuns(stateDir: string, options: InspectOptions = {}): Promise<RunInspection[]> {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new AfoError('STATE_DIR_INVALID', '상태 폴더는 절대 경로여야 합니다.');
  const root = path.normalize(stateDir);
  const directory = statePaths(root).journal;
  const stat = await lstatOrNull(directory);
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AfoError('STATE_CORRUPT', '저널 폴더가 일반 폴더가 아닙니다.');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort(order);
  const runs: RunInspection[] = [];
  for (const name of names) runs.push(await inspectFile(root, name, options));
  return runs;
}
