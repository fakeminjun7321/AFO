import { z } from 'zod';

export const RuleSetId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const label = z.string().min(1).max(80).regex(/^[^/\\:\u0000-\u001f\u007f]+$/u);
const relativeDirectory = z.string().min(1).max(512).refine((s) =>
  !/[\\<>:"|?*\u0000-\u001f\u007f]/u.test(s) && s.split('/').every((p) =>
    p !== '' && p !== '.' && p !== '..' && !/[. ]$/u.test(p) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p)), '허용된 상대 목적지가 아닙니다.');

export const CloudRule = z.strictObject({
  id: RuleSetId, extension: z.string().regex(/^\.[a-z0-9]{1,16}$/u),
  keyword: label.nullable(), targetDirectory: relativeDirectory, enabled: z.boolean(),
});
export const RuleSetDraft = z.strictObject({
  formatVersion: z.literal(1), name: label,
  rules: z.array(CloudRule).max(20).refine((rules) => new Set(rules.map((r) => r.id)).size === rules.length,
    '규칙 ID가 중복됩니다.'),
});
export const StoredRuleSet = RuleSetDraft.safeExtend({
  revision: z.number().int().positive(), updatedAtMillis: z.number().finite(),
});
export type RuleSetInput = z.infer<typeof RuleSetDraft>;
export type RuleSetRecord = z.infer<typeof StoredRuleSet>;
export const RuleSetMetadata = RuleSetDraft.omit({ rules: true }).extend({
  revision: z.number().int().positive(),
  ruleIds: z.array(RuleSetId).max(20).refine((ids) => new Set(ids).size === ids.length),
});

/** Absolute paths, local evidence filenames, approval tokens and file content have no cloud fields. */
export const CLOUD_FIELDS = ['formatVersion', 'revision', 'name', 'ruleIds', 'updatedAt'] as const;
