import { z } from 'zod';

/** Keep real spelling, including NFD; normalizing an input path may address a different file. */
export const RelativePathSchema = z.string().min(1).max(4096).refine((value) =>
  !/[\\<>:"|?*\u0000-\u001f\u007f]/u.test(value) &&
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' &&
    !/[. ]$/u.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)),
  '지원하는 상대 경로가 아닙니다.');

export const RootSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/u), canonicalPath: z.string().min(1), readOnly: z.literal(true),
});
export const FileSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/u), relativePath: RelativePathSchema,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  modifiedNs: z.string().regex(/^\d+$/u), device: z.string(), inode: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
});
export const ScanSchema = z.strictObject({
  root: RootSchema, files: z.array(FileSchema), directories: z.array(RelativePathSchema),
  skipped: z.array(z.strictObject({ relativePath: z.string(), reason: z.string() })),
  complete: z.boolean(),
}).superRefine((scan, ctx) => {
  if (new Set(scan.files.map((f) => f.id)).size !== scan.files.length ||
      new Set(scan.files.map((f) => f.relativePath)).size !== scan.files.length)
    ctx.addIssue({ code: 'custom', message: '중복 파일 식별자 또는 경로입니다.' });
});
export const RuleSchema = z.strictObject({
  id: z.string().min(1), extension: z.string().regex(/^\.[a-z0-9]{1,16}$/u),
  keyword: z.string().min(2).max(80).nullable(), targetDirectory: RelativePathSchema,
  evidence: z.array(RelativePathSchema).min(2).refine((items) => new Set(items).size === items.length,
    '서로 다른 참고 파일 근거가 필요합니다.'),
});
export const ProfileSchema = z.strictObject({
  formatVersion: z.literal(1), id: z.string().min(1), revision: z.number().int().positive(),
  status: z.enum(['draft', 'confirmed', 'disabled']), referenceRoot: RootSchema,
  referenceFiles: z.array(RelativePathSchema), rules: z.array(RuleSchema),
}).superRefine((p, ctx) => {
  if (new Set(p.rules.map((r) => r.id)).size !== p.rules.length)
    ctx.addIssue({ code: 'custom', message: '중복 규칙 ID입니다.' });
  const references = new Set(p.referenceFiles);
  if (p.rules.some((r) => r.evidence.some((file) => !references.has(file))))
    ctx.addIssue({ code: 'custom', message: '참고 파일에 없는 규칙 근거입니다.' });
});
export const PreviewItemSchema = z.strictObject({
  fileId: z.string(), source: RelativePathSchema, destination: RelativePathSchema.nullable(),
  action: z.enum(['move', 'keep', 'review']), reason: z.string(), ruleId: z.string().nullable(),
});
export const DuplicateSchema = z.strictObject({
  sha256: z.string(), suggestedKeep: RelativePathSchema,
  candidates: z.array(RelativePathSchema), logicalCandidateBytes: z.number().nonnegative(),
});
export const PreviewSchema = z.strictObject({
  formatVersion: z.literal(1), mode: z.literal('preview-only'), id: z.string(), root: RootSchema,
  profileRevision: z.number().int().positive().nullable(), items: z.array(PreviewItemSchema),
  duplicates: z.array(DuplicateSchema), largeFiles: z.array(RelativePathSchema),
  skipped: z.array(z.strictObject({ relativePath: z.string(), reason: z.string() })),
  scanComplete: z.boolean(), executionAvailable: z.literal(false),
});
export type FileSnapshot = z.infer<typeof FileSchema>;
export type ScanResult = z.infer<typeof ScanSchema>;
export type RuleProfile = z.infer<typeof ProfileSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type PreviewItem = z.infer<typeof PreviewItemSchema>;
export type Preview = z.infer<typeof PreviewSchema>;

/* ---- Write path contracts (#4). Shape and consistency only; the shared service enforces authority. ---- */
export const ErrorCodeSchema = z.enum(['ROOT_FORBIDDEN', 'PATH_OUTSIDE_ROOT', 'LINK_REJECTED', 'FILE_CHANGED',
  'SOURCE_MISSING', 'DEST_EXISTS', 'CROSS_VOLUME', 'NOT_SUPPORTED', 'PERMISSION_DENIED', 'LOCKED_BY_OTHER', 'FILE_BUSY',
  'APPROVAL_MISSING', 'APPROVAL_INVALID', 'APPROVAL_EXPIRED', 'APPROVAL_USED', 'PLAN_CHANGED', 'PROFILE_CHANGED',
  'MODE_MISMATCH', 'KEEPER_INVALID', 'JOURNAL_FAILED', 'TRASH_FAILED', 'STATE_DIR_CONFLICT', 'STATE_DIR_INVALID',
  'STATE_CORRUPT', 'DISK_FULL', 'CANCELLED', 'UNKNOWN']);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export class AfoError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AfoError';
    this.code = ErrorCodeSchema.parse(code);
  }
}
export const isAfoError = (value: unknown, code?: ErrorCode): value is AfoError =>
  value instanceof AfoError && (code === undefined || value.code === code);

/** Approvals live at most this long after issue. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
/** Opaque random IDs (session, approval, run): UUID-like and safe as a file name. */
export const OpaqueIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,128}$/u);
export const OperationIdSchema = z.string().regex(/^[a-f0-9]{8,64}$/u);
const InstantSchema = z.iso.datetime();
const DigitsSchema = z.string().regex(/^\d+$/u);
const ByteCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** POSIX, Windows drive or UNC absolute path; Win32 device/namespace paths (\\?\, \\.\) are rejected. Which form is valid on this OS is the adapter's check. */
const AbsolutePathSchema = z.string().min(1).max(4096).refine((value) => !value.includes('\u0000') &&
  (/^\//u.test(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\(?![?.]\\)[^\\]/u.test(value)), '절대 경로가 필요합니다.');
const key = (value: string): string => value.normalize('NFC').toLowerCase();
const later = (a: string, b: string): boolean => Date.parse(a) > Date.parse(b);
const duplicated = (values: string[]): boolean => new Set(values).size !== values.length;
const issue = (ctx: z.RefinementCtx, message: string): void => { ctx.addIssue({ code: 'custom', message }); };

const grantShape = { formatVersion: z.literal(1), id: Sha256Schema, canonicalPath: AbsolutePathSchema,
  device: DigitsSchema, inode: DigitsSchema, sessionId: OpaqueIdSchema, issuedAt: InstantSchema };
export const RootGrantSchema = z.strictObject({ ...grantShape, scope: z.literal('work') });
/** Reference folders are read-only; write APIs accept RootGrant (scope 'work') only. */
export const ReferenceGrantSchema = z.strictObject({ ...grantShape, scope: z.literal('reference'), readOnly: z.literal(true) });

export const OperationKindSchema = z.enum(['move', 'trash', 'delete']);
export const ExpectedFileSchema = z.strictObject({
  size: ByteCountSchema, modifiedNs: DigitsSchema, device: DigitsSchema, inode: DigitsSchema, sha256: Sha256Schema.nullable(),
});
export const PlanOperationSchema = z.strictObject({
  id: OperationIdSchema, kind: OperationKindSchema, fileId: Sha256Schema, source: RelativePathSchema,
  destination: RelativePathSchema.nullable(), reason: z.string().min(1), ruleId: z.string().min(1).nullable(),
  keeper: RelativePathSchema.nullable(), expected: ExpectedFileSchema,
}).superRefine((op, ctx) => {
  if ((op.kind === 'move') !== (op.destination !== null)) issue(ctx, 'move 작업만 목적지를 가집니다.');
  if (op.destination !== null && key(op.destination) === key(op.source)) issue(ctx, '목적지가 원래 경로와 같습니다.');
  if (op.keeper !== null) {
    if (op.kind === 'move') issue(ctx, 'move 작업에는 남길 파일이 없습니다.');
    if (key(op.keeper) === key(op.source)) issue(ctx, '남길 파일이 삭제 대상과 같습니다.');
    if (op.expected.sha256 === null) issue(ctx, '남길 파일과 비교할 내용 해시가 필요합니다.');
  }
});
export const ReviewItemSchema = z.strictObject({
  fileId: Sha256Schema, source: RelativePathSchema, status: z.enum(['keep', 'review']), reason: z.string().min(1),
});
export const OperationPlanSchema = z.strictObject({
  formatVersion: z.literal(1), id: Sha256Schema, rootGrantId: Sha256Schema, rootPath: AbsolutePathSchema,
  sessionId: OpaqueIdSchema, createdAt: InstantSchema, expiresAt: InstantSchema,
  profileId: z.string().min(1).nullable(), profileRevision: z.number().int().positive().nullable(),
  deleteMode: z.enum(['trash', 'permanent']), operations: z.array(PlanOperationSchema), reviewItems: z.array(ReviewItemSchema),
  /** logicalBytes = sum of expected.size over all operations: logical size, not reclaimed space. */
  summary: z.strictObject({ move: ByteCountSchema, trash: ByteCountSchema, delete: ByteCountSchema, logicalBytes: ByteCountSchema }),
}).superRefine((plan, ctx) => {
  if ((plan.profileId === null) !== (plan.profileRevision === null)) issue(ctx, '프로필 ID와 버전은 함께 있어야 합니다.');
  if (!later(plan.expiresAt, plan.createdAt)) issue(ctx, '계획 만료 시각이 생성 시각보다 늦어야 합니다.');
  const ops = plan.operations;
  if (duplicated(ops.map((op) => op.id))) issue(ctx, '중복 작업 ID입니다.');
  const items = [...ops, ...plan.reviewItems];
  if (duplicated(items.map((item) => item.fileId)) || duplicated(items.map((item) => key(item.source))))
    issue(ctx, '한 파일에 작업·검토 항목이 둘 이상입니다.');
  const sources = new Set(ops.map((op) => key(op.source)));
  const destinations = ops.flatMap((op) => op.destination === null ? [] : [key(op.destination)]);
  if (duplicated(destinations) || destinations.some((d) => sources.has(d))) issue(ctx, '목적지가 겹치거나 다른 작업 대상과 같습니다.');
  if (ops.some((op) => op.keeper !== null && sources.has(key(op.keeper)))) issue(ctx, '남길 파일이 같은 계획의 작업 대상입니다.');
  if (ops.some((op) => op.kind === (plan.deleteMode === 'trash' ? 'delete' : 'trash'))) issue(ctx, '삭제 방식과 작업 종류가 다릅니다.');
  const count = (kind: OperationKind): number => ops.filter((op) => op.kind === kind).length;
  const bytes = ops.reduce((sum, op) => sum + op.expected.size, 0);
  if (plan.summary.move !== count('move') || plan.summary.trash !== count('trash') ||
      plan.summary.delete !== count('delete') || plan.summary.logicalBytes !== bytes) issue(ctx, '요약이 작업 목록과 다릅니다.');
});

export const ApprovalModeSchema = z.enum(['organize', 'trash', 'permanent-delete']);
/** One approval covers exactly one operation kind; mixed selections are MODE_MISMATCH. */
export const approvalModeKind = { organize: 'move', trash: 'trash', 'permanent-delete': 'delete' } as const satisfies
  Record<z.infer<typeof ApprovalModeSchema>, z.infer<typeof OperationKindSchema>>;
export const ApprovalSchema = z.strictObject({
  formatVersion: z.literal(1), id: OpaqueIdSchema, planId: Sha256Schema, sessionId: OpaqueIdSchema, rootGrantId: Sha256Schema,
  operationIds: z.array(OperationIdSchema).min(1), mode: ApprovalModeSchema,
  profileId: z.string().min(1).nullable(), profileRevision: z.number().int().positive().nullable(),
  issuedAt: InstantSchema, expiresAt: InstantSchema, usedAt: InstantSchema.nullable(),
}).superRefine((a, ctx) => {
  if (a.operationIds.some((id, i) => i > 0 && !(a.operationIds[i - 1]! < id))) issue(ctx, '작업 ID는 중복 없이 정렬해야 합니다.');
  if ((a.profileId === null) !== (a.profileRevision === null)) issue(ctx, '프로필 ID와 버전은 함께 있어야 합니다.');
  if (!later(a.expiresAt, a.issuedAt)) issue(ctx, '승인 만료 시각이 발급 시각보다 늦어야 합니다.');
  if (Date.parse(a.expiresAt) - Date.parse(a.issuedAt) > APPROVAL_TTL_MS) issue(ctx, '승인 유효 기간이 너무 깁니다.');
  if (a.usedAt !== null && later(a.issuedAt, a.usedAt)) issue(ctx, '사용 시각이 발급 시각보다 이릅니다.');
});

const IdentitySchema = z.strictObject({ device: DigitsSchema, inode: DigitsSchema, size: ByteCountSchema, sha256: Sha256Schema.nullable() });
export const JournalPhaseSchema = z.enum(['intent', 'done', 'failed', 'skipped', 'undo-intent', 'undone']);
export const JournalEntrySchema = z.strictObject({
  formatVersion: z.literal(1), runId: OpaqueIdSchema, seq: z.number().int().nonnegative(), opId: OperationIdSchema,
  /** planId and rootGrantId let recovery after a restart resolve the relative paths against the right root. */
  planId: Sha256Schema, rootGrantId: Sha256Schema, approvalId: OpaqueIdSchema, phase: JournalPhaseSchema, kind: OperationKindSchema, source: RelativePathSchema,
  destination: RelativePathSchema.nullable(), before: IdentitySchema, after: IdentitySchema.nullable(),
  errorCode: ErrorCodeSchema.nullable(), at: InstantSchema,
}).superRefine((e, ctx) => {
  const finishedMove = e.kind === 'move' && (e.phase === 'done' || e.phase === 'undone');
  if ((e.kind === 'move') !== (e.destination !== null)) issue(ctx, 'move 기록만 목적지를 가집니다.');
  if ((e.phase === 'undo-intent' || e.phase === 'undone') && e.kind !== 'move') issue(ctx, '이동만 되돌릴 수 있습니다.');
  if ((e.phase === 'failed' || e.phase === 'skipped') !== (e.errorCode !== null)) issue(ctx, '실패·건너뜀 기록에만 오류 코드가 있습니다.');
  if (finishedMove !== (e.after !== null)) issue(ctx, '완료된 이동만, 그리고 반드시 이후 식별을 가집니다.');
});

export const ResultStatusSchema = z.enum(['moved', 'trashed', 'deleted', 'skipped', 'failed', 'unknown']);
export const ExecutionReportSchema = z.strictObject({
  formatVersion: z.literal(1), runId: OpaqueIdSchema, planId: Sha256Schema, approvalId: OpaqueIdSchema,
  results: z.array(z.strictObject({ opId: OperationIdSchema, status: ResultStatusSchema, errorCode: ErrorCodeSchema.nullable(), detail: z.string() })),
  /** Trash moves are not reclaimed space; free-space values are observations other processes may affect. */
  space: z.strictObject({ logicalBytesSelected: ByteCountSchema, freeBytesBefore: ByteCountSchema.nullable(),
    freeBytesAfter: ByteCountSchema.nullable(), note: z.string() }),
}).superRefine((r, ctx) => {
  if (duplicated(r.results.map((x) => x.opId))) issue(ctx, '중복 작업 결과입니다.');
  for (const x of r.results) {
    if ((x.status === 'failed' || x.status === 'skipped') && x.errorCode === null) issue(ctx, '실패·건너뜀 결과에는 오류 코드가 필요합니다.');
    if ((x.status === 'moved' || x.status === 'trashed' || x.status === 'deleted') && x.errorCode !== null) issue(ctx, '성공 결과에 오류 코드가 있습니다.');
  }
});
export type RootGrant = z.infer<typeof RootGrantSchema>;
export type ReferenceGrant = z.infer<typeof ReferenceGrantSchema>;
export type OperationKind = z.infer<typeof OperationKindSchema>;
export type PlanOperation = z.infer<typeof PlanOperationSchema>;
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
export type OperationPlan = z.infer<typeof OperationPlanSchema>;
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export type ExecutionReport = z.infer<typeof ExecutionReportSchema>;
