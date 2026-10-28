import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { AfoError, ProfileSchema, ProfileStoreSchema, RuleProfileV2Schema, isAfoError } from '../../contracts/src/index.js';
import type { CorrectionMatch, ProfileStore, ProtectedEntry, RuleProfile, RuleProfileV2, ScanResult } from '../../contracts/src/index.js';
import { digest, emptyProfile, makeCorrection, pathKey, profileFromV1, withCorrection, withRuleEnabled, withStatus, withoutCorrection }
  from '../../engine/src/index.js';
import type { AnyProfile } from '../../engine/src/index.js';
import { withRootLock } from './lock.js';
import { readJson, resolveStateDir, statePaths, writeJsonAtomic } from './state.js';

/**
 * Personal rule profile store (#18): one profile in <state>/profiles/active.json (first version).
 * Only app-local state is written. Reference folders and work roots are never read or touched here.
 * Every change runs under one lock per state folder (withProfileLock), so the expectedRevision/expectedCorrupt check and the
 * write are not split by another process using this API. Reads (loadProfile) take no lock; writes are atomic renames.
 */
/**
 * expectedRevision: the revision the caller saw, or null for "no saved profile (empty store)".
 * expectedCorrupt: the fingerprint of the damaged file the caller saw (CorruptProfile.fingerprint), for save/reset over it.
 * Either one, when given, makes the call fail with PROFILE_CHANGED if the store is no longer in that state.
 */
export interface ProfileStoreOptions { stateDir?: string; now?: () => Date; expectedRevision?: number | null; expectedCorrupt?: string }
export interface CorruptProfile { status: 'corrupt'; reason: string; fingerprint: string }

const REFERENCE_REASON = '참고한 기존 파일이라 이동·삭제하지 않습니다.';
const MOVED = '저장한 참고 폴더의 이름이나 위치가 바뀌었습니다. 규칙을 다시 확인할 때까지 개인 규칙을 적용하지 않습니다(참고 파일 보호는 유지).';
const found = (where: string): string =>
  `저장한 규칙의 근거 파일이 다른 위치(${where})에서 발견됐습니다. 규칙을 다시 확인할 때까지 개인 규칙을 적용하지 않습니다(그 폴더는 보호).`;
type Identity = { device: string; inode: string };
async function identityOf(absolute: string): Promise<Identity | null> {
  try {
    const s = await lstat(absolute, { bigint: true });
    return s.isDirectory() && !s.isSymbolicLink() ? { device: String(s.dev), inode: String(s.ino) } : null;
  } catch { return null; }
}

/** dev/inode of a v1 profile's reference folder, only if that folder is still the one the profile was read from (same real-path ID). */
export async function referenceIdentity(input: RuleProfile): Promise<Identity | null> {
  const v1 = ProfileSchema.parse(input);
  const where = v1.referenceRoot.canonicalPath;
  if (!path.isAbsolute(where) || digest(where) !== v1.referenceRoot.id) return null;
  return identityOf(where);
}
/** Confirmed v1 → v2 with the reference folder's dev/inode recorded (metadata only; nothing is opened or written). */
export async function profileFromConfirmed(input: unknown, now: Date = new Date()): Promise<RuleProfileV2> {
  const v1 = ProfileSchema.parse(input);
  return profileFromV1(v1, now, await referenceIdentity(v1));
}

export interface ReferenceCheck { entries: ProtectedEntry[]; stale: string | null }
/**
 * Work-root files that belong to a saved v2 profile's reference folder, plus whether that folder looks changed (stale).
 * Recognised by real-path ID or by dev/inode (survives a same-volume rename/move); either match protects the folder.
 * A match by only one of the two, or two or more saved evidence examples found under another folder of the work root
 * (e.g. a copy or cross-volume move), marks the profile stale and protects that folder too. Reference folder inside the
 * work root: files under it; work root equal to or inside it: every file. Applies whatever the profile status is.
 */
export async function storedReferenceCheck(scan: ScanResult, input: AnyProfile): Promise<ReferenceCheck> {
  if (input.formatVersion !== 2) return { entries: [], stale: null };
  const id = input.referenceRootId; const identity = input.referenceRootIdentity ?? null;
  const root = scan.root.canonicalPath;
  const prefixes = new Set<string>(); // '' = the whole work root
  let stale: string | null = null;
  const match = async (absolute: string): Promise<boolean> => {
    const byId = id !== null && digest(absolute) === id;
    const real = identity === null ? null : await identityOf(absolute);
    const byIdentity = real !== null && identity !== null && real.device === identity.device && real.inode === identity.inode;
    if (identity !== null && byId !== byIdentity) stale ??= MOVED;
    return byId || byIdentity;
  };
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (await match(dir)) { prefixes.add(''); break; }
    if (path.dirname(dir) === dir) break;
  }
  if (!prefixes.has('')) for (const d of scan.directories) if (await match(path.join(root, ...d.split('/')))) prefixes.add(d);
  const covered = (rel: string): boolean => [...prefixes].some((p) => p === '' || rel === p || rel.startsWith(`${p}/`));
  if (!prefixes.has('')) {
    const examples = [...new Set(input.rules.flatMap((r) => r.evidence))].map((e) => e.split('/').map(pathKey));
    const hits = new Map<string, Set<number>>();
    for (const f of scan.files) {
      const parts = f.relativePath.split('/');
      examples.forEach((e, i) => {
        if (e.length > parts.length || !e.every((seg, j) => seg === pathKey(parts[parts.length - e.length + j]!))) return;
        const prefix = parts.slice(0, parts.length - e.length).join('/');
        hits.set(prefix, (hits.get(prefix) ?? new Set<number>()).add(i));
      });
    }
    for (const [prefix, seen] of [...hits].sort(([a], [b]) => a.length - b.length)) {
      if (seen.size < 2 || prefixes.has('') || (prefix !== '' && covered(prefix))) continue;
      prefixes.add(prefix); stale ??= found(prefix === '' ? '작업 폴더 자체' : prefix);
    }
  }
  const entries = scan.files.filter((f) => covered(f.relativePath))
    .map((f) => ({ relativePath: f.relativePath, code: 'REFERENCE_FILE' as const, reason: REFERENCE_REASON }));
  return { entries, stale };
}

export const profileFile = (stateDir: string = resolveStateDir()): string => path.join(statePaths(stateDir).profiles, 'active.json');
const fileOf = (o: ProfileStoreOptions): string => profileFile(o.stateDir ?? resolveStateDir());
const clock = (o: ProfileStoreOptions): Date => o.now?.() ?? new Date();

type Current = { kind: 'active'; profile: RuleProfileV2 } | { kind: 'empty'; lastRevision: number } |
  { kind: 'corrupt'; reason: string; fingerprint: string };
/** Changes whenever the damaged entry is rewritten, replaced or set aside (identity, size and times). */
async function fingerprint(file: string): Promise<string> {
  try {
    const s = await lstat(file, { bigint: true });
    return digest([s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].join(':')).slice(0, 32);
  } catch { return 'unreadable'; }
}

/** Classifies the stored file without trusting it. Unreadable, invalid, old-format or draft content is 'corrupt'. */
async function current(file: string): Promise<Current> {
  let raw: unknown;
  const corrupt = async (reason: string): Promise<Current> => ({ kind: 'corrupt', reason, fingerprint: await fingerprint(file) });
  try { raw = await readJson(file, z.unknown()); }
  catch (error) { if (isAfoError(error, 'STATE_CORRUPT')) return corrupt(error.message); throw error; }
  if (raw === null) return { kind: 'empty', lastRevision: 0 };
  const v1 = ProfileSchema.safeParse(raw);
  if (v1.success) return corrupt(v1.data.status === 'draft'
    ? '확인되지 않은 초안(v1) 프로필입니다. 규칙을 확인한 뒤 다시 저장하세요.'
    : '이전 형식(v1) 프로필은 자동 적용하지 않습니다. 다시 확인해 저장하세요.');
  const parsed = ProfileStoreSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return corrupt(`저장된 프로필이 계약과 다릅니다${first?.path.length ? ` (${first.path.join('.')})` : ''}.`);
  }
  return parsed.data.state === 'active' ? { kind: 'active', profile: parsed.data.profile }
    : { kind: 'empty', lastRevision: parsed.data.lastRevision };
}

/** Saved profile; null when none is saved or after reset; { status: 'corrupt' } needs the user to re-confirm. Never deletes anything. */
export async function loadProfile(options: ProfileStoreOptions = {}): Promise<RuleProfileV2 | CorruptProfile | null> {
  const state = await current(fileOf(options));
  return state.kind === 'active' ? state.profile : state.kind === 'empty' ? null
    : { status: 'corrupt', reason: state.reason, fingerprint: state.fingerprint };
}

const changed = (message: string): AfoError => new AfoError('PROFILE_CHANGED', message);
function checkExpected(state: Current, options: ProfileStoreOptions): void {
  const { expectedRevision, expectedCorrupt } = options;
  if (expectedRevision === undefined && expectedCorrupt === undefined) return;
  const ok = state.kind === 'corrupt' ? expectedCorrupt === state.fingerprint && expectedRevision === undefined
    : expectedCorrupt === undefined && expectedRevision === (state.kind === 'active' ? state.profile.revision : null);
  if (!ok) throw changed('프로필이 그 사이에 바뀌었습니다. 다시 불러온 뒤 확인하세요.');
}
const write = (file: string, value: ProfileStore): Promise<void> => writeJsonAtomic(file, value, ProfileStoreSchema);

/** A damaged file is renamed aside (kept for inspection), only when the user explicitly saves or resets over it. */
async function setAside(file: string): Promise<void> {
  const target = path.join(path.dirname(file), `corrupt-${Date.now()}-${randomBytes(4).toString('hex')}.json`);
  try { await rename(file, target); }
  catch (error) {
    // Gone although we hold the lock: changed outside AFO's lock (or by hand). Never report the save/reset as done.
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      throw changed('손상된 프로필이 그 사이에 사라졌습니다. 다시 불러온 뒤 확인하세요.');
    throw new AfoError('STATE_CORRUPT', '손상된 프로필을 따로 보관하지 못해 덮어쓰지 않았습니다.', { cause: error });
  }
}

/** How long a change waits for another process's profile change (each holds the lock for milliseconds) before giving up. */
export const PROFILE_LOCK_WAIT_MS = 3000;
/**
 * Serialises every change to one state folder's profile store across processes: a lock.ts lock in <state>/locks/ keyed by
 * the dev/inode of <state>/profiles. A held lock is retried briefly; still held after PROFILE_LOCK_WAIT_MS → LOCKED_BY_OTHER.
 */
async function withProfileLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  const directory = statePaths(stateDir).profiles;
  let identity: { device: string; inode: string };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const s = await lstat(directory, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) throw new AfoError('STATE_CORRUPT', `프로필 폴더가 일반 폴더가 아닙니다: ${directory}`);
    identity = { device: String(s.dev), inode: String(s.ino) };
  } catch (error) {
    throw isAfoError(error) ? error : new AfoError('STATE_CORRUPT', `프로필 폴더를 준비할 수 없습니다: ${directory}`, { cause: error });
  }
  const deadline = Date.now() + PROFILE_LOCK_WAIT_MS;
  let entered = false;
  for (;;) {
    try { return await withRootLock(stateDir, identity, () => { entered = true; return fn(); }); }
    catch (error) {
      // lock.ts throws LOCKED_BY_OTHER only before fn runs; never retry once fn has started.
      if (entered || !isAfoError(error, 'LOCKED_BY_OTHER')) throw error;
      if (Date.now() >= deadline) throw new AfoError('LOCKED_BY_OTHER',
        `다른 AFO 실행이 개인 규칙 프로필을 바꾸는 중이라 기다렸지만 끝나지 않았습니다. 잠시 뒤 다시 시도하세요. (${error.message})`, { cause: error });
      await sleep(10 + Math.floor(Math.random() * 40));
    }
  }
}

/**
 * The decision is made from the store as read, first without the lock (a refused call creates nothing, not even the lock
 * folder) and then again under the lock, where only the second decision's write runs. A decision needing no write returns at once.
 */
type Step<T> = { result: T; apply?: (file: string) => Promise<void> };
async function transact<T>(options: ProfileStoreOptions, decide: (state: Current) => Step<T>): Promise<T> {
  const stateDir = options.stateDir ?? resolveStateDir();
  const file = profileFile(stateDir);
  const first = decide(await current(file));
  if (first.apply === undefined) return first.result;
  return withProfileLock(stateDir, async () => {
    const step = decide(await current(file));
    await step.apply?.(file);
    return step.result;
  });
}

/**
 * Saves a confirmed profile (confirmed v1 is converted; drafts and disabled profiles are refused) and makes it the active one.
 * The stored revision is always above every revision this store has held, so (profileId, revision) is never reused.
 */
export async function saveConfirmedProfile(input: unknown, options: ProfileStoreOptions = {}): Promise<RuleProfileV2> {
  const now = clock(options);
  const version = input !== null && typeof input === 'object' && 'formatVersion' in input ? input.formatVersion : undefined;
  const profile = version === 2 ? RuleProfileV2Schema.parse(input) : await profileFromConfirmed(input, now);
  if (profile.status !== 'confirmed') throw new Error('확인한(confirmed) 프로필만 저장할 수 있습니다.');
  return transact(options, (state) => {
    checkExpected(state, options);
    const floor = state.kind === 'active' ? state.profile.revision : state.kind === 'empty' ? state.lastRevision : 0;
    const saved = RuleProfileV2Schema.parse({ ...profile, revision: Math.max(profile.revision, floor + 1), updatedAt: now.toISOString() });
    return { result: saved, apply: async (file) => {
      if (state.kind === 'corrupt') await setAside(file);
      await write(file, { formatVersion: 2, state: 'active', profile: saved });
    } };
  });
}

function changeActive(state: Current, options: ProfileStoreOptions,
  change: (profile: RuleProfileV2, now: Date) => RuleProfileV2): Step<RuleProfileV2> {
  if (state.kind === 'corrupt') throw new AfoError('STATE_CORRUPT', `저장된 프로필이 손상됐습니다: ${state.reason}`);
  if (state.kind === 'empty') throw new Error('저장된 개인 규칙 프로필이 없습니다.');
  checkExpected(state, options);
  const next = change(state.profile, clock(options));
  return next === state.profile ? { result: next }
    : { result: next, apply: (file) => write(file, { formatVersion: 2, state: 'active', profile: next }) };
}
const mutate = (options: ProfileStoreOptions, change: (profile: RuleProfileV2, now: Date) => RuleProfileV2): Promise<RuleProfileV2> =>
  transact(options, (state) => changeActive(state, options, change));

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
export const addCorrection = (match: CorrectionMatch, targetDirectory: string, options: ProfileStoreOptions = {}): Promise<RuleProfileV2> =>
  transact(options, (state) => {
    if (state.kind !== 'empty')
      return changeActive(state, options, (p, now) => withCorrection(p, makeCorrection(match, targetDirectory, now), now));
    checkExpected(state, options);
    const now = clock(options);
    const profile = withCorrection(emptyProfile(`local-${randomUUID()}`, state.lastRevision + 1, now),
      makeCorrection(match, targetDirectory, now), now);
    return { result: profile, apply: (file) => write(file, { formatVersion: 2, state: 'active', profile }) };
  });

/**
 * Forgets every saved rule and correction. Writes an 'empty' record instead of deleting the file so the revision counter
 * keeps rising. A damaged file is set aside first, not deleted. Nothing outside the state folder is touched.
 */
export const resetProfile = (options: ProfileStoreOptions = {}): Promise<void> =>
  transact(options, (state) => {
    checkExpected(state, options);
    if (state.kind === 'empty') return { result: undefined }; // never saved, or already reset
    const lastRevision = state.kind === 'active' ? state.profile.revision : 0;
    return { result: undefined, apply: async (file) => {
      if (state.kind === 'corrupt') await setAside(file);
      await write(file, { formatVersion: 2, state: 'empty', lastRevision, updatedAt: clock(options).toISOString() });
    } };
  });
