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
