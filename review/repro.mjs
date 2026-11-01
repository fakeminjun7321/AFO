import { mkdtemp, mkdir, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { issueRootGrant } from '../dist/packages/filesystem/src/grants.js';
import { withRootLock } from '../dist/packages/filesystem/src/lock.js';
import { inspectRuns } from '../dist/packages/filesystem/src/recovery.js';
import { appendJournal, journalFile } from '../dist/packages/filesystem/src/state.js';

const temporary = await mkdtemp(path.join(tmpdir(), 'afo-review-'));
const result = {};
try {
  await mkdir(path.join(temporary, 'root'));
  const root = await realpath(path.join(temporary, 'root'));
  const state = path.join(temporary, 'state');
  const first = await issueRootGrant(root);
  const second = await issueRootGrant(root);
  const childCode = `
    const { issueRootGrant } = await import(${JSON.stringify(new URL('../dist/packages/filesystem/src/grants.js', import.meta.url).href)});
    const { withRootLock } = await import(${JSON.stringify(new URL('../dist/packages/filesystem/src/lock.js', import.meta.url).href)});
    const grant = await issueRootGrant(process.argv[1]);
    await withRootLock(process.argv[2], grant.id, async () => console.log(JSON.stringify({ entered: true, grant: grant.id })));
  `;
  result.lock = await withRootLock(state, first.id, async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, root, state], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    return { sameCanonicalPath: first.canonicalPath === second.canonicalPath, grantsDiffer: first.id !== second.id,
      childExitCode: code, childWhileParentHeldLock: stdout.trim(), stderr };
  });
  const source = path.join(root, 'a.txt');
  await writeFile(source, 'original');
  const before = await lstat(source, { bigint: true });
  const expected = { size: Number(before.size), modifiedNs: String(before.mtimeNs), device: String(before.dev),
    inode: String(before.ino), sha256: createHash('sha256').update('original').digest('hex') };
  const op = { id: '12345678', kind: 'trash', fileId: 'a'.repeat(64), source: 'a.txt', destination: null,
    reason: 'synthetic review', ruleId: null, keeper: null, expected };
  const plan = { formatVersion: 1, id: 'b'.repeat(64), rootGrantId: first.id, rootPath: root,
    sessionId: first.sessionId, createdAt: '2026-10-26T01:00:00.000Z', expiresAt: '2026-10-26T01:10:00.000Z',
    profileId: null, profileRevision: null, deleteMode: 'trash', operations: [op], reviewItems: [],
    summary: { move: 0, trash: 1, delete: 0, logicalBytes: expected.size } };
  await appendJournal(journalFile(state, 'run-00000001'), { formatVersion: 1, runId: 'run-00000001', seq: 0,
    opId: op.id, planId: plan.id, rootGrantId: first.id, approvalId: 'approval-0001', phase: 'intent', kind: 'trash',
    source: op.source, destination: null, before: { device: expected.device, inode: expected.inode, size: expected.size,
      sha256: expected.sha256 }, after: null, errorCode: null, at: '2026-10-26T01:01:00.000Z' });
  await writeFile(source, 'changed content with a different size');
  const after = await lstat(source, { bigint: true });
  const [run] = await inspectRuns(state, { loadPlan: async () => ({ plan, grant: first }) });
  result.recovery = { sameInode: before.ino === after.ino, oldSize: Number(before.size), newSize: Number(after.size),
    reported: run.unfinished[0] };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
