import { randomBytes, randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AfoError, ProfileSchema, ProfileStoreSchema, RuleProfileV2Schema, isAfoError } from '../../contracts/src/index.js';
import type { CorrectionMatch, ProfileStore, ProtectedEntry, RuleProfileV2, ScanResult } from '../../contracts/src/index.js';
import { digest, emptyProfile, makeCorrection, profileFromV1, withCorrection, withRuleEnabled, withStatus, withoutCorrection }
  from '../../engine/src/index.js';
import { readJson, resolveStateDir, statePaths, writeJsonAtomic } from './state.js';

/**
 * Personal rule profile store (#18): one profile in <state>/profiles/active.json (first version).
 * Only app-local state is written. Reference folders and work roots are never read or touched here.
 * No cross-process lock yet (#13): `expectedRevision` lets a caller refuse a profile another process changed meanwhile.
 */
export interface ProfileStoreOptions { stateDir?: string; now?: () => Date; expectedRevision?: number }
export interface CorruptProfile { status: 'corrupt'; reason: string }

/**
 * Work-root files that belong to a saved profile's reference folder, found by its root ID (no path is stored).
 * Reference folder inside the work root: files under it. Work root equal to or inside the reference folder: every file.
 * Applies whatever the profile status is. A renamed or moved reference folder is no longer recognised.
 */
export function storedReferenceEntries(scan: ScanResult, profile: { formatVersion: number; referenceRootId?: string | null }): ProtectedEntry[] {
  const id = profile.formatVersion === 2 ? profile.referenceRootId ?? null : null;
  if (id === null) return [];
  const root = scan.root.canonicalPath;
  let all = false;
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (digest(dir) === id) { all = true; break; }
    if (path.dirname(dir) === dir) break;
  }
  const folders = all ? [] : scan.directories.filter((d) => digest(path.join(root, ...d.split('/'))) === id);
  return scan.files.filter((f) => all || folders.some((d) => f.relativePath.startsWith(`${d}/`)))
    .map((f) => ({ relativePath: f.relativePath, code: 'REFERENCE_FILE' as const, reason: '참고한 기존 파일이라 이동·삭제하지 않습니다.' }));
}

export const profileFile = (stateDir: string = resolveStateDir()): string => path.join(statePaths(stateDir).profiles, 'active.json');
const fileOf = (o: ProfileStoreOptions): string => profileFile(o.stateDir ?? resolveStateDir());
const clock = (o: ProfileStoreOptions): Date => o.now?.() ?? new Date();

type Current = { kind: 'active'; profile: RuleProfileV2 } | { kind: 'empty'; lastRevision: number } | { kind: 'corrupt'; reason: string };

/** Classifies the stored file without trusting it. Unreadable, invalid, old-format or draft content is 'corrupt'. */
async function current(file: string): Promise<Current> {
  let raw: unknown;
  try { raw = await readJson(file, z.unknown()); }
  catch (error) { if (isAfoError(error, 'STATE_CORRUPT')) return { kind: 'corrupt', reason: error.message }; throw error; }
  if (raw === null) return { kind: 'empty', lastRevision: 0 };
  const v1 = ProfileSchema.safeParse(raw);
  if (v1.success) return { kind: 'corrupt', reason: v1.data.status === 'draft'
    ? '확인되지 않은 초안(v1) 프로필입니다. 규칙을 확인한 뒤 다시 저장하세요.'
    : '이전 형식(v1) 프로필은 자동 적용하지 않습니다. 다시 확인해 저장하세요.' };
  const parsed = ProfileStoreSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { kind: 'corrupt', reason: `저장된 프로필이 계약과 다릅니다${first?.path.length ? ` (${first.path.join('.')})` : ''}.` };
  }
  return parsed.data.state === 'active' ? { kind: 'active', profile: parsed.data.profile }
    : { kind: 'empty', lastRevision: parsed.data.lastRevision };
}

/** Saved profile; null when none is saved or after reset; { status: 'corrupt' } needs the user to re-confirm. Never deletes anything. */
export async function loadProfile(options: ProfileStoreOptions = {}): Promise<RuleProfileV2 | CorruptProfile | null> {
  const state = await current(fileOf(options));
  return state.kind === 'active' ? state.profile : state.kind === 'empty' ? null : { status: 'corrupt', reason: state.reason };
}

const changed = (message: string): AfoError => new AfoError('PROFILE_CHANGED', message);
function checkExpected(state: Current, options: ProfileStoreOptions): void {
  if (options.expectedRevision === undefined) return;
  const revision = state.kind === 'active' ? state.profile.revision : state.kind === 'empty' ? null : undefined;
  if (revision !== options.expectedRevision) throw changed('프로필이 그 사이에 바뀌었습니다. 다시 불러온 뒤 확인하세요.');
}
const write = (file: string, value: ProfileStore): Promise<void> => writeJsonAtomic(file, value, ProfileStoreSchema);

/** A damaged file is renamed aside (kept for inspection), only when the user explicitly saves or resets over it. */
async function setAside(file: string): Promise<void> {
  const target = path.join(path.dirname(file), `corrupt-${Date.now()}-${randomBytes(4).toString('hex')}.json`);
  try { await rename(file, target); }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw new AfoError('STATE_CORRUPT', '손상된 프로필을 따로 보관하지 못해 덮어쓰지 않았습니다.', { cause: error });
  }
}

/**
 * Saves a confirmed profile (confirmed v1 is converted; drafts and disabled profiles are refused) and makes it the active one.
 * The stored revision is always above every revision this store has held, so (profileId, revision) is never reused.
 */
export async function saveConfirmedProfile(input: unknown, options: ProfileStoreOptions = {}): Promise<RuleProfileV2> {
  const now = clock(options);
  const version = input !== null && typeof input === 'object' && 'formatVersion' in input ? input.formatVersion : undefined;
  const profile = version === 2 ? RuleProfileV2Schema.parse(input) : profileFromV1(input, now);
  if (profile.status !== 'confirmed') throw new Error('확인한(confirmed) 프로필만 저장할 수 있습니다.');
  const file = fileOf(options);
  const state = await current(file);
  checkExpected(state, options);
  if (state.kind === 'corrupt') await setAside(file);
  const floor = state.kind === 'active' ? state.profile.revision : state.kind === 'empty' ? state.lastRevision : 0;
  const saved = RuleProfileV2Schema.parse({ ...profile, revision: Math.max(profile.revision, floor + 1), updatedAt: now.toISOString() });
  await write(file, { formatVersion: 2, state: 'active', profile: saved });
  return saved;
}

async function mutate(options: ProfileStoreOptions, change: (profile: RuleProfileV2, now: Date) => RuleProfileV2): Promise<RuleProfileV2> {
  const file = fileOf(options);
  const state = await current(file);
  if (state.kind === 'corrupt') throw new AfoError('STATE_CORRUPT', `저장된 프로필이 손상됐습니다: ${state.reason}`);
  if (state.kind === 'empty') throw new Error('저장된 개인 규칙 프로필이 없습니다.');
  checkExpected(state, options);
  const next = change(state.profile, clock(options));
  if (next !== state.profile) await write(file, { formatVersion: 2, state: 'active', profile: next });
  return next;
}

/** Turns one saved rule on or off. Same value: no write and no new revision. */
export const setRuleEnabled = (ruleId: string, enabled: boolean, options: ProfileStoreOptions = {}): Promise<RuleProfileV2> =>
  mutate(options, (p, now) => withRuleEnabled(p, ruleId, enabled, now));
/** Disabled profiles are kept but never applied. */
export const disableProfile = (options: ProfileStoreOptions = {}): Promise<RuleProfileV2> =>
  mutate(options, (p, now) => withStatus(p, 'disabled', now));
export const enableProfile = (options: ProfileStoreOptions = {}): Promise<RuleProfileV2> =>
  mutate(options, (p, now) => withStatus(p, 'confirmed', now));
export const removeCorrection = (correctionId: string, options: ProfileStoreOptions = {}): Promise<RuleProfileV2> =>
  mutate(options, (p, now) => withoutCorrection(p, correctionId, now));

/**
 * Stores a correction the user chose to apply from now on ("이후에도 적용", CLI --remember). One-off corrections are passed
 * to the preview as overrides and never reach this function. Without a saved profile, a correction-only profile is created.
 */
export async function addCorrection(match: CorrectionMatch, targetDirectory: string, options: ProfileStoreOptions = {}): Promise<RuleProfileV2> {
  const file = fileOf(options);
  const state = await current(file);
  if (state.kind === 'active') return mutate(options, (p, now) => withCorrection(p, makeCorrection(match, targetDirectory, now), now));
  if (state.kind === 'corrupt') throw new AfoError('STATE_CORRUPT', `저장된 프로필이 손상됐습니다: ${state.reason}`);
  checkExpected(state, options);
  const now = clock(options);
  const profile = withCorrection(emptyProfile(`local-${randomUUID()}`, state.lastRevision + 1, now),
    makeCorrection(match, targetDirectory, now), now);
  await write(file, { formatVersion: 2, state: 'active', profile });
  return profile;
}

/**
 * Forgets every saved rule and correction. Writes an 'empty' record instead of deleting the file so the revision counter
 * keeps rising. A damaged file is set aside first, not deleted. Nothing outside the state folder is touched.
 */
export async function resetProfile(options: ProfileStoreOptions = {}): Promise<void> {
  const file = fileOf(options);
  const state = await current(file);
  checkExpected(state, options);
  if (state.kind === 'empty') return; // never saved, or already reset
  if (state.kind === 'corrupt') await setAside(file);
  const lastRevision = state.kind === 'active' ? state.profile.revision : 0;
  await write(file, { formatVersion: 2, state: 'empty', lastRevision, updatedAt: clock(options).toISOString() });
}
