import path from 'node:path';
import { AfoError, ApprovalModeSchema, OpaqueIdSchema, PERMANENT_DELETE_PHRASE, approvalModeKind, isAfoError } from '../../../packages/contracts/src/index.js';
import type { ApprovalMode, ExecutionReport, OperationKind, PlanOperation } from '../../../packages/contracts/src/index.js';
import { approvalCode, selectOperations } from '../../../packages/engine/src/index.js';
import { consumeApproval, issueApproval, loadSavedPlan } from '../../../packages/filesystem/src/approvals.js';
import { RunRecordError, executeBatch, listRuns, readRun, undoRun } from '../../../packages/filesystem/src/executor.js';
import type { RunRecord, UndoRecord } from '../../../packages/filesystem/src/executor.js';
import { issueRootGrant, revokeGrant } from '../../../packages/filesystem/src/grants.js';
import { inspectRuns } from '../../../packages/filesystem/src/recovery.js';
import { CliError, usage } from './rules.js';

/**
 * Execution commands (#10–#13): apply, undo, runs, recover. Only an adapter: approvals are issued and consumed by approvals.ts,
 * files are changed only by executor.ts under its root lock, and recovery is report-only (recovery.ts). Nothing here touches user files.
 */
/** stdout text plus the process exit code (docs/CLI.md): 0 success, 3 partial failure/unknown, 130 cancelled. */
export class CliResult {
  constructor(readonly output: string, readonly exitCode: number) {}
}
export interface ExecContext {
  json: boolean; warn: (line: string) => void; stateDir: () => string; signal?: AbortSignal | undefined;
  isTTY: boolean; ask: (question: string) => Promise<string>;
}
export interface ApplyValues { mode?: string | undefined; only?: string | undefined; confirm?: string | undefined; phrase?: string | undefined }

type Status = ExecutionReport['results'][number]['status'];
const PLAN_ID = /^[a-f0-9]{64}$/u;
const modeLabel: Record<ApprovalMode, string> = { organize: '이동(organize)', trash: '휴지통으로 이동(trash)', 'permanent-delete': '영구 삭제(permanent-delete)' };
const kindLabel: Record<OperationKind, string> = { move: '이동', trash: '휴지통', delete: '영구 삭제' };
const statusLabel: Record<Status, string> = { moved: '이동함', trashed: '휴지통으로 보냄', deleted: '영구 삭제함', skipped: '건너뜀',
  failed: '실패', unknown: '결과 불명' };
const success = (s: Status): boolean => s === 'moved' || s === 'trashed' || s === 'deleted';
const cancelled = (report: ExecutionReport, signal?: AbortSignal): boolean =>
  signal?.aborted === true || report.results.some((r) => r.errorCode === 'CANCELLED');
const exitOf = (report: ExecutionReport, signal?: AbortSignal): number =>
  cancelled(report, signal) ? 130 : report.results.every((r) => success(r.status)) ? 0 : 3;
const stateOf = (ctx: ExecContext): string => path.resolve(ctx.stateDir());

/** Paths for display: from the saved plan when it is still there, else operation IDs only. */
async function planOperations(stateDir: string, planId: string): Promise<Map<string, PlanOperation> | null> {
  try {
    const saved = await loadSavedPlan(stateDir, planId);
    return saved === null ? null : new Map(saved.plan.operations.map((op) => [op.id, op]));
  } catch { return null; }
}
const where = (op: PlanOperation | undefined, reverse = false): string => op === undefined ? '(계획 파일 없음: 경로 미표시)'
  : op.destination === null ? op.source : reverse ? `${op.destination} → ${op.source}` : `${op.source} → ${op.destination}`;

function counts(report: ExecutionReport): Record<Status, number> {
  const c: Record<Status, number> = { moved: 0, trashed: 0, deleted: 0, skipped: 0, failed: 0, unknown: 0 };
  for (const r of report.results) c[r.status] += 1;
  return c;
}
const countLine = (report: ExecutionReport): string => {
  const c = counts(report);
  return `성공 ${c.moved + c.trashed + c.deleted} / 건너뜀 ${c.skipped} / 실패 ${c.failed} / 결과 불명 ${c.unknown} (전체 ${report.results.length})`;
};

function resultLines(report: ExecutionReport, ops: Map<string, PlanOperation> | null, undo: boolean): string[] {
  return report.results.map((r) => {
    const label = undo ? r.status === 'moved' ? '되돌림' : r.status === 'unknown' ? '결과 불명' : '되돌리지 않음' : statusLabel[r.status];
    return `  [${label}] ${r.opId} ${where(ops?.get(r.opId), undo)}${r.errorCode ? ` (${r.errorCode})` : ''} — ${r.detail}`;
  });
}

function spaceLines(report: ExecutionReport, mode: ApprovalMode): string[] {
  const { logicalBytesSelected, freeBytesBefore, freeBytesAfter, note } = report.space;
  return [`논리 크기 합계: ${logicalBytesSelected} B (선택한 파일 크기의 합, 확보량 아님)`,
    ...(mode === 'permanent-delete' ? [freeBytesBefore === null || freeBytesAfter === null ? '여유 공간: 관측하지 못했습니다.'
      : `여유 공간(관측): 실행 전 ${freeBytesBefore} B → 실행 후 ${freeBytesAfter} B (다른 프로그램의 쓰기 영향 가능, 정확한 회수량 아님)`] : []),
    `참고: ${note}`];
}

function afterLines(report: ExecutionReport, mode: ApprovalMode, undoable = counts(report).moved > 0): string[] {
  const c = counts(report);
  return [
    mode === 'organize' ? (undoable ? `되돌리기: undo ${report.runId} (이동한 파일만, 원래 경로가 비어 있고 내용이 그대로일 때만)` : '되돌릴 이동 항목이 없습니다.')
      : mode === 'trash' ? '되돌리기: 휴지통으로 보낸 파일은 Finder 휴지통·Windows 휴지통에서 직접 복원합니다. AFO undo는 휴지통 이동을 되돌리지 않습니다.'
      : '되돌리기: 영구 삭제는 되돌릴 수 없습니다.',
    ...(c.unknown ? ['결과 불명 항목이 있습니다. 같은 apply를 다시 실행하지 말고 recover로 실제 파일 상태를 확인하세요.'] : []),
    ...(c.failed || c.skipped ? ['실패·건너뛴 항목은 바꾸지 않았습니다. 다시 정리하려면 plan부터 다시 실행해 새 승인을 받으세요.'] : []),
  ];
}

/**
 * The same plan operations are never run twice through this CLI: a saved run of this plan that includes any selected operation refuses
 * the new approval (APPROVAL_USED, exit 4). consumeApproval/executor block reuse of one approval record; this blocks a second approval
 * for work already done (ADR 0003 decision 3). An unreadable run record fails closed.
 */
async function refuseRepeated(stateDir: string, planId: string, operationIds: string[]): Promise<void> {
  const wanted = new Set(operationIds);
  for (const runId of await listRuns(stateDir)) {
    let found: Awaited<ReturnType<typeof readRun>>;
    try { found = await readRun(stateDir, runId); }
    catch (error) {
      throw new AfoError('STATE_CORRUPT', `실행 기록(${runId})을 읽을 수 없어 같은 작업을 이미 실행했는지 확인하지 못했습니다. 실행하지 않았습니다. ` +
        `runs ${runId}로 확인하세요.`, { cause: error });
    }
    if (found?.run.planId === planId && found.run.operationIds.some((id) => wanted.has(id)))
      throw new AfoError('APPROVAL_USED', `이 계획의 같은 작업을 이미 실행했습니다(실행 ID ${runId}). 승인은 한 번만 쓸 수 있습니다. ` +
        `결과는 runs ${runId}로 확인하고, 다시 정리하려면 plan부터 다시 실행하세요. 아무것도 바꾸지 않았습니다.`);
  }
}

/** Finds the run this approval started (lock-release failure happens after the run record is saved). */
async function runOfApproval(stateDir: string, approvalId: string): Promise<string | null> {
  try {
    for (const runId of await listRuns(stateDir)) if ((await readRun(stateDir, runId))?.run.approvalId === approvalId) return runId;
  } catch { /* reported as unknown below */ }
  return null;
}

async function prompt(ctx: ExecContext, given: string | undefined, question: string, missing: string): Promise<string> {
  if (given !== undefined) return given;
  if (!ctx.isTTY) throw new CliError(missing, 4);
  return (await ctx.ask(question)).trim();
}

/** apply <planId> --mode … : saved plan → summary → typed confirmation → issueApproval → consumeApproval → executeBatch. */
export async function applyCommand(planId: string, values: ApplyValues, ctx: ExecContext): Promise<CliResult> {
  if (!PLAN_ID.test(planId)) throw usage('apply에는 plan이 출력한 계획 ID(64자 16진수)를 그대로 넣으세요.');
  const parsedMode = ApprovalModeSchema.safeParse(values.mode);
  if (!parsedMode.success) throw usage('--mode는 organize, trash, permanent-delete 중 하나입니다.');
  const mode = parsedMode.data;
  const permanent = mode === 'permanent-delete';
  if (values.phrase !== undefined && !permanent) throw usage('--phrase는 --mode permanent-delete에서만 씁니다.');
  const stateDir = stateOf(ctx);
  const saved = await loadSavedPlan(stateDir, planId);
  if (saved === null) throw new AfoError('PLAN_CHANGED', '저장된 계획을 찾을 수 없습니다. plan을 다시 실행하세요.');
  const { plan } = saved;
  const kind = approvalModeKind[mode];
  const ofMode = plan.operations.filter((op) => op.kind === kind);
  if (!ofMode.length) throw new AfoError('MODE_MISMATCH', `이 계획에는 ${kindLabel[kind]} 작업이 없습니다` +
    `${kind === 'move' ? '' : `(계획의 삭제 방식: ${plan.deleteMode === 'trash' ? 'trash' : 'permanent'})`}. 아무것도 바꾸지 않았습니다.`);
  const ids = values.only === undefined ? ofMode.map((op) => op.id) : values.only.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const operations = selectOperations(plan, ids, mode); // unknown/duplicate IDs → APPROVAL_INVALID, other kinds → MODE_MISMATCH
  const operationIds = operations.map((op) => op.id);
  await refuseRepeated(stateDir, plan.id, operationIds);

  const code = approvalCode(plan.id, operationIds, mode);
  const keepers = [...new Set(operations.flatMap((op) => op.keeper === null ? [] : [op.keeper]))];
  const bytes = operations.reduce((sum, op) => sum + op.expected.size, 0);
  const summary = [`AFO 실행 확인 — 계획 ${plan.id}`, `방식: ${modeLabel[mode]}${permanent ? ' — 되돌릴 수 없습니다' : ''} / 작업 ${operations.length}개` +
      `${values.only === undefined ? '(이 방식의 전체)' : `(--only로 고름, 이 방식 전체 ${ofMode.length}개 중)`} / 계획 만료 ${plan.expiresAt}`,
    ...operations.flatMap((op) => [`  ${op.id} ${kindLabel[op.kind]} ${where(op)}${op.kind === 'move' ? '' : ` (논리 크기 ${op.expected.size} B)`}`,
      `    이유: ${op.reason}`]),
    ...(keepers.length ? [`남길 파일(바꾸지 않음): ${keepers.join(', ')}`] : []),
    ...(kind === 'move' ? [] : [`논리 크기 합계 ${bytes} B (확보량 아님${kind === 'trash' ? '. 휴지통으로 보낸 파일은 디스크에 남습니다' : ''})`]),
    ...(permanent ? [`영구 삭제는 되돌릴 수 없습니다. 휴지통을 거치지 않습니다. 확인 문구 "${PERMANENT_DELETE_PHRASE}"도 입력해야 합니다.`] : []),
    `승인 코드: ${code} (이 계획·이 작업 목록·이 방식에만 유효. 실행 직전에 파일을 다시 확인하고 바뀐 파일은 건너뜁니다)`];
  const asking = ctx.isTTY && (values.confirm === undefined || (permanent && values.phrase === undefined));
  const needsFlags = !ctx.isTTY && (values.confirm === undefined || (permanent && values.phrase === undefined));
  if (!ctx.json || asking || needsFlags) for (const line of summary) ctx.warn(line);

  const confirmation = await prompt(ctx, values.confirm, '승인 코드 8자를 입력하세요(빈 입력은 취소): ',
    `비대화형 실행에는 --confirm <승인 코드>가 필요합니다${permanent ? `(영구 삭제는 --phrase "${PERMANENT_DELETE_PHRASE}"도)` : ''}. 아무것도 바꾸지 않았습니다.`);
  if (confirmation === '') throw new CliError('승인 코드를 입력하지 않아 실행하지 않았습니다. 아무것도 바꾸지 않았습니다.', 4);
  const phrase = permanent ? await prompt(ctx, values.phrase, `되돌릴 수 없습니다. 확인 문구 "${PERMANENT_DELETE_PHRASE}"를 입력하세요: `,
    `영구 삭제에는 --phrase "${PERMANENT_DELETE_PHRASE}"도 필요합니다. 아무것도 바꾸지 않았습니다.`) : undefined;

  const approval = await issueApproval(stateDir, { planId: plan.id, operationIds, mode, confirmation,
    ...(phrase === undefined ? {} : { confirmPhrase: phrase }) });
  const batch = await consumeApproval(stateDir, approval.id);
  let report: ExecutionReport;
  try { report = await executeBatch(batch, ctx.signal ? { signal: ctx.signal } : {}); }
  catch (error) {
    if (error instanceof RunRecordError) {
      ctx.warn(`경고: ${error.message} 같은 apply를 다시 실행하지 말고 recover로 확인하세요.`);
      return new CliResult(ctx.json ? JSON.stringify({ runId: error.report.runId, report: error.report }, null, 2)
        : applyLines(error.report, mode, operations).join('\n'), 1);
    }
    if (isAfoError(error, 'LOCKED_BY_OTHER'))
      throw new AfoError('LOCKED_BY_OTHER', `${error.message} 파일은 바꾸지 않았습니다. 이번 시도의 승인은 이미 사용돼 다시 쓸 수 없으므로, ` +
        '다른 실행이 끝난 뒤 apply를 다시 실행해 승인을 다시 받아야 합니다.', { cause: error });
    if (error instanceof AfoError && error.message.startsWith('작업은 끝났지만')) {
      const runId = await runOfApproval(stateDir, approval.id);
      throw new AfoError(error.code, `${error.message} 실행 결과는 저장됐습니다. 같은 apply를 다시 실행하지 말고 ` +
        `${runId === null ? 'runs로 실행 ID를 찾아' : `runs ${runId}로`} 결과를 확인하세요.`, { cause: error });
    }
    throw error;
  } finally { revokeGrant(batch.grant); }
  if (ctx.json) return new CliResult(JSON.stringify({ runId: report.runId, report }, null, 2), exitOf(report, ctx.signal));
  return new CliResult(applyLines(report, mode, operations).join('\n'), exitOf(report, ctx.signal));
}

function applyLines(report: ExecutionReport, mode: ApprovalMode, operations: PlanOperation[]): string[] {
  return [`AFO 실행 결과 — 실행 ID: ${report.runId}`, `방식: ${modeLabel[mode]} / 계획 ${report.planId}`,
    ...resultLines(report, new Map(operations.map((op) => [op.id, op])), false), `결과: ${countLine(report)}`,
    ...spaceLines(report, mode), ...afterLines(report, mode)];
}

/**
 * undo <runId>: confirmation code = first 8 characters of the run ID; undoRun moves back only unchanged files into empty paths.
 * `simple` (afo undo without an ID, guided.ts): the same checks and codes with a short screen; JSON output is identical.
 */
export async function undoCommand(runId: string, values: { confirm?: string | undefined }, ctx: ExecContext,
  simple = false): Promise<CliResult> {
  if (!OpaqueIdSchema.safeParse(runId).success) throw usage('undo에는 apply가 출력한 실행 ID를 그대로 넣으세요.');
  const stateDir = stateOf(ctx);
  const found = await readRun(stateDir, runId);
  if (found === null) throw new CliError('해당 실행 기록이 없습니다. runs로 실행 ID를 확인하세요.', 1);
  const { run, undos } = found;
  if (run.mode !== 'organize')
    throw new CliError(`이 실행은 ${modeLabel[run.mode]}입니다. 휴지통 이동·영구 삭제는 되돌리지 않습니다. 휴지통으로 보낸 파일은 ` +
      'Finder 휴지통·Windows 휴지통에서 직접 복원하세요. 영구 삭제는 되돌릴 수 없습니다.', 1);
  const ops = await planOperations(stateDir, run.planId);
  const undone = new Set(undos.flatMap((u) => u.report.results.filter((r) => r.status === 'moved').map((r) => r.opId)));
  const candidates = (run.report?.results ?? []).filter((r) => r.status === 'moved' && !undone.has(r.opId));
  const unclear = run.report === null || run.report.results.some((r) => r.status === 'unknown');
  if (!candidates.length && !unclear) {
    const text = `되돌릴 이동 항목이 없습니다(실행 ${run.runId}: ${undone.size ? '이미 되돌렸거나 ' : ''}이동한 파일 없음). 아무것도 바꾸지 않았습니다.`;
    return new CliResult(ctx.json ? JSON.stringify({ runId: run.runId, report: null, message: text }, null, 2) : text, 0);
  }
  const code = run.runId.slice(0, 8);
  const summary = simple ? simpleUndoSummary(run.startedAt, candidates.map((r) => ops?.get(r.opId)), unclear, code) : [`AFO 되돌리기 확인 — 실행 ${run.runId} (${run.startedAt})`,
    `되돌릴 후보 ${candidates.length}개(정리한 위치 → 원래 위치):`,
    ...candidates.map((r) => `  ${r.opId} ${where(ops?.get(r.opId), true)}`),
    ...(unclear ? ['이 실행에는 결과가 확인되지 않은 항목이 있습니다. 그런 항목은 추측해 옮기지 않고 결과 불명으로 보고합니다(recover로 확인).'] : []),
    '정리한 파일이 그대로이고 원래 경로가 비어 있을 때만 옮깁니다. 원래 경로에 파일이 있거나 내용이 바뀐 항목은 건너뜁니다(덮어쓰지 않음).',
    '휴지통 이동·영구 삭제는 되돌리지 않습니다. 이 실행이 새로 만든 폴더는 되돌린 뒤 비어 있을 때만 지웁니다.',
    `확인 코드: ${code} (실행 ID 앞 8자)`];
  const needs = values.confirm === undefined;
  if (!ctx.json || needs) for (const line of summary) ctx.warn(line);
  const typed = await prompt(ctx, values.confirm, simple ? '코드(그냥 Enter는 취소): ' : '확인 코드 8자를 입력하세요(빈 입력은 취소): ',
    '비대화형 되돌리기에는 --confirm <실행 ID 앞 8자>가 필요합니다. 아무것도 바꾸지 않았습니다.');
  if (typed !== code) throw new CliError('확인 코드가 맞지 않아 되돌리지 않았습니다. 아무것도 바꾸지 않았습니다.', 4);

  const grant = await issueRootGrant(run.root.canonicalPath);
  let report: ExecutionReport;
  try { report = await undoRun(stateDir, run.runId, grant, ctx.signal ? { signal: ctx.signal } : {}); }
  catch (error) {
    if (error instanceof RunRecordError) {
      ctx.warn(`경고: ${error.message} undo를 다시 실행하기 전에 recover로 확인하세요.`);
      return new CliResult(ctx.json ? JSON.stringify({ runId: run.runId, report: error.report }, null, 2)
        : (simple ? simpleUndoLines : undoLines)(error.report, ops).join('\n'), 1);
    }
    if (isAfoError(error, 'LOCKED_BY_OTHER'))
      throw new AfoError('LOCKED_BY_OTHER', `${error.message} 파일은 바꾸지 않았습니다. 다른 실행이 끝난 뒤 undo를 다시 실행하세요.`, { cause: error });
    if (error instanceof AfoError && error.message.startsWith('작업은 끝났지만'))
      throw new AfoError(error.code, `${error.message} 되돌리기 결과는 저장됐습니다. 다시 실행하지 말고 runs ${run.runId}로 확인하세요.`, { cause: error });
    throw error;
  } finally { revokeGrant(grant); }
  const exit = cancelled(report, ctx.signal) ? 130 : report.results.every((r) => r.status === 'moved') ? 0 : 3;
  if (ctx.json) return new CliResult(JSON.stringify({ runId: run.runId, report }, null, 2), exit);
  return new CliResult((simple ? simpleUndoLines : undoLines)(report, ops).join('\n'), exit);
}

const localTime = (iso: string): string => new Intl.DateTimeFormat('ko-KR',
  { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const MAX_UNDO_LIST = 20;
function simpleUndoSummary(startedAt: string, ops: (PlanOperation | undefined)[], unclear: boolean, code: string): string[] {
  return [`${localTime(startedAt)}에 정리한 파일 ${ops.length}개를 원래 자리로 되돌릴까요?`,
    ...ops.slice(0, MAX_UNDO_LIST).map((op) => `  ${op === undefined ? '(계획 파일이 없어 이름을 표시하지 못함)' : where(op, true)}`),
    ...(ops.length > MAX_UNDO_LIST ? [`  … 외 ${ops.length - MAX_UNDO_LIST}개`] : []),
    ...(unclear ? ['결과가 확인되지 않은 파일은 건드리지 않아요(afo recover로 확인).'] : []),
    '원래 자리에 다른 파일이 있거나 정리한 뒤 바뀐 파일은 덮어쓰지 않고 건너뛰어요.',
    `계속하려면 아래 코드를 입력하세요: ${code}`];
}
function simpleUndoLines(report: ExecutionReport, ops: Map<string, PlanOperation> | null): string[] {
  const back = report.results.filter((r) => r.status === 'moved').length;
  const unknown = report.results.filter((r) => r.status === 'unknown').length;
  const notBack = report.results.filter((r) => r.status !== 'moved');
  const name = (opId: string): string => { const op = ops?.get(opId); return op?.destination ?? op?.source ?? '(이름 모름)'; };
  const dirs = report.directories;
  return [`되돌렸어요: ${back}개 · 건너뜀 ${report.results.length - back - unknown}${unknown ? ` · 결과 확인 못 함 ${unknown}` : ''}`,
    ...notBack.slice(0, MAX_UNDO_LIST).map((r) => `  ${name(r.opId)} — ${r.detail}`),
    ...(notBack.length > MAX_UNDO_LIST ? [`  … 외 ${notBack.length - MAX_UNDO_LIST}개`] : []),
    ...(dirs?.removed.length ? [`정리할 때 만든 빈 폴더 ${dirs.removed.length}개도 지웠어요.`] : []),
    ...(dirs?.kept.length ? [`정리할 때 만든 폴더 ${dirs.kept.length}개는 그대로 뒀어요:`, ...dirs.kept.map((k) => `  ${k.path} — ${k.reason}`)] : []),
    ...(unknown ? ['결과를 확인하지 못한 파일이 있어요. 다시 실행하지 말고 afo recover로 실제 상태를 확인하세요.'] : [])];
}

function undoLines(report: ExecutionReport, ops: Map<string, PlanOperation> | null): string[] {
  const back = report.results.filter((r) => r.status === 'moved').length;
  const unknown = report.results.filter((r) => r.status === 'unknown').length;
  return [`AFO 되돌리기 결과 — 실행 ID: ${report.runId}`,
    ...(report.results.length ? resultLines(report, ops, true) : ['  되돌릴 항목이 없었습니다.']),
    `결과: 되돌림 ${back} / 되돌리지 않음 ${report.results.length - back - unknown} / 결과 불명 ${unknown}`,
    ...(report.directories?.removed.length ? [`이 실행이 만든 빈 폴더를 지웠습니다: ${report.directories.removed.join(', ')}`] : []),
    ...(report.directories?.kept ?? []).map((k) => `이 실행이 만든 폴더를 그대로 둠: ${k.path} — ${k.reason}`),
    `참고: ${report.space.note}`, '휴지통 이동·영구 삭제는 되돌리지 않습니다(휴지통은 OS에서 사용자가 복원).',
    ...(unknown ? ['결과 불명 항목은 recover로 실제 파일 상태를 확인하세요. AFO는 자동으로 다시 실행·원복하지 않습니다.'] : [])];
}

export interface RunSummary {
  runId: string; planId: string; mode: ApprovalMode; startedAt: string; finishedAt: string | null;
  results: Record<Status, number> | null; undos: number; undone: number; undoable: boolean;
}
function summarize(run: RunRecord, undos: UndoRecord[]): RunSummary {
  const undone = new Set(undos.flatMap((u) => u.report.results.filter((r) => r.status === 'moved').map((r) => r.opId)));
  const moved = run.report?.results.filter((r) => r.status === 'moved' && !undone.has(r.opId)).length ?? 0;
  return { runId: run.runId, planId: run.planId, mode: run.mode, startedAt: run.startedAt, finishedAt: run.finishedAt,
    results: run.report === null ? null : counts(run.report), undos: undos.length, undone: undone.size, undoable: run.mode === 'organize' && moved > 0 };
}
const summaryLine = (s: RunSummary): string => `${s.runId}  ${s.startedAt}  ${modeLabel[s.mode]}  ` +
  (s.results === null ? '끝나지 않음(결과 기록 없음 — recover로 확인)'
    : `성공 ${s.results.moved + s.results.trashed + s.results.deleted}·건너뜀 ${s.results.skipped}·실패 ${s.results.failed}·불명 ${s.results.unknown}`) +
  `  되돌리기 ${s.undos}회(되돌린 항목 ${s.undone})${s.undoable ? '  undo 가능' : ''}`;

/** Every run record, oldest first; unreadable ones as { runId, error }. Shared by `runs` and `gui`. */
export async function runSummaries(stateDir: string): Promise<(RunSummary | { runId: string; error: string })[]> {
  const rows: (RunSummary | { runId: string; error: string })[] = [];
  for (const id of await listRuns(stateDir)) {
    try {
      const found = await readRun(stateDir, id);
      if (found) rows.push(summarize(found.run, found.undos));
    } catch (error) { rows.push({ runId: id, error: error instanceof Error ? error.message : String(error) }); }
  }
  const key = (r: (typeof rows)[number]): string => 'startedAt' in r ? r.startedAt : '';
  return rows.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

/** runs [<runId>]: listRuns/readRun summary. Read only. */
export async function runsCommand(runId: string | undefined, ctx: ExecContext): Promise<CliResult> {
  const stateDir = stateOf(ctx);
  if (runId !== undefined) {
    if (!OpaqueIdSchema.safeParse(runId).success) throw usage('runs에는 apply가 출력한 실행 ID를 그대로 넣으세요.');
    const found = await readRun(stateDir, runId);
    if (found === null) throw new CliError('해당 실행 기록이 없습니다. runs로 실행 ID를 확인하세요.', 1);
    if (ctx.json) return new CliResult(JSON.stringify(found, null, 2), 0);
    const { run, undos } = found;
    const ops = await planOperations(stateDir, run.planId);
    return new CliResult([`실행 ${run.runId}`, `방식: ${modeLabel[run.mode]} / 계획 ${run.planId}`, `시작 ${run.startedAt} / 끝 ${run.finishedAt ?? '기록 없음'}`,
      ...(run.report === null ? ['결과 기록이 없습니다(중단된 실행일 수 있음). 다시 실행하지 말고 recover로 확인하세요.']
        : [...resultLines(run.report, ops, false), `결과: ${countLine(run.report)}`, ...spaceLines(run.report, run.mode),
          ...afterLines(run.report, run.mode, summarize(run, undos).undoable)]),
      ...undos.flatMap((u) => [`되돌리기 ${u.undoIndex}회차 (${u.finishedAt}):`, ...(u.report.results.length ? resultLines(u.report, ops, true) : ['  되돌릴 항목이 없었습니다.'])]),
    ].join('\n'), 0);
  }
  const rows = await runSummaries(stateDir);
  if (ctx.json) return new CliResult(JSON.stringify({ runs: rows }, null, 2), 0);
  if (!rows.length) return new CliResult('실행 기록이 없습니다.', 0);
  return new CliResult([`실행 기록 ${rows.length}개 (오래된 순):`,
    ...rows.map((r) => 'error' in r ? `${r.runId}  [읽을 수 없음] ${r.error}` : summaryLine(r))].join('\n'), 0);
}

/** inspectRuns over every journal; `open` is the runs that are not clean. Report only. Shared by `recover` and `gui`. */
export async function recoverReport(stateDir: string): Promise<{ all: Awaited<ReturnType<typeof inspectRuns>>; open: Awaited<ReturnType<typeof inspectRuns>> }> {
  const all = await inspectRuns(stateDir, { loadPlan: (planId) => loadSavedPlan(stateDir, planId) });
  return { all, open: all.filter((r) => r.status !== 'clean') };
}

/** recover: inspectRuns report only (no re-run, rollback or delete). Exit 3 when a run needs the user's attention. */
export async function recoverCommand(ctx: ExecContext): Promise<CliResult> {
  const { all, open } = await recoverReport(stateOf(ctx));
  const exit = open.some((r) => r.status !== 'active') ? 3 : 0;
  if (ctx.json) return new CliResult(JSON.stringify({ checked: all.length, runs: open }, null, 2), exit);
  if (!open.length) return new CliResult(`끝나지 않은 실행이 없습니다(저널 ${all.length}개 확인). 아무것도 바꾸지 않았습니다.`, 0);
  const label = { active: '진행 중', unfinished: '끝나지 않음', corrupt: '저널 손상', unreadable: '읽을 수 없음', clean: '정상' } as const;
  return new CliResult(['AFO 복구 점검 — 보고만 합니다. 자동으로 다시 실행·원복·삭제하지 않습니다.', `저널 ${all.length}개 중 확인이 필요한 실행 ${open.length}개:`,
    ...open.flatMap((r) => [`실행 ${r.runId} [${label[r.status]}]${r.rootPath ? ` 폴더 ${r.rootPath}` : ''} / 끝난 작업 ${r.finished}개`,
      ...(r.problem ? [`  문제: ${r.problem}`] : []),
      ...r.unfinished.map((u) => `  ${u.opId} ${kindLabel[u.kind]}${u.phase === 'undo-intent' ? '(되돌리기)' : ''} ${u.source}` +
        `${u.destination ? ` → ${u.destination}` : ''} 상태: ${u.state}${u.detail ? ` (${u.detail})` : ''}\n    해제 조건·할 일: ${u.action}`)]),
  ].join('\n'), exit);
}
