import path from 'node:path';
import { CorrectionMatchSchema, CorrectionSchema, PROFILE_EVIDENCE_LIMIT, ProfileSchema, RelativePathSchema, RuleProfileV2Schema,
  TargetDirectorySchema, correctionMatchKey } from '../../contracts/src/index.js';
import type { ComplexRule, Correction, CorrectionMatch, FileSnapshot, RuleProfile, RuleProfileV2 } from '../../contracts/src/index.js';
import type { Classification } from './classify.js';
import { compare, digest, pathKey } from './util.js';
import { complexMatches } from './smart.js';

/**
 * Personal rules (#18): pure functions shared by the profile store, CLI and later GUI.
 * Every change returns a new profile with revision + 1; nothing here reads or writes files.
 */
export type AnyProfile = RuleProfile | RuleProfileV2;

/** v1 (preview JSON) or v2 (saved). Anything else, including a v2 with a broken field, throws. */
export function parseProfile(input: unknown): AnyProfile {
  const version = input !== null && typeof input === 'object' && 'formatVersion' in input ? input.formatVersion : undefined;
  return version === 2 ? RuleProfileV2Schema.parse(input) : ProfileSchema.parse(input);
}

/** Last segment of a POSIX or Windows path, used as a display label only. */
const labelOf = (canonicalPath: string): string | null =>
  canonicalPath.split(/[\\/]/u).filter((part) => part !== '' && !/^[A-Za-z]:$/u.test(part)).at(-1)?.slice(0, 255) ?? null;

/**
 * Confirmed v1 → v2. Drafts and disabled v1 profiles are refused: only rules the user confirmed become saved rules.
 * The absolute reference path and the full reference file list are dropped; at most PROFILE_EVIDENCE_LIMIT examples stay.
 */
export function profileFromV1(input: unknown, now: Date = new Date(),
  identity: { device: string; inode: string } | null = null): RuleProfileV2 {
  const v1 = ProfileSchema.parse(input);
  if (v1.status !== 'confirmed') throw new Error('확인한 규칙 프로필만 저장할 수 있습니다(초안·비활성 v1 거부).');
  return RuleProfileV2Schema.parse({ formatVersion: 2, id: v1.id, revision: v1.revision, status: 'confirmed',
    referenceRootId: v1.referenceRoot.id, referenceRootIdentity: identity, referenceRootLabel: labelOf(v1.referenceRoot.canonicalPath),
    rules: v1.rules.map((r) => ({ id: r.id, extension: r.extension, keyword: r.keyword, targetDirectory: r.targetDirectory,
      evidence: [...r.evidence].sort(compare).slice(0, PROFILE_EVIDENCE_LIMIT), evidenceCount: r.evidence.length, enabled: true })),
    corrections: [], updatedAt: now.toISOString() });
}

const next = (profile: RuleProfileV2, change: Partial<RuleProfileV2>, now: Date): RuleProfileV2 =>
  RuleProfileV2Schema.parse({ ...profile, ...change, revision: profile.revision + 1, updatedAt: now.toISOString() });

/** Unchanged input is returned as-is (same object) so callers can skip writing. Unknown rule IDs throw. */
export function withRuleEnabled(input: RuleProfileV2, ruleId: string, enabled: boolean, now: Date = new Date()): RuleProfileV2 {
  const profile = RuleProfileV2Schema.parse(input);
  const rule = profile.rules.find((r) => r.id === ruleId);
  const complex = profile.complexRules?.find((r) => r.id === ruleId);
  if (complex) return complex.enabled === enabled ? input : next(profile, { complexRules: profile.complexRules!.map((r) => r.id === ruleId ? { ...r, enabled } : r) }, now);
  if (!rule) throw new Error('해당 ID의 저장 규칙이 없습니다.');
  if (rule.enabled === enabled) return input;
  return next(profile, { rules: profile.rules.map((r) => r.id === ruleId ? { ...r, enabled } : r) }, now);
}

export function withStatus(input: RuleProfileV2, status: RuleProfileV2['status'], now: Date = new Date()): RuleProfileV2 {
  const profile = RuleProfileV2Schema.parse(input);
  return profile.status === status ? input : next(profile, { status }, now);
}

/** Builds a saved correction. The ID depends on the match and target only, so the same correction keeps its ID. */
export function makeCorrection(match: CorrectionMatch, targetDirectory: string, now: Date = new Date()): Correction {
  const m = CorrectionMatchSchema.parse(match);
  const target = TargetDirectorySchema.parse(targetDirectory);
  return CorrectionSchema.parse({ id: digest(JSON.stringify([correctionMatchKey(m), pathKey(target)])).slice(0, 16), match: m,
    targetDirectory: target, createdAt: now.toISOString() });
}

/** Adds a correction, replacing any earlier one with the same match. */
export function withCorrection(input: RuleProfileV2, correction: Correction, now: Date = new Date()): RuleProfileV2 {
  const profile = RuleProfileV2Schema.parse(input);
  const c = CorrectionSchema.parse(correction);
  const matchKey = correctionMatchKey(c.match);
  const same = profile.corrections.find((x) => correctionMatchKey(x.match) === matchKey);
  if (same && pathKey(same.targetDirectory) === pathKey(c.targetDirectory)) return input;
  return next(profile, { corrections: [...profile.corrections.filter((x) => x !== same), c] }, now);
}

export function withoutCorrection(input: RuleProfileV2, correctionId: string, now: Date = new Date()): RuleProfileV2 {
  const profile = RuleProfileV2Schema.parse(input);
  if (!profile.corrections.some((c) => c.id === correctionId)) throw new Error('해당 ID의 저장 수정이 없습니다.');
  return next(profile, { corrections: profile.corrections.filter((c) => c.id !== correctionId) }, now);
}

/** Starts a v2 profile that only holds saved corrections (no reference folder was used). */
export function emptyProfile(id: string, revision: number, now: Date = new Date()): RuleProfileV2 {
  return RuleProfileV2Schema.parse({ formatVersion: 2, id, revision, status: 'confirmed', referenceRootId: null, referenceRootLabel: null,
    rules: [], corrections: [], updatedAt: now.toISOString() });
}

/** Rules and corrections that may apply, or null when the profile is a draft or disabled. */
interface Active { id: string; revision: number; rules: { id: string; extension: string; keyword: string | null; targetDirectory: string }[];
  corrections: Correction[]; complexRules: ComplexRule[] }
export function activeRules(profile: AnyProfile): Active | null {
  if (profile.status !== 'confirmed') return null;
  return profile.formatVersion === 1
    ? { id: profile.id, revision: profile.revision, rules: profile.rules, corrections: [], complexRules: [] }
    : { id: profile.id, revision: profile.revision, rules: profile.rules.filter((r) => r.enabled), corrections: profile.corrections,
      complexRules: (profile.complexRules ?? []).filter((r) => r.enabled) };
}

const review = (reason: string): Classification =>
  ({ targetDirectory: null, category: null, ruleId: null, source: null, reasonCode: 'RULE_CONFLICT', reason });
const distinct = (targets: string[]): number => new Set(targets.map(pathKey)).size;
const inside = (folder: string, dir: string): boolean => pathKey(dir) === pathKey(folder) || pathKey(dir).startsWith(`${pathKey(folder)}/`);

/**
 * Personal part of classification, or null to fall through to the default rules.
 * Order: saved correction (exact name before keyword) → file already inside a personal folder (kept) → confirmed, enabled rule.
 * Matches with different destinations are RULE_CONFLICT (review), never an arbitrary pick. Uses names only.
 */
export function classifyPersonal(relativePath: string, input: AnyProfile, file?: Pick<FileSnapshot, 'size' | 'modifiedNs'>): Classification | null {
  const active = activeRules(input);
  if (!active) return null;
  const rel = RelativePathSchema.parse(relativePath);
  const name = path.posix.basename(rel);
  const ext = path.posix.extname(name).toLowerCase();
  const nameKey = pathKey(name);
  const byName = active.corrections.filter((c) => c.match.type === 'file-name' && pathKey(c.match.name) === nameKey);
  const byKeyword = active.corrections.filter((c) => c.match.type === 'keyword' && c.match.extension === ext &&
    (c.match.keyword === null || nameKey.includes(pathKey(c.match.keyword))));
  const corrections = byName.length ? byName : byKeyword;
  if (distinct(corrections.map((c) => c.targetDirectory)) > 1) return review('저장한 수정끼리 목적지가 충돌합니다.');
  const correction = corrections.sort((a, b) => compare(a.id, b.id))[0];
  if (correction) return { targetDirectory: correction.targetDirectory, category: null, ruleId: correction.id, source: 'correction',
    reasonCode: 'SAVED_CORRECTION', reason: '이후에도 적용하기로 저장한 사용자 수정입니다.' };
  const dir = path.posix.dirname(rel);
  if (dir !== '.') {
    const home = [...active.rules.map((r) => r.targetDirectory), ...active.corrections.map((c) => c.targetDirectory), ...active.complexRules.map((r) => r.targetDirectory)]
      .filter((folder) => inside(folder, dir)).sort((a, b) => b.length - a.length || compare(a, b))[0];
    // A file the user (or the reference folder) already placed in a personal folder is not moved elsewhere.
    if (home) return { targetDirectory: dir, category: null, ruleId: null, source: 'personal', reasonCode: 'ALREADY_PLACED',
      reason: `이미 개인 정리 폴더(${home})에 있어 옮기지 않습니다.` };
  }
  const complex = active.complexRules.filter((r) => complexMatches(r, rel, file)).sort((a, b) => b.priority - a.priority || compare(a.id, b.id));
  if (complex.length) {
    const highest = complex.filter((r) => r.priority === complex[0]!.priority);
    if (distinct(highest.map((r) => r.targetDirectory)) > 1) return review('같은 우선순위의 복합 규칙 목적지가 충돌합니다.');
    const rule = highest[0]!;
    return { targetDirectory: rule.targetDirectory, category: null, ruleId: rule.id, source: 'personal', reasonCode: 'COMPLEX_RULE',
      reason: `사용자 복합 규칙 '${rule.name}' (${rule.match === 'all' ? '모든 조건' : '하나 이상의 조건'}, 우선순위 ${rule.priority})` };
  }
  const matches = active.rules.filter((r) => r.extension === ext && (r.keyword === null || nameKey.includes(pathKey(r.keyword))));
  if (distinct(matches.map((r) => r.targetDirectory)) > 1) return review('개인 규칙의 목적지가 충돌합니다.');
  const rule = matches.sort((a, b) => compare(a.id, b.id))[0];
  return rule ? { targetDirectory: rule.targetDirectory, category: null, ruleId: rule.id, source: 'personal',
    reasonCode: 'PERSONAL_RULE', reason: '확인한 개인 규칙을 적용합니다.' } : null;
}
