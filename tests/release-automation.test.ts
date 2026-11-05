import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = new URL('../../scripts/release/prepare-auto-release.mjs', import.meta.url);
const automation = await import(script.href) as {
  nextReleaseVersion: (current: string, tags: string[]) => string;
  prepareAutoRelease: (root: string, options: { expectedSha: string; output?: string }) => Promise<Record<string, string>>;
};

test('automatic version selection respects explicit versions, uses numeric order, and ignores prereleases', () => {
  const cases: [string, string[], string][] = [
    ['0.4.0', ['v0.3.0'], '0.4.0'], ['0.4.0', ['v0.4.0'], '0.4.1'],
    ['0.4.0', ['v0.4.9', 'v0.4.10'], '0.4.11'], ['0.3.0', ['v0.4.0'], '0.4.1'],
    ['0.4.0', ['v0.5.0-beta.1', 'junk'], '0.4.0'], ['0.4.0', [], '0.4.0'],
  ];
  for (const [current, tags, expected] of cases) assert.equal(automation.nextReleaseVersion(current, tags), expected);
  for (const invalid of ['0.4', '01.4.0', '0.4.0-beta.1', '../0.4.0'])
    assert.throws(() => automation.nextReleaseVersion(invalid, []));
});

test('main automation commits all version files, pushes a real tag, and skips stale main events in a disposable Git repo', async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), 'afo-release-git-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const remote = path.join(temp, 'remote.git'); const root = path.join(temp, 'checkout');
  await mkdir(root);
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', '--initial-branch=main', remote); git('init', '--initial-branch=main');
  git('config', 'user.name', 'AFO Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('remote', 'add', 'origin', remote);
  await mkdir(path.join(root, 'apps/cli/src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.3.0' }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '0.3.0', packages: { '': { version: '0.3.0' } } }));
  await writeFile(path.join(root, 'apps/cli/src/version.ts'), "export const AFO_VERSION = '0.3.0';\n");
  git('add', '.'); git('commit', '-m', 'initial'); git('tag', 'v0.3.0'); git('push', 'origin', 'main', '--tags');
  const stale = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'feature.txt'), 'synthetic change'); git('add', '.'); git('commit', '-m', 'feature'); git('push', 'origin', 'main');
  const expectedSha = git('rev-parse', 'HEAD');
  assert.equal((await automation.prepareAutoRelease(root, { expectedSha: stale })).skip, 'true');
  const output = path.join(temp, 'github-output');
  const result = await automation.prepareAutoRelease(root, { expectedSha, output });
  assert.equal(result.version, '0.3.1'); assert.equal(result.skip, 'false');
  const mainSha = git('ls-remote', 'origin', 'refs/heads/main').split(/\s/u)[0];
  const tagSha = git('ls-remote', 'origin', 'refs/tags/v0.3.1').split(/\s/u)[0];
  assert.equal(mainSha, result.sha); assert.equal(tagSha, result.sha);
  assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, '0.3.1');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, '0.3.1'); assert.equal(lock.packages[''].version, '0.3.1');
  assert.match(await readFile(path.join(root, 'apps/cli/src/version.ts'), 'utf8'), /'0\.3\.1'/u);
  assert.match(await readFile(output, 'utf8'), /tag=v0\.3\.1/u);
  assert.equal(git('status', '--porcelain'), '');
});

test('synthetic update fixture cannot write to the public release directory', () => {
  const builder = fileURLToPath(new URL('../../scripts/release/build-binaries.mjs', import.meta.url));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const extra of [[], ['--out', path.join(root, 'release')]]) {
    const result = spawnSync(process.execPath, [builder, '--update-fixture', ...extra], { cwd: root, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /별도 --out 경로/u);
  }
});
