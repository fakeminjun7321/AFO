#!/usr/bin/env node
// Called only by the trusted main-push workflow. Never uses a personal token or force-pushes.
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const parseVersion = (value) => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (!match) throw new Error(`정식 버전만 허용합니다: ${value}`);
  return match.slice(1).map(BigInt);
};
const compare = (left, right) => {
  const a = parseVersion(left); const b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
};

/** Respect an explicit newer package version; otherwise increment the highest stable tag's patch number. */
export function nextReleaseVersion(current, tags) {
  parseVersion(current);
  const stable = tags.filter((tag) => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag)).map((tag) => tag.slice(1));
  const latest = stable.sort(compare).at(-1);
  if (!latest || compare(current, latest) > 0) return current;
  const [major, minor, patch] = parseVersion(latest);
  return `${major}.${minor}.${patch + 1n}`;
}

export async function prepareAutoRelease(root, { expectedSha, output } = {}) {
  if (!expectedSha || !/^[0-9a-f]{40}$/u.test(expectedSha)) throw new Error('main 이벤트의 정확한 커밋 SHA가 필요합니다.');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const emit = async (values) => {
    if (output) await appendFile(output, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(JSON.stringify(values));
    return values;
  };
  const head = git('rev-parse', 'HEAD');
  const remoteMain = git('ls-remote', 'origin', 'refs/heads/main').split(/\s/u)[0];
  if (head !== expectedSha || remoteMain !== expectedSha) return emit({ skip: 'true', reason: 'superseded-main-push' });
  if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('수정 중인 작업 사본에서는 자동 릴리스를 준비하지 않습니다.');
  git('fetch', 'origin', '--tags');
  const packageFile = path.join(root, 'package.json');
  const lockFile = path.join(root, 'package-lock.json');
  const versionFile = path.join(root, 'apps/cli/src/version.ts');
  const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
  const lock = JSON.parse(await readFile(lockFile, 'utf8'));
  const source = await readFile(versionFile, 'utf8');
  const currentDeclaration = `export const AFO_VERSION = '${pkg.version}';`;
  if (!source.includes(currentDeclaration) || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version)
    throw new Error('package.json·lockfile·CLI 버전 상수가 다릅니다.');
  const tags = git('tag', '--list', 'v*').split('\n');
  const version = nextReleaseVersion(pkg.version, tags);
  const tag = `v${version}`;
  if (version !== pkg.version) {
    pkg.version = version; lock.version = version; lock.packages[''].version = version;
    await writeFile(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
    await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
    await writeFile(versionFile, source.replace(currentDeclaration, `export const AFO_VERSION = '${version}';`));
    git('config', 'user.name', 'github-actions[bot]');
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
    git('add', 'package.json', 'package-lock.json', 'apps/cli/src/version.ts');
    git('commit', '-m', `chore(release): ${tag}`);
    // A concurrent main change causes a normal non-fast-forward failure. Never force or silently rebase a release.
    git('push', 'origin', 'HEAD:refs/heads/main');
  }
  const sha = git('rev-parse', 'HEAD');
  git('tag', tag, sha);
  git('push', 'origin', `refs/tags/${tag}`);
  return emit({ skip: 'false', version, tag, sha });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await prepareAutoRelease(process.cwd(), { expectedSha: process.env.GITHUB_SHA, output: process.env.GITHUB_OUTPUT });
