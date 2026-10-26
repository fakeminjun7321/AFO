import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, rename, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ReferenceGrantSchema, RootGrantSchema, isAfoError } from '../packages/contracts/src/index.js';
import { currentSessionId, issueReferenceGrant, issueRootGrant, readReference, revokeGrant, scanRoot, verifyGrant }
  from '../packages/filesystem/src/index.js';
import { fixture, manifest } from './helpers.js';

const code = (expected: string) => (error: unknown): boolean => isAfoError(error) && error.code === expected;

test('work and reference grants carry the real path, dev/inode, session and scope', async (t) => {
  const root = await fixture(t, { 'a.pdf': 'a' });
  const stat = await lstat(root, { bigint: true });
  const work = RootGrantSchema.parse(await issueRootGrant(root));
  assert.equal(work.scope, 'work'); assert.equal(work.canonicalPath, root);
  assert.equal(work.device, String(stat.dev)); assert.equal(work.inode, String(stat.ino));
  assert.equal(work.sessionId, currentSessionId());
  const reference = ReferenceGrantSchema.parse(await issueReferenceGrant(root));
  assert.equal(reference.scope, 'reference'); assert.equal(reference.readOnly, true);
  assert.deepEqual(await verifyGrant(work, 'work'), work);
  assert.deepEqual(await verifyGrant(reference, 'reference', { sessionId: currentSessionId() }), reference);
  // Re-selecting the same folder yields a different grant (bound approvals must not carry over).
  assert.notEqual((await issueRootGrant(root)).id, work.id);
});
test('scopes are not interchangeable: a reference grant cannot scan as a work root and vice versa', async (t) => {
  const root = await fixture(t, { 'a.pdf': 'a' });
  const work = await issueRootGrant(root); const reference = await issueReferenceGrant(root);
  await assert.rejects(scanRoot(reference as never), code('ROOT_FORBIDDEN'));
  await assert.rejects(readReference(work as never), code('ROOT_FORBIDDEN'));
  await assert.rejects(verifyGrant(work, 'work', { sessionId: 'another-session-1' }), code('ROOT_FORBIDDEN'));
});
test('grants not issued by this process, tampered or revoked grants are refused', async (t) => {
  const root = await fixture(t, { 'a.pdf': 'a' }); const other = await fixture(t, { 'b.pdf': 'b' });
  const work = await issueRootGrant(root);
  const forged = { ...work, id: 'f'.repeat(64) };
  assert.equal(RootGrantSchema.safeParse(forged).success, true);
  await assert.rejects(scanRoot(forged), code('ROOT_FORBIDDEN'));
  await assert.rejects(scanRoot({ ...work, canonicalPath: other }), code('ROOT_FORBIDDEN'));
  await assert.rejects(scanRoot({ ...work, approved: true } as never), code('ROOT_FORBIDDEN'));
  assert.equal(revokeGrant(work), true);
  await assert.rejects(scanRoot(work), code('ROOT_FORBIDDEN'));
});
test('a root replaced by another folder or a link after issue is refused (dev/inode check)', async (t) => {
  const parent = await fixture(t, { 'root/a.pdf': 'a', 'elsewhere/b.pdf': 'b' });
  const root = path.join(parent, 'root');
  const grant = await issueRootGrant(root);
  await rename(root, path.join(parent, 'moved-away'));
  await mkdir(root);
  await assert.rejects(verifyGrant(grant, 'work'), code('FILE_CHANGED'));
  await assert.rejects(scanRoot(grant), code('FILE_CHANGED'));
  await rm(root, { recursive: true });
  await symlink(path.join(parent, 'moved-away'), root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(scanRoot(grant), code('FILE_CHANGED'));
  await rm(root);
  await assert.rejects(scanRoot(grant), code('FILE_CHANGED'));
});
test('grant issue refuses files, links, missing paths, OS folders, bundles and development projects', async (t) => {
  const root = await fixture(t, { 'file.pdf': 'x', 'Tool.app/Contents/Resources/r.txt': 'r', 'proj/package.json': '{}',
    'proj/src/deep/a.ts': 'src', 'ok/a.pdf': 'a' });
  const before = await manifest(root);
  await symlink(path.join(root, 'ok'), path.join(root, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir');
  const refused = [path.join(root, 'file.pdf'), path.join(root, 'shortcut'), path.join(root, 'missing'),
    path.join(root, 'Tool.app'), path.join(root, 'Tool.app/Contents/Resources'), path.join(root, 'proj'),
    path.join(root, 'proj/src/deep'), path.parse(root).root, homedir()];
  if (process.platform === 'darwin') refused.push('/System', '/Applications', path.join(homedir(), 'Library'), '/Users', '/private/var');
  for (const target of refused) {
    await assert.rejects(issueRootGrant(target), (e: unknown) => isAfoError(e), target);
    await assert.rejects(issueReferenceGrant(target), (e: unknown) => isAfoError(e), target);
  }
  await assert.rejects(issueRootGrant(''), code('ROOT_FORBIDDEN'));
  await assert.rejects(issueRootGrant(path.join(root, 'file.pdf')), /직접 선택/u);
  assert.equal((await issueRootGrant(path.join(root, 'ok'))).scope, 'work');
  const after = await manifest(root); delete after['shortcut'];
  assert.deepEqual(after, before);
});
