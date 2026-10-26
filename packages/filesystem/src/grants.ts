import { lstat, readdir, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { AfoError, OpaqueIdSchema, ReferenceGrantSchema, RootGrantSchema } from '../../contracts/src/index.js';
import type { ReferenceGrant, RootGrant } from '../../contracts/src/index.js';
import { digest } from '../../engine/src/index.js';

/**
 * Root grants (#6). Only this module issues grants; every grant is registered in this process and re-verified
 * (registration, real path, dev/inode) before use. A grant built elsewhere — e.g. from CLI JSON — is rejected.
 * Persisting grants across processes is the shared service's job (#8); it must re-issue and compare identity.
 */
export const projectMarkers: ReadonlySet<string> = new Set(['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'Package.swift',
  'go.mod', 'pom.xml', 'build.gradle', '.hg', '.svn']);
export const bundlePattern = /\.(?:app|framework|bundle|plugin|kext|xcodeproj|xcworkspace|photoslibrary|photolibrary|musiclibrary)$/iu;
const processSession = randomUUID();
/** Session of this process. Grants and later approvals are bound to it. */
export const currentSessionId = (): string => processSession;
const issued = new Map<string, string>();

const fsCode = (error: unknown): string => error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
const fold = (value: string): string =>
  process.platform === 'darwin' || process.platform === 'win32' ? value.normalize('NFC').toLowerCase() : value;
export const within = (root: string, child: string): boolean => {
  const rel = path.relative(fold(root), fold(child));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
};
const same = (a: string, b: string): boolean => fold(path.resolve(a)) === fold(path.resolve(b));
const forbidden = (message: string, cause?: unknown): AfoError =>
  new AfoError('ROOT_FORBIDDEN', message, cause === undefined ? undefined : { cause });

/** OS-managed locations: whole trees (`inside`) and folders that may hold user folders but are not roots themselves (`exact`). */
function osLocations(home: string): { inside: string[]; exact: string[] } {
  if (process.platform === 'win32') {
    const env = process.env;
    return { inside: [env['WINDIR'] ?? 'C:\\Windows', env['ProgramFiles'] ?? 'C:\\Program Files',
      env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', env['ProgramData'] ?? 'C:\\ProgramData',
      env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming')].filter((p) => p !== ''),
    // os.tmpdir() lives under AppData\Local, so only the container itself is refused.
    exact: [home, path.join(home, 'AppData'), path.join(home, 'AppData', 'Local'), path.dirname(home)] };
  }
  return { inside: ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/dev',
    '/proc', '/sys', '/boot', path.join(home, 'Library')],
  exact: [home, '/Users', '/home', '/Volumes', '/private', '/private/var', '/var', '/tmp', '/private/tmp'] };
}

async function hasProjectMarker(dir: string): Promise<boolean> {
  try { return (await readdir(dir)).some((name) => projectMarkers.has(name) || /\.xcodeproj$/iu.test(name)); }
  catch { return false; }
}

/** Shared root policy: a real folder chosen directly, not a disk root, home, OS folder, app bundle or dev project. */
async function checkRoot(input: unknown): Promise<{ canonicalPath: string; stat: BigIntStats }> {
  if (typeof input !== 'string' || input === '' || input.includes('\u0000')) throw forbidden('폴더 경로가 필요합니다.');
  // "a/../b" means different folders lexically and physically once a link is involved; refuse instead of guessing.
  if (input.split(process.platform === 'win32' ? /[\\/]/u : /\//u).some((part) => part === '.' || part === '..'))
    throw forbidden('"."·".."가 들어간 경로는 받지 않습니다. 폴더를 직접 선택하세요.');
  // Device/namespace (\\?\, \\.\) and UNC network paths bypass Win32 path rules; the first version accepts local drive folders only.
  if (process.platform === 'win32' && /^[\\/]{2}/u.test(input))
    throw forbidden('장치·네트워크(UNC) 경로는 받지 않습니다. 로컬 드라이브의 폴더를 선택하세요.');
  const unreadable = (error: unknown): AfoError =>
    new AfoError(fsCode(error) === 'EACCES' || fsCode(error) === 'EPERM' ? 'PERMISSION_DENIED' : 'ROOT_FORBIDDEN',
      '선택한 폴더를 찾거나 읽을 수 없습니다.', { cause: error });
  const notFolder = (): AfoError => forbidden('일반 폴더를 직접 선택해야 합니다(파일·링크·바로가기 불가).');
  let stat: BigIntStats; let canonicalPath: string;
  try {
    // The input itself must not be a link; type and identity come from the real path the grant will name.
    if ((await lstat(path.resolve(input), { bigint: true })).isSymbolicLink()) throw notFolder();
    canonicalPath = await realpath(input);
    stat = await lstat(canonicalPath, { bigint: true });
  } catch (error) { throw error instanceof AfoError ? error : unreadable(error); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw notFolder();
  const home = await realpath(homedir()).catch(() => path.resolve(homedir()));
  const locations = osLocations(home);
  if (canonicalPath === path.parse(canonicalPath).root || locations.exact.some((p) => same(p, canonicalPath)) ||
      locations.inside.some((p) => within(path.resolve(p), canonicalPath)))
    throw forbidden('홈 전체, 디스크 루트와 시스템 폴더는 분석 대상이 아닙니다.');
  if (await hasProjectMarker(canonicalPath)) throw forbidden('개발 프로젝트 내부는 분석하지 않습니다.');
  // Ancestors: app bundles and project markers. Home itself is skipped (a dotfiles repo in home must not block everything).
  for (let dir = canonicalPath; ; ) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (bundlePattern.test(path.basename(dir))) throw forbidden('앱·라이브러리 묶음 내부는 분석하지 않습니다.');
    if (dir !== canonicalPath && !same(dir, home) && await hasProjectMarker(dir))
      throw forbidden('개발 프로젝트 내부는 분석하지 않습니다.');
    dir = parent;
  }
  return { canonicalPath, stat };
}

async function issue<G extends RootGrant | ReferenceGrant>(input: unknown, scope: G['scope'], sessionId: string): Promise<G> {
  const { canonicalPath, stat } = await checkRoot(input);
  const fields = { formatVersion: 1, canonicalPath, device: String(stat.dev), inode: String(stat.ino),
    sessionId: OpaqueIdSchema.parse(sessionId), issuedAt: new Date().toISOString() };
  // Random salt: re-selecting the same folder yields a new grant, which invalidates anything bound to the old one.
  const id = digest(JSON.stringify([scope, fields, randomBytes(16).toString('hex')]));
  const grant = scope === 'work' ? RootGrantSchema.parse({ ...fields, id, scope })
    : ReferenceGrantSchema.parse({ ...fields, id, scope, readOnly: true });
  issued.set(id, canonical(grant));
  return grant as G;
}
const canonical = (grant: RootGrant | ReferenceGrant): string =>
  JSON.stringify(Object.entries(grant).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

/** Work root: the only scope later write APIs accept. */
export const issueRootGrant = (input: string, options: { sessionId?: string } = {}): Promise<RootGrant> =>
  issue<RootGrant>(input, 'work', options.sessionId ?? processSession);
/** Reference folder: read-only, metadata only. */
export const issueReferenceGrant = (input: string, options: { sessionId?: string } = {}): Promise<ReferenceGrant> =>
  issue<ReferenceGrant>(input, 'reference', options.sessionId ?? processSession);

/**
 * Re-checks a grant right before use: issued by this process and unchanged, same session if given,
 * and the folder at canonicalPath is still the same real directory (dev/inode). A replaced or relinked root is refused.
 */
export async function verifyGrant<S extends 'work' | 'reference'>(input: unknown, scope: S, options: { sessionId?: string } = {}):
  Promise<S extends 'work' ? RootGrant : ReferenceGrant> {
  const parsed = scope === 'work' ? RootGrantSchema.safeParse(input) : ReferenceGrantSchema.safeParse(input);
  if (!parsed.success) throw forbidden(scope === 'work' ? '작업 폴더 권한(RootGrant)이 아닙니다.' : '참고 폴더 권한(ReferenceGrant)이 아닙니다.');
  const grant = parsed.data;
  if (issued.get(grant.id) !== canonical(grant)) throw forbidden('이 실행에서 발급하지 않았거나 변조된 폴더 권한입니다.');
  if (options.sessionId !== undefined && grant.sessionId !== options.sessionId) throw forbidden('다른 세션의 폴더 권한입니다.');
  let stat: BigIntStats; let actual: string;
  try { [stat, actual] = await Promise.all([lstat(grant.canonicalPath, { bigint: true }), realpath(grant.canonicalPath)]); }
  catch (error) { throw new AfoError('FILE_CHANGED', '선택한 폴더가 사라졌거나 읽을 수 없습니다. 다시 선택하세요.', { cause: error }); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || actual !== grant.canonicalPath ||
      String(stat.dev) !== grant.device || String(stat.ino) !== grant.inode)
    throw new AfoError('FILE_CHANGED', '선택한 폴더가 바뀌었습니다(다른 폴더·링크로 교체). 다시 선택하세요.');
  return grant as S extends 'work' ? RootGrant : ReferenceGrant;
}

/** Drops a grant (e.g. when the user selects another folder). Later verification fails. */
export const revokeGrant = (grant: { id: string }): boolean => issued.delete(grant.id);
