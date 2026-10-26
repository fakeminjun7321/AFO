import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { AfoError, isAfoError } from '../../../packages/contracts/src/index.js';
import type { ReferenceGrant, RootGrant, RuleProfile, ScanProgress } from '../../../packages/contracts/src/index.js';
import { confirmProfile } from '../../../packages/engine/src/index.js';
import { analyzeRoot, issueReferenceGrant, issueRootGrant, revokeGrant, verifyGrant } from '../../../packages/filesystem/src/index.js';
import type { Analysis, AnalyzeOptions } from '../../../packages/filesystem/src/index.js';
import { PickerUnavailable } from './os.js';
import type { FolderKind, FolderPicker } from './os.js';

/**
 * GUI channel handlers (#9, read-only step). Transport-independent: the HTTP server (and a later Electron IPC bridge)
 * authenticates the caller and passes the parsed JSON body here. Root policy, grant verification, analysis and rule
 * confirmation are the shared services' — this adapter only maps opaque IDs it issued to the objects it holds.
 * Nothing here writes to the filesystem.
 */
export type AdapterCode = 'INVALID_REQUEST' | 'UNKNOWN_JOB' | 'UNKNOWN_PROFILE' | 'JOB_NOT_DONE' | 'NO_RULES' |
  'PICKER_BUSY' | 'PICKER_UNAVAILABLE' | 'INTERNAL';
export class ChannelError extends Error {
  constructor(readonly code: AdapterCode, message: string) { super(message); this.name = 'ChannelError'; }
}
export interface ErrorBody { code: string; message: string }

/** Only AfoError / ChannelError messages reach the client; anything else (fs errors carry paths) becomes a generic message. */
export function toErrorBody(error: unknown): ErrorBody {
  if (isAfoError(error) || error instanceof ChannelError) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) return { code: 'INVALID_REQUEST', message: '요청 형식이 올바르지 않습니다.' };
  // Plain Error from the shared engine (Korean, no paths). System errors (code/syscall/path) are not passed through.
  if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype && !('code' in error) && !('path' in error))
    return { code: 'UNKNOWN', message: error.message.slice(0, 300) };
  return { code: 'INTERNAL', message: '요청을 처리하지 못했습니다.' };
}

const GrantId = z.string().regex(/^[a-f0-9]{64}$/u);
const HandleId = z.string().regex(/^[a-z0-9-]{8,128}$/u);
const Kind = z.enum(['work', 'reference']);
const schemas = {
  // Length and emptiness are checked in select() so that a refused path clears the selection like any other refusal.
  'select-folder': z.strictObject({ kind: Kind, path: z.string() }),
  'pick-folder': z.strictObject({ kind: Kind }),
  analyze: z.strictObject({ rootGrantId: GrantId, referenceGrantId: GrantId.nullable(), profileId: HandleId.nullable() }),
  job: z.strictObject({ jobId: HandleId }),
  cancel: z.strictObject({ jobId: HandleId }),
  'confirm-rules': z.strictObject({ jobId: HandleId, ruleIds: z.array(z.string().min(1).max(128)).min(1).max(1000) }),
} as const;
export type Channel = keyof typeof schemas;
export const channels: readonly Channel[] = Object.keys(schemas) as Channel[];
export const isChannel = (value: string): value is Channel => Object.hasOwn(schemas, value);

type JobState = 'running' | 'done' | 'failed' | 'cancelled';
interface Job {
  id: string; state: JobState; controller: AbortController; progress: ScanProgress | null; startedAt: string;
  rootGrantId: string; referenceGrantId: string | null; profileId: string | null;
  analysis: Analysis | null; error: ErrorBody | null;
}
export type Analyze = (grant: RootGrant, options: AnalyzeOptions) => Promise<Analysis>;
export interface ServiceOptions { picker: FolderPicker; analyze?: Analyze }
const MAX_JOBS = 8;

export function createService(options: ServiceOptions): { handle: (channel: Channel, body: unknown) => Promise<unknown>; shutdown: () => void } {
  const analyze = options.analyze ?? analyzeRoot;
  const grants = { work: new Map<string, RootGrant>(), reference: new Map<string, ReferenceGrant>() };
  const jobs = new Map<string, Job>();
  /** Confirmed rules, usable only with the exact work + reference selection they were confirmed for. */
  const profiles = new Map<string, { profile: RuleProfile; rootGrantId: string; referenceGrantId: string | null }>();
  let pickerBusy = false;

  /** Drops the current folder of this kind and every confirmed profile bound to it. */
  function clearSelection(kind: FolderKind): void {
    for (const old of grants[kind].values()) {
      revokeGrant(old);
      for (const [id, bound] of profiles) if (bound.rootGrantId === old.id || bound.referenceGrantId === old.id) profiles.delete(id);
    }
    grants[kind].clear();
  }
  /**
   * A new choice (typed or picked) replaces the previous folder of the same kind. A refused choice also clears it:
   * the screen then has no folder of that kind instead of silently keeping the previous one.
   */
  async function select(kind: FolderKind, input: unknown): Promise<unknown> {
    let grant: RootGrant | ReferenceGrant;
    try {
      if (typeof input !== 'string' || input === '' || input.length > 4096) throw new AfoError('ROOT_FORBIDDEN', '폴더 경로가 필요합니다.');
      // Shared policy resolves relative input against the process cwd; a typed GUI path must be absolute instead.
      if (!path.isAbsolute(input)) throw new AfoError('ROOT_FORBIDDEN', '전체 경로(절대 경로)를 입력하세요.');
      grant = kind === 'work' ? await issueRootGrant(input) : await issueReferenceGrant(input);
    } catch (error) { clearSelection(kind); throw error; }
    clearSelection(kind);
    if (kind === 'work') grants.work.set(grant.id, grant as RootGrant); else grants.reference.set(grant.id, grant as ReferenceGrant);
    return { selected: { kind, grantId: grant.id, path: grant.canonicalPath } };
  }
  const job = (id: string): Job => {
    const found = jobs.get(id);
    if (!found) throw new ChannelError('UNKNOWN_JOB', '알 수 없는 분석 작업입니다. 다시 분석하세요.');
    return found;
  };
  const prune = (): void => {
    const finished = [...jobs.values()].filter((j) => j.state !== 'running');
    for (const old of finished.slice(0, Math.max(0, jobs.size - MAX_JOBS))) jobs.delete(old.id);
  };

  const handlers: { [C in Channel]: (input: z.infer<(typeof schemas)[C]>) => Promise<unknown> } = {
    'select-folder': ({ kind, path: input }) => select(kind, input),
    'pick-folder': async ({ kind }) => {
      if (pickerBusy) throw new ChannelError('PICKER_BUSY', '이미 폴더 선택 대화상자가 열려 있습니다.');
      pickerBusy = true;
      let picked: string | null;
      try { picked = await options.picker(kind); }
      catch (error) {
        throw new ChannelError('PICKER_UNAVAILABLE', error instanceof PickerUnavailable ? error.message : '폴더 선택 대화상자를 열지 못했습니다. 경로를 직접 입력하세요.');
      } finally { pickerBusy = false; }
      // Cancel (or a dialog that could not open) is not a choice: the previous selection stays.
      if (picked === null) return { selected: null };
      return select(kind, picked);
    },
    analyze: async ({ rootGrantId, referenceGrantId, profileId }) => {
      const root = grants.work.get(rootGrantId);
      if (!root) throw new AfoError('ROOT_FORBIDDEN', '이 화면에서 선택한 작업 폴더 권한이 아닙니다. 폴더를 다시 선택하세요.');
      const reference = referenceGrantId === null ? undefined : grants.reference.get(referenceGrantId);
      if (referenceGrantId !== null && !reference) throw new AfoError('ROOT_FORBIDDEN', '이 화면에서 선택한 참고 폴더 권한이 아닙니다. 다시 선택하세요.');
      const bound = profileId === null ? undefined : profiles.get(profileId);
      if (profileId !== null && !bound) throw new ChannelError('UNKNOWN_PROFILE', '확인된 규칙을 찾을 수 없습니다(폴더를 바꾸면 해제됩니다). 규칙을 다시 확인하세요.');
      if (bound && (bound.rootGrantId !== rootGrantId || bound.referenceGrantId !== referenceGrantId))
        throw new AfoError('PROFILE_CHANGED', '확인한 규칙은 확인할 때의 작업·참고 폴더 선택에서만 씁니다. 규칙을 다시 확인하세요.');
      const profile = bound?.profile;
      // Fail fast on a replaced folder; analyzeRoot verifies again before and after reading.
      await verifyGrant(root, 'work');
      if (reference) await verifyGrant(reference, 'reference');
      for (const other of jobs.values()) if (other.state === 'running') other.controller.abort();
      const current: Job = { id: randomUUID(), state: 'running', controller: new AbortController(), progress: null,
        startedAt: new Date().toISOString(), rootGrantId, referenceGrantId, profileId, analysis: null, error: null };
      jobs.set(current.id, current);
      prune();
      void analyze(root, { signal: current.controller.signal, onProgress: (p) => { current.progress = p; },
        ...(reference ? { reference } : {}), ...(profile ? { profile } : {}) })
        .then((analysis) => { current.analysis = analysis; current.state = 'done'; })
        .catch((error: unknown) => {
          current.state = current.controller.signal.aborted || isAfoError(error, 'CANCELLED') ? 'cancelled' : 'failed';
          current.error = current.state === 'cancelled' ? { code: 'CANCELLED', message: '분석을 취소했습니다.' } : toErrorBody(error);
        });
      return { jobId: current.id };
    },
    job: async ({ jobId }) => {
      const j = job(jobId);
      const result = j.analysis === null ? null : { preview: j.analysis.preview, suggestedProfile: j.analysis.suggestedProfile,
        protected: j.analysis.protected, profileId: j.profileId,
        appliedRuleIds: j.profileId === null ? [] : (profiles.get(j.profileId)?.profile.rules.map((r) => r.id) ?? []) };
      return { jobId: j.id, state: j.state, progress: j.progress, startedAt: j.startedAt, result, error: j.error };
    },
    cancel: async ({ jobId }) => {
      const j = job(jobId);
      if (j.state === 'running') j.controller.abort();
      return { jobId: j.id, cancelRequested: j.state === 'running' };
    },
    'confirm-rules': async ({ jobId, ruleIds }) => {
      const j = job(jobId);
      if (j.state !== 'done' || j.analysis === null) throw new ChannelError('JOB_NOT_DONE', '분석이 끝난 뒤 규칙을 확인할 수 있습니다.');
      const suggested = j.analysis.suggestedProfile;
      if (suggested === null || suggested.rules.length === 0) throw new ChannelError('NO_RULES', '이 분석에는 참고 규칙 후보가 없습니다.');
      let confirmed: RuleProfile;
      try { confirmed = confirmProfile(suggested, ruleIds); }
      catch (error) { throw isAfoError(error) ? error : new ChannelError('INVALID_REQUEST', '확인할 규칙 ID를 후보 목록에서 중복 없이 선택하세요.'); }
      const profileId = randomUUID();
      // A job may outlive its folders (re-selected meanwhile): only bind to selections that are still current.
      if (!grants.work.has(j.rootGrantId) || (j.referenceGrantId !== null && !grants.reference.has(j.referenceGrantId)))
        throw new AfoError('PROFILE_CHANGED', '폴더 선택이 바뀌었습니다. 다시 분석한 뒤 규칙을 확인하세요.');
      profiles.set(profileId, { profile: confirmed, rootGrantId: j.rootGrantId, referenceGrantId: j.referenceGrantId });
      return { profileId, profile: confirmed, saved: false };
    },
  };

  return {
    async handle(channel, body) {
      const parsed = schemas[channel].safeParse(body);
      if (!parsed.success) throw new ChannelError('INVALID_REQUEST', '요청 형식이 올바르지 않거나 알 수 없는 필드가 있습니다.');
      return (handlers[channel] as (input: unknown) => Promise<unknown>)(parsed.data);
    },
    shutdown() { for (const j of jobs.values()) if (j.state === 'running') j.controller.abort(); },
  };
}
