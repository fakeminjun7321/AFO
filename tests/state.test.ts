import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AfoError } from '../packages/contracts/src/index.js';
import type { ErrorCode, JournalEntry } from '../packages/contracts/src/index.js';
import { appendJournal, assertStateDirOutside, journalFile, readJournal, readJson, resolveStateDir, statePaths,
  writeJsonAtomic } from '../packages/filesystem/src/state.js';
import { createFixture } from './helpers.js';

const code = (expected: ErrorCode) => (error: unknown): boolean => error instanceof AfoError && error.code === expected;
const Doc = z.strictObject({ name: z.string(), count: z.number().int() });
const entry = (seq: number, extra: Partial<JournalEntry> = {}): JournalEntry => ({
  formatVersion: 1, runId: 'run-00000001', seq, opId: '0000000a', planId: '1'.repeat(64), rootGrantId: '2'.repeat(64), approvalId: 'approval-0001', phase: 'intent',
  kind: 'trash', source: '사진/여행 😀.jpg', destination: null, before: { device: '1', inode: '2', size: 5, sha256: null },
  after: null, errorCode: null, at: '2026-10-26T01:00:00.000Z', ...extra });

test('state folder comes from AFO_STATE_DIR or the OS app-data default, never a relative or empty value', () => {
  assert.equal(resolveStateDir({ AFO_STATE_DIR: '/tmp/afo-state/../afo-state' }, 'darwin', '/Users/u'), '/tmp/afo-state');
  for (const bad of ['', '   ', 'relative/state', './state'])
    assert.throws(() => resolveStateDir({ AFO_STATE_DIR: bad }, 'darwin', '/Users/u'), code('STATE_DIR_INVALID'), bad);
  assert.throws(() => resolveStateDir({ AFO_STATE_DIR: '/state' }, 'win32', 'C:\\Users\\u'), code('STATE_DIR_INVALID'));
  assert.equal(resolveStateDir({}, 'darwin', '/Users/u'), '/Users/u/Library/Application Support/AFO');
  assert.equal(resolveStateDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Local\\AFO');
  assert.equal(resolveStateDir({}, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Local\\AFO');
  assert.equal(resolveStateDir({ XDG_STATE_HOME: '/x/state' }, 'linux', '/home/u'), '/x/state/afo');
  assert.equal(resolveStateDir({ XDG_STATE_HOME: 'rel' }, 'linux', '/home/u'), '/home/u/.local/state/afo');
  const layout = statePaths('/s');
  assert.deepEqual(Object.keys(layout), ['profiles', 'plans', 'approvals', 'journal', 'locks']);
  assert.equal(journalFile('/s', 'run-00000001'), path.join('/s', 'journal', 'run-00000001.jsonl'));
  for (const bad of ['../../../etc', 'a/b', 'short']) assert.throws(() => journalFile('/s', bad), bad);
});

test('state folders overlapping the work root are rejected by real path', async (t) => {
  const { root: base } = await createFixture({ 'work/a.pdf': 'a', 'state/': '' }, t);
  const work = path.join(base, 'work');
  await assertStateDirOutside(path.join(base, 'state'), work);
  await assertStateDirOutside(path.join(base, 'state', 'not-yet', 'created'), work);
  await assert.rejects(assertStateDirOutside(work, work), code('STATE_DIR_CONFLICT'));
  await assert.rejects(assertStateDirOutside(path.join(work, '.afo', 'deep'), work), code('STATE_DIR_CONFLICT'));
  await assert.rejects(assertStateDirOutside(base, work), code('STATE_DIR_CONFLICT'));
  if (process.platform !== 'win32') {
    await symlink(work, path.join(base, 'alias'));
    await assert.rejects(assertStateDirOutside(path.join(base, 'alias', 'state'), work), code('STATE_DIR_CONFLICT'));
  }
  if (process.platform === 'darwin' || process.platform === 'win32')
    await assert.rejects(assertStateDirOutside(path.join(work.toUpperCase(), 'state'), work), code('STATE_DIR_CONFLICT'));
});

test('atomic JSON writes replace whole files, validate first and leave no temp files', async (t) => {
  const { root } = await createFixture({}, t);
  const file = path.join(root, 'plans', 'p.json');
  await writeJsonAtomic(file, { name: '첫 계획', count: 1 }, Doc);
  assert.deepEqual(await readJson(file, Doc), { name: '첫 계획', count: 1 });
  await writeJsonAtomic(file, { name: '둘째', count: 2 }, Doc);
  assert.deepEqual(await readJson(file, Doc), { name: '둘째', count: 2 });
  assert.throws(() => Doc.parse({ name: 3 }));
  await assert.rejects(writeJsonAtomic(file, { name: 3 }, Doc));
  assert.deepEqual(await readJson(file, Doc), { name: '둘째', count: 2 }, 'invalid value must not replace the file');
  await assert.rejects(writeJsonAtomic(file, 'x'.repeat(1024 * 1024)), code('STATE_CORRUPT'));
  await mkdir(path.join(root, 'plans', 'blocked.json'));
  await assert.rejects(writeJsonAtomic(path.join(root, 'plans', 'blocked.json'), { name: 'x', count: 0 }), AfoError);
  assert.deepEqual((await readdir(path.join(root, 'plans'))).sort(), ['blocked.json', 'p.json']);
});

test('readJson reports missing as null and every damaged or unusual file as STATE_CORRUPT', async (t) => {
  const { root } = await createFixture({ 'bad.json': '{"name": "x", "cou', 'wrong.json': '{"name":"x","count":"1"}',
    'extra.json': '{"name":"x","count":1,"approved":true}', 'folder.json/': '' }, t);
  assert.equal(await readJson(path.join(root, 'none.json'), Doc), null);
  for (const name of ['bad.json', 'wrong.json', 'extra.json', 'folder.json'])
    await assert.rejects(readJson(path.join(root, name), Doc), code('STATE_CORRUPT'), name);
  await writeFile(path.join(root, 'big.json'), `"${'x'.repeat(1024 * 1024)}"`);
  await assert.rejects(readJson(path.join(root, 'big.json'), z.string()), code('STATE_CORRUPT'));
  await writeFile(path.join(root, 'latin1.json'), Buffer.from([0x22, 0xff, 0x22]));
  await assert.rejects(readJson(path.join(root, 'latin1.json'), z.string()), code('STATE_CORRUPT'));
  if (process.platform !== 'win32') {
    await writeFile(path.join(root, 'real.json'), '{"name":"x","count":1}');
    await symlink(path.join(root, 'real.json'), path.join(root, 'link.json'));
    await assert.rejects(readJson(path.join(root, 'link.json'), Doc), code('STATE_CORRUPT'));
  }
});

test('journal appends validated lines and reports torn, invalid and out-of-order lines', async (t) => {
  const { root } = await createFixture({}, t);
  const file = journalFile(root, 'run-00000001');
  assert.equal(await readJournal(file), null);
  await appendJournal(file, entry(0));
  await appendJournal(file, entry(1, { phase: 'done' }));
  assert.deepEqual((await readJournal(file))?.entries.map((e) => [e.seq, e.phase]), [[0, 'intent'], [1, 'done']]);
  const before = await readFile(file);
  await assert.rejects(appendJournal(file, entry(2, { phase: 'failed' })), 'failed entry without error code');
  assert.deepEqual(await readFile(file), before, 'rejected entries are not written');

  await appendFile(file, '{"formatVersion":1,"runId":"run-0000'); // simulated crash mid-line
  await appendJournal(file, entry(2, { opId: '0000000b' }));
  await appendFile(file, `${JSON.stringify(entry(1, { opId: '0000000c' }))}\n`);
  await appendFile(file, `${JSON.stringify(entry(9, { runId: 'run-00000002' }))}\n`);
  await appendFile(file, `${JSON.stringify({ ...entry(10), phase: 'gone' })}\n`);
  const read = await readJournal(file);
  assert.deepEqual(read?.entries.map((e) => [e.seq, e.opId]), [[0, '0000000a'], [1, '0000000a'], [2, '0000000b']]);
  assert.deepEqual(read?.corrupt.map((c) => c.line), [3, 5, 6, 7]);
  assert.match(read?.corrupt[0]?.reason ?? '', /잘린/u);
  if (process.platform !== 'win32') {
    await writeFile(path.join(root, 'elsewhere.jsonl'), '');
    await symlink(path.join(root, 'elsewhere.jsonl'), path.join(root, 'link.jsonl'));
    await assert.rejects(appendJournal(path.join(root, 'link.jsonl'), entry(0)), code('JOURNAL_FAILED'));
    assert.equal((await readFile(path.join(root, 'elsewhere.jsonl'))).length, 0);
  }
});
