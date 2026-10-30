import path from 'node:path';
import { CLASSIFICATION_VERSION, RelativePathSchema, TargetDirectorySchema } from '../../contracts/src/index.js';
import type { ClassificationReason } from '../../contracts/src/index.js';
import { classifyPersonal, parseProfile } from './rules.js';
import type { AnyProfile } from './rules.js';

export { CLASSIFICATION_VERSION };
import { defaultCategory } from './defaults.js';
export { categoryExtensions } from './defaults.js';
export const extensionOf = (name: string): string => path.posix.extname(name).toLowerCase();

export interface Classification {
  /** Destination folder relative to the work root, or null when the file needs review. */
  targetDirectory: string | null; category: string | null; ruleId: string | null;
  source: 'override' | 'correction' | 'personal' | 'default' | null; reasonCode: ClassificationReason; reason: string;
}
const review = (reasonCode: ClassificationReason, reason: string): Classification =>
  ({ targetDirectory: null, category: null, ruleId: null, source: null, reasonCode, reason });

/**
 * One file's classification. Priority: one-off user override → saved correction → confirmed, enabled personal rule → default rule.
 * Draft/disabled profiles and disabled rules are ignored. Uses the name only; contents, size and age are never used.
 */
export function classifyFile(relativePath: string, options: { profile?: AnyProfile; override?: string } = {}): Classification {
  const name = path.posix.basename(RelativePathSchema.parse(relativePath));
  const ext = extensionOf(name);
  if (options.override !== undefined)
    return { targetDirectory: TargetDirectorySchema.parse(options.override), category: null, ruleId: null, source: 'override',
      reasonCode: 'USER_OVERRIDE', reason: '사용자가 명시적으로 지정한 이번 분류입니다.' };
  const result = defaultCategory(name);
  const ambiguous = result.reason === 'COMPOUND_EXTENSION' || result.reason === 'INCOMPLETE_DOWNLOAD';
  if (options.profile !== undefined) {
    const personal = classifyPersonal(relativePath, parseProfile(options.profile));
    // A rule learned from extensions is not trusted for an ambiguous double extension or an unfinished download;
    // explicit saved corrections are.
    if (personal && !(ambiguous && personal.reasonCode === 'PERSONAL_RULE')) return personal;
  }
  if (result.reason === 'INCOMPLETE_DOWNLOAD')
    return review(result.reason, '다운로드가 끝나지 않은 파일일 수 있어 그대로 둡니다. 다운로드가 끝난 뒤 다시 확인해 주세요.');
  if (result.reason === 'NO_EXTENSION') return review(result.reason, '확장자가 없어 종류를 판단하지 않았습니다. 기타/검토 대상입니다.');
  if (result.reason === 'COMPOUND_EXTENSION') return review(result.reason, '확장자가 여러 개라 종류가 애매합니다. 직접 확인해 주세요.');
  if (result.reason === 'UNKNOWN_EXTENSION' || !result.category) return review('UNKNOWN_EXTENSION', '분류 기준이 불분명합니다.');
  return { targetDirectory: result.category, category: result.category, ruleId: null, source: 'default', reasonCode: 'DEFAULT_EXTENSION',
    reason: `확장자(${ext})에 따른 기본 분류(${CLASSIFICATION_VERSION})입니다.` };
}
