import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, lstat, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createManifest, diffManifest } from './fixtures/index.js';
import { executeBatch, readRun, undoRun } from '../packages/filesystem/src/executor.js';
import { journalFile } from '../packages/filesystem/src/state.js';
import { F, abs, approve, journal, operation, phases, setup } from './executor-helpers.js';
import type { Env } from './executor-helpers.js';

const code = (expected: string) => (error: unknown): boolean => {
  assert.equal((error as { code?: string }).code, expected); return true;
};
async function organize(env: Env, moves: [string, string][]): Promise<{ runId: string; ids: string[] }> {
  const ops = [];
  for (const [source, destination] of moves) ops.push(await operation(env, 'move', source, { destination }));
  const report = await executeBatch(approve(env, ops, 'organize'));
  assert.ok(report.results.every((r) => r.status === 'moved'));
  return { runId: report.runId, ids: ops.map((op) => op.id) };
}
const files = (m: Awaited<ReturnType<typeof createManifest>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(m).filter(([, e]) => e.type === 'file'));

test('undo: moved files return to their original paths; journal pairs keep the forward source/destination/before', async (t) => {
  const env = await setup(t, { [`${F}a.pdf`]: 'a', [`${F}sub/${F}b.txt`]: 'b' });
  const original = await createManifest(env.root);
  const { runId, ids } = await organize(env, [[`${F}a.pdf`, `${F}문서/${F}a.pdf`], [`${F}sub/${F}b.txt`, `${F}text/${F}b.txt`]]);
  await rm(abs(env, `${F}sub`), { recursive: true }); // the original parent folder is gone; undo recreates it inside the root
  const report = await undoRun(env.stateDir, runId, env.grant);
  assert.equal(report.runId, runId);
  assert.deepEqual(report.results.map((r) => [r.opId, r.status, r.errorCode]), [[ids[0], 'moved', null], [ids[1], 'moved', null]]);
  assert.match(report.results[0]!.detail, /되돌렸습니다/u);
  const now = await createManifest(env.root);
  assert.deepEqual(files(now), files(original), 'same paths, sizes, mtimes and hashes as before the run');
  assert.deepEqual(diffManifest(original, now).added, [`${F}문서`, `${F}text`].sort(), 'only the created (now empty) folders remain');
  const entries = await journal(env, runId);
  assert.deepEqual(phases(entries), [`${ids[0]}:intent`, `${ids[0]}:done`, `${ids[1]}:intent`, `${ids[1]}:done`,
    `${ids[0]}:undo-intent`, `${ids[0]}:undone`, `${ids[1]}:undo-intent`, `${ids[1]}:undone`]);
  const [done, undoIntent, undone] = [entries[1]!, entries[4]!, entries[5]!];
  for (const e of [undoIntent, undone]) assert.deepEqual([e.source, e.destination, e.before, e.kind], [done.source, done.destination, done.before, 'move']);
  assert.deepEqual([undoIntent.after, undone.after], [null, done.after]);
  assert.deepEqual(entries.map((e) => e.seq), [0, 1, 2, 3, 4, 5, 6, 7]);
  const saved = await readRun(env.stateDir, runId);
  assert.equal(saved?.run.report?.results.length, 2, 'the original report is kept');
  assert.deepEqual(saved?.undos.map((u) => [u.undoIndex, u.report]), [[1, report]]);
});

test('undo: a new file at the original path is never overwritten; both files are kept', async (t) => {
  const env = await setup(t, { [`${F}a.pdf`]: 'moved content' });
  const { runId } = await organize(env, [[`${F}a.pdf`, `${F}dest/${F}a.pdf`]]);
  await writeFile(abs(env, `${F}a.pdf`), 'user made a new file');
  const before = await createManifest(env.root);
  const report = await undoRun(env.stateDir, runId, env.grant);
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['failed', 'DEST_EXISTS']]);
  assert.deepEqual(await createManifest(env.root), before);
});

test('undo: a moved file edited afterwards (same size and mtime, or different size) is not moved back', async (t) => {
  const when = new Date('2026-01-02T03:04:05Z');
  const env = await setup(t, { [`${F}a.txt`]: { data: 'aaaa', modified: when }, [`${F}b.txt`]: 'bbbb' });
  const { runId } = await organize(env, [[`${F}a.txt`, `${F}out/${F}a.txt`], [`${F}b.txt`, `${F}out/${F}b.txt`]]);
  await writeFile(abs(env, `${F}out/${F}a.txt`), 'AAAA');
  await utimes(abs(env, `${F}out/${F}a.txt`), when, when);
  await appendFile(abs(env, `${F}out/${F}b.txt`), 'more');
  const before = await createManifest(env.root);
  const report = await undoRun(env.stateDir, runId, env.grant);
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['failed', 'FILE_CHANGED'], ['failed', 'FILE_CHANGED']]);
  assert.deepEqual(await createManifest(env.root), before);
});

test('undo: a second undo does not run anything again; a failed undo can be retried once the conflict is gone', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a', [`${F}b.txt`]: 'b' });
  const { runId, ids } = await organize(env, [[`${F}a.txt`, `${F}out/${F}a.txt`], [`${F}b.txt`, `${F}out/${F}b.txt`]]);
  await writeFile(abs(env, `${F}b.txt`), 'blocker');
  const first = await undoRun(env.stateDir, runId, env.grant);
  assert.deepEqual(first.results.map((r) => [r.opId, r.status, r.errorCode]), [[ids[0], 'moved', null], [ids[1], 'failed', 'DEST_EXISTS']]);
  await rm(abs(env, `${F}b.txt`));
  const second = await undoRun(env.stateDir, runId, env.grant);
  assert.deepEqual(second.results.map((r) => [r.opId, r.status]), [[ids[1], 'moved']], 'already undone op is left out');
  const settled = await createManifest(env.root);
  const third = await undoRun(env.stateDir, runId, env.grant);
  assert.deepEqual(third.results, []);
  assert.deepEqual(await createManifest(env.root), settled);
  assert.equal(await readFile(abs(env, `${F}b.txt`), 'utf8'), 'b');
  assert.deepEqual((await readRun(env.stateDir, runId))?.undos.map((u) => u.undoIndex), [1, 2, 3]);
  const tail = phases(await journal(env, runId)).slice(4);
  assert.deepEqual(tail, [`${ids[0]}:undo-intent`, `${ids[0]}:undone`, `${ids[1]}:undo-intent`, `${ids[1]}:failed:DEST_EXISTS`,
    `${ids[1]}:undo-intent`, `${ids[1]}:undone`]);
});

test('undo: refused for another root, a missing run, a corrupt journal; an interrupted undo is reported unknown and not retried', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a', [`${F}b.txt`]: 'b' });
  const other = await setup(t, {});
  const { runId, ids } = await organize(env, [[`${F}a.txt`, `${F}out/${F}a.txt`], [`${F}b.txt`, `${F}out/${F}b.txt`]]);
  const moved = await createManifest(env.root);
  await assert.rejects(undoRun(env.stateDir, runId, other.grant), code('ROOT_FORBIDDEN'));
  await assert.rejects(undoRun(env.stateDir, '00000000-0000-4000-8000-000000000000', env.grant), code('APPROVAL_MISSING'));
  await assert.rejects(undoRun(env.stateDir, '../x', env.grant), code('APPROVAL_MISSING'));
  const file = journalFile(env.stateDir, runId);
  const intact = await readFile(file);
  await appendFile(file, '{"torn": \n');
  await assert.rejects(undoRun(env.stateDir, runId, env.grant), code('STATE_CORRUPT'));
  assert.deepEqual(await createManifest(env.root), moved);
  // An undo-intent with no outcome (crash during undo) must not be guessed at.
  const lines = intact.toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const dangling = { ...lines[1]!, seq: 4, phase: 'undo-intent', after: null, at: new Date().toISOString() };
  await writeFile(file, `${intact.toString('utf8')}${JSON.stringify(dangling)}\n`);
  const report = await undoRun(env.stateDir, runId, env.grant);
  assert.deepEqual(report.results.map((r) => [r.opId, r.status, r.errorCode]), [[ids[0], 'unknown', 'UNKNOWN'], [ids[1], 'moved', null]]);
  assert.ok((await lstat(abs(env, `${F}out/${F}a.txt`))).isFile(), 'the unclear one stays where it is');
});

test('undo: a renamed original parent that became a link to elsewhere is refused (LINK_REJECTED)', async (t) => {
  const env = await setup(t, { [`${F}sub/${F}a.txt`]: 'a', [`${F}elsewhere/.keep`]: '' });
  const { runId } = await organize(env, [[`${F}sub/${F}a.txt`, `${F}out/${F}a.txt`]]);
  await rm(abs(env, `${F}sub`), { recursive: true });
  try { await symlink(abs(env, `${F}elsewhere`), abs(env, `${F}sub`), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if ((error as { code?: string }).code === 'EPERM') { t.skip('symlink privilege missing'); return; } throw error; }
  const report = await undoRun(env.stateDir, runId, env.grant);
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['failed', 'LINK_REJECTED']]);
  assert.equal(await readFile(abs(env, `${F}out/${F}a.txt`), 'utf8'), 'a');
  assert.equal(await lstat(abs(env, `${F}elsewhere/${F}a.txt`)).catch(() => null), null);
});
