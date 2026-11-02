import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, lstat, mkdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createManifest, diffManifest } from './fixtures/index.js';
import { executeBatch, readRun, undoRun } from '../packages/filesystem/src/executor.js';
import { PlatformError, linkMoveNoClobber } from '../packages/filesystem/src/platform.js';
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
  assert.deepEqual(diffManifest(original, now).added, [], 'the folders the run created are removed again once empty');
  assert.deepEqual([...report.directories!.removed].sort(), [`${F}문서`, `${F}text`].sort());
  assert.deepEqual(report.directories!.kept, []);
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

test('undo (D2): a forward move closed failed+UNKNOWN is reported unknown and never moved back; a definite failure is left out', async (t) => {
  const env = await setup(t, { [`${F}u.txt`]: 'unclear', [`${F}f.txt`]: 'failed', [`${F}ok.txt`]: 'ok', [`${F}out/${F}f.txt`]: 'blocker' });
  const unclear = await operation(env, 'move', `${F}u.txt`, { destination: `${F}out/${F}u.txt` });
  const failed = await operation(env, 'move', `${F}f.txt`, { destination: `${F}out/${F}f.txt` });
  const ok = await operation(env, 'move', `${F}ok.txt`, { destination: `${F}out/${F}ok.txt` });
  // out/f.txt already exists: a definite DEST_EXISTS before any OS call.
  // (mock) the real no-clobber move of u.txt succeeds, then the adapter reports an unclear outcome.
  const report = await executeBatch(approve(env, [unclear, failed, ok], 'organize'), { adapter: {
    linkMoveNoClobber: async (s, d, x) => {
      const moved = await linkMoveNoClobber(s, d, x);
      if (s.endsWith(`${F}u.txt`)) throw new PlatformError('UNKNOWN', 'mock unclear');
      return moved;
    } } });
  assert.deepEqual(report.results.map((r) => [r.opId, r.status, r.errorCode]),
    [[unclear.id, 'unknown', 'UNKNOWN'], [failed.id, 'failed', 'DEST_EXISTS'], [ok.id, 'moved', null]]);
  const before = await createManifest(env.root);
  const undo = await undoRun(env.stateDir, report.runId, env.grant);
  assert.deepEqual(undo.results.map((r) => [r.opId, r.status, r.errorCode]), [[unclear.id, 'unknown', 'UNKNOWN'], [ok.id, 'moved', null]]);
  assert.match(undo.results[0]!.detail, /결과 불명 이동 — 복구 점검 필요/u);
  assert.equal(await readFile(abs(env, `${F}out/${F}u.txt`), 'utf8'), 'unclear', 'the unclear move is not guessed back');
  assert.equal(await readFile(abs(env, `${F}ok.txt`), 'utf8'), 'ok');
  assert.equal(await readFile(abs(env, `${F}out/${F}f.txt`), 'utf8'), 'blocker');
  assert.deepEqual(diffManifest(before, await createManifest(env.root)).added, [`${F}ok.txt`]);
  const tail = phases(await journal(env, report.runId)).slice(6);
  assert.deepEqual(tail, [`${ok.id}:undo-intent`, `${ok.id}:undone`], 'no undo entry for the unclear or the failed op');
  const again = await undoRun(env.stateDir, report.runId, env.grant);
  assert.deepEqual(again.results.map((r) => [r.opId, r.status]), [[unclear.id, 'unknown']], 'still reported on every later undo');
});

test('undo removes only the empty folders this run created (deepest first); an existing empty folder and a folder with a user file stay', async (t) => {
  const env = await setup(t, { [`${F}a.pdf`]: 'a', [`${F}b.txt`]: 'b', [`${F}c.jpg`]: 'c', [`${F}있던폴더/`]: '' });
  const original = await createManifest(env.root);
  const { runId } = await organize(env, [[`${F}a.pdf`, `${F}있던폴더/${F}a.pdf`], [`${F}b.txt`, `${F}새/${F}깊은/${F}b.txt`],
    [`${F}c.jpg`, `${F}채운/${F}c.jpg`]]);
  const { run } = (await readRun(env.stateDir, runId))!;
  assert.deepEqual(run.createdDirectories?.map((d) => d.path), [`${F}새`, `${F}새/${F}깊은`, `${F}채운`], 'only folders mkdir created');
  await writeFile(abs(env, `${F}채운/${F}user.txt`), 'the user put a file here');
  const report = await undoRun(env.stateDir, runId, env.grant);
  assert.ok(report.results.every((r) => r.status === 'moved'));
  assert.deepEqual(report.directories!.removed, [`${F}새/${F}깊은`, `${F}새`], 'deepest first');
  assert.deepEqual(report.directories!.kept.map((k) => k.path), [`${F}채운`]);
  assert.match(report.directories!.kept[0]!.reason, /다른 항목/u);
  const now = await createManifest(env.root);
  assert.deepEqual(now[`${F}있던폴더`], { type: 'directory' }, 'a folder that existed before is never removed');
  assert.equal(now[`${F}새`], undefined);
  assert.deepEqual(diffManifest(original, now).added, [`${F}채운`, `${F}채운/${F}user.txt`]);
  assert.deepEqual(diffManifest(original, now).removed, []);
});

test('undo keeps a recorded folder that was replaced by another folder of the same name (identity changed)', async (t) => {
  const env = await setup(t, { [`${F}a.pdf`]: 'a', [`${F}b.pdf`]: 'b' });
  const { runId } = await organize(env, [[`${F}a.pdf`, `${F}문서/${F}a.pdf`], [`${F}b.pdf`, `${F}다른/${F}b.pdf`]]);
  // The user moves the file out, replaces the folder with a new one of the same name and moves the file back.
  await rename(abs(env, `${F}다른/${F}b.pdf`), abs(env, `${F}b-out.pdf`));
  await rm(abs(env, `${F}다른`), { recursive: true });
  await mkdir(abs(env, `${F}다른`));
  await rename(abs(env, `${F}b-out.pdf`), abs(env, `${F}다른/${F}b.pdf`));
  const report = await undoRun(env.stateDir, runId, env.grant);
  assert.deepEqual(report.results.map((r) => r.status), ['moved', 'moved']);
  assert.deepEqual(report.directories!.removed, [`${F}문서`]);
  assert.deepEqual(report.directories!.kept.map((k) => k.path), [`${F}다른`]);
  assert.match(report.directories!.kept[0]!.reason, /바뀌어/u);
  assert.equal((await lstat(abs(env, `${F}다른`))).isDirectory(), true, 'the replacement folder (now empty) is not removed');
});

test('undo of an older run record without the folder list still works and removes no folder', async (t) => {
  const env = await setup(t, { [`${F}a.pdf`]: 'a' });
  const original = await createManifest(env.root);
  const { runId } = await organize(env, [[`${F}a.pdf`, `${F}문서/${F}a.pdf`]]);
  const file = path.join(env.stateDir, 'runs', `${runId}.json`);
  const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.ok(Array.isArray(record.createdDirectories));
  delete record.createdDirectories; // the record format before this change
  await writeFile(file, JSON.stringify(record));
  const report = await undoRun(env.stateDir, runId, env.grant);
  assert.deepEqual(report.results.map((r) => r.status), ['moved']);
  assert.equal(report.directories, undefined);
  assert.match(report.space.note, /목록이 없어 빈 폴더를 지우지 않았습니다/u);
  const now = await createManifest(env.root);
  assert.deepEqual(diffManifest(original, now).added, [`${F}문서`], 'the old behaviour: the empty folder stays');
});
