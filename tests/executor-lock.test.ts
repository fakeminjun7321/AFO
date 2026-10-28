import test from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createManifest } from './fixtures/index.js';
import { executeBatch, listRuns, readRun, undoRun } from '../packages/filesystem/src/executor.js';
import { issueRootGrant } from '../packages/filesystem/src/grants.js';
import { readRootLock, rootLockFile, withRootLock } from '../packages/filesystem/src/lock.js';
import { journalFile } from '../packages/filesystem/src/state.js';
import { F, abs, approve, journal, operation, phases, setup, stateNames } from './executor-helpers.js';

/* #10/#13: executeBatch and undoRun each hold the root lock (lock.ts) once. Synthetic temp roots and a temp state folder only. */
const code = (expected: string) => (error: unknown): boolean => {
  assert.equal((error as { code?: string }).code, expected); return true;
};
const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

test('lock: executeBatch while another run holds the root → LOCKED_BY_OTHER, nothing written; after release the same batch runs', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a', [`${F}b.txt`]: 'b' });
  const ops = [await operation(env, 'move', `${F}a.txt`, { destination: `${F}x/${F}a.txt` }),
    await operation(env, 'move', `${F}b.txt`, { destination: `${F}x/${F}b.txt` })];
  const batch = approve(env, ops, 'organize');
  const before = await createManifest(env.root);
  // Same folder through a re-issued grant (new id, same session): the lock key is the directory identity, not the grant id.
  const reissued = await issueRootGrant(env.root, { sessionId: env.grant.sessionId });
  await withRootLock(env.stateDir, env.grant, async () => {
    await assert.rejects(executeBatch(batch), code('LOCKED_BY_OTHER'));
    await assert.rejects(executeBatch({ ...batch, grant: reissued }), code('LOCKED_BY_OTHER'), 'other grant id, same folder');
    assert.deepEqual(await createManifest(env.root), before);
    assert.deepEqual(await stateNames(env), ['locks'], 'no runs/ (approval marker, run record) and no journal/');
    assert.deepEqual(await listRuns(env.stateDir), []);
  });
  assert.equal((await readRootLock(env.stateDir, env.grant)).state, 'free');
  const report = await executeBatch(batch);
  assert.deepEqual(report.results.map((r) => r.status), ['moved', 'moved'], 'the refused attempt did not spend the approval');
  assert.equal(await readFile(abs(env, `${F}x/${F}a.txt`), 'utf8'), 'a');
  assert.ok(await exists(path.join(env.stateDir, 'runs', `${batch.approval.id}.approval`)));
  assert.equal((await readRootLock(env.stateDir, env.grant)).state, 'free', 'released after the run');
  await assert.rejects(executeBatch(batch), code('APPROVAL_USED'));
});

test('lock: undoRun while another run holds the root → LOCKED_BY_OTHER, journal and undo records unchanged; after release it undoes', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a' });
  const op = await operation(env, 'move', `${F}a.txt`, { destination: `${F}x/${F}a.txt` });
  const report = await executeBatch(approve(env, [op], 'organize'));
  const moved = await createManifest(env.root);
  const journalBefore = await readFile(journalFile(env.stateDir, report.runId));
  const runsBefore = (await readdir(path.join(env.stateDir, 'runs'))).sort();
  await withRootLock(env.stateDir, env.grant, async () => {
    await assert.rejects(undoRun(env.stateDir, report.runId, env.grant), code('LOCKED_BY_OTHER'));
  });
  assert.deepEqual(await createManifest(env.root), moved);
  assert.deepEqual(await readFile(journalFile(env.stateDir, report.runId)), journalBefore);
  assert.deepEqual((await readdir(path.join(env.stateDir, 'runs'))).sort(), runsBefore, 'no undo-<n>.json');
  const undo = await undoRun(env.stateDir, report.runId, env.grant);
  assert.deepEqual(undo.results.map((r) => [r.opId, r.status]), [[op.id, 'moved']]);
  assert.equal(await readFile(abs(env, `${F}a.txt`), 'utf8'), 'a');
  assert.equal((await readRootLock(env.stateDir, env.grant)).state, 'free');
});

test('lock: a run that throws (fault injection) still releases the lock; the next run is not blocked', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a', [`${F}b.txt`]: 'b' });
  const a = await operation(env, 'move', `${F}a.txt`, { destination: `${F}x/${F}a.txt` });
  const crash = new Error('simulated crash');
  await assert.rejects(executeBatch(approve(env, [a], 'organize'), { faultInjection: () => { throw crash; } }), (e) => e === crash);
  assert.equal((await readRootLock(env.stateDir, env.grant)).state, 'free');
  const b = await operation(env, 'move', `${F}b.txt`, { destination: `${F}x/${F}b.txt` });
  assert.equal((await executeBatch(approve(env, [b], 'organize'))).results[0]!.status, 'moved');
});

test('lock: a release failure after a finished run is thrown, but the run record, journal and files already hold the result', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a' });
  const op = await operation(env, 'move', `${F}a.txt`, { destination: `${F}x/${F}a.txt` });
  const lockFile = rootLockFile(env.stateDir, env.grant);
  // Someone removes our lock file mid-run; release then refuses (the lock no longer carries our token).
  await assert.rejects(executeBatch(approve(env, [op], 'organize'), { onProgress: () => { unlinkSync(lockFile); } }),
    (error: unknown) => { assert.equal((error as { code?: string }).code, 'STATE_CORRUPT');
      assert.match((error as Error).message, /작업은 끝났지만/u); return true; });
  assert.equal(await readFile(abs(env, `${F}x/${F}a.txt`), 'utf8'), 'a');
  const [runId] = await listRuns(env.stateDir);
  const saved = await readRun(env.stateDir, runId!);
  assert.deepEqual(saved?.run.report?.results.map((r) => [r.opId, r.status]), [[op.id, 'moved']], 'runs/<runId>.json has the report');
  assert.deepEqual(phases(await journal(env, runId!)), [`${op.id}:intent`, `${op.id}:done`]);
});
