import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createManifest } from './fixtures/index.js';
import { executeBatch, undoRun } from '../packages/filesystem/src/executor.js';
import type { ExecutorAdapter } from '../packages/filesystem/src/executor.js';
import { PlatformError, deleteFilePermanently, isTrashSupported } from '../packages/filesystem/src/platform.js';
import { F, abs, approve, isRoot, journal, operation, phases, setup, sha } from './executor-helpers.js';

const code = (expected: string) => (error: unknown): boolean => {
  assert.equal((error as { code?: string }).code, expected); return true;
};
/** Mock trash: renames the file into a separate temp folder outside the root. Not OS trash evidence. */
async function mockTrash(t: TestContext): Promise<{ dir: string; adapter: Partial<ExecutorAdapter>; calls: { trash: number; delete: number } }> {
  const dir = await mkdtemp(path.join(tmpdir(), `${F}mock-trash-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = { trash: 0, delete: 0 };
  return { dir, calls, adapter: {
    moveToTrash: async (file) => { calls.trash++; await rename(file, path.join(dir, path.basename(file))); },
    deleteFilePermanently: async () => { calls.delete++; throw new Error('must not be called'); } } };
}

test('trash (mock): approved files with a verified keeper are trashed; the report counts no reclaimed space', async (t) => {
  const env = await setup(t, { [`${F}copy.zip`]: 'same', [`${F}orig.zip`]: 'same', [`${F}old.log`]: 'log', [`${F}keep.txt`]: 'k' });
  const { dir, adapter } = await mockTrash(t);
  const dup = await operation(env, 'trash', `${F}copy.zip`, { keeper: `${F}orig.zip` });
  const single = await operation(env, 'trash', `${F}old.log`);
  const report = await executeBatch(approve(env, [dup, single], 'trash'), { adapter });
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['trashed', null], ['trashed', null]]);
  assert.deepEqual((await readdir(dir)).sort(), [`${F}copy.zip`, `${F}old.log`]);
  assert.deepEqual(Object.keys(await createManifest(env.root)).sort(), [`${F}keep.txt`, `${F}orig.zip`]);
  assert.deepEqual([report.space.freeBytesBefore, report.space.freeBytesAfter], [null, null]);
  assert.match(report.space.note, /확보한 공간으로 세지 않습니다/u);
  assert.match(report.space.note, /앱 내 자동 복구 없음/u);
  assert.deepEqual(phases(await journal(env, report.runId)), [`${dup.id}:intent`, `${dup.id}:done`, `${single.id}:intent`, `${single.id}:done`]);
  await assert.rejects(undoRun(env.stateDir, report.runId, env.grant), code('NOT_SUPPORTED'));
});

test('trash (mock): a trash failure keeps the file, is not retried and never falls back to permanent deletion', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a' });
  const calls = { trash: 0, delete: 0 };
  const op = await operation(env, 'trash', `${F}a.txt`);
  const before = await createManifest(env.root);
  const report = await executeBatch(approve(env, [op], 'trash'), { adapter: {
    moveToTrash: async () => { calls.trash++; throw new PlatformError('TRASH_FAILED', 'mock trash failure'); },
    deleteFilePermanently: async () => { calls.delete++; } } });
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['failed', 'TRASH_FAILED']]);
  assert.deepEqual(calls, { trash: 1, delete: 0 });
  assert.deepEqual(await createManifest(env.root), before);
});

test('trash (mock): a tool that reports failure although the file is gone is unknown, not success and not failed', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a' });
  const { dir } = await mockTrash(t);
  const op = await operation(env, 'trash', `${F}a.txt`);
  const report = await executeBatch(approve(env, [op], 'trash'), { adapter: { moveToTrash: async (file) => {
    await rename(file, path.join(dir, 'gone')); throw new PlatformError('TRASH_FAILED', 'mock'); } } });
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['unknown', 'UNKNOWN']]);
});

test('trash (real OS): one synthetic afo-test- file goes to the real trash; siblings stay (AFO_REAL_TRASH_TEST=1 only)', async (t) => {
  if (!await isTrashSupported()) { t.skip(`${process.platform}: NOT_SUPPORTED`); return; }
  if (process.env['AFO_REAL_TRASH_TEST'] !== '1') { t.skip('실제 OS 휴지통 검사는 AFO_REAL_TRASH_TEST=1에서만 실행'); return; }
  const name = `${F}executor-trash-${Date.now().toString(36)}.txt`;
  const env = await setup(t, { [name]: 'synthetic trash fixture', [`${F}keep.txt`]: 'keep' });
  const op = await operation(env, 'trash', name);
  const report = await executeBatch(approve(env, [op], 'trash'));
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['trashed', null]]);
  assert.equal(await lstat(abs(env, name)).catch(() => null), null);
  assert.deepEqual(Object.keys(await createManifest(env.root)), [`${F}keep.txt`]);
  t.diagnostic(`trashed ${name} through the real OS trash (restore is manual, not checked here)`);
});

test('permanent delete: a duplicate is deleted only after its keeper is verified; keeper hash kept; free space observed', async (t) => {
  const env = await setup(t, { [`${F}copy.bin`]: 'x'.repeat(1 << 20), [`${F}orig.bin`]: 'x'.repeat(1 << 20), [`${F}chosen.txt`]: 'pick' });
  const keeperHash = await sha(abs(env, `${F}orig.bin`));
  const dup = await operation(env, 'delete', `${F}copy.bin`, { keeper: `${F}orig.bin` });
  const chosen = await operation(env, 'delete', `${F}chosen.txt`); // keeper null: a file the user selected explicitly
  const report = await executeBatch(approve(env, [dup, chosen], 'permanent-delete'));
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['deleted', null], ['deleted', null]]);
  assert.deepEqual(Object.keys(await createManifest(env.root)), [`${F}orig.bin`]);
  assert.equal(await sha(abs(env, `${F}orig.bin`)), keeperHash);
  assert.equal(typeof report.space.freeBytesBefore, 'number');
  assert.equal(typeof report.space.freeBytesAfter, 'number');
  assert.equal(report.space.logicalBytesSelected, (1 << 20) + 4);
  assert.match(report.space.note, /정확한 회수량이 아닙니다/u);
  assert.match(report.space.note, /되돌릴 수 없습니다/u);
  if (process.platform !== 'win32') assert.match(report.results[0]!.detail, /할당 크기 관측 \d+바이트/u);
  t.diagnostic(`free before=${report.space.freeBytesBefore} after=${report.space.freeBytesAfter} (observation; other processes affect it)`);
  await assert.rejects(undoRun(env.stateDir, report.runId, env.grant), code('NOT_SUPPORTED'));
});

test('permanent delete: keeper changed (same size/mtime), missing or a link → KEEPER_INVALID and the target is kept', async (t) => {
  const when = new Date('2026-01-02T03:04:05Z');
  const env = await setup(t, { [`${F}d1.txt`]: 'same', [`${F}k1.txt`]: { data: 'same', modified: when },
    [`${F}d2.txt`]: 'two!', [`${F}k2.txt`]: 'two!', [`${F}d3.txt`]: 'tri!', [`${F}k3.txt`]: 'tri!' });
  const ops = [await operation(env, 'delete', `${F}d1.txt`, { keeper: `${F}k1.txt` }),
    await operation(env, 'delete', `${F}d2.txt`, { keeper: `${F}k2.txt` }),
    await operation(env, 'delete', `${F}d3.txt`, { keeper: `${F}k3.txt` })];
  await writeFile(abs(env, `${F}k1.txt`), 'SAME'); await utimes(abs(env, `${F}k1.txt`), when, when);
  await unlink(abs(env, `${F}k2.txt`));
  await unlink(abs(env, `${F}k3.txt`));
  try { await symlink(abs(env, `${F}d3.txt`), abs(env, `${F}k3.txt`)); }
  catch (error) { if ((error as { code?: string }).code === 'EPERM') { t.skip('symlink privilege missing'); return; } throw error; }
  const before = await createManifest(env.root);
  const report = await executeBatch(approve(env, ops, 'permanent-delete'));
  assert.deepEqual(report.results.map((r) => r.errorCode), ['KEEPER_INVALID', 'KEEPER_INVALID', 'KEEPER_INVALID']);
  assert.deepEqual(await createManifest(env.root), before);
});

test('permanent delete: a permission error fails once without retry and the file stays', async (t) => {
  if (process.platform !== 'darwin' || isRoot()) { t.skip('chflags uchg 검사는 macOS 일반 사용자 전용'); return; }
  const env = await setup(t, { [`${F}locked.txt`]: 'locked', [`${F}free.txt`]: 'free' });
  const ops = [await operation(env, 'delete', `${F}locked.txt`), await operation(env, 'delete', `${F}free.txt`)];
  const locked = abs(env, `${F}locked.txt`);
  execFileSync('/usr/bin/chflags', ['uchg', locked]);
  let calls = 0; let report;
  try {
    report = await executeBatch(approve(env, ops, 'permanent-delete'), { adapter: { deleteFilePermanently: async (...args) => {
      calls++; return deleteFilePermanently(...args); } } }); // real unlink, counted
  } finally { execFileSync('/usr/bin/chflags', ['nouchg', locked]); }
  assert.deepEqual(report.results.map((r) => [r.status, r.errorCode]), [['failed', 'PERMISSION_DENIED'], ['deleted', null]]);
  assert.equal(calls, 2, 'one call per operation, no retry');
  assert.equal(await readFile(locked, 'utf8'), 'locked');
});

test('permanent delete: approval in trash mode for delete operations is MODE_MISMATCH and nothing is deleted', async (t) => {
  const env = await setup(t, { [`${F}a.txt`]: 'a' });
  const op = await operation(env, 'delete', `${F}a.txt`);
  const batch = approve(env, [op], 'permanent-delete');
  await assert.rejects(executeBatch({ ...batch, approval: { ...batch.approval, mode: 'trash' } }), code('MODE_MISMATCH'));
  assert.equal(await readFile(abs(env, `${F}a.txt`), 'utf8'), 'a');
});
