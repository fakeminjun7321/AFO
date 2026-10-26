/**
 * #13 root-lock verifier tests, written independently of tests/lock.test.ts.
 * Real child processes (process.execPath) import the compiled dist lock.js. State and "outside" folders are only
 * mkdtemp(os.tmpdir()) fixtures. Ordering is driven by child stdout lines and in-process fs gates, never by sleeps.
 * Tests with `todo` reproduce confirmed contract violations (V13-R*): they run and report, but do not fail `npm test`.
 * Record: docs/verification/ISSUE_13_LOCK_VERIFY.md.
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, link, lstat, mkdir, readdir, readFile, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { hostname } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createHash, randomBytes } from 'node:crypto';
import { AfoError } from '../packages/contracts/src/index.js';
import type { ErrorCode } from '../packages/contracts/src/index.js';
import { LOCK_RELEASE_WARNING, readRootLock, rootLockFile, withRootLock } from '../packages/filesystem/src/lock.js';
import { createFixture, createManifest, diffManifest, sameManifest } from './helpers.js';

const LOCK_URL = new URL('../packages/filesystem/src/lock.js', import.meta.url).href;

// ---- Adapter: the only place that knows the shape of the lock key (2nd parameter). Retarget here when it changes
// from a RootGrant.id string to { canonicalPath, device, inode }; children receive the key as JSON. ----
type LockKey = string;
/** Key for a work folder as one grant issuance would produce it. At 2229898 grant IDs are per issuance (salted). */
async function keyFor(dir: string, issuance = 'grant-1'): Promise<LockKey> {
  return createHash('sha256').update(`${issuance}\u0000${await realpath(dir)}`).digest('hex');
}
const lock = <T>(state: string, key: LockKey, fn: () => Promise<T>): Promise<T> => withRootLock(state, key, fn);
const readLock = (state: string, key: LockKey): ReturnType<typeof readRootLock> => readRootLock(state, key);
const lockPath = (state: string, key: LockKey): string => rootLockFile(state, key);
const BAD_KEYS: unknown[] = ['', '../x', 'A'.repeat(64), '1'.repeat(63), `${'1'.repeat(63)}/`, `${'1'.repeat(64)}\u0000`];
const BAD_KEY_CODE: ErrorCode = 'ROOT_FORBIDDEN';
// ---------------------------------------------------------------------------------------------------------------
const N = Number(process.env['AFO_VERIFY_LOCK_N'] ?? 8);
const TRIALS_FREE = Number(process.env['AFO_VERIFY_LOCK_TRIALS_FREE'] ?? 8);
const TRIALS_STALE = Number(process.env['AFO_VERIFY_LOCK_TRIALS_STALE'] ?? 20);
const posixOnly = process.platform === 'win32' ? 'POSIX 신호·심볼릭 링크 권한 전제(Windows: 미검증)' : false;
const is = (expected: ErrorCode) => (error: unknown): boolean => error instanceof AfoError && error.code === expected;

// Child modes: race (READY, wait a line, then lock), hold (lock, hold until a line), once, hang (fn never settles),
// exit (process.exit inside fn), idle (READY, wait a line, exit). fn appends "S pid"/"E pid" to the shared log.
const CHILD = `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [moduleUrl, stateDir, keyJson, log, mode] = process.argv.slice(2);
const id = JSON.parse(keyJson);
const say = (l) => new Promise((r) => process.stdout.write(l + '\\n', r));
const mark = (k) => { if (log !== '-') appendFileSync(log, k + ' ' + process.pid + '\\n'); };
let rl; const queue = []; const waiting = [];
const line = () => {
  if (!rl) { rl = createInterface({ input: process.stdin }); rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else queue.push(l); }); }
  return queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiting.push(r));
};
if (mode === 'idle') { await say('READY'); await line(); process.exit(0); }
const { withRootLock } = await import(moduleUrl);
if (mode === 'race') { await say('READY'); await line(); }
try {
  const value = await withRootLock(stateDir, id, async () => {
    mark('S'); await say('ACQUIRED ' + process.pid);
    if (mode === 'hang') return new Promise(() => {});
    if (mode === 'exit') process.exit(0);
    if (mode === 'race' || mode === 'hold') await line();
    mark('E'); return 'ok';
  });
  await say('RELEASED ' + value); process.exit(0);
} catch (error) { await say('ERROR ' + (error?.code ?? String(error))); process.exit(error?.code === 'LOCKED_BY_OTHER' ? 3 : 1); }
`;

interface Env { root: string; state: string; script: string; log: string; outside: string; work: string; key: LockKey }
interface Kid { pid: number; lines: string[]; waitFor(prefix: string): Promise<string>; send(line?: string): void;
  closed: Promise<{ code: number | null; signal: string | null }>; settled(): Promise<'acquired' | 'closed'> }
type Mode = 'race' | 'hold' | 'once' | 'hang' | 'exit' | 'idle';

async function setup(t: TestContext): Promise<Env> {
  const { root } = await createFixture({ 'state/': '', 'bin/': '', 'outside/sentinel.txt': 'outside data', 'log/': '',
    'work/a.txt': 'synthetic work file' }, t);
  const script = path.join(root, 'bin', 'child.mjs');
  await writeFile(script, CHILD);
  const work = path.join(root, 'work');
  return { root, state: path.join(root, 'state'), script, log: path.join(root, 'log', 'fn.log'), outside: path.join(root, 'outside'),
    work, key: await keyFor(work) };
}

function kid(t: TestContext, env: Env, mode: Mode,
  options: { state?: string; cwd?: string; log?: string; key?: LockKey } = {}): Kid {
  const proc = spawn(process.execPath, [env.script, LOCK_URL, options.state ?? env.state, JSON.stringify(options.key ?? env.key),
    options.log ?? env.log, mode],
    { stdio: ['pipe', 'pipe', 'pipe'], ...(options.cwd ? { cwd: options.cwd } : {}) });
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
  const lines: string[] = [];
  let stderr = '';
  proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  proc.stdin.on('error', () => undefined);
  const closed = once(proc, 'close').then(([c, s]) => ({ code: c as number | null, signal: s as string | null }));
  const waiters: Array<{ prefix: string; resolve: (l: string) => void }> = [];
  createInterface({ input: proc.stdout }).on('line', (l) => {
    lines.push(l);
    for (const w of [...waiters]) if (l.startsWith(w.prefix)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(l); }
  });
  const waitFor = (prefix: string): Promise<string> => {
    const hit = lines.find((l) => l.startsWith(prefix));
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      waiters.push({ prefix, resolve });
      void closed.then(() => setImmediate(() => reject(new Error(`child ended before ${prefix}: ${lines.join(' | ')} ${stderr}`))));
    });
  };
  assert.ok(proc.pid !== undefined);
  const settled = (): Promise<'acquired' | 'closed'> =>
    Promise.race([waitFor('ACQUIRED').then(() => 'acquired' as const, () => 'closed' as const), closed.then(() => 'closed' as const)])
      .then((first) => first === 'closed' && lines.some((l) => l.startsWith('ACQUIRED')) ? 'acquired' : first);
  return { pid: proc.pid, lines, waitFor, settled, closed, send: (l = 'go') => { proc.stdin.write(`${l}\n`); } };
}

const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);
const asides = async (state: string): Promise<string[]> =>
  (await readdir(path.join(state, 'locks')).catch(() => [] as string[])).filter((n) => n.includes('.stale-'));
const lockJson = (fields: Record<string, unknown>): string => `${JSON.stringify({ formatVersion: 1, pid: 1, hostname: hostname(),
  startedAt: '2026-10-26T02:00:00.000Z', token: randomBytes(16).toString('hex'), ...fields })}\n`;

/** pid of a child that has exited and been reaped (kill(pid,0) → ESRCH). */
async function deadPid(t: TestContext, env: Env): Promise<number> {
  const idle = kid(t, env, 'idle');
  await idle.waitFor('READY'); idle.send();
  assert.equal((await idle.closed).code, 0);
  assert.throws(() => process.kill(idle.pid, 0), (e: NodeJS.ErrnoException) => e.code === 'ESRCH');
  return idle.pid;
}

/** Walks the S/E log; maxActive > 1 means two fns ran at the same time. */
function analyse(text: string): { starts: string[]; maxActive: number; unclosed: string[] } {
  const active = new Set<string>(); const starts: string[] = []; let maxActive = 0;
  for (const l of text.split('\n').filter(Boolean)) {
    const [kind, pid] = l.split(' ') as [string, string];
    if (kind === 'S') { starts.push(pid); active.add(pid); maxActive = Math.max(maxActive, active.size); }
    else { assert.ok(active.delete(pid), `E without S: ${l}`); }
  }
  return { starts, maxActive, unclosed: [...active] };
}

/** N children released at once by one stdin write each; holders keep the lock until every other child has settled. */
async function race(t: TestContext, env: Env, n: number): Promise<{ kids: Kid[]; holders: Kid[]; exits: Array<number | null>;
  log: ReturnType<typeof analyse> }> {
  await writeFile(env.log, '');
  const kids = Array.from({ length: n }, () => kid(t, env, 'race'));
  await Promise.all(kids.map((k) => k.waitFor('READY')));
  for (const k of kids) k.send('GO');
  const states = await Promise.all(kids.map((k) => k.settled()));
  const holders = kids.filter((_, i) => states[i] === 'acquired');
  for (const h of holders) h.send('RELEASE');
  const exits = (await Promise.all(kids.map((k) => k.closed))).map((c) => c.code);
  return { kids, holders, exits, log: analyse(await readFile(env.log, 'utf8')) };
}

// ---------------------------------------------------------------------------------------------------------------
// In-process scheduling gates on node:fs/promises (live ESM bindings via syncBuiltinESMExports). Used only to force a
// specific interleaving of the real lock.ts code paths; the other actors are real child processes.
const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<'rename' | 'unlink', (...a: string[]) => Promise<void>>;
const original = { rename: fsp.rename, unlink: fsp.unlink };
function hook(name: 'rename' | 'unlink', impl: (...a: string[]) => Promise<void>): void { fsp[name] = impl; syncBuiltinESMExports(); }
function unhook(): void { fsp.rename = original.rename; fsp.unlink = original.unlink; syncBuiltinESMExports(); }
function gate(): { reached: Promise<void>; open: () => void; pass: () => Promise<void> } {
  let open!: () => void; let arrive!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const reached = new Promise<void>((r) => { arrive = r; });
  return { reached, open, pass: async () => { arrive(); await opened; } };
}

// =============================================================================================================
test('V13-C1 8 real processes race for a free lock: exactly one fn runs, the rest LOCKED_BY_OTHER without running fn',
  { timeout: 120_000 }, async (t) => {
    const env = await setup(t);
    const file = lockPath(env.state, env.key);
    for (let trial = 0; trial < TRIALS_FREE; trial += 1) {
      const r = await race(t, env, N);
      assert.equal(r.holders.length, 1, `trial ${trial}: holders ${r.holders.map((h) => h.pid)}`);
      assert.equal(r.log.maxActive, 1, `trial ${trial}: overlapping fns`);
      assert.deepEqual(r.log.starts, [String(r.holders[0]!.pid)], `trial ${trial}: only the holder's fn ran`);
      assert.deepEqual(r.log.unclosed, []);
      assert.deepEqual(r.exits.toSorted(), [0, ...Array<number>(N - 1).fill(3)], `trial ${trial}: exit codes`);
      for (const k of r.kids) if (k !== r.holders[0]) assert.deepEqual(k.lines.slice(1), ['ERROR LOCKED_BY_OTHER']);
      assert.equal(await exists(file), false, 'lock removed after the holder released');
      assert.deepEqual(await asides(env.state), []);
    }
    t.diagnostic(`free race: ${TRIALS_FREE} trials × ${N} processes, 1 holder each`);
  });

test('V13-C2 8 real processes race to take over one stale lock (dead pid): never two concurrent holders, no .stale-* left',
  { todo: 'FAIL at 2229898: see ISSUE_13_LOCK_VERIFY.md C2', timeout: 300_000 }, async (t) => {
    const env = await setup(t);
    const file = lockPath(env.state, env.key);
    await mkdir(path.dirname(file), { recursive: true });
    const overlaps: string[] = [];
    let lockedRan = 0;
    for (let trial = 0; trial < TRIALS_STALE; trial += 1) {
      const dead = await deadPid(t, env);
      await writeFile(file, lockJson({ pid: dead }));
      assert.equal((await readLock(env.state, env.key)).state, 'stale');
      const r = await race(t, env, N);
      assert.ok(r.holders.length >= 1, `trial ${trial}: nobody took over the stale lock: ${r.kids.map((k) => k.lines.join('/'))}`);
      if (r.log.maxActive > 1 || r.holders.length > 1) overlaps.push(`trial ${trial}: ${r.holders.length} holders, ` +
        `max concurrent fns ${r.log.maxActive}, holder results ${r.holders.map((h) => h.lines.at(-1)).join('/')}`);
      for (const k of r.kids) if (!r.holders.includes(k)) {
        assert.deepEqual(k.lines.slice(1), ['ERROR LOCKED_BY_OTHER'], `trial ${trial}: loser output`);
        if (r.log.starts.includes(String(k.pid))) lockedRan += 1;
      }
      assert.equal(await exists(file), false, `trial ${trial}: lock left after all released`);
      assert.deepEqual(await asides(env.state), [], `trial ${trial}: .stale-* left`);
    }
    t.diagnostic(`stale race: ${TRIALS_STALE} trials × ${N} processes; trials with >1 holder: ${overlaps.length} ${overlaps.join('; ')}`);
    assert.equal(lockedRan, 0, 'a LOCKED_BY_OTHER process ran fn');
    assert.deepEqual(overlaps, [], 'two holders at once');
  });

test('V13-C3 holder alive (running or SIGSTOPped) blocks; SIGKILL mid-fn leaves a stale lock the next process takes over',
  { timeout: 30_000, skip: posixOnly }, async (t) => {
    const env = await setup(t);
    const file = lockPath(env.state, env.key);
    const holder = kid(t, env, 'hold');
    await holder.waitFor('ACQUIRED');
    const held = await readFile(file);
    const blocked = kid(t, env, 'once');
    assert.deepEqual(await blocked.closed, { code: 3, signal: null });
    process.kill(holder.pid, 'SIGSTOP');
    const blockedStopped = kid(t, env, 'once');
    assert.deepEqual(await blockedStopped.closed, { code: 3, signal: null }, 'stopped holder still counts as alive');
    assert.deepEqual(await readFile(file), held, 'holder bytes untouched by blocked processes');
    process.kill(holder.pid, 'SIGKILL');
    assert.equal((await holder.closed).signal, 'SIGKILL');
    assert.deepEqual(await readFile(file), held, 'SIGKILL leaves the file');
    assert.equal((await readLock(env.state, env.key)).state, 'stale');
    const next = kid(t, env, 'once');
    assert.deepEqual(await next.closed, { code: 0, signal: null });
    assert.deepEqual(next.lines, [`ACQUIRED ${next.pid}`, 'RELEASED ok']);
    assert.equal(await exists(file), false);
    assert.deepEqual(await asides(env.state), []);
    assert.deepEqual(analyse(await readFile(env.log, 'utf8')).unclosed, [String(holder.pid)], 'killed fn never finished');
  });

test('V13-C4 fn failure shapes: errors propagate unchanged and the lock is released each time', async (t) => {
  const env = await setup(t);
  const file = lockPath(env.state, env.key);
  const err = new Error('sync throw in async fn');
  await assert.rejects(lock(env.state, env.key, async () => { throw err; }), (e) => e === err);
  assert.equal(await exists(file), false);
  const syncErr = new TypeError('sync throw in non-async fn');
  const syncFn = (() => { throw syncErr; }) as unknown as () => Promise<never>;
  await assert.rejects(lock(env.state, env.key, syncFn), (e) => e === syncErr);
  assert.equal(await exists(file), false);
  const marker = { code: 'LOCKED_BY_OTHER' };
  for (const value of [undefined, null, 0, '', 'text', marker, Symbol.for('v13')]) {
    let caught: unknown = 'none';
    try { await lock(env.state, env.key, () => Promise.reject(value)); } catch (e) { caught = e; }
    assert.equal(caught, value, `rejection ${String(value)} propagated unchanged`);
    assert.equal(await exists(file), false);
  }
  assert.equal(await lock(env.state, env.key, (() => 42) as unknown as () => Promise<number>), 42, 'non-promise return');
  assert.equal(await exists(file), false);
  assert.deepEqual(await asides(env.state), []);
});

test('V13-C5 fn hangs and the process exits normally, or calls process.exit: lock stays, is judged stale, next process takes over',
  { timeout: 30_000 }, async (t) => {
    const env = await setup(t);
    const file = lockPath(env.state, env.key);
    for (const mode of ['hang', 'exit'] as const) {
      const k = kid(t, env, mode);
      await k.waitFor('ACQUIRED');
      const closed = await k.closed;
      assert.equal(closed.signal, null, `${mode}: no signal`);
      assert.equal(closed.code, mode === 'hang' ? 13 : 0, `${mode}: exit code (13 = unsettled top-level await)`);
      const left = JSON.parse(await readFile(file, 'utf8')) as { pid: number };
      assert.equal(left.pid, k.pid, `${mode}: lock left behind`);
      assert.equal((await readLock(env.state, env.key)).state, 'stale');
      const next = kid(t, env, 'once');
      assert.deepEqual(await next.closed, { code: 0, signal: null }, `${mode}: next process acquires`);
      assert.equal(await exists(file), false);
      assert.deepEqual(await asides(env.state), []);
    }
  });

test('V13-C6 links inside locks/ never touch anything outside the state folder', { skip: posixOnly }, async (t) => {
  const env = await setup(t);
  const before = await createManifest(env.outside);
  const locks = path.join(env.state, 'locks');
  const file = lockPath(env.state, env.key);
  let ran = 0;
  const fn = async (): Promise<void> => { ran += 1; };
  // locks/ itself is a symlink to the outside folder.
  await symlink(env.outside, locks);
  await assert.rejects(lock(env.state, env.key, fn), is('STATE_CORRUPT'));
  assert.equal((await lstat(locks)).isSymbolicLink(), true);
  assert.equal(await readlink(locks), env.outside);
  assert.ok(sameManifest(diffManifest(before, await createManifest(env.outside))), 'outside unchanged (locks symlink)');
  await original.unlink(locks);
  await mkdir(locks);
  // lock file is a dangling symlink, a symlink to an outside dir, and a symlink to an outside stale-looking lock.
  const dead = await deadPid(t, env);
  const outsideLock = path.join(env.outside, 'stale-looking.lock');
  await writeFile(outsideLock, lockJson({ pid: dead }));
  const before2 = await createManifest(env.outside);
  for (const target of [path.join(env.outside, 'missing.lock'), env.outside, outsideLock]) {
    await symlink(target, file);
    await assert.rejects(lock(env.state, env.key, fn), is('LOCKED_BY_OTHER'), `symlink → ${path.basename(target)}`);
    assert.equal(await readlink(file), target, 'link itself left in place');
    assert.equal((await readLock(env.state, env.key)).state, 'corrupt');
    assert.ok(sameManifest(diffManifest(before2, await createManifest(env.outside))), `outside unchanged (→ ${path.basename(target)})`);
    assert.equal(await exists(path.join(env.outside, 'missing.lock')), false, 'dangling target not created');
    await original.unlink(file);
  }
  assert.equal(ran, 0);
  assert.deepEqual(await asides(env.state), []);
  // lock file is a hard link to an outside stale lock: taking over may drop the link name but never the outside data.
  const outsideBytes = await readFile(outsideLock);
  await link(outsideLock, file);
  await lock(env.state, env.key, async () => {
    ran += 1;
    assert.deepEqual(await readFile(outsideLock), outsideBytes, 'outside bytes unchanged while held');
    assert.notEqual((await stat(file)).ino, (await stat(outsideLock)).ino, 'new lock is a fresh inode');
  });
  assert.equal(ran, 1);
  assert.deepEqual(await readFile(outsideLock), outsideBytes);
  assert.equal((await stat(outsideLock)).nlink, 1);
  assert.equal(await exists(file), false);
});

test('V13-C7 pid edge cases: only a same-host pid that kill(pid,0) reports ESRCH is removed; everything else blocks untouched', async (t) => {
  const env = await setup(t);
  const file = lockPath(env.state, env.key);
  await mkdir(path.dirname(file), { recursive: true });
  const raw = (pid: string): string => `{"formatVersion":1,"pid":${pid},"hostname":${JSON.stringify(hostname())},` +
    `"startedAt":"2026-10-26T02:00:00.000Z","token":"${'d'.repeat(32)}"}\n`;
  const blocking: Array<[string, string, string]> = [
    ['own pid, other token', lockJson({ pid: process.pid }), 'held'],
    ['pid 1 (EPERM)', lockJson({ pid: 1 }), 'held'],
    ['pid 2^32+1 (kill throws ERR_INVALID_ARG_TYPE)', lockJson({ pid: 2 ** 32 + 1 }), 'held'],
    ['pid MAX_SAFE_INTEGER', lockJson({ pid: Number.MAX_SAFE_INTEGER }), 'held'],
    ['own pid, other host', lockJson({ pid: process.pid, hostname: `${hostname()}-other` }), 'foreign-host'],
    ['pid 0', raw('0'), 'corrupt'], ['pid -1', raw('-1'), 'corrupt'], ['pid -12345', raw('-12345'), 'corrupt'],
    ['pid 1.5', raw('1.5'), 'corrupt'], ['pid "123"', raw('"123"'), 'corrupt'], ['pid 1e400', raw('1e400'), 'corrupt'],
    ['pid null', raw('null'), 'corrupt'], ['pid 2^53+1', raw('9007199254740993'), 'corrupt'], ['empty file', '', 'corrupt'],
  ];
  let ran = 0;
  for (const [label, bytes, state] of blocking) {
    await writeFile(file, bytes);
    assert.equal((await readLock(env.state, env.key)).state, state, label);
    await assert.rejects(lock(env.state, env.key, async () => { ran += 1; }), is('LOCKED_BY_OTHER'), label);
    assert.equal(await readFile(file, 'utf8'), bytes, `${label}: bytes unchanged`);
    assert.deepEqual(await asides(env.state), [], label);
  }
  assert.equal(ran, 0);
  // Same rule, removable: a dead child pid and 2^31-1 (ESRCH on this OS).
  const big = 2 ** 31 - 1;
  const bigDead = ((): boolean => { try { process.kill(big, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; } })();
  for (const pid of [await deadPid(t, env), ...(bigDead ? [big] : [])]) {
    await writeFile(file, lockJson({ pid }));
    assert.equal((await readLock(env.state, env.key)).state, 'stale', `pid ${pid}`);
    assert.equal(await lock(env.state, env.key, async () => (await readLock(env.state, env.key)).holder?.pid), process.pid);
    assert.equal(await exists(file), false);
    assert.deepEqual(await asides(env.state), []);
  }
  if (!bigDead) t.diagnostic('2^31-1 is not ESRCH here; only the dead child pid case ran');
});

test('V13-C8 release never deletes a lock it does not own; release errors only after fn; fn errors win over release errors',
  { timeout: 30_000 }, async (t) => {
    const env = await setup(t);
    const file = lockPath(env.state, env.key);
    const away = path.join(env.root, 'moved-away.lock');
    // fn succeeds, but its lock was moved away and a real process acquired meanwhile.
    let other!: Kid; let otherBytes!: Buffer; let movedBytes!: Buffer;
    await assert.rejects(lock(env.state, env.key, async () => {
      movedBytes = await readFile(file);
      await original.rename(file, away);
      other = kid(t, env, 'hold');
      await other.waitFor('ACQUIRED');
      otherBytes = await readFile(file);
      return 'done';
    }), (e) => is('STATE_CORRUPT')(e) && (e as Error).message.startsWith('작업은 끝났지만'));
    assert.deepEqual(await readFile(file), otherBytes, "other process's lock untouched");
    assert.deepEqual(await readFile(away), movedBytes, 'moved file untouched');
    other.send();
    assert.deepEqual(await other.closed, { code: 0, signal: null }, 'other process releases its own lock normally');
    assert.equal(await exists(file), false);
    // fn fails and its lock was replaced: fn's error (same object) is thrown, the release failure is only a warning.
    const warnings: Array<{ code?: string }> = [];
    const onWarning = (w: Error & { code?: string }): void => { warnings.push(w); };
    process.on('warning', onWarning);
    t.after(() => { process.off('warning', onWarning); });
    const boom = new Error('fn failed');
    await assert.rejects(lock(env.state, env.key, async () => {
      await original.unlink(file);
      other = kid(t, env, 'hold');
      await other.waitFor('ACQUIRED');
      otherBytes = await readFile(file);
      throw boom;
    }), (e) => e === boom);
    await new Promise((r) => setImmediate(r));
    assert.ok(warnings.some((w) => w.code === LOCK_RELEASE_WARNING), 'release failure reported as warning');
    assert.deepEqual(await readFile(file), otherBytes);
    other.send();
    assert.equal((await other.closed).code, 0);
    // fn succeeds and its lock vanished: STATE_CORRUPT after fn (fn did run).
    let ran = false;
    await assert.rejects(lock(env.state, env.key, async () => { ran = true; await original.unlink(file); }), is('STATE_CORRUPT'));
    assert.equal(ran, true);
  });

test('V13-C9 state-folder negatives: locks is a file, locks is unwritable, invalid IDs touch nothing', { skip: posixOnly }, async (t) => {
  const env = await setup(t);
  const locks = path.join(env.state, 'locks');
  let ran = 0;
  await writeFile(locks, 'not a folder');
  await assert.rejects(lock(env.state, env.key, async () => { ran += 1; }), is('STATE_CORRUPT'));
  assert.equal(await readFile(locks, 'utf8'), 'not a folder');
  await original.unlink(locks);
  await mkdir(locks, { mode: 0o500 });
  t.after(() => chmod(locks, 0o700).catch(() => undefined));
  if (process.getuid?.() === 0) t.diagnostic('running as root: permission case is not meaningful');
  else await assert.rejects(lock(env.state, env.key, async () => { ran += 1; }), is('PERMISSION_DENIED'));
  await chmod(locks, 0o700);
  const fresh = path.join(env.root, 'never-created');
  for (const bad of BAD_KEYS)
    await assert.rejects(lock(fresh, bad as LockKey, async () => { ran += 1; }), is(BAD_KEY_CODE), JSON.stringify(bad));
  assert.equal(await exists(fresh), false);
  assert.equal(ran, 0);
});

// ----------------------------------------------- confirmed violations -----------------------------------------------
test('V13-R1 stale takeover restore window admits a second holder (A holds, B moved A\'s lock aside, C acquires)',
  { todo: 'FAIL at 2229898: see ISSUE_13_LOCK_VERIFY.md R1', timeout: 30_000 }, async (t) => {
    const env = await setup(t);
    const file = lockPath(env.state, env.key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(env.log, '');
    await writeFile(file, lockJson({ pid: await deadPid(t, env) }));
    const before = gate(); const after = gate();
    let armed = true;
    hook('rename', async (from, to) => {
      if (!armed || from !== file || !String(to).includes('.stale-')) return original.rename(from, to!);
      armed = false; await before.pass(); await original.rename(from, to!); await after.pass();
    });
    t.after(unhook);
    // B (this process) judged the dead-pid lock stale and is about to move it aside.
    const b = lock(env.state, env.key, async () => 'B ran').then((v) => v, (e: unknown) => e);
    await before.reached;
    const a = kid(t, env, 'hold');           // A takes over the same stale lock and holds it
    await a.waitFor('ACQUIRED');
    before.open(); await after.reached;      // B's rename moved A's live lock aside; the lock path is empty now
    const c = kid(t, env, 'hold');           // C: any process starting now
    const cState = await c.settled();
    after.open();
    const bResult = await b;
    a.send(); c.send();
    const [aExit, cExit] = await Promise.all([a.closed, c.closed]);
    const log = analyse(await readFile(env.log, 'utf8'));
    t.diagnostic(`B: ${bResult instanceof AfoError ? bResult.code : String(bResult)}; C: ${cState}; A exit ${aExit.code} ${a.lines.at(-1)}; ` +
      `C exit ${cExit.code}; max concurrent fns ${log.maxActive}`);
    assert.equal(cState, 'closed', 'C must be refused while A holds the lock');
    assert.equal(log.maxActive, 1, 'two fns ran at the same time');
  });

test('V13-R2 release inspect→unlink gap deletes another process\'s lock, letting a fourth process in',
  { todo: 'FAIL at 2229898: see ISSUE_13_LOCK_VERIFY.md R2', timeout: 30_000 }, async (t) => {
    const env = await setup(t);
    const file = lockPath(env.state, env.key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(env.log, '');
    await writeFile(file, lockJson({ pid: await deadPid(t, env) }));
    const before = gate(); const after = gate(); const release = gate();
    let renameArmed = true; let unlinkArmed = false;
    hook('rename', async (from, to) => {
      if (!renameArmed || from !== file || !String(to).includes('.stale-')) return original.rename(from, to!);
      renameArmed = false; await before.pass(); await original.rename(from, to!); await after.pass();
    });
    hook('unlink', async (target) => {
      if (unlinkArmed && target === file) { unlinkArmed = false; await release.pass(); }
      return original.unlink(target!);
    });
    t.after(unhook);
    const b = lock(env.state, env.key, async () => 'B ran').then((v) => v, (e: unknown) => e); // B: judged stale, paused
    await before.reached;
    const a = lock(env.state, env.key, async () => { unlinkArmed = true; return 'A done'; }) // A: takes over, fn ends,
      .then((v) => v, (e: unknown) => e);                                                         // release paused before unlink
    await release.reached;
    before.open(); await after.reached;      // B moves A's lock aside
    const c = kid(t, env, 'hold');
    await c.waitFor('ACQUIRED');             // C acquires the empty path
    const cBytes = await readFile(file);
    after.open();
    const bResult = await b;                 // B: link EEXIST → gives up
    release.open();
    const aResult = await a;                 // A: unlinks whatever is at the path now
    const cLockSurvived = await readFile(file).then((bytes) => bytes.equals(cBytes), () => false);
    const d = kid(t, env, 'once');
    const dExit = await d.closed;
    c.send();
    const cExit = await c.closed;
    t.diagnostic(`A: ${aResult instanceof AfoError ? aResult.code : String(aResult)}; B: ${bResult instanceof AfoError ? bResult.code : String(bResult)}; ` +
      `C lock survived: ${cLockSurvived}; D exit ${dExit.code} (${d.lines.join('/')}); C exit ${cExit.code} ${c.lines.at(-1)}`);
    assert.equal(cLockSurvived, true, "A's release deleted C's lock");
    assert.equal(dExit.code, 3, 'D must be refused while C holds the lock');
  });

test('V13-R3 relative stateDir resolves against each process cwd, so two processes on one root do not exclude each other',
  { todo: 'risk at 2229898: withRootLock accepts a relative stateDir; see ISSUE_13_LOCK_VERIFY.md R3', timeout: 30_000 }, async (t) => {
    const env = await setup(t);
    await mkdir(path.join(env.root, 'cwd1')); await mkdir(path.join(env.root, 'cwd2'));
    const a = kid(t, env, 'hold', { state: 'rel-state', cwd: path.join(env.root, 'cwd1'), log: '-' });
    const aState = await a.settled();
    const b = kid(t, env, 'once', { state: 'rel-state', cwd: path.join(env.root, 'cwd2'), log: '-' });
    const bExit = await b.closed;
    a.send(); await a.closed;
    t.diagnostic(`A ${aState}; B exit ${bExit.code} ${b.lines.join('/')}; created ${await exists(path.join(env.root, 'cwd1', 'rel-state', 'locks'))}`);
    assert.ok(aState === 'closed' || bExit.code === 3, 'relative stateDir rejected, or B refused while A holds the same root');
  });

test('V13-R4 two grant issuances for the same work folder must exclude each other',
  { todo: 'FAIL at 2229898 by design: the key is a per-issuance RootGrant.id; see ISSUE_13_LOCK_VERIFY.md R4', timeout: 30_000 }, async (t) => {
    const env = await setup(t);
    const first = await keyFor(env.work, 'grant-1');
    const second = await keyFor(env.work, 'grant-2'); // e.g. a second CLI process or GUI window re-issuing a grant
    const a = kid(t, env, 'hold', { key: first, log: '-' });
    await a.waitFor('ACQUIRED');
    const b = kid(t, env, 'once', { key: second, log: '-' });
    const bExit = await b.closed;
    a.send(); await a.closed;
    t.diagnostic(`B exit ${bExit.code} ${b.lines.join('/')}`);
    assert.equal(bExit.code, 3, 'B must be refused while A holds the same folder');
  });
