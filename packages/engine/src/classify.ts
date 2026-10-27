import path from 'node:path';
import { CLASSIFICATION_VERSION, ProfileSchema, RelativePathSchema } from '../../contracts/src/index.js';
import type { ClassificationReason, RuleProfile } from '../../contracts/src/index.js';
import { pathKey } from './util.js';

export { CLASSIFICATION_VERSION };
import { defaultCategory } from './defaults.js';
export { categoryExtensions } from './defaults.js';
export const extensionOf = (name: string): string => path.posix.extname(name).toLowerCase();

export interface Classification {
  /** Destination folder relative to the work root, or null when the file needs review. */
  targetDirectory: string | null; category: string | null; ruleId: string | null;
  source: 'override' | 'personal' | 'default' | null; reasonCode: ClassificationReason; reason: string;
}
const review = (reasonCode: ClassificationReason, reason: string): Classification =>
  ({ targetDirectory: null, category: null, ruleId: null, source: null, reasonCode, reason });

/**
 * One file's classification. Priority: explicit user override → confirmed personal rule → default rule.
 * Draft/disabled profiles are ignored. Uses the name only; contents, size and age are never used.
 */
export function classifyFile(relativePath: string, options: { profile?: RuleProfile; override?: string } = {}): Classification {
  const name = path.posix.basename(RelativePathSchema.parse(relativePath));
  const ext = extensionOf(name);
  if (options.override !== undefined)
    return { targetDirectory: RelativePathSchema.parse(options.override), category: null, ruleId: null, source: 'override',
      reasonCode: 'USER_OVERRIDE', reason: '사용자가 명시적으로 지정한 이번 분류입니다.' };
  const profile = options.profile === undefined ? undefined : ProfileSchema.parse(options.profile);
  if (profile?.status === 'confirmed') {
    const matches = profile.rules.filter((r) => r.extension === ext &&
      (r.keyword === null || pathKey(name).includes(pathKey(r.keyword))));
    if (new Set(matches.map((r) => pathKey(r.targetDirectory))).size > 1)
      return review('RULE_CONFLICT', '개인 규칙의 목적지가 충돌합니다.');
    const rule = matches[0];
    if (rule) return { targetDirectory: rule.targetDirectory, category: null, ruleId: rule.id, source: 'personal',
      reasonCode: 'PERSONAL_RULE', reason: '확인한 개인 규칙을 적용합니다.' };
  }
  const result = defaultCategory(name);
  if (result.reason === 'NO_EXTENSION') return review(result.reason, '확장자가 없어 종류를 판단하지 않았습니다. 기타/검토 대상입니다.');
  if (result.reason === 'COMPOUND_EXTENSION') return review(result.reason, '확장자가 여러 개라 종류가 애매합니다. 직접 확인해 주세요.');
  if (result.reason === 'UNKNOWN_EXTENSION' || !result.category) return review('UNKNOWN_EXTENSION', '분류 기준이 불분명합니다.');
  return { targetDirectory: result.category, category: result.category, ruleId: null, source: 'default', reasonCode: 'DEFAULT_EXTENSION',
    reason: `확장자(${ext})에 따른 기본 분류(${CLASSIFICATION_VERSION})입니다.` };
}
