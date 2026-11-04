#!/usr/bin/env node
// Local-only user-path check: two real release archives, a loopback release server, and a disposable installation.
// node scripts/release/verify-update.mjs --old <older archive> --new <newer archive>
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const { values } = parseArgs({ options: { old: { type: 'string' }, new: { type: 'string' } } });
if (!values.old || !values.new) throw new Error('Both --old and --new release archives are required.');
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Run on macOS or Windows.');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const root = await mkdtemp(path.join(tmpdir(), 'afo-self-update-'));
const requests = [];
let badChecksum = false;
let server;
try {
  const name = process.platform === 'win32' ? 'afo.exe' : 'afo';
  const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar';
  for (const [kind, archive] of [['old', values.old], ['new', values.new]]) {
    const dir = path.join(root, kind); await mkdir(dir);
    await execute(tar, ['-xf', path.resolve(archive), '-C', dir, name]);
    if (process.platform !== 'win32') await chmod(path.join(dir, name), 0o755);
  }
  const oldExe = path.join(root, 'old', name);
  const newExe = path.join(root, 'new', name);
  const oldVersion = (await execute(oldExe, ['--version'])).stdout.trim().replace(/^afo /u, '');
  const newVersion = (await execute(newExe, ['--version'])).stdout.trim().replace(/^afo /u, '');
  assert.notEqual(oldVersion, newVersion, 'Use different release versions.');
  const archive = path.basename(values.new);
  const data = await readFile(values.new);
  const checksum = hash(data);
  const metadata = JSON.stringify({ tag_name: `v${newVersion}`, draft: false, prerelease: false,
    assets: [{ name: archive }, { name: 'SHA256SUMS' }] });
  server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/latest.json') res.end(metadata);
    else if (req.url === '/SHA256SUMS') res.end(`${badChecksum ? '0'.repeat(64) : checksum}  ${archive}\n`);
    else if (req.url === `/${archive}`) res.end(data);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const install = path.join(root, '설치 경로 with spaces'); await mkdir(install);
  const executable = path.join(install, name);
  await copyFile(oldExe, executable);
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  const entry = process.platform === 'darwin' ? path.join(root, 'afo-path-link') : executable;
  if (entry !== executable) await symlink(executable, entry);
  const state = path.join(root, 'state'); await mkdir(state);
  const saved = path.join(state, 'saved-rules.json'); await writeFile(saved, 'preserve saved rules');
  const env = { ...process.env, AFO_STATE_DIR: state, AFO_UPDATE_BASE: `http://127.0.0.1:${server.address().port}` };
  const run = (args) => execute(entry, args, { env, timeout: 60_000, windowsHide: true });
  const expectedHash = hash(await readFile(newExe));
  const updated = await run(['update']);
  assert.match(updated.stdout, /업데이트 완료/u);
  assert.equal((await run(['--version'])).stdout.trim(), `afo ${newVersion}`);
  assert.equal(hash(await readFile(executable)), expectedHash);
  assert.equal(await readFile(saved, 'utf8'), 'preserve saved rules');
  const before = requests.length;
  assert.match((await run(['update'])).stdout, /이미 최신/u);
  assert.deepEqual(requests.slice(before), ['/latest.json']);
  // Restore only this synthetic old executable, then exercise a failed update via the same public CLI.
  const restore = path.join(install, 'restore'); await copyFile(oldExe, restore);
  if (process.platform !== 'win32') await chmod(restore, 0o755);
  const { rename } = await import('node:fs/promises');
  await rename(restore, executable);
  const originalHash = hash(await readFile(executable));
  badChecksum = true;
  await assert.rejects(run(['update']), (error) => error.code === 1 && /SHA-256/u.test(error.stderr));
  assert.equal(hash(await readFile(executable)), originalHash);
  assert.equal((await run(['--version'])).stdout.trim(), `afo ${oldVersion}`);
  assert.equal(await readFile(saved, 'utf8'), 'preserve saved rules');
  assert.equal((await readdir(install)).some((item) => item.startsWith('.afo-update-') || item.endsWith('.update-lock')), false);
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, oldVersion, newVersion,
    replacement: 'passed', latestNoop: 'passed', checksumFailurePreservesOriginal: 'passed',
    savedRulesPreserved: true, executableSha256: expectedHash, localRequests: requests, liveReleaseRequests: 0 }, null, 2));
} finally {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
