import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { AfoError, TargetDirectorySchema } from '../../../packages/contracts/src/index.js';
import type { ReferenceGrant, RootGrant } from '../../../packages/contracts/src/index.js';
import { parseProfile, pathKey } from '../../../packages/engine/src/index.js';
import type { AnyProfile } from '../../../packages/engine/src/index.js';
import { analyzeRoot, issueReferenceGrant, issueRootGrant, scanRoot } from '../../../packages/filesystem/src/index.js';
import type { Analysis } from '../../../packages/filesystem/src/index.js';
import { loadProfile } from '../../../packages/filesystem/src/profiles.js';
import { assertStateDirOutside } from '../../../packages/filesystem/src/state.js';
import { corruptHint, isCorrupt, usage } from './rules.js';
import type { Stored } from './rules.js';

/** Shared by preview and plan: profile choice, grants, one-off --move corrections and the read-only analysis. */
const MAX_JSON = 1024 * 1024;
export async function readJsonFile(file: string): Promise<unknown> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON) throw new Error('규칙 JSON은 1 MiB 이하의 일반 파일이어야 합니다.');
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

/** 'stale': the saved profile was loaded but not applied because its reference folder looks changed (preview.profileNotice). */
export interface ProfileInfo { source: 'saved' | 'stale' | 'file' | 'none' | 'skipped' | 'corrupt'; id: string | null; revision: number | null;
  status: string | null; warning?: string }
export interface AnalyzeValues { profile?: string | undefined; reference?: string | undefined; 'no-saved-rules'?: boolean | undefined;
  move?: string[] | undefined; remember?: boolean | undefined }
export interface AnalyzeContext { warn: (line: string) => void; stateDir: () => string; options: { signal?: AbortSignal };
  /** The command will write the state folder: it must not overlap the work or reference folder. */
  writesState: boolean }
export interface Target { grant: RootGrant; referenceGrant: ReferenceGrant | undefined; analysis: Analysis; info: ProfileInfo; saved: Stored;
  picked: { fileId: string; relativePath: string; target: string }[] }

export function profileLine(info: ProfileInfo, stale = info.source === 'stale'): string {
  const notApplied = '이번 분석에는 적용하지 않음(참고 폴더 변경 감지, 기본 분류, 참고 파일 보호는 유지)';
  return info.source === 'file' ? stale ? `개인 규칙: --profile 파일(ID ${info.id}, revision ${info.revision}) — ${notApplied}`
      : `개인 규칙: --profile 파일 적용(ID ${info.id}, revision ${info.revision}, 상태 ${info.status})`
    : info.source === 'stale' ? `개인 규칙: 저장된 프로필(revision ${info.revision}) — ${notApplied}`
    : info.source === 'skipped' ? '개인 규칙: --no-saved-rules로 적용하지 않음(기본 분류)'
    : info.source === 'none' ? '개인 규칙: 저장된 규칙 없음(기본 분류)'
    : info.source === 'corrupt' ? '개인 규칙: 저장된 프로필 손상으로 적용하지 않음(기본 분류)'
    : info.status === 'disabled' ? '개인 규칙: 저장된 프로필이 꺼져 있음(기본 분류, 참고 파일 보호는 유지)'
    : `개인 규칙: 저장된 프로필 적용(revision ${info.revision})`;
}

export async function analyzeTarget(target: string, values: AnalyzeValues, ctx: AnalyzeContext): Promise<Target> {
  const moves = values.move ?? [];
  if (values.profile !== undefined && values['no-saved-rules']) throw usage('--profile과 --no-saved-rules 중 하나만 쓰세요.');
  // Profile: an explicit file, else the saved one (damaged → warn and fall back to default rules), unless skipped.
  let profile: AnyProfile | undefined; let info: ProfileInfo;
  let saved: Stored = null;
  if (values.profile !== undefined) {
    profile = parseProfile(await readJsonFile(values.profile));
    info = { source: 'file', id: profile.id, revision: profile.revision, status: profile.status };
  } else if (values['no-saved-rules']) info = { source: 'skipped', id: null, revision: null, status: null };
  else {
    saved = await loadProfile({ stateDir: ctx.stateDir() });
    if (saved === null) info = { source: 'none', id: null, revision: null, status: null };
    else if (isCorrupt(saved)) {
      info = { source: 'corrupt', id: null, revision: null, status: null,
        warning: `저장된 개인 규칙 프로필이 손상돼 적용하지 않았습니다: ${saved.reason}` };
      if (values.remember) throw new AfoError('STATE_CORRUPT', `${info.warning} ${corruptHint}`);
      ctx.warn(`경고: ${info.warning} ${corruptHint}`);
    } else { profile = saved; info = { source: 'saved', id: saved.id, revision: saved.revision, status: saved.status }; }
  }

  const grant = await issueRootGrant(target);
  const referenceGrant = values.reference !== undefined ? await issueReferenceGrant(values.reference) : undefined;
  if (ctx.writesState) {
    // Saving must not write into the folders being organized or consulted.
    await assertStateDirOutside(ctx.stateDir(), grant.canonicalPath);
    if (referenceGrant) await assertStateDirOutside(ctx.stateDir(), referenceGrant.canonicalPath);
  }
  // One-off corrections: "<relative path>=<folder>", resolved to file IDs of the current scan.
  const overrides: Record<string, string> = {};
  const picked: Target['picked'] = [];
  if (moves.length) {
    const files = (await scanRoot(grant, ctx.options)).files;
    for (const spec of moves) {
      if (!spec.includes('=')) throw usage(`--move는 <상대 경로>=<목적지 폴더> 형식입니다: ${spec}`);
      const splits = [...spec.matchAll(/=/gu)].map((m) => m.index)
        .map((i) => [spec.slice(0, i), spec.slice(i + 1)] as const)
        .map(([rel, dir]) => [files.find((f) => f.relativePath === rel) ?? files.find((f) => pathKey(f.relativePath) === pathKey(rel)), dir] as const)
        .filter(([file]) => file !== undefined);
      if (splits.length !== 1) throw new Error(`--move의 파일을 이 폴더에서 하나로 찾을 수 없습니다: ${spec}`);
      const [file, dir] = splits[0]!;
      const folder = TargetDirectorySchema.safeParse(dir);
      if (!folder.success) throw usage(`--move의 목적지는 작업 폴더 안의 상대 폴더여야 합니다(숨김·..·절대 경로 불가): ${dir}`);
      if (overrides[file!.id] !== undefined) throw usage(`같은 파일에 --move를 두 번 지정했습니다: ${file!.relativePath}`);
      overrides[file!.id] = folder.data;
      picked.push({ fileId: file!.id, relativePath: file!.relativePath, target: folder.data });
    }
    if (values.remember) {
      const names = picked.map((p) => pathKey(path.posix.basename(p.relativePath)));
      if (new Set(names).size !== names.length) throw usage('--remember는 파일 이름으로 저장하므로 같은 이름의 파일을 두 번 지정할 수 없습니다.');
    }
  }

  const analysis = await analyzeRoot(grant, { ...ctx.options, stateDir: ctx.stateDir(), ...(profile ? { profile } : {}),
    ...(referenceGrant ? { reference: referenceGrant } : {}), ...(picked.length ? { overrides } : {}) });
  for (const p of picked) {
    const item = analysis.preview.items.find((i) => i.fileId === p.fileId);
    if (!item) throw new AfoError('FILE_CHANGED', `분석 중 파일이 바뀌었습니다: ${p.relativePath}. 다시 실행하세요.`);
    if (item.reasonCode === 'PROTECTED_REFERENCE') throw new Error(`참고한 기존 파일은 옮기지 않습니다: ${p.relativePath}`);
    if (item.reasonCode === 'READ_FAILED') throw new Error(`읽지 못한 파일은 수정할 수 없습니다: ${p.relativePath}`);
  }
  if (analysis.preview.profileNotice?.code === 'PROFILE_STALE' && info.source === 'saved') info = { ...info, source: 'stale' };
  return { grant, referenceGrant, analysis, info, saved, picked };
}
