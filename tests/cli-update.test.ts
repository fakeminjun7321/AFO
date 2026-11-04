import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateCommand } from '../apps/cli/src/update.js';
import type { UpdateRuntime } from '../apps/cli/src/update.js';
import { run } from '../apps/cli/src/index.js';

const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const archive = 'afo-darwin-arm64.tar.gz';
const metadata = (version = '0.4.0'): string => JSON.stringify({ tag_name: `v${version}`, draft: false, prerelease: false,
  assets: [{ name: archive }, { name: 'SHA256SUMS' }] });

async function setup(t: test.TestContext): Promise<{ dir: string; executable: string; runtime: UpdateRuntime; urls: string[]; responses: Map<string, string | Buffer | number> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'afo-update-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'afo');
  await writeFile(executable, 'original executable');
  const responses = new Map<string, string | Buffer | number>([['latest', metadata()]]);
  const urls: string[] = [];
  const request: typeof fetch = async (input) => {
    const url = String(input); urls.push(url);
    const key = url.endsWith('/latest') ? 'latest' : path.posix.basename(new URL(url).pathname);
    const value = responses.get(key);
    if (typeof value === 'number') return new Response(null, { status: value });
    if (value === undefined) throw new Error(`unexpected request: ${url}`);
    return new Response(typeof value === 'string' ? value : new Uint8Array(value));
  };
  return { dir, executable, urls, responses, runtime: { executable, platform: 'darwin', arch: 'arm64', version: '0.3.0', fetch: request } };
}

test('update is discoverable and rejects flags, targets and source execution without touching Node', async () => {
  assert.match(await run(['help']), /afo update/u);
  assert.match(await run(['help', '--all']), /SHA-256/u);
  await assert.rejects(run(['update', 'folder']), /추가 인수/u);
  await assert.rejects(run(['update', '--json']), /옵션/u);
  const nodeBefore = hash(await readFile(process.execPath));
  const cli = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'update'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /소스에서 실행한 AFO/u);
  assert.equal(hash(await readFile(process.execPath)), nodeBefore);
});

test('same or newer installed version skips asset downloads and leaves no lock', async (t) => {
  for (const version of ['0.3.0', '0.2.9']) {
    const s = await setup(t); s.responses.set('latest', metadata(version));
    assert.match(await updateCommand(undefined, () => {}, s.runtime), /최신|유지/u);
    assert.equal(s.urls.length, 1);
    assert.equal(await readFile(s.executable, 'utf8'), 'original executable');
    assert.deepEqual(await readdir(s.dir), ['afo']);
  }
});

test('version comparison is numeric (0.10.0 is newer than 0.9.0)', async (t) => {
  const s = await setup(t); s.runtime.version = '0.9.0'; s.responses.set('latest', metadata('0.10.0'));
  s.responses.set('SHA256SUMS', 'missing checksum');
  await assert.rejects(updateCommand(undefined, () => {}, s.runtime), /체크섬/u);
  assert.equal(s.urls.length, 2);
});

test('network errors, rate limits, missing releases/assets and invalid versions preserve installed bytes', async (t) => {
  for (const response of [403, 404, 429, 500, 'invalid json', metadata('../bad'), metadata('0.4.0-beta.1'),
    JSON.stringify({ tag_name: 'v0.4.0', draft: false, prerelease: true }),
    JSON.stringify({ tag_name: 'v0.4.0', draft: false, prerelease: false, assets: [] })]) {
    const s = await setup(t); s.responses.set('latest', response);
    await assert.rejects(updateCommand(undefined, () => {}, s.runtime));
    assert.equal(s.urls.length, 1);
    assert.equal(await readFile(s.executable, 'utf8'), 'original executable');
    assert.deepEqual(await readdir(s.dir), ['afo']);
  }
});

test('bad and duplicate checksums abort before executing or replacing anything', async (t) => {
  for (const sums of [`${'0'.repeat(64)}  ${archive}\n`, `${'0'.repeat(64)}  ${archive}\n`.repeat(2), 'bad sum']) {
    const s = await setup(t); s.responses.set('SHA256SUMS', sums); s.responses.set(archive, Buffer.from('not executable'));
    await assert.rejects(updateCommand(undefined, () => {}, s.runtime), /체크섬|SHA-256/u);
    assert.equal(await readFile(s.executable, 'utf8'), 'original executable');
    assert.deepEqual(await readdir(s.dir), ['afo']);
  }
});

test('cancellation and unsupported platforms do not make requests or writes', async (t) => {
  const s = await setup(t);
  await assert.rejects(updateCommand(AbortSignal.abort(), () => {}, s.runtime), { name: 'AbortError' });
  await assert.rejects(updateCommand(undefined, () => {}, { ...s.runtime, platform: 'linux' }), /지원/u);
  assert.equal(s.urls.length, 0);
  assert.deepEqual(await readdir(s.dir), ['afo']);
});

test('an existing update lock is preserved and prevents a second updater', async (t) => {
  const s = await setup(t); await writeFile(`${s.executable}.update-lock`, 'other updater');
  await assert.rejects(updateCommand(undefined, () => {}, s.runtime), /잠금/u);
  assert.equal(await readFile(`${s.executable}.update-lock`, 'utf8'), 'other updater');
  assert.equal(s.urls.length, 0);
});

test('untrusted download overrides and redirect targets are rejected without followup requests', async (t) => {
  const s = await setup(t);
  await assert.rejects(updateCommand(undefined, () => {}, { ...s.runtime, testBase: 'http://example.com' }), /로컬 검증/u);
  for (const location of ['https://example.com/payload', 'http://github.com/payload', 'https://api.github.com/repos/fakeminjun7321/AFO/releases/latest']) {
    let count = 0;
    const request: typeof fetch = async () => { count++; return new Response(null, { status: 302, headers: { location } }); };
    await assert.rejects(updateCommand(undefined, () => {}, { ...s.runtime, fetch: request }), /주소|반복/u);
    assert.equal(count, 1);
  }
});

// Real tar, executable, filesystem rename and checksum checks on macOS. HTTP is substituted above, never the destination files.
test('macOS swaps only the verified executable through a PATH symlink and preserves state', { skip: process.platform !== 'darwin' }, async (t) => {
  const s = await setup(t);
  const payload = path.join(s.dir, 'payload');
  await writeFile(payload, '#!/bin/sh\nprintf "afo 0.4.0\\n"\n', { mode: 0o755 });
  const contentDir = await mkdtemp(path.join(s.dir, 'content-'));
  await rename(payload, path.join(contentDir, 'afo'));
  const file = path.join(s.dir, archive);
  execFileSync('/usr/bin/tar', ['-czf', file, '-C', contentDir, 'afo']);
  const data = await readFile(file);
  s.responses.set(archive, data); s.responses.set('SHA256SUMS', `${hash(data)}  ${archive}\n`);
  const state = path.join(s.dir, 'saved-rules.json'); await writeFile(state, 'rules must survive');
  const link = path.join(s.dir, 'afo-link'); await symlink(s.executable, link);
  const output = await updateCommand(undefined, () => {}, { ...s.runtime, executable: link });
  assert.match(output, /업데이트 완료/u);
  assert.equal(execFileSync(link, ['--version'], { encoding: 'utf8' }).trim(), 'afo 0.4.0');
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await readFile(state, 'utf8'), 'rules must survive');
  assert.equal((await readdir(s.dir)).some((name) => name.startsWith('.afo-update-') || name.endsWith('.update-lock')), false);
});

test('a checksum-valid archive with a wrong executable version keeps the original', { skip: process.platform !== 'darwin' }, async (t) => {
  const s = await setup(t);
  const payload = await mkdtemp(path.join(s.dir, 'payload-'));
  await writeFile(path.join(payload, 'afo'), '#!/bin/sh\nprintf "afo 0.1.0\\n"\n');
  await chmod(path.join(payload, 'afo'), 0o755);
  const file = path.join(s.dir, archive); execFileSync('/usr/bin/tar', ['-czf', file, '-C', payload, 'afo']);
  const data = await readFile(file); s.responses.set(archive, data); s.responses.set('SHA256SUMS', `${hash(data)}  ${archive}\n`);
  await assert.rejects(updateCommand(undefined, () => {}, s.runtime), /버전이 릴리스와 다릅니다/u);
  assert.equal(await readFile(s.executable, 'utf8'), 'original executable');
  assert.equal((await readdir(s.dir)).some((name) => name.startsWith('.afo-update-') || name.endsWith('.update-lock')), false);
});

