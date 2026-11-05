import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { AfoError, RelativePathSchema, SmartOptionsSchema, TargetDirectorySchema } from '../../../packages/contracts/src/index.js';
import type { ReferenceGrant, RootGrant, ScanProgress, SmartOptions } from '../../../packages/contracts/src/index.js';
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
  move?: string[] | undefined; remember?: boolean | undefined;
  rename?: string[] | undefined; renames?: { fileId: string; name: string }[] | undefined; smart?: SmartOptions | undefined;
  skip?: string[] | undefined; skips?: string[] | undefined;
  conflicts?: string | undefined; content?: boolean | undefined; ocr?: boolean | undefined; 'photo-dates'?: string | undefined;
  'similar-photos'?: boolean | undefined; 'similar-threshold'?: string | undefined; 'ai-model'?: string | undefined; 'ai-url'?: string | undefined;
  /** One-off corrections chosen by file ID (the guided flow); the same path as --move without parsing "<path>=<folder>" text. */
  overrides?: { fileId: string; target: string }[] | undefined }
export interface AnalyzeContext { warn: (line: string) => void; stateDir: () => string;
  options: { signal?: AbortSignal; onProgress?: (progress: ScanProgress) => void };
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
  const parsedSmart = SmartOptionsSchema.safeParse({ ...(values.smart ?? {}),
    ...(values.conflicts !== undefined ? { conflicts: values.conflicts } : {}), ...(values.content !== undefined ? { content: values.content } : {}),
    ...(values.ocr !== undefined ? { ocr: values.ocr } : {}), ...(values['photo-dates'] !== undefined ? { photoDates: values['photo-dates'] } : {}),
    ...(values['similar-photos'] !== undefined ? { similarPhotos: values['similar-photos'] } : {}),
    ...(values['similar-threshold'] !== undefined ? { similarThreshold: Number(values['similar-threshold']) } : {}),
    ...(values['ai-model'] !== undefined ? { aiModel: values['ai-model'] } : {}), ...(values['ai-url'] !== undefined ? { aiUrl: values['ai-url'] } : {}) });
  if (!parsedSmart.success) throw usage(`분석 옵션이 올바르지 않습니다: ${parsedSmart.error.issues[0]?.message ?? ''}`);
  const smart = parsedSmart.data;
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
  const renames: Record<string, string> = {};
  const skips = new Set(values.skips ?? []);
  const picked: Target['picked'] = [];
  if (moves.length || values.rename?.length || values.skip?.length) {
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
    for (const spec of values.rename ?? []) {
      const choices = [...spec.matchAll(/=/gu)].map((match) => match.index).map((i) => [files.find((file) => pathKey(file.relativePath) === pathKey(spec.slice(0, i))), spec.slice(i + 1)] as const).filter(([file]) => file);
      if (choices.length !== 1) throw usage('--rename는 <상대 경로>=<새 파일 이름> 형식이며 현재 파일 하나와 일치해야 합니다.');
      const [file, name] = choices[0]!;
      if (renames[file!.id]) throw usage('같은 파일에 이름 변경을 두 번 지정했습니다.');
      renames[file!.id] = name;
    }
    for (const name of values.skip ?? []) { const file = files.find((file) => pathKey(file.relativePath) === pathKey(name));
      if (!file) throw usage('--skip에는 현재 작업 폴더에 있는 파일의 상대 경로를 지정하세요.'); skips.add(file.id); }
  }
  for (const value of values.renames ?? []) {
    if (renames[value.fileId]) throw usage('같은 파일에 이름 변경을 두 번 지정했습니다.');
    renames[value.fileId] = value.name;
  }
  for (const name of Object.values(renames)) if (!RelativePathSchema.safeParse(name).success || name.includes('/') || name.includes('\\') || name.startsWith('.'))
    throw usage('새 파일 이름은 경로 구분자·숨김·예약 이름 없는 파일 이름 하나여야 합니다.');

  const byId: { fileId: string; target: string }[] = [];
  for (const o of values.overrides ?? []) {
    const folder = TargetDirectorySchema.safeParse(o.target);
    if (!folder.success) throw usage(`목적지는 작업 폴더 안의 상대 폴더여야 합니다(숨김·..·절대 경로 불가): ${o.target}`);
    if (overrides[o.fileId] !== undefined) throw usage('같은 파일에 수정을 두 번 지정했습니다.');
    overrides[o.fileId] = folder.data;
    byId.push({ fileId: o.fileId, target: folder.data });
  }

  const analysis = await analyzeRoot(grant, { ...ctx.options, stateDir: ctx.stateDir(), ...(profile ? { profile } : {}),
    ...(referenceGrant ? { reference: referenceGrant } : {}), ...(Object.keys(overrides).length ? { overrides } : {}),
    ...(Object.keys(renames).length ? { renames } : {}), ...(skips.size ? { skips: [...skips] } : {}), ...(Object.keys(smart).length ? { smart } : {}) });
  for (const fileId of Object.keys(renames)) {
    const item = analysis.preview.items.find((item) => item.fileId === fileId);
    if (!item) throw new AfoError('FILE_CHANGED', '이름을 변경할 파일이 분석 중 바뀌었습니다.');
    if (item.reasonCode === 'PROTECTED_REFERENCE' || item.reasonCode === 'READ_FAILED') throw usage('보호되거나 읽지 못한 파일의 이름은 변경하지 않습니다.');
  }
  for (const o of byId) {
    // File IDs hash the root, relative path and inode: a missing ID means the file was renamed, replaced or removed since.
    const item = analysis.preview.items.find((i) => i.fileId === o.fileId);
    if (!item) throw new AfoError('FILE_CHANGED', '분석 중 파일이 바뀌었습니다. 다시 실행하세요.');
    picked.push({ fileId: o.fileId, relativePath: item.source, target: o.target });
  }
  for (const p of picked) {
    const item = analysis.preview.items.find((i) => i.fileId === p.fileId);
    if (!item) throw new AfoError('FILE_CHANGED', `분석 중 파일이 바뀌었습니다: ${p.relativePath}. 다시 실행하세요.`);
    if (item.reasonCode === 'PROTECTED_REFERENCE') throw new Error(`참고한 기존 파일은 옮기지 않습니다: ${p.relativePath}`);
    if (item.reasonCode === 'READ_FAILED') throw new Error(`읽지 못한 파일은 수정할 수 없습니다: ${p.relativePath}`);
  }
  if (analysis.preview.profileNotice?.code === 'PROFILE_STALE' && info.source === 'saved') info = { ...info, source: 'stale' };
  return { grant, referenceGrant, analysis, info, saved, picked };
}
