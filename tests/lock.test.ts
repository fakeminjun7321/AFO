import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { hostname } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { AfoError } from '../packages/contracts/src/index.js';
import type { ErrorCode } from '../packages/contracts/src/index.js';
import { LOCK_RELEASE_WARNING, MAX_LOCK_BYTES, readRootLock, rootLockFile, rootLockKey, withRootLock } from '../packages/filesystem/src/lock.js';
import type { RootLockTarget } from '../packages/filesystem/src/lock.js';
import { createFixture } from './helpers.js';

const code = (expected: ErrorCode) => (error: unknown): boolean => error instanceof AfoError && error.code === expected;
const LOCK_MODULE = new URL('../packages/filesystem/src/lock.js', import.meta.url).href;
const LOCKED_EXIT = 3;
const STRESS_N = Number(process.env['AFO_LOCK_STRESS_N'] ?? 8);
const STRESS_TRIALS = Number(process.env['AFO_LOCK_STRESS_TRIALS'] ?? 20);
// Child: derives the target from realpath + lstat(bigint) of the folder spelling it was given (as a grant issuer would).
// Modes: hold (lock, hold until a line), once, idle (READY, wait, exit), race (READY, wait a line, lock, hold until a line).
// fn appends "S pid" / "E pid" to the shared log (unless '-'). LOCKED_BY_OTHER exits 3.
const CHILD = `import { appendFileSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const [moduleUrl, stateDir, folder, mode, log] = process.argv.slice(2);
const say = (text) => new Promise((resolve) => process.stdout.write(text + '\\n', resolve));
const mark = (kind) => { if (log !== '-') appendFileSync(log, kind + ' ' + process.pid + '\\n'); };
const queue = []; const waiting = [];
createInterface({ input: process.stdin }).on('line', (l) => { const w = waiting.shift(); if (w) w(l); else queue.push(l); });
const line = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve));
if (mode === 'idle') { await say('READY'); await line(); process.exit(0); }
const { withRootLock, rootLockKey } = await import(moduleUrl);
const canonicalPath = await realpath(folder);
const stat = await lstat(canonicalPath, { bigint: true });
const root = { canonicalPath, device: String(stat.dev), inode: String(stat.ino) };
if (mode === 'race') { await say('READY'); await line(); }
try {
  await withRootLock(stateDir, root, async () => {
    mark('S'); await say('ACQUIRED ' + process.pid + ' ' + rootLockKey(root));
    if (mode === 'hold' || mode === 'race') await line();
    mark('E');
  });
  await say('RELEASED'); process.exit(0);
} catch (error) { await say('ERROR ' + (error?.code ?? String(error))); process.exit(error?.code === 'LOCKED_BY_OTHER' ? 3 : 1); }
`;

async function targetOf(folder: string): Promise<RootLockTarget> {
  const canonicalPath = await realpath(folder);
  const stat = await lstat(canonicalPath, { bigint: true });
  return { canonicalPath, device: String(stat.dev), inode: String(stat.ino) };
}

interface Setup { state: string; script: string; base: string; work: string; other: string; ID: RootLockTarget; OTHER_ID: RootLockTarget;
  folder: string }
async function setup(t: TestContext): Promise<Setup> {
  const { root: base } = await createFixture({ 'state/': '', 'bin/': '', 'work/': '', 'other/': '', 'log/': '' }, t);
  const script = path.join(base, 'bin', 'lock-child.mjs');
  await writeFile(script, CHILD);
  const work = path.join(base, 'work');
  const other = path.join(base, 'other');
  const state = path.join(base, 'state');
  const ID = await targetOf(work);
  return { state, script, base, work, other, ID, OTHER_ID: await targetOf(other), folder: rootLockFile(state, ID) };
}

interface Child { pid: number; lines: string[]; waitFor(prefix: string): Promise<string>; send(): void;
  closed: Promise<{ code: number | null; signal: string | null }>; settled(): Promise<'acquired' | 'closed'> }

function child(t: TestContext, script: string, state: string, folder: string, mode: 'hold' | 'once' | 'idle' | 'race', log = '-'): Child {
  const proc = spawn(process.execPath, [script, LOCK_MODULE, state, folder, mode, log], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
  proc.stdin.on('error', () => undefined);
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
  const settled = (): Promise<'acquired' | 'closed'> => Promise.race([waitFor('ACQUIRED').then(() => 'acquired' as const, () => 'closed' as const),
    closed.then(() => lines.some((line) => line.startsWith('ACQUIRED')) ? 'acquired' as const : 'closed' as const)]);
  assert.ok(proc.pid !== undefined);
  return { pid: proc.pid, lines, waitFor, settled, send: () => { proc.stdin.write('go\n'); }, closed };
}

const lockBytes = (fields: Record<string, unknown>): string => `${JSON.stringify({ formatVersion: 1, pid: 1, hostname: hostname(),
  startedAt: '2026-10-26T01:00:00.000Z', token: 'c'.repeat(32), canonicalPath: '/afo-lock-fixture', generation: 1, ...fields })}\n`;
const exists = (file: string): Promise<boolean> => lstat(file).then(() => true, () => false);
const names = async (folder: string): Promise<string[]> => (await readdir(folder).catch(() => [] as string[])).toSorted();
/** Path of the newest `<n>.lock` in the lock folder. */
async function newest(folder: string): Promise<string> {
  const max = Math.max(0, ...(await names(folder)).map((name) => /^(\d+)\.lock$/u.exec(name)?.[1]).filter(Boolean).map(Number));
  assert.ok(max > 0, `no generation in ${folder}`);
  return path.join(folder, `${max}.lock`);
}
/** Hand-written generation file (and optional marker), as a crashed or foreign run would leave it. */
async function writeGeneration(folder: string, n: number, data: string | Buffer, released = false): Promise<string> {
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `${n}.lock`);
  await writeFile(file, data);
  if (released) await writeFile(path.join(folder, `${n}.released`), '{}\n');
  return file;
}
async function deadPid(t: TestContext, { script, state, work }: Setup): Promise<number> {
  const idle = child(t, script, state, work, 'idle');
  await idle.waitFor('READY'); idle.send();
  assert.equal((await idle.closed).code, 0);
  assert.throws(() => process.kill(idle.pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
  return idle.pid;
}
/** Directory symlink, or a junction on Windows (no privilege needed); false (with an explicit skip) when the OS refuses. */
async function linkDir(t: TestContext, target: string, alias: string): Promise<boolean> {
  try { await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows: 링크 생성 권한 없음(EPERM)'); return false; }
    throw error;
  }
}
/** Walks the S/E log; maxActive > 1 means two fns ran at the same time. */
function analyse(text: string): { starts: string[]; maxActive: number; unclosed: string[] } {
  const active = new Set<string>(); const starts: string[] = []; let maxActive = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    const [kind, pid] = line.split(' ') as [string, string];
    if (kind === 'S') { starts.push(pid); active.add(pid); maxActive = Math.max(maxActive, active.size); }
    else assert.ok(active.delete(pid), `E without S: ${line}`);
  }
  return { starts, maxActive, unclosed: [...active] };
}

test('two real processes on one root: the second is LOCKED_BY_OTHER, a third acquires after release', { timeout: 15_000 }, async (t) => {
  const { state, script, work, ID, folder } = await setup(t);
  const a = child(t, script, state, work, 'hold');
  assert.equal(await a.waitFor('ACQUIRED'), `ACQUIRED ${a.pid} ${rootLockKey(ID)}`);
  assert.equal(folder, path.join(state, 'locks', rootLockKey(ID)));
  assert.deepEqual(await names(folder), ['1.lock']);
  assert.deepEqual(await readRootLock(state, ID), { state: 'held', holder: JSON.parse(await readFile(path.join(folder, '1.lock'), 'utf8')) });
  assert.equal((await readRootLock(state, ID)).holder?.pid, a.pid);
  assert.equal((await readRootLock(state, ID)).holder?.canonicalPath, ID.canonicalPath);
  assert.equal((await readRootLock(state, ID)).holder?.generation, 1);
  const b = child(t, script, state, work, 'once');
  assert.deepEqual(await b.closed, { code: LOCKED_EXIT, signal: null });
  assert.deepEqual(b.lines, ['ERROR LOCKED_BY_OTHER']);
  assert.deepEqual(await names(folder), ['1.lock'], 'the loser created nothing');
  a.send();
  assert.deepEqual(await a.closed, { code: 0, signal: null });
  assert.equal(a.lines.at(-1), 'RELEASED');
  assert.deepEqual(await names(folder), ['1.lock', '1.released']);
  assert.deepEqual(await readRootLock(state, ID), { state: 'free', holder: null });
  const c = child(t, script, state, work, 'once');
  assert.deepEqual(await c.closed, { code: 0, signal: null });
  assert.deepEqual(c.lines, [`ACQUIRED ${c.pid} ${rootLockKey(ID)}`, 'RELEASED']);
  assert.deepEqual(await names(folder), ['2.lock', '2.released'], 'older generations cleaned by the newer holder');
});

test('the same folder reached by two path spellings in two processes is one lock', { timeout: 15_000 }, async (t) => {
  const { state, script, base, work, ID } = await setup(t);
  const aliasParent = path.join(base, 'alias-of-base'); // removed with the fixture (rm never follows links)
  if (!(await linkDir(t, base, aliasParent))) return;
  const viaAlias = path.join(aliasParent, 'work');
  assert.notEqual(viaAlias, work);
  assert.equal(rootLockKey(await targetOf(viaAlias)), rootLockKey(ID));
  assert.equal(rootLockKey({ ...ID, canonicalPath: viaAlias }), rootLockKey(ID), 'canonicalPath is not part of the key');
  const upper = path.join(base, 'WORK');
  if (await exists(upper)) assert.equal(rootLockKey(await targetOf(upper)), rootLockKey(ID), 'case-insensitive volume');
  const a = child(t, script, state, work, 'hold');
  await a.waitFor('ACQUIRED');
  const b = child(t, script, state, viaAlias, 'once');
  assert.deepEqual(await b.closed, { code: LOCKED_EXIT, signal: null }, b.lines.join(' | '));
  assert.deepEqual(b.lines, ['ERROR LOCKED_BY_OTHER']);
  a.send();
  assert.equal((await a.closed).code, 0);
  const c = child(t, script, state, viaAlias, 'once');
  assert.deepEqual(await c.closed, { code: 0, signal: null });
});

test('different roots do not block each other and have different keys', { timeout: 15_000 }, async (t) => {
  const { state, script, work, other, ID, OTHER_ID } = await setup(t);
  assert.notEqual(rootLockKey(ID), rootLockKey(OTHER_ID));
  assert.match(rootLockKey(ID), /^[a-f0-9]{64}$/u);
  assert.notEqual(rootLockKey({ ...ID, device: `${ID.device}1` }), rootLockKey(ID));
  await mkdir(path.join(work, 'sub'));
  assert.notEqual(rootLockKey(await targetOf(path.join(work, 'sub'))), rootLockKey(ID), 'overlapping roots are separate locks (documented)');
  const a = child(t, script, state, work, 'hold');
  await a.waitFor('ACQUIRED');
  const b = child(t, script, state, other, 'once');
  assert.deepEqual(await b.closed, { code: 0, signal: null });
  assert.equal(await withRootLock(state, OTHER_ID, async () => 'other root'), 'other root');
  a.send();
  assert.equal((await a.closed).code, 0);
});

test('same process: the lock is not re-entrant and a concurrent second call never runs its fn', async (t) => {
  const { state, ID, folder } = await setup(t);
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
  assert.equal((await readRootLock(state, ID)).state, 'free');
  assert.deepEqual(await names(folder), ['2.lock', '2.released']);
});

test('a SIGKILLed holder leaves a stale generation that the next acquirer supersedes', { timeout: 15_000 }, async (t) => {
  const { state, script, work, ID, folder } = await setup(t);
  const a = child(t, script, state, work, 'hold');
  await a.waitFor('ACQUIRED');
  process.kill(a.pid, process.platform === 'win32' ? undefined : 'SIGKILL');
  const closed = await a.closed;
  assert.ok(closed.signal === 'SIGKILL' || process.platform === 'win32', JSON.stringify(closed));
  assert.equal(JSON.parse(await readFile(path.join(folder, '1.lock'), 'utf8')).pid, a.pid);
  assert.equal((await readRootLock(state, ID)).state, 'stale');
  let ran = false;
  assert.deepEqual(await withRootLock(state, ID, async () => { ran = true; return (await readRootLock(state, ID)).holder; }),
    JSON.parse(await readFile(path.join(folder, '2.lock'), 'utf8')));
  assert.equal(ran, true);
  assert.deepEqual(await names(folder), ['2.lock', '2.released']);
  assert.equal((await readRootLock(state, ID)).state, 'free');
});

test(`stress: ${STRESS_N} real processes race for a stale or free lock ${STRESS_TRIALS} times; never two fns at once`, { timeout: 240_000 }, async (t) => {
  const s = await setup(t);
  const { script, base, work, ID } = s;
  const dead = await deadPid(t, s);
  const overlaps: string[] = [];
  for (let trial = 0; trial < STRESS_TRIALS + 4; trial += 1) {
    const free = trial >= STRESS_TRIALS; // last 4 trials: no lock at all
    const state = path.join(base, `state-${trial}`);
    const folder = rootLockFile(state, ID);
    const log = path.join(base, 'log', `fn-${trial}.log`);
    await writeFile(log, '');
    if (!free) { // older released generations plus a stale newest one, so cleanup also runs
      await writeGeneration(folder, trial + 1, lockBytes({ pid: dead, generation: trial + 1 }));
      if (trial > 0) await writeGeneration(folder, trial, lockBytes({ pid: dead, generation: trial }), true);
      await writeFile(path.join(folder, 'notes.txt'), 'unknown names are kept');
      assert.equal((await readRootLock(state, ID)).state, 'stale');
    }
    const kids = Array.from({ length: STRESS_N }, () => child(t, script, state, work, 'race', log));
    await Promise.all(kids.map((kid) => kid.waitFor('READY')));
    for (const kid of kids) kid.send();
    const states = await Promise.all(kids.map((kid) => kid.settled()));
    const holders = kids.filter((_, index) => states[index] === 'acquired');
    for (const holder of holders) holder.send();
    const exits = (await Promise.all(kids.map((kid) => kid.closed))).map((c) => c.code);
    const result = analyse(await readFile(log, 'utf8'));
    if (holders.length !== 1 || result.maxActive !== 1) overlaps.push(`trial ${trial}: ${holders.length} holders, max ${result.maxActive}`);
    assert.deepEqual(result.unclosed, []);
    assert.deepEqual(result.starts, holders.map((h) => String(h.pid)), `trial ${trial}: only holders ran fn`);
    assert.deepEqual(exits.toSorted(), [0, ...Array<number>(STRESS_N - 1).fill(LOCKED_EXIT)], `trial ${trial}: exit codes`);
    assert.equal((await readRootLock(state, ID)).state, 'free', `trial ${trial}`);
    if (!free) assert.equal(await readFile(path.join(folder, 'notes.txt'), 'utf8'), 'unknown names are kept');
  }
  t.diagnostic(`${STRESS_TRIALS} stale + 4 free trials × ${STRESS_N} processes; trials with ≠1 holder: ${overlaps.length}`);
  assert.deepEqual(overlaps, []);
});

test('a slow process that re-creates an already-cleaned generation backs off (after-check)', async (t) => {
  const { state, ID, folder } = await setup(t);
  const fsp = createRequire(import.meta.url)('node:fs/promises') as { open: (...args: unknown[]) => Promise<unknown> };
  const original = fsp.open;
  let injected = false;
  // Right after our exclusive create of 1.lock, a racing holder's newer generation 2 appears (as if it won while we were slow).
  fsp.open = async (...args: unknown[]) => {
    const handle = await original(...args);
    if (!injected && args[0] === path.join(folder, '1.lock')) { injected = true; await writeFile(path.join(folder, '2.lock'), lockBytes({ pid: process.pid, generation: 2 })); }
    return handle;
  };
  syncBuiltinESMExports();
  let ran = false;
  try { await assert.rejects(withRootLock(state, ID, async () => { ran = true; }), code('LOCKED_BY_OTHER')); }
  finally { fsp.open = original; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(ran, false);
  assert.deepEqual(await names(folder), ['1.lock', '1.released', '2.lock'], 'our generation marked released; the newer one untouched');
  assert.equal((await readRootLock(state, ID)).holder?.generation, 2);
  await assert.rejects(withRootLock(state, ID, async () => { ran = true; }), code('LOCKED_BY_OTHER'));
  assert.equal(ran, false);
});

test('release gap: releasing never deletes anything, so a newer holder survives and keeps blocking', { timeout: 15_000 }, async (t) => {
  const { state, script, work, ID, folder } = await setup(t);
  // A releases while child C is waiting; C takes generation 2; a stale-looking old file re-appears; D is still blocked by C.
  await withRootLock(state, ID, async () => {
    const b = child(t, script, state, work, 'once');
    assert.equal((await b.closed).code, LOCKED_EXIT);
  });
  assert.deepEqual(await names(folder), ['1.lock', '1.released']);
  const c = child(t, script, state, work, 'hold');
  await c.waitFor('ACQUIRED');
  const cBytes = await readFile(path.join(folder, '2.lock'));
  assert.deepEqual(await names(folder), ['2.lock']);
  await writeGeneration(folder, 1, lockBytes({ pid: process.pid, generation: 1 })); // a slow loser's re-created old number
  const d = child(t, script, state, work, 'once');
  assert.deepEqual(await d.closed, { code: LOCKED_EXIT, signal: null });
  assert.deepEqual(await readFile(path.join(folder, '2.lock')), cBytes);
  assert.equal((await readRootLock(state, ID)).holder?.pid, c.pid);
  c.send();
  assert.equal((await c.closed).code, 0);
  assert.deepEqual(await names(folder), ['1.lock', '2.lock', '2.released']);
  assert.equal((await readRootLock(state, ID)).state, 'free');
});

test('a hand-written lock of a live process blocks and is left byte-for-byte untouched', { timeout: 15_000 }, async (t) => {
  const { state, script, work, ID, folder } = await setup(t);
  const idle = child(t, script, state, work, 'idle');
  await idle.waitFor('READY');
  const bytes = lockBytes({ pid: idle.pid, generation: 7 });
  const file = await writeGeneration(folder, 7, bytes);
  let ran = false;
  await assert.rejects(withRootLock(state, ID, async () => { ran = true; }),
    (error: unknown) => code('LOCKED_BY_OTHER')(error) && (error as Error).message.includes(`pid ${idle.pid}`) &&
      (error as Error).message.includes('2026-10-26T01:00:00.000Z') && (error as Error).message.includes(folder));
  assert.equal(ran, false);
  assert.equal(await readFile(file, 'utf8'), bytes);
  assert.deepEqual(await names(folder), ['7.lock']);
  assert.equal((await readRootLock(state, ID)).state, 'held');
  idle.send();
  await idle.closed;
  assert.equal((await readRootLock(state, ID)).state, 'stale');
  assert.equal(await readFile(file, 'utf8'), bytes, 'readRootLock never changes anything');
  assert.equal(await withRootLock(state, ID, async () => (await readRootLock(state, ID)).holder?.generation), 8);
});

test('foreign-host and corrupt newest generations are never superseded automatically', { timeout: 15_000 }, async (t) => {
  const s = await setup(t);
  const { state, ID, folder } = s;
  const dead = await deadPid(t, s);
  const cases: Array<[string, string | Buffer, string]> = [
    ['foreign host, dead pid', lockBytes({ pid: dead, hostname: 'afo-other-host.invalid' }), 'foreign-host'],
    ['empty', '', 'corrupt'], ['torn JSON', '{"formatVersion":1,"pid":', 'corrupt'],
    ['missing fields', '{"formatVersion":1}', 'corrupt'], ['extra field', lockBytes({ pid: dead, extra: true }), 'corrupt'],
    ['no canonicalPath', lockBytes({ pid: dead, canonicalPath: undefined }), 'corrupt'],
    ['relative canonicalPath', lockBytes({ pid: dead, canonicalPath: 'work' }), 'corrupt'],
    ['no generation', lockBytes({ pid: dead, generation: undefined }), 'corrupt'],
    ['generation differs from file name', lockBytes({ pid: dead, generation: 2 }), 'corrupt'],
    ['wrong version', lockBytes({ pid: dead, formatVersion: 2 }), 'corrupt'], ['oversized', ' '.repeat(MAX_LOCK_BYTES + 1), 'corrupt'],
    ['invalid UTF-8', Buffer.from([0xff, 0xfe]), 'corrupt'],
  ];
  for (const [name, bytes, expected] of cases) {
    const data = Buffer.from(bytes);
    const file = await writeGeneration(folder, 1, data);
    assert.equal((await readRootLock(state, ID)).state, expected, name);
    let ran = false;
    await assert.rejects(withRootLock(state, ID, async () => { ran = true; }),
      (error: unknown) => code('LOCKED_BY_OTHER')(error) && (error as Error).message.includes(folder), name);
    assert.equal(ran, false, name);
    assert.deepEqual(await readFile(file), data, name);
    assert.deepEqual(await names(folder), ['1.lock'], `${name}: no newer generation created`);
  }
});

test('links or folders at generation or marker names are never followed and never count as free', async (t) => {
  const { state, ID, folder } = await setup(t);
  await mkdir(folder, { recursive: true });
  const target = path.join(state, 'elsewhere.json');
  const bytes = lockBytes({ pid: 2 ** 22 + 12345 });
  await writeFile(target, bytes);
  try { await symlink(target, path.join(folder, '1.lock')); }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows: 심볼릭 링크 생성 권한 없음(EPERM)'); return; }
    throw error;
  }
  const mustNotRun = async (): Promise<void> => { throw new Error('fn must not run'); };
  await assert.rejects(withRootLock(state, ID, mustNotRun), code('LOCKED_BY_OTHER'));
  assert.equal((await lstat(path.join(folder, '1.lock'))).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), bytes);
  assert.equal((await readRootLock(state, ID)).state, 'corrupt');
  await rm(path.join(folder, '1.lock'));
  await mkdir(path.join(folder, '1.lock'));
  await assert.rejects(withRootLock(state, ID, mustNotRun), code('LOCKED_BY_OTHER'));
  assert.equal((await lstat(path.join(folder, '1.lock'))).isDirectory(), true);
  await rm(path.join(folder, '1.lock'), { recursive: true });
  // A marker that is a link (to a regular file) does not release a live generation.
  await writeGeneration(folder, 1, lockBytes({ pid: process.pid }));
  await symlink(target, path.join(folder, '1.released'));
  await assert.rejects(withRootLock(state, ID, mustNotRun), code('LOCKED_BY_OTHER'));
  assert.equal((await readRootLock(state, ID)).state, 'corrupt');
  assert.deepEqual(await names(folder), ['1.lock', '1.released']);
});

test('a locks or key folder that is a file or a link is STATE_CORRUPT, never free, and nothing is created through it', async (t) => {
  const { state, base, ID, folder } = await setup(t);
  const mustNotRun = async (): Promise<void> => { throw new Error('fn must not run'); };
  const locks = path.join(state, 'locks');
  await writeFile(locks, 'not a folder');
  await assert.rejects(readRootLock(state, ID), code('STATE_CORRUPT'));
  await assert.rejects(withRootLock(state, ID, mustNotRun), code('STATE_CORRUPT'));
  assert.equal(await readFile(locks, 'utf8'), 'not a folder');
  await rm(locks);
  await mkdir(locks);
  await writeFile(folder, 'not a folder');
  await assert.rejects(readRootLock(state, ID), code('STATE_CORRUPT'));
  await assert.rejects(withRootLock(state, ID, mustNotRun), code('STATE_CORRUPT'));
  assert.equal(await readFile(folder, 'utf8'), 'not a folder');
  await rm(locks, { recursive: true });
  const real = path.join(base, 'real-locks');
  await mkdir(real);
  if (!(await linkDir(t, real, locks))) return;
  await assert.rejects(readRootLock(state, ID), code('STATE_CORRUPT'));
  await assert.rejects(withRootLock(state, ID, mustNotRun), code('STATE_CORRUPT'));
  assert.deepEqual(await readdir(real), []);
  await rm(locks);
  await mkdir(locks);
  await linkDir(t, real, folder);
  await assert.rejects(readRootLock(state, ID), code('STATE_CORRUPT'));
  await assert.rejects(withRootLock(state, ID, mustNotRun), code('STATE_CORRUPT'));
  assert.deepEqual(await readdir(real), []);
});

test('fn errors propagate unchanged, results are returned, and the generation is released either way', async (t) => {
  const { state, ID, folder } = await setup(t);
  assert.deepEqual(await withRootLock(state, ID, async () => ({ moved: 2 })), { moved: 2 });
  assert.deepEqual(await names(folder), ['1.lock', '1.released']);
  const boom = new AfoError('FILE_CHANGED', 'boom');
  await assert.rejects(withRootLock(state, ID, async () => { assert.equal((await readRootLock(state, ID)).state, 'held'); throw boom; }),
    (error: unknown) => error === boom);
  assert.deepEqual(await names(folder), ['2.lock', '2.released']);
  await assert.rejects(withRootLock(state, ID, () => Promise.reject('plain string')), (error: unknown) => error === 'plain string');
  assert.deepEqual(await names(folder), ['3.lock', '3.released']);
  assert.equal((await readRootLock(state, ID)).state, 'free');
});

test('release never touches a generation whose token changed while fn ran and reports it', async (t) => {
  const { state, ID, folder } = await setup(t);
  const foreign = (generation: number): string => lockBytes({ pid: process.pid, token: 'd'.repeat(32), generation });
  await assert.rejects(withRootLock(state, ID, async () => { await writeFile(await newest(folder), foreign(1)); return 'done'; }),
    (error: unknown) => code('STATE_CORRUPT')(error) && (error as Error).message.includes('작업은 끝났지만'));
  assert.equal(await readFile(path.join(folder, '1.lock'), 'utf8'), foreign(1));
  assert.deepEqual(await names(folder), ['1.lock'], 'no marker for a lock that is not ours');
  await rm(folder, { recursive: true }); // manual release
  await assert.rejects(withRootLock(state, ID, async () => { await rm(path.join(folder, '1.lock')); }), code('STATE_CORRUPT'));
  assert.deepEqual(await names(folder), []);
  await assert.rejects(withRootLock(state, ID, async () => { await writeFile(path.join(folder, '1.released'), 'forged'); }),
    (error: unknown) => code('STATE_CORRUPT')(error) && (error as Error).message.includes('해제 표시가 이미'));
  await rm(folder, { recursive: true });
  const warned = once(process, 'warning');
  const boom = new Error('fn failed');
  await assert.rejects(withRootLock(state, ID, async () => { await writeFile(path.join(folder, '1.lock'), foreign(1)); throw boom; }),
    (error: unknown) => error === boom);
  const [warning] = await warned as [NodeJS.ErrnoException];
  assert.equal(warning.code, LOCK_RELEASE_WARNING);
  assert.equal(await readFile(path.join(folder, '1.lock'), 'utf8'), foreign(1));
});

test('invalid root targets and state folders are rejected before touching disk', async (t) => {
  const { state, ID } = await setup(t);
  const bad: unknown[] = [
    { ...ID, device: '' }, { ...ID, device: '-1' }, { ...ID, device: '1.5' }, { ...ID, device: 'a1' }, { ...ID, device: 1 },
    { ...ID, inode: '' }, { ...ID, inode: '0x1f' }, { ...ID, inode: '9'.repeat(41) },
    { ...ID, canonicalPath: '' }, { ...ID, canonicalPath: 'relative/work' }, { ...ID, canonicalPath: '../work' },
    { ...ID, canonicalPath: `${ID.canonicalPath}\u0000x` }, { ...ID, canonicalPath: '\\\\?\\C:\\work' },
    { device: ID.device, inode: ID.inode }, 'a'.repeat(64), null,
  ];
  for (const root of bad) {
    const label = JSON.stringify(root);
    let ran = false;
    await assert.rejects(withRootLock(state, root as RootLockTarget, async () => { ran = true; }), code('ROOT_FORBIDDEN'), label);
    await assert.rejects(readRootLock(state, root as RootLockTarget), code('ROOT_FORBIDDEN'), label);
    assert.throws(() => rootLockKey(root as RootLockTarget), code('ROOT_FORBIDDEN'), label);
    assert.equal(ran, false, label);
  }
  const relative = `afo-lock-rel-${process.pid}`;
  for (const dir of [relative, `./${relative}`, '', `${state}\u0000x`]) {
    let ran = false;
    await assert.rejects(withRootLock(dir, ID, async () => { ran = true; }), code('STATE_DIR_INVALID'), JSON.stringify(dir));
    await assert.rejects(readRootLock(dir, ID), code('STATE_DIR_INVALID'), JSON.stringify(dir));
    assert.throws(() => rootLockFile(dir, ID), code('STATE_DIR_INVALID'));
    assert.equal(ran, false);
  }
  assert.equal(await exists(path.resolve(relative)), false, 'nothing created under the current directory');
  assert.deepEqual(await readdir(state), []);
  assert.deepEqual(await readRootLock(state, ID), { state: 'free', holder: null });
  assert.deepEqual(await readdir(state), []);
});
