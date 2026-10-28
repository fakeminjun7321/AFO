import path from 'node:path';
import { z } from 'zod';
import { AfoError, PERMANENT_DELETE_PHRASE, approvalModeKind, isAfoError } from '../../../packages/contracts/src/index.js';
import type { ApprovalMode, OperationKind, OperationPlan, PlanOperation, Preview, ReviewItem, SavedPlan } from '../../../packages/contracts/src/index.js';
import { approvalChoices, buildPlan, diffPlans, pathKey } from '../../../packages/engine/src/index.js';
import type { DeleteSelection } from '../../../packages/engine/src/index.js';
import { hashCandidates, scanRoot } from '../../../packages/filesystem/src/index.js';
import { loadSavedPlan, savePlan } from '../../../packages/filesystem/src/approvals.js';
import { readJson, statePaths, writeJsonAtomic } from '../../../packages/filesystem/src/state.js';
import { analyzeTarget, profileLine } from './analyze.js';
import type { AnalyzeValues } from './analyze.js';
import { usage } from './rules.js';

/**
 * `plan` (#8): the preview's analysis → buildPlan → savePlan in the state folder. Shows operations, reasons and per-mode approval codes.
 * Nothing here writes the work root, and no approval is issued: codes are only displayed for the later `apply`.
 */
export interface PlanValues extends AnalyzeValues {
  'delete-mode'?: string | undefined; 'delete-duplicates'?: string | undefined; 'delete-file'?: string[] | undefined }

/** CLI-owned index plans/latest-<rootId>.json: the last plan shown for a root, so the next plan can show only what changed. */
const LatestSchema = z.strictObject({ formatVersion: z.literal(1), planId: z.string().regex(/^[a-f0-9]{64}$/u) });
const ROOT_ID = /^[a-f0-9]{64}$/u;
const latestFile = (stateDir: string, rootId: string): string => path.join(statePaths(stateDir).plans, `latest-${rootId}.json`);

const kindLabel: Record<OperationKind, string> = { move: '이동', trash: '휴지통', delete: '영구 삭제' };
const modeLabel: Record<ApprovalMode, string> = { organize: '이동', trash: '휴지통으로 이동', 'permanent-delete': '영구 삭제 — 되돌릴 수 없음' };
const statusLabel: Record<ReviewItem['status'], string> = { keep: '유지', review: '검토 필요' };
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function opLines(op: PlanOperation, once: Set<string>): string[] {
  const head = op.kind === 'move' ? `  ${op.id} ${kindLabel.move} ${op.source} → ${op.destination}${once.has(op.fileId) ? ' (사용자 수정, 이번 계획에만 적용)' : ''}`
    : `  ${op.id} ${kindLabel[op.kind]} ${op.source} (${op.keeper === null ? '직접 고른 파일' : `남길 파일: ${op.keeper}`}, 논리 크기 ${op.expected.size} B)`;
  return [head, `    이유: ${op.reason}`];
}

export async function planCommand(target: string, values: PlanValues, ctx: { json: boolean; warn: (line: string) => void;
  stateDir: () => string; options: { signal?: AbortSignal } }): Promise<string> {
  const deleteMode = values['delete-mode'] ?? 'trash';
  if (deleteMode !== 'trash' && deleteMode !== 'permanent') throw usage('--delete-mode는 trash 또는 permanent입니다.');
  const dupSpec = values['delete-duplicates'];
  const dupPrefixes = dupSpec === undefined || dupSpec === 'all' ? [] : dupSpec.split(',').map((s) => s.trim().toLowerCase());
  if (dupPrefixes.some((p) => !/^[a-f0-9]{8,64}$/u.test(p)))
    throw usage('--delete-duplicates는 all 또는 쉼표로 구분한 중복 그룹 해시(앞 8자 이상)입니다.');

  const { grant, analysis, info, picked } = await analyzeTarget(target, values, { ...ctx, writesState: true });
  const { preview } = analysis;
  // analyzeRoot does not return its hashed scan, so take a second snapshot with the same hash exclusions (protected files).
  // buildPlan refuses it if the file list differs from the preview, and a changed duplicate fails the keeper hash check.
  const raw = await scanRoot(grant, ctx.options);
  if (raw.cancelled) throw new AfoError('CANCELLED', '분석을 취소했습니다.');
  const scan = await hashCandidates(grant, raw, { ...ctx.options, exclude: analysis.protected.map((p) => p.relativePath) });

  const deleteSelections: DeleteSelection[] | 'all-duplicates' | undefined = dupSpec === 'all' ? 'all-duplicates'
    : dupPrefixes.length ? dupPrefixes.map((prefix) => {
      const groups = preview.duplicates.filter((g) => g.sha256.startsWith(prefix));
      if (groups.length !== 1) throw new AfoError('KEEPER_INVALID', `중복 그룹을 하나로 찾을 수 없습니다: ${prefix}`);
      return { sha256: groups[0]!.sha256, candidates: groups[0]!.candidates };
    }) : undefined;
  const explicitDeletes = (values['delete-file'] ?? []).map((rel) => {
    const exact = preview.items.find((i) => i.source === rel);
    const folded = preview.items.filter((i) => pathKey(i.source) === pathKey(rel));
    return exact?.source ?? (folded.length === 1 ? folded[0]!.source : rel);
  });
  const plan = buildPlan(preview, { scan, grant, sessionId: grant.sessionId, deleteMode, now: new Date(),
    ...(deleteSelections ? { deleteSelections } : {}), ...(explicitDeletes.length ? { explicitDeletes } : {}) });

  const stateDir = path.resolve(ctx.stateDir());
  const rootId = ROOT_ID.test(preview.root.id) ? preview.root.id : null;
  // The previous plan of this root is read before the index is overwritten. Unreadable history only skips the comparison.
  let previous: SavedPlan | null = null;
  if (rootId !== null) {
    try {
      const latest = await readJson(latestFile(stateDir, rootId), LatestSchema);
      if (latest !== null) {
        previous = await loadSavedPlan(stateDir, latest.planId);
        if (previous === null) ctx.warn('참고: 이전 계획 파일이 없어 전체 작업을 표시합니다.');
      }
    } catch (error) { ctx.warn(`경고: 이전 계획을 읽지 못해 전체 작업을 표시합니다(${message(error)}).`); }
  }
  try { await savePlan(stateDir, plan, grant); }
  catch (error) {
    if (values.profile !== undefined && isAfoError(error, 'PROFILE_CHANGED'))
      throw new AfoError('PROFILE_CHANGED', '계획과 승인은 저장된 개인 규칙에만 묶입니다. --profile 파일의 규칙을 쓰려면 rules save로 저장한 뒤 plan을 실행하세요.');
    throw error;
  }
  if (rootId !== null) {
    try { await writeJsonAtomic(latestFile(stateDir, rootId), { formatVersion: 1, planId: plan.id }, LatestSchema); }
    catch (error) { ctx.warn(`경고: 최근 계획 기록을 저장하지 못했습니다(다음 plan에서 비교하지 않음): ${message(error)}`); }
  }

  const choices = approvalChoices(plan);
  if (ctx.json) return JSON.stringify({ planId: plan.id, plan, approvalChoices: choices, reviewItems: plan.reviewItems }, null, 2);
  return humanPlan(plan, previous, choices, { preview, info, once: new Set(picked.map((p) => p.fileId)), grant });
}

function humanPlan(plan: OperationPlan, previous: SavedPlan | null, choices: ReturnType<typeof approvalChoices>, extra: {
  preview: Preview; info: Parameters<typeof profileLine>[0]; once: Set<string>;
  grant: { device: string; inode: string } }): string {
  const lines = ['AFO 정리 계획 — 실제 파일은 변경하지 않았습니다(계획만 앱 상태 폴더에 저장).',
    `계획 ID: ${plan.id}`, `만료: ${plan.expiresAt} (지나면 다시 plan 하세요)`,
    `분석: ${extra.preview.items.length}개 / 스캔 ${extra.preview.scanComplete ? '완료' : '일부 미완료'} / 제외·오류 ${extra.preview.skipped.length}개`,
    profileLine(extra.info),
    `삭제 방식: ${plan.deleteMode === 'trash' ? '휴지통(trash) — OS 휴지통에서 복원 가능' : `영구 삭제(permanent) — 되돌릴 수 없습니다`}`];

  // Operation IDs hash the file identity, target and keeper, so an unchanged ID is the same operation the user already saw.
  let shown = new Set(plan.operations.map((op) => op.id));
  if (previous !== null) {
    const diff = diffPlans(previous.plan, plan);
    shown = new Set(diff.added);
    lines.push(`이전 계획(${previous.plan.id.slice(0, 12)}…, ${previous.plan.createdAt})과 비교: 그대로 ${diff.unchanged.length}개(목록 생략), ` +
      `새로 추가·바뀐 작업 ${diff.added.length}개, 빠진 작업 ${diff.removed.length}개. 바뀐 작업만 아래에 표시합니다.`);
    if (diff.profileChanged) lines.push('  참고: 개인 규칙(프로필 또는 revision)이 이전 계획과 다릅니다.');
    if (diff.deleteModeChanged) lines.push(`  참고: 삭제 방식이 ${previous.plan.deleteMode}에서 ${plan.deleteMode}로 바뀌었습니다.`);
    if (previous.grant.device !== extra.grant.device || previous.grant.inode !== extra.grant.inode)
      lines.push('  참고: 같은 경로의 폴더가 다른 폴더로 바뀌었습니다.');
    const removed = new Set(diff.removed);
    for (const op of previous.plan.operations.filter((o) => removed.has(o.id)))
      lines.push(`  [빠짐] ${op.id} ${kindLabel[op.kind]} ${op.source}${op.destination ? ` → ${op.destination}` : ''}`);
  }

  const { move, trash, delete: purge } = plan.summary;
  lines.push(`작업 ${plan.operations.length}개: 이동 ${move}, 휴지통 ${trash}, 영구 삭제 ${purge}`);
  for (const choice of choices) {
    const kind = approvalModeKind[choice.mode];
    const ops = plan.operations.filter((op) => op.kind === kind);
    const bytes = ops.reduce((sum, op) => sum + op.expected.size, 0);
    lines.push(`[${modeLabel[choice.mode]}] ${ops.length}개${kind === 'move' ? '' : ` — 논리 크기 합계 ${bytes} B (확보량 아님)`}`);
    const visible = ops.filter((op) => shown.has(op.id));
    if (!visible.length) lines.push('  (모두 이전 계획과 같음)');
    for (const op of visible) lines.push(...opLines(op, extra.once));
  }

  if (extra.preview.duplicates.length) {
    const deleted = new Set(plan.operations.filter((op) => op.kind !== 'move').map((op) => op.source));
    lines.push('중복 후보 그룹(내용 해시가 같음). 지우려면 --delete-duplicates <해시 앞 12자> 또는 all:');
    for (const g of extra.preview.duplicates) lines.push(`  ${g.sha256.slice(0, 12)} 남길 파일: ${g.suggestedKeep} / 삭제 후보: ${g.candidates.join(', ')}` +
      ` (논리 크기 ${g.logicalCandidateBytes} B, 확보량 아님)${g.candidates.some((c) => deleted.has(c)) ? ' — 이번 계획에 포함' : ''}`);
  }

  const groups = new Map<string, { status: ReviewItem['status']; reason: string; sources: string[] }>();
  for (const item of plan.reviewItems) {
    const key = `${item.status}\u0000${item.reason}`;
    const group = groups.get(key) ?? { status: item.status, reason: item.reason, sources: [] };
    group.sources.push(item.source); groups.set(key, group);
  }
  lines.push(`검토·유지 항목 ${plan.reviewItems.length}개(계획에 넣지 않음, 바꾸지 않음)${groups.size ? ':' : ''}`);
  for (const g of groups.values())
    lines.push(`  [${statusLabel[g.status]}] ${g.sources.length}개: ${g.reason}`, `    예: ${g.sources.slice(0, 3).join(', ')}${g.sources.length > 3 ? ', …' : ''}`);

  if (!choices.length) lines.push('실행할 작업이 없어 승인 코드가 없습니다.');
  else {
    lines.push('승인 코드(방식마다 그 방식의 작업 전체를 한 번에 승인합니다. 이 계획 ID와 작업 목록에만 유효):');
    for (const c of choices) lines.push(`  ${c.mode} (${kindLabel[approvalModeKind[c.mode]]} ${c.operationIds.length}개): ${c.code}` +
      (c.mode === 'permanent-delete' ? ` — 되돌릴 수 없습니다. 실행할 때 확인 문구 "${PERMANENT_DELETE_PHRASE}"도 입력해야 합니다.` : ''));
  }
  lines.push('실행 명령은 다음 버전에서 제공합니다. 이 버전은 파일을 옮기거나 지우지 않습니다.');
  return lines.join('\n');
}
