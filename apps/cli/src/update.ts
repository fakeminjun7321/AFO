import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isSea } from 'node:sea';
import { promisify } from 'node:util';
import { AFO_VERSION } from './version.js';

const execute = promisify(execFile);
const repo = 'fakeminjun7321/AFO';
const api = `https://api.github.com/repos/${repo}/releases/latest`;
const downloads = `https://github.com/${repo}/releases/download`;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Explicit dependencies for isolated tests; the CLI never accepts an executable path from arguments or environment. */
export interface UpdateRuntime {
  executable: string | undefined;
  platform: NodeJS.Platform;
  arch: string;
  version: string;
  fetch: typeof fetch;
  testBase?: string | undefined;
}

function localBase(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash)
    throw new Error('AFO_UPDATE_BASE는 로컬 검증용 http://127.0.0.1:<포트> 주소만 허용합니다.');
  return url.href.replace(/\/$/u, '');
}

/** Bounded downloads, no retries, HTTPS-only redirects to GitHub's release delivery hosts. */
async function download(url: string, max: number, runtime: UpdateRuntime, signal: AbortSignal, testBase: string | undefined): Promise<Buffer> {
  let next = new URL(url);
  const seen = new Set<string>();
  for (let hops = 0; hops <= 5; hops++) {
    if (seen.has(next.href)) throw new Error('업데이트 다운로드가 같은 주소로 반복 리디렉션됩니다.');
    seen.add(next.href);
    const local = testBase !== undefined && next.origin === new URL(testBase).origin;
    if (!local && (next.protocol !== 'https:' || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)))
      throw new Error('업데이트 다운로드 주소가 허용된 GitHub 주소가 아닙니다.');
    const response = await runtime.fetch(next, { redirect: 'manual', signal, headers: { 'User-Agent': `afo/${runtime.version}`, Accept: next.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || hops === 5) throw new Error('업데이트 다운로드의 리디렉션이 너무 많거나 잘못됐습니다.');
      next = new URL(location, next);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`업데이트 다운로드 실패: HTTP ${response.status}${response.status === 403 || response.status === 429 ? ' (GitHub 접근·요청 한도를 확인하세요)' : ''}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('업데이트 응답이 비어 있습니다.');
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > max) throw new Error('업데이트 응답이 허용 크기를 넘었습니다.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  }
  throw new Error('업데이트 다운로드 실패');
}

export async function updateCommand(signal: AbortSignal | undefined, warn: (line: string) => void, runtime: UpdateRuntime = {
  executable: isSea() ? process.execPath : undefined, platform: process.platform, arch: process.arch,
  version: AFO_VERSION, fetch: globalThis.fetch, testBase: process.env.AFO_UPDATE_BASE,
}): Promise<string> {
  if (!runtime.executable)
    throw new Error('소스에서 실행한 AFO는 자동 업데이트하지 않습니다. 저장소에서 git pull 후 npm ci --ignore-scripts 및 npm run build를 실행하세요. 단일 실행 파일 설치본에서는 afo update를 쓸 수 있습니다.');
  const target = runtime.platform === 'darwin' && ['arm64', 'x64'].includes(runtime.arch) ? `darwin-${runtime.arch}`
    : runtime.platform === 'win32' && runtime.arch === 'x64' ? 'win-x64' : undefined;
  if (!target) throw new Error('자동 업데이트는 macOS(arm64·x64)와 Windows(x64) 설치본을 지원합니다.');
  const testBase = localBase(runtime.testBase);
  const timeout = AbortSignal.timeout(180_000);
  const cancelled = signal ? AbortSignal.any([signal, timeout]) : timeout;
  cancelled.throwIfAborted();
  // Resolve installer-created symlinks to update the actual executable, preserving the PATH link.
  const executable = await realpath(runtime.executable);
  const original = await lstat(executable);
  if (!original.isFile() || original.nlink !== 1) throw new Error('업데이트 대상은 하드링크가 없는 일반 실행 파일이어야 합니다.');
  // One installation, one update. An interrupted updater leaves a visible lock rather than allowing races.
  const lock = `${executable}.update-lock`;
  try { await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`다른 업데이트가 실행 중이거나 중단된 잠금이 있습니다: ${lock}. 실행 중인 업데이트가 없는지 확인하세요.`);
    throw error;
  }
  let stage: string | undefined;
  try {
    warn('AFO 최신 버전을 확인하고 있습니다.');
    const release = JSON.parse((await download(testBase ? `${testBase}/latest.json` : api, 1024 * 1024, runtime, cancelled, testBase)).toString('utf8')) as {
      tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: { name?: unknown }[];
    };
    const latest = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/u, '') : '';
    if (!versionPattern.test(latest) || release.draft !== false || release.prerelease !== false || !versionPattern.test(runtime.version))
      throw new Error('최신 정식 릴리스의 버전 정보를 확인할 수 없습니다.');
    const numbers = latest.split('.').map(Number);
    const current = runtime.version.split('.').map(Number);
    const difference = numbers.map((n, i) => n - current[i]!).find((n) => n !== 0) ?? 0;
    if (difference <= 0) return difference === 0 ? `이미 최신 버전입니다: afo ${runtime.version}`
      : `설치된 afo ${runtime.version}이 최신 정식 릴리스(${latest})보다 새 버전입니다. 그대로 유지합니다.`;
    const archive = `afo-${target}.${runtime.platform === 'win32' ? 'zip' : 'tar.gz'}`;
    if (!Array.isArray(release.assets) || ![archive, 'SHA256SUMS'].every((name) => release.assets!.some((asset) => asset.name === name)))
      throw new Error('이 OS용 실행 파일 또는 SHA256SUMS가 릴리스에 없습니다.');
    const base = testBase ?? `${downloads}/${release.tag_name}`;
    warn(`AFO ${runtime.version} → ${latest} 내려받는 중`);
    const sums = (await download(`${base}/SHA256SUMS`, 1024 * 1024, runtime, cancelled, testBase)).toString('utf8');
    const expected = sums.split(/\r?\n/u).map((line) => /^([0-9a-f]{64})  (\S+)$/u.exec(line))
      .filter((match) => match?.[2] === archive);
    if (expected.length !== 1) throw new Error('SHA256SUMS에 올바른 체크섬이 없습니다.');
    const data = await download(`${base}/${archive}`, 200 * 1024 * 1024, runtime, cancelled, testBase);
    if (digest(data) !== expected[0]![1]) throw new Error('받은 파일의 SHA-256이 SHA256SUMS와 다릅니다. 설치본을 유지합니다.');
    // Same directory/volume: POSIX replacement is a single atomic rename, including signed macOS executables.
    stage = await mkdtemp(path.join(path.dirname(executable), '.afo-update-'));
    const archivePath = path.join(stage, archive);
    await writeFile(archivePath, data, { mode: 0o600 });
    const name = runtime.platform === 'win32' ? 'afo.exe' : 'afo';
    const unpacked = path.join(stage, name);
    // Git for Windows also supplies a GNU tar.exe, which treats C: as a remote host. Use Windows' built-in bsdtar.
    const tar = runtime.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
    await execute(tar, ['-xf', archivePath, '-C', stage, name], { signal: cancelled, timeout: 30_000, windowsHide: true });
    const candidate = await lstat(unpacked);
    if (!candidate.isFile() || candidate.nlink !== 1) throw new Error('압축 파일에 일반 실행 파일이 없습니다.');
    if (runtime.platform !== 'win32') await chmod(unpacked, 0o755);
    const checked = await execute(unpacked, ['--version'], { signal: cancelled, timeout: 15_000, windowsHide: true });
    if (checked.stdout.trim() !== `afo ${latest}`) throw new Error('받은 실행 파일의 버전이 릴리스와 다릅니다. 설치본을 유지합니다.');
    cancelled.throwIfAborted();
    const now = await lstat(executable);
    if (now.ino !== original.ino || now.dev !== original.dev || now.size !== original.size || now.mtimeMs !== original.mtimeMs)
      throw new Error('업데이트 중 설치 파일이 바뀌었습니다. 교체하지 않았습니다.');
    if (runtime.platform === 'win32') {
      // Windows cannot overwrite a running image. Rename it aside, then place the verified replacement.
      const backup = `${executable}.previous-${randomUUID()}`;
      await rename(executable, backup);
      try { await rename(unpacked, executable); }
      catch (error) {
        try { await rename(backup, executable); }
        catch (restoreError) {
          throw new Error(`새 실행 파일 배치와 원래 이름 복원에 실패했습니다. 이전 설치본은 ${backup}에 있습니다. ${String(restoreError)}`, { cause: error });
        }
        throw error;
      }
      try { await rm(backup); }
      catch { warn(`실행 중이던 이전 파일은 종료 후 지울 수 있습니다: ${backup}`); }
    } else await rename(unpacked, executable);
    return `업데이트 완료: afo ${runtime.version} → ${latest}\n다음 실행부터 새 버전을 사용합니다. afo --version으로 확인하세요.`;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch((error: unknown) => warn(`업데이트 임시 폴더 정리 실패: ${String(error)}`));
    await rm(lock).catch((error: unknown) => warn(`업데이트 잠금 정리 실패: ${lock} (${String(error)})`));
  }
}
