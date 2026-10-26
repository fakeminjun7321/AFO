import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { AfoError } from '../packages/contracts/src/index.js';
import type { ErrorCode } from '../packages/contracts/src/index.js';
import { LOCK_RELEASE_WARNING, readRootLock, rootLockFile, withRootLock } from '../packages/filesystem/src/lock.js';
import { createFixture } from './helpers.js';

const code = (expected: ErrorCode) => (error: unknown): boolean => error instanceof AfoError && error.code === expected;
const ID = 'a'.repeat(64);
const OTHER_ID = 'b'.repeat(64);
const LOCK_MODULE = new URL('../packages/filesystem/src/lock.js', import.meta.url).href;
const LOCKED_EXIT = 3;
// Child: acquires, prints ACQUIRED, optionally holds until a stdin line, prints RELEASED. LOCKED_BY_OTHER exits 3.
const CHILD = `const [moduleUrl, stateDir, id, mode] = process.argv.slice(2);
const say = (line) => new Promise((resolve) => process.stdout.write(line + '\\n', resolve));
const line = () => new Promise((resolve) => process.stdin.once('data', resolve));
if (mode === 'idle') { await say('READY'); await line(); process.exit(0); }
const { withRootLock } = await import(moduleUrl);
try {
  await withRootLock(stateDir, id, async () => { await say('ACQUIRED ' + process.pid); if (mode === 'hold') await line(); });
  await say('RELEASED'); process.exit(0);
} catch (error) { await say('ERROR ' + (error?.code ?? String(error))); process.exit(error?.code === 'LOCKED_BY_OTHER' ? 3 : 1); }
`;

interface Child { pid: number; lines: string[]; waitFor(prefix: string): Promise<string>; send(): void;
  closed: Promise<{ code: number | null; signal: string | null }> }

async function setup(t: TestContext): Promise<{ state: string; script: string }> {
  const { root } = await createFixture({ 'state/': '', 'bin/': '' }, t);
  const script = path.join(root, 'bin', 'lock-child.mjs');
  await writeFile(script, CHILD);
  return { state: path.join(root, 'state'), script };
}

function child(t: TestContext, script: string, state: string, id: string, mode: 'hold' | 'once' | 'idle'): Child {
  const proc = spawn(process.execPath, [script, LOCK_MODULE, state, id, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
  const lines: string[] = [];
  let stderr = '';
  proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = once(proc, 'close').then(([exit, signal]) => ({ code: exit as number | null, signal: signal as string | null }));
  const waiters: Array<{ prefix: string; resolve: (line: string) => void }> = [];
  createInterface({ input: proc.stdout }).on('line', (line) => {
    lines.push(line);
    for (const waiter of [...waiters]) if (line.startsWith(waiter.prefix)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(line); }
  });
  const waitFor = (prefix: string): Promise<string> => {
    const hit = lines.find((line) => line.startsWith(prefix));
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      waiters.push({ prefix, resolve });
      void closed.then(() => setImmediate(() => reject(new Error(`자식이 ${prefix} 전에 끝남: ${lines.join(' | ')} ${stderr}`))));
    });
  };
  assert.ok(proc.pid !== undefined);
  return { pid: proc.pid, lines, waitFor, send: () => { proc.stdin.write('go\n'); }, closed };
}

const lockBytes = (fields: Record<string, unknown>): string => `${JSON.stringify({ formatVersion: 1, pid: 1, hostname: hostname(),
  startedAt: '2026-10-26T01:00:00.000Z', token: 'c'.repeat(32), ...fields })}\n`;
const exists = (file: string): Promise<boolean> => lstat(file).then(() => true, () => false);
const leftovers = async (state: string): Promise<string[]> =>
  (await readdir(path.join(state, 'locks')).catch(() => [])).filter((name) => name.includes('.stale-'));
async function deadPid(t: TestContext, script: string, state: string): Promise<number> {
  const idle = child(t, script, state, ID, 'idle');
  await idle.waitFor('READY'); idle.send();
  assert.equal((await idle.closed).code, 0);
  return idle.pid;
}

test('two real processes on one root: the second is LOCKED_BY_OTHER, a third acquires after release', { timeout: 15_000 }, async (t) => {
  const { state, script } = await setup(t);
  const a = child(t, script, state, ID, 'hold');
  assert.equal(await a.waitFor('ACQUIRED'), `ACQUIRED ${a.pid}`);
  assert.deepEqual(await readRootLock(state, ID), { state: 'held', holder: JSON.parse(await readFile(rootLockFile(state, ID), 'utf8')) });
  assert.equal((await readRootLock(state, ID)).holder?.pid, a.pid);
  const b = child(t, script, state, ID, 'once');
  assert.deepEqual(await b.closed, { code: LOCKED_EXIT, signal: null });
  assert.deepEqual(b.lines, ['ERROR LOCKED_BY_OTHER']);
  a.send();
  assert.deepEqual(await a.closed, { code: 0, signal: null });
  assert.equal(a.lines.at(-1), 'RELEASED');
  assert.equal(await exists(rootLockFile(state, ID)), false);
  const c = child(t, script, state, ID, 'once');
  assert.deepEqual(await c.closed, { code: 0, signal: null });
  assert.deepEqual(c.lines, [`ACQUIRED ${c.pid}`, 'RELEASED']);
  assert.equal(await exists(rootLockFile(state, ID)), false);
});

test('different roots do not block each other', { timeout: 15_000 }, async (t) => {
  const { state, script } = await setup(t);
  const a = child(t, script, state, ID, 'hold');
  await a.waitFor('ACQUIRED');
  const b = child(t, script, state, OTHER_ID, 'once');
  assert.deepEqual(await b.closed, { code: 0, signal: null });
  assert.equal(await withRootLock(state, OTHER_ID, async () => 'other root'), 'other root');
  a.send();
  assert.equal((await a.closed).code, 0);
});

test('same process: the lock is not re-entrant and a concurrent second call never runs its fn', async (t) => {
  const { state } = await setup(t);
  let nested = false;
  await withRootLock(state, ID, async () => {
    await assert.rejects(withRootLock(state, ID, async () => { nested = true; }), code('LOCKED_BY_OTHER'));
    assert.equal((await readRootLock(state, ID)).holder?.pid, process.pid);
  });
  assert.equal(nested, false);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let runs = 0;
  const calls = [0, 1].map(() => withRootLock(state, ID, async () => { runs += 1; await gate; return 'ok'; }));
  const loser = await Promise.race(calls.map((call, index) => call.then(() => index, () => index)));
  open();
  const results = await Promise.allSettled(calls);
  assert.equal(results[loser]?.status, 'rejected');
  assert.ok(results[loser]?.status === 'rejected' && code('LOCKED_BY_OTHER')(results[loser].reason));
  assert.deepEqual(results[1 - loser], { status: 'fulfilled', value: 'ok' });
  assert.equal(runs, 1);
  assert.equal(await exists(rootLockFile(state, ID)), false);
});

test('a SIGKILLed holder leaves a stale lock that the next acquirer takes over', { timeout: 15_000 }, async (t) => {
  const { state, script } = await setup(t);
  const a = child(t, script, state, ID, 'hold');
  await a.waitFor('ACQUIRED');
  process.kill(a.pid, process.platform === 'win32' ? undefined : 'SIGKILL');
  const closed = await a.closed;
  assert.ok(closed.signal === 'SIGKILL' || process.platform === 'win32', JSON.stringify(closed));
  const file = rootLockFile(state, ID);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, a.pid);
  assert.equal((await readRootLock(state, ID)).state, 'stale');
  let ran = false;
  assert.equal(await withRootLock(state, ID, async () => { ran = true; return (await readRootLock(state, ID)).holder?.pid; }), process.pid);
  assert.equal(ran, true);
  assert.equal(await exists(file), false);
  assert.deepEqual(await leftovers(state), []);
});

test('two processes racing for one stale lock: exactly one acquires', { timeout: 15_000 }, async (t) => {
  const { state, script } = await setup(t);
  const dead = await deadPid(t, script, state);
  await mkdir(path.join(state, 'locks'));
  await writeFile(rootLockFile(state, ID), lockBytes({ pid: dead }));
  const racers = [child(t, script, state, ID, 'hold'), child(t, script, state, ID, 'hold')];
  const outcome = await Promise.race(racers.map((racer, index) =>
    racer.closed.then((result) => ({ index, result }))));
  assert.deepEqual(outcome.result, { code: LOCKED_EXIT, signal: null }, racers.map((r) => r.lines.join(',')).join(' / '));
  const winner = racers[1 - outcome.index];
  assert.ok(winner);
  await winner.waitFor('ACQUIRED');
  assert.equal((await readRootLock(state, ID)).holder?.pid, winner.pid);
  winner.send();
  assert.equal((await winner.closed).code, 0);
  assert.equal(await exists(rootLockFile(state, ID)), false);
  assert.deepEqual(await leftovers(state), []);
});

test('a hand-written lock of a live process blocks and is left byte-for-byte untouched', { timeout: 15_000 }, async (t) => {
  const { state, script } = await setup(t);
  const idle = child(t, script, state, ID, 'idle');
  await idle.waitFor('READY');
  const file = rootLockFile(state, ID);
  const bytes = lockBytes({ pid: idle.pid });
  await mkdir(path.dirname(file));
  await writeFile(file, bytes);
  let ran = false;
  await assert.rejects(withRootLock(state, ID, async () => { ran = true; }),
    (error: unknown) => code('LOCKED_BY_OTHER')(error) && (error as Error).message.includes(`pid ${idle.pid}`) &&
      (error as Error).message.includes('2026-10-26T01:00:00.000Z'));
  assert.equal(ran, false);
  assert.equal(await readFile(file, 'utf8'), bytes);
  assert.equal((await readRootLock(state, ID)).state, 'held');
  idle.send();
  await idle.closed;
  assert.equal((await readRootLock(state, ID)).state, 'stale');
  assert.equal(await readFile(file, 'utf8'), bytes, 'readRootLock never removes');
});

test('foreign-host and corrupt locks are never auto-removed', { timeout: 15_000 }, async (t) => {
  const { state, script } = await setup(t);
  const dead = await deadPid(t, script, state);
  const file = rootLockFile(state, ID);
  await mkdir(path.dirname(file));
  const cases: Array<[string, string | Buffer, string]> = [
    ['foreign host, dead pid', lockBytes({ pid: dead, hostname: 'afo-other-host.invalid' }), 'foreign-host'],
    ['empty', '', 'corrupt'], ['torn JSON', '{"formatVersion":1,"pid":', 'corrupt'],
    ['missing fields', '{"formatVersion":1}', 'corrupt'], ['extra field', lockBytes({ pid: dead, extra: true }), 'corrupt'],
    ['wrong version', lockBytes({ pid: dead, formatVersion: 2 }), 'corrupt'], ['oversized', ' '.repeat(5000), 'corrupt'],
    ['invalid UTF-8', Buffer.from([0xff, 0xfe]), 'corrupt'],
  ];
  for (const [name, bytes, expected] of cases) {
    const data = Buffer.from(bytes);
    await writeFile(file, data);
    assert.equal((await readRootLock(state, ID)).state, expected, name);
    let ran = false;
    await assert.rejects(withRootLock(state, ID, async () => { ran = true; }),
      (error: unknown) => code('LOCKED_BY_OTHER')(error) && (error as Error).message.includes(file), name);
    assert.equal(ran, false, name);
    assert.deepEqual(await readFile(file), data, name);
  }
  assert.deepEqual(await leftovers(state), []);
});

test('a symlink or folder at the lock path is never followed or removed', async (t) => {
  const { state } = await setup(t);
  const file = rootLockFile(state, ID);
  await mkdir(path.dirname(file));
  const target = path.join(state, 'elsewhere.json');
  const bytes = lockBytes({ pid: 2 ** 22 + 12345 });
  await writeFile(target, bytes);
  try { await symlink(target, file); }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows: 심볼릭 링크 생성 권한 없음(EPERM)'); return; }
    throw error;
  }
  await assert.rejects(withRootLock(state, ID, async () => { throw new Error('fn must not run'); }), code('LOCKED_BY_OTHER'));
  assert.equal((await lstat(file)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), bytes);
  assert.equal((await readRootLock(state, ID)).state, 'corrupt');
  await rm(file);
  await mkdir(file);
  await assert.rejects(withRootLock(state, ID, async () => { throw new Error('fn must not run'); }), code('LOCKED_BY_OTHER'));
  assert.equal((await lstat(file)).isDirectory(), true);
});

test('fn errors propagate unchanged, results are returned, and the lock is removed either way', async (t) => {
  const { state } = await setup(t);
  const file = rootLockFile(state, ID);
  assert.deepEqual(await withRootLock(state, ID, async () => ({ moved: 2 })), { moved: 2 });
  assert.equal(await exists(file), false);
  const boom = new AfoError('FILE_CHANGED', 'boom');
  await assert.rejects(withRootLock(state, ID, async () => { assert.equal(await exists(file), true); throw boom; }),
    (error: unknown) => error === boom);
  assert.equal(await exists(file), false);
  await assert.rejects(withRootLock(state, ID, () => Promise.reject('plain string')), (error: unknown) => error === 'plain string');
  assert.equal(await exists(file), false);
  assert.deepEqual(await readdir(path.join(state, 'locks')), []);
});

test('release never deletes a lock whose token changed while fn ran', async (t) => {
  const { state } = await setup(t);
  const file = rootLockFile(state, ID);
  const foreign = lockBytes({ pid: process.pid, token: 'd'.repeat(32) });
  await assert.rejects(withRootLock(state, ID, async () => { await writeFile(file, foreign); return 'done'; }),
    (error: unknown) => code('STATE_CORRUPT')(error) && (error as Error).message.includes('작업은 끝났지만'));
  assert.equal(await readFile(file, 'utf8'), foreign);
  await rm(file);
  await assert.rejects(withRootLock(state, ID, async () => { await rm(file); }), code('STATE_CORRUPT'));
  assert.equal(await exists(file), false);
  const warned = once(process, 'warning');
  const boom = new Error('fn failed');
  await assert.rejects(withRootLock(state, ID, async () => { await writeFile(file, foreign); throw boom; }),
    (error: unknown) => error === boom);
  const [warning] = await warned as [NodeJS.ErrnoException];
  assert.equal(warning.code, LOCK_RELEASE_WARNING);
  assert.equal(await readFile(file, 'utf8'), foreign);
});

test('invalid root grant IDs are rejected before touching disk', async (t) => {
  const { state } = await setup(t);
  for (const bad of ['../x', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '', 'g'.repeat(64), `${'a'.repeat(62)}/x`, `../${'a'.repeat(61)}`]) {
    let ran = false;
    await assert.rejects(withRootLock(state, bad, async () => { ran = true; }), code('ROOT_FORBIDDEN'), bad);
    await assert.rejects(readRootLock(state, bad), code('ROOT_FORBIDDEN'), bad);
    assert.equal(ran, false, bad);
  }
  assert.deepEqual(await readdir(state), []);
  assert.deepEqual(await readRootLock(state, ID), { state: 'free', holder: null });
  assert.deepEqual(await readdir(state), []);
});
