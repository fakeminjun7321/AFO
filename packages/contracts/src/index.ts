import { z } from 'zod';

/** Keep real spelling, including NFD; normalizing an input path may address a different file. */
export const RelativePathSchema = z.string().min(1).max(4096).refine((value) =>
  !/[\\<>:"|?*\u0000-\u001f\u007f]/u.test(value) &&
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' &&
    !/[. ]$/u.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)),
  '지원하는 상대 경로가 아닙니다.');

/* ---- Scan/classification extensions (#6/#7). Added fields are optional so earlier JSON stays valid. ---- */
/** Machine code for an excluded or failed scan entry. `reason` remains the short Korean text. */
export const SkipCodeSchema = z.enum(['HIDDEN', 'APP_BUNDLE', 'DEV_PROJECT', 'SYSTEM_PATH', 'LINK', 'HARDLINK', 'NOT_REGULAR',
  'UNSUPPORTED_NAME', 'TOO_LARGE', 'OTHER_VOLUME', 'OUTSIDE_ROOT', 'DEPTH_LIMIT', 'COUNT_LIMIT', 'READ_FAILED',
  'CLOUD_PLACEHOLDER', 'REFERENCE_FILE', 'HASH_FAILED', 'FILE_CHANGED']);
export type SkipCode = z.infer<typeof SkipCodeSchema>;
/** User-facing explanation per code (Korean). */
export const skipCodeDescriptions: Readonly<Record<SkipCode, string>> = {
  HIDDEN: '숨김 파일·폴더는 정리 대상에서 뺍니다.',
  APP_BUNDLE: '앱·라이브러리 묶음 내부를 바꾸면 앱이 망가질 수 있어 제외합니다.',
  DEV_PROJECT: '개발 프로젝트·빌드·의존성 폴더는 이름만으로 정리할 수 없어 제외합니다.',
  SYSTEM_PATH: '운영체제가 관리하는 항목이라 제외합니다.',
  LINK: '링크·바로가기·junction은 다른 위치를 가리킬 수 있어 따라가지 않습니다.',
  HARDLINK: '같은 내용이 여러 이름으로 연결된 파일(하드링크)은 이동·삭제·용량 계산에서 제외합니다.',
  NOT_REGULAR: '일반 파일이 아닌 항목(장치·소켓·파이프 등)은 제외합니다.',
  UNSUPPORTED_NAME: 'Windows·macOS 모두에서 안전하게 다룰 수 없는 이름이라 제외합니다.',
  TOO_LARGE: '크기를 정확히 계산할 수 없을 만큼 큰 파일이라 제외합니다.',
  OTHER_VOLUME: '다른 디스크(볼륨)에 있는 폴더라 제외합니다.',
  OUTSIDE_ROOT: '실제 위치가 선택한 폴더 밖이라 제외합니다.',
  DEPTH_LIMIT: '폴더 깊이 한도에 도달해 더 깊은 곳은 읽지 않았습니다.',
  COUNT_LIMIT: '파일 개수 한도에 도달해 나머지는 읽지 않았습니다.',
  READ_FAILED: '접근 권한이 없거나 읽는 중 사라진 항목입니다.',
  CLOUD_PLACEHOLDER: '디스크에 내용이 없는 파일(클라우드 전용 또는 희소 파일 가능성)이라 내려받지 않고 제외합니다.',
  REFERENCE_FILE: '참고한 기존 파일이라 이동·삭제하지 않습니다.',
  HASH_FAILED: '내용을 읽지 못해 중복 여부를 확인하지 않았습니다.',
  FILE_CHANGED: '분석 중 파일이 바뀌어 결과를 쓰지 않았습니다.',
};
/** Codes that mean the scan or hash result is incomplete (as opposed to a deliberate exclusion). */
export const incompleteSkipCodes: readonly SkipCode[] = ['DEPTH_LIMIT', 'COUNT_LIMIT', 'READ_FAILED', 'OUTSIDE_ROOT',
  'HASH_FAILED', 'FILE_CHANGED'];
export const SkippedEntrySchema = z.strictObject({
  relativePath: z.string(), reason: z.string(), code: SkipCodeSchema.optional(),
  /** OS error code such as EACCES, when one exists. Never a path or file content. */
  detail: z.string().regex(/^[A-Z0-9_]{1,32}$/u).optional(),
});
export type SkippedEntry = z.infer<typeof SkippedEntrySchema>;
const OptionalBytesSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const RootSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/u), canonicalPath: z.string().min(1), readOnly: z.literal(true),
});
export const FileSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/u), relativePath: RelativePathSchema,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  modifiedNs: z.string().regex(/^\d+$/u), device: z.string(), inode: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  /** st_blocks*512 where the OS reports a trustworthy value; null when unknown (e.g. Windows). */
  allocatedBytes: OptionalBytesSchema.nullable().optional(),
});
export const ScanSchema = z.strictObject({
  root: RootSchema, files: z.array(FileSchema), directories: z.array(RelativePathSchema),
  skipped: z.array(SkippedEntrySchema),
  complete: z.boolean(),
  /** true when the caller asked for a partial result on cancellation. */
  cancelled: z.boolean().optional(),
}).superRefine((scan, ctx) => {
  if (scan.cancelled === true && scan.complete) ctx.addIssue({ code: 'custom', message: '취소된 스캔은 완료일 수 없습니다.' });
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
/** Classification rule set version. Changing default rules must change this value. */
export const CLASSIFICATION_VERSION = 'default-2';
export const ClassificationReasonSchema = z.enum(['USER_OVERRIDE', 'PERSONAL_RULE', 'DEFAULT_EXTENSION', 'ALREADY_PLACED',
  'PROTECTED_REFERENCE', 'READ_FAILED', 'RULE_CONFLICT', 'COMPOUND_EXTENSION', 'NO_EXTENSION', 'UNKNOWN_EXTENSION',
  'DEST_CONFLICT', 'DEST_COLLISION', 'PARENT_CONFLICT', 'SAVED_CORRECTION', 'DEST_INVALID']);
export type ClassificationReason = z.infer<typeof ClassificationReasonSchema>;
export const PreviewItemSchema = z.strictObject({
  fileId: z.string(), source: RelativePathSchema, destination: RelativePathSchema.nullable(),
  action: z.enum(['move', 'keep', 'review']), reason: z.string(), ruleId: z.string().nullable(),
  reasonCode: ClassificationReasonSchema.optional(), category: z.string().min(1).nullable().optional(),
});
export const DuplicateMemberSchema = z.strictObject({
  relativePath: RelativePathSchema, allocatedBytes: OptionalBytesSchema.nullable(), protected: z.boolean(),
});
const dupKey = (value: string): string => value.normalize('NFC').toLowerCase();
export const DuplicateSchema = z.strictObject({
  sha256: z.string(), suggestedKeep: RelativePathSchema,
  candidates: z.array(RelativePathSchema), logicalCandidateBytes: z.number().nonnegative(),
  /** Every file with this content (sorted), including protected ones that are never candidates. */
  size: OptionalBytesSchema.optional(), members: z.array(DuplicateMemberSchema).min(2).optional(),
  keepReason: z.string().min(1).optional(),
  /** Sum of known allocations of candidates; null when any is unknown. */
  allocatedCandidateBytes: OptionalBytesSchema.nullable().optional(),
  /** Estimate only: allocation (or logical size when unknown) of candidates. Clones, snapshots and trash change the real result. */
  reclaimableEstimateBytes: OptionalBytesSchema.optional(),
}).superRefine((group, ctx) => {
  if (new Set(group.candidates.map(dupKey)).size !== group.candidates.length ||
      group.candidates.some((c) => dupKey(c) === dupKey(group.suggestedKeep)))
    ctx.addIssue({ code: 'custom', message: '남길 파일과 후보가 겹치거나 후보가 중복됩니다.' });
  if (group.members === undefined) return;
  const members = new Map(group.members.map((m) => [dupKey(m.relativePath), m]));
  if (members.size !== group.members.length || !members.has(dupKey(group.suggestedKeep)) ||
      group.candidates.some((c) => members.get(dupKey(c))?.protected !== false))
    ctx.addIssue({ code: 'custom', message: '중복 후보는 같은 그룹의 보호되지 않은 파일이어야 합니다.' });
});
export const DuplicateNoteSchema = z.strictObject({
  relativePath: RelativePathSchema, code: z.enum(['EMPTY_FILE', 'HASH_UNAVAILABLE']), reason: z.string().min(1),
});
export const SpaceEstimateSchema = z.strictObject({
  logicalCandidateBytes: OptionalBytesSchema, allocatedCandidateBytes: OptionalBytesSchema.nullable(),
  reclaimableEstimateBytes: OptionalBytesSchema, note: z.string().min(1),
});
export const PreviewSchema = z.strictObject({
  formatVersion: z.literal(1), mode: z.literal('preview-only'), id: z.string(), root: RootSchema,
  profileRevision: z.number().int().positive().nullable(), items: z.array(PreviewItemSchema),
  /** Profile applied to this preview (#18); set together with profileRevision so #8 can bind plans and approvals. */
  profileId: z.string().min(1).nullable().optional(),
  duplicates: z.array(DuplicateSchema), largeFiles: z.array(RelativePathSchema),
  skipped: z.array(SkippedEntrySchema),
  scanComplete: z.boolean(), executionAvailable: z.literal(false),
  classificationVersion: z.string().min(1).optional(), duplicateNotes: z.array(DuplicateNoteSchema).optional(),
  space: SpaceEstimateSchema.optional(), cancelled: z.boolean().optional(),
  /** Saved profile not applied because its reference folder looks moved/renamed (#18). Reference files stay protected. */
  profileNotice: z.strictObject({ code: z.literal('PROFILE_STALE'), reason: z.string().min(1) }).optional(),
});
export type FileSnapshot = z.infer<typeof FileSchema>;
export type ScanResult = z.infer<typeof ScanSchema>;
export type RuleProfile = z.infer<typeof ProfileSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type PreviewItem = z.infer<typeof PreviewItemSchema>;
export type Preview = z.infer<typeof PreviewSchema>;
export type Duplicate = z.infer<typeof DuplicateSchema>;
export type DuplicateNote = z.infer<typeof DuplicateNoteSchema>;
export type SpaceEstimate = z.infer<typeof SpaceEstimateSchema>;

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
/** Opaque random IDs (session, approval, run): lowercase UUID-like, so two IDs never share a file name on case-insensitive volumes. */
export const OpaqueIdSchema = z.string().regex(/^[a-z0-9-]{8,128}$/u);
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


/* ---- Reference reading and progress (#6). ---- */
/** Reference folders yield structure, names and extensions only: no sizes, identities or content hashes. */
export const ReferenceScanSchema = z.strictObject({
  formatVersion: z.literal(1), mode: z.literal('reference-metadata'), grantId: Sha256Schema, root: RootSchema,
  files: z.array(z.strictObject({ relativePath: RelativePathSchema, extension: z.string().regex(/^\.[^./]{1,32}$/u).nullable() })),
  directories: z.array(RelativePathSchema), skipped: z.array(SkippedEntrySchema),
  complete: z.boolean(), cancelled: z.boolean().optional(),
}).superRefine((scan, ctx) => {
  if (duplicated(scan.files.map((f) => f.relativePath))) issue(ctx, '중복 참고 파일 경로입니다.');
  if (scan.cancelled === true && scan.complete) issue(ctx, '취소된 스캔은 완료일 수 없습니다.');
});
export type ReferenceScan = z.infer<typeof ReferenceScanSchema>;
/** Reference files inside the work root: shown as keep, never moved, deleted or hashed. */
export const ProtectedEntrySchema = z.strictObject({
  relativePath: RelativePathSchema, code: z.literal('REFERENCE_FILE'), reason: z.string().min(1),
});
export type ProtectedEntry = z.infer<typeof ProtectedEntrySchema>;
export const ScanProgressSchema = z.strictObject({
  phase: z.enum(['scan', 'reference', 'hash']), directories: ByteCountSchema, files: ByteCountSchema, skipped: ByteCountSchema,
  hashedFiles: ByteCountSchema, hashTargets: ByteCountSchema, bytesHashed: ByteCountSchema, bytesToHash: ByteCountSchema,
});
export type ScanProgress = z.infer<typeof ScanProgressSchema>;

/* ---- Saved personal rules (#18). ProfileSchema (v1) stays readable; only a confirmed v1 converts to v2. ---- */
/** Stored evidence examples per rule. More would copy the reference folder's file list into app data. */
export const PROFILE_EVIDENCE_LIMIT = 3;
/** Relative folder under the work root. Hidden segments are refused: the scanner skips them, so moved files would vanish from view. */
export const TargetDirectorySchema = RelativePathSchema.refine((value) => value.split('/').every((part) => !part.startsWith('.')),
  '숨김 폴더는 목적지가 될 수 없습니다.');
const FileNameSchema = z.string().min(1).max(255).refine((value) => !value.includes('/') && RelativePathSchema.safeParse(value).success,
  '파일 이름 하나가 필요합니다.');
const ExtensionSchema = z.string().regex(/^\.[a-z0-9]{1,16}$/u);
export const SavedRuleSchema = z.strictObject({
  id: z.string().min(1).max(128), extension: ExtensionSchema, keyword: z.string().min(2).max(80).nullable(),
  targetDirectory: TargetDirectorySchema,
  /** A few reference-relative examples for explanation; evidenceCount is how many reference files supported the rule. */
  evidence: z.array(RelativePathSchema).min(2).max(PROFILE_EVIDENCE_LIMIT), evidenceCount: z.number().int().min(2).max(1_000_000),
  enabled: z.boolean(),
}).superRefine((rule, ctx) => {
  if (duplicated(rule.evidence)) issue(ctx, '서로 다른 참고 파일 근거가 필요합니다.');
  if (rule.evidenceCount < rule.evidence.length) issue(ctx, '근거 개수가 예시보다 적습니다.');
});
/** Exact file name, or extension plus optional filename keyword. Compared case- and Unicode-insensitively. */
export const CorrectionMatchSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('file-name'), name: FileNameSchema }),
  z.strictObject({ type: z.literal('keyword'), extension: ExtensionSchema, keyword: z.string().min(1).max(80).nullable() }),
]);
/** Explicit user correction saved with "이후에도 적용". One-off corrections are never stored. */
export const CorrectionSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{16}$/u), match: CorrectionMatchSchema, targetDirectory: TargetDirectorySchema, createdAt: InstantSchema,
});
export const correctionMatchKey = (match: z.infer<typeof CorrectionMatchSchema>): string => match.type === 'file-name'
  ? JSON.stringify(['file-name', key(match.name)]) : JSON.stringify(['keyword', match.extension, match.keyword === null ? null : key(match.keyword)]);
export const RuleProfileV2Schema = z.strictObject({
  formatVersion: z.literal(2), id: z.string().min(1).max(128), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['confirmed', 'disabled']),
  /**
   * Reference folder: display name (last path segment) and RootSchema.id (sha256 of its real path), never the path itself.
   * The ID lets a later analysis recognise that folder inside or around a work root and keep its files untouched.
   */
  referenceRootId: Sha256Schema.nullable(),
  /** dev/inode of the reference folder when saved: recognises it after a same-volume rename or move. Absent in early v2 files. */
  referenceRootIdentity: z.strictObject({ device: DigitsSchema, inode: DigitsSchema }).nullable().optional(),
  referenceRootLabel: z.string().min(1).max(255).refine((v) => !/[\\/\u0000]/u.test(v), '폴더 이름만 저장합니다.').nullable(),
  rules: z.array(SavedRuleSchema).max(1000), corrections: z.array(CorrectionSchema).max(1000), updatedAt: InstantSchema,
}).superRefine((p, ctx) => {
  if (duplicated(p.rules.map((r) => r.id))) issue(ctx, '중복 규칙 ID입니다.');
  if (duplicated(p.corrections.map((c) => c.id))) issue(ctx, '중복 수정 ID입니다.');
  if (duplicated(p.corrections.map((c) => correctionMatchKey(c.match)))) issue(ctx, '같은 조건의 저장 수정이 둘 이상입니다.');
});
/** profiles/active.json. 'empty' keeps the last revision after a reset so a (profileId, revision) pair is never reused. */
export const ProfileStoreSchema = z.discriminatedUnion('state', [
  z.strictObject({ formatVersion: z.literal(2), state: z.literal('active'), profile: RuleProfileV2Schema }),
  z.strictObject({ formatVersion: z.literal(2), state: z.literal('empty'), lastRevision: z.number().int().nonnegative(), updatedAt: InstantSchema }),
]);
export type SavedRule = z.infer<typeof SavedRuleSchema>;
export type CorrectionMatch = z.infer<typeof CorrectionMatchSchema>;
export type Correction = z.infer<typeof CorrectionSchema>;
export type RuleProfileV2 = z.infer<typeof RuleProfileV2Schema>;
export type ProfileStore = z.infer<typeof ProfileStoreSchema>;

/* ---- Plans and one-time batch approvals (#8). Storage wrappers; the shared service is the only writer. ---- */
/** Plans expire this long after creation; approvals never outlive their plan. */
export const PLAN_TTL_MS = 60 * 60 * 1000;
/** Exact phrase the user types (in addition to the approval code) for permanent deletion. */
export const PERMANENT_DELETE_PHRASE = '영구 삭제';
/** Root identity at plan time. Not covered by the plan hash, so approvals repeat it under their MAC. */
export const GrantIdentitySchema = z.strictObject({
  canonicalPath: AbsolutePathSchema, device: DigitsSchema, inode: DigitsSchema, sessionId: OpaqueIdSchema,
});
/** plans/<planId>.json */
export const SavedPlanSchema = z.strictObject({ plan: OperationPlanSchema, grant: GrantIdentitySchema }).superRefine((s, ctx) => {
  if (s.grant.canonicalPath !== s.plan.rootPath || s.grant.sessionId !== s.plan.sessionId) issue(ctx, '계획과 작업 폴더 식별이 다릅니다.');
});
/** approvals/<approvalId>.json. mac = HMAC-SHA256(state secret, approval without usedAt + grant). */
export const SavedApprovalSchema = z.strictObject({
  formatVersion: z.literal(1), approval: ApprovalSchema, grant: GrantIdentitySchema, mac: Sha256Schema,
});
/** What an interface may send to request an approval. Strict: extra keys such as `approved: true` are refused. */
export const ApprovalRequestSchema = z.strictObject({
  planId: Sha256Schema, operationIds: z.array(OperationIdSchema).min(1), mode: ApprovalModeSchema,
  confirmation: z.string().regex(/^[a-f0-9]{8}$/u), confirmPhrase: z.string().max(64).optional(),
});
export type GrantIdentity = z.infer<typeof GrantIdentitySchema>;
export type SavedPlan = z.infer<typeof SavedPlanSchema>;
export type SavedApproval = z.infer<typeof SavedApprovalSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
