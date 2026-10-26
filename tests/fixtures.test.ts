import test from 'node:test';
import assert from 'node:assert/strict';
import { access, appendFile, mkdir, readFile, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURE_PREFIX, createFixture, createManifest, diffManifest, sameManifest, sampleSpec } from './fixtures/index.js';

test('fixtures are created only under a fresh temp folder and cleaned up', async () => {
  const { root, cleanup } = await createFixture(sampleSpec());
  const temp = await realpath(tmpdir());
  assert.equal(path.dirname(root), temp);
  assert.ok(path.basename(root).startsWith(FIXTURE_PREFIX));
  assert.notEqual(root, await realpath(homedir()));
  const files = await createManifest(root);
  assert.equal(files['사진/빈 파일.png']?.type, 'file');
  assert.equal(files['사진/빈 파일.png']?.type === 'file' && files['사진/빈 파일.png'].bytes, '0');
  assert.deepEqual(files['빈 폴더'], { type: 'directory' });
  assert.equal(files['깊은/a/b/c/d.txt']?.type, 'file');
  assert.equal(await readFile(path.join(root, '사진', '여행 😀.jpg'), 'utf8'), 'image');
  await cleanup();
  await assert.rejects(access(root));
});

test('fixture specs cannot escape the temp root', async () => {
  for (const bad of ['../escape.txt', '/abs.txt', 'a/../../b.txt', 'a//b.txt', './a.txt', 'a\\..\\b.txt'])
    await assert.rejects(createFixture({ [bad]: 'x' }), /단순 상대 경로/u, bad);
});

test('manifest treats prototype-like file names as ordinary entries', async (t) => {
  const { root } = await createFixture({ 'a.txt': 'a', constructor: 'c', ['__proto__']: 'p', hasOwnProperty: 'h' }, t);
  const before = await createManifest(root);
  assert.deepEqual(Object.keys(before).sort(), ['__proto__', 'a.txt', 'constructor', 'hasOwnProperty']);
  assert.equal(Object.hasOwn(before, '__proto__') && before['__proto__']?.type, 'file');
  await writeFile(path.join(root, 'toString'), 't');
  await rm(path.join(root, 'constructor'));
  await writeFile(path.join(root, '__proto__'), 'changed');
  const after = await createManifest(root);
  const expectedDiff = { added: ['toString'], removed: ['constructor'], changed: ['__proto__'] };
  assert.deepEqual(diffManifest(before, after, { ignoreModified: true }), expectedDiff);
  // Baselines reloaded from JSON are plain objects; the diff must not consult the prototype chain either.
  const reload = (m: object) => JSON.parse(JSON.stringify(m)) as typeof before;
  assert.deepEqual(diffManifest(reload(before), reload(after), { ignoreModified: true }), expectedDiff);
  assert.deepEqual(diffManifest({}, reload(after)).added, ['__proto__', 'a.txt', 'hasOwnProperty', 'toString']);
});

test('manifest diff detects added, removed, content, size and timestamp changes', async (t) => {
  const old = new Date('2020-01-02T03:04:05Z');
  const { root } = await createFixture({ 'keep.txt': 'same', 'edit.txt': 'aaaa', 'grow.txt': 'a', 'gone.txt': 'x',
    'touch.txt': { data: 't', modified: old }, 'move/me.txt': 'm' }, t);
  const before = await createManifest(root);
  assert.ok(sameManifest(diffManifest(before, await createManifest(root))));
  await writeFile(path.join(root, 'edit.txt'), 'bbbb');
  const editedTime = new Date('2021-01-01T00:00:00Z');
  await utimes(path.join(root, 'edit.txt'), editedTime, editedTime);
  await appendFile(path.join(root, 'grow.txt'), 'b');
  await rm(path.join(root, 'gone.txt'));
  await utimes(path.join(root, 'touch.txt'), new Date(), new Date());
  await mkdir(path.join(root, 'new'));
  await rename(path.join(root, 'move', 'me.txt'), path.join(root, 'new', 'me.txt'));
  const after = await createManifest(root);
  const diff = diffManifest(before, after);
  assert.deepEqual(diff, { added: ['new', 'new/me.txt'], removed: ['gone.txt', 'move/me.txt'],
    changed: ['edit.txt', 'grow.txt', 'touch.txt'] });
  assert.deepEqual(diffManifest(before, after, { ignoreModified: true }).changed, ['edit.txt', 'grow.txt']);
  assert.equal(after['new/me.txt']?.type === 'file' && before['move/me.txt']?.type === 'file' &&
    after['new/me.txt'].sha256 === before['move/me.txt'].sha256, true, 'moved content keeps its hash');
  assert.equal(sameManifest(diff), false);
});
