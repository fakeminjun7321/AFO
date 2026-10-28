import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, lstat, readFile, rename, unlink, utimes, writeFile } from 'node:fs/promises';
import { AfoError } from '../packages/contracts/src/index.js';
import type { PlanOperation } from '../packages/contracts/src/index.js';
import { approvalChoices, approvalCode, buildPlan, buildPreview } from '../packages/engine/src/index.js';
import { hashCandidates, scanRoot } from '../packages/filesystem/src/index.js';
import { consumeApproval, issueApproval, savePlan } from '../packages/filesystem/src/approvals.js';
import { executeBatch } from '../packages/filesystem/src/executor.js';
import { F, abs, journal, phases, setup, sha } from './executor-helpers.js';

/*
 * #8 O-1: consumeApproval does not re-stat files, so the executor's own re-check right before each OS call is the only guard.
 * Real #8 path: scan → preview → buildPlan → savePlan → issueApproval → consumeApproval, THEN the files change, then executeBatch.
 * Synthetic mkdtemp(os.tmpdir()) root and a separate temp state folder; organize mode only (real same-volume moves, no OS trash).
 */
const when = new Date('2026-01-02T03:04:05Z'); // whole seconds, so utimes restores mtimeNs exactly

test('#8 O-1: files changed after consumeApproval fail FILE_CHANGED / SOURCE_MISSING and stay as they are; the rest move', async (t) => {
  const env = await setup(t, {
    [`${F}grow.pdf`]: 'grow-content-01',                      // ① content appended → size differs
    [`${F}same1.pdf`]: { data: 'SAME-SIZE-A', modified: when }, // ② same size, other content, mtime restored (needs sha256)
    [`${F}same2.pdf`]: { data: 'SAME-SIZE-B', modified: when }, //    same size as same1, so both are hashed; unchanged
    [`${F}swap.pdf`]: { data: 'swap-me-please', modified: when }, // ③ replaced by a new file of the same name (new inode)
    [`${F}gone.pdf`]: 'gone-soon',                             //    deleted
    [`${F}ok.jpg`]: 'picture',                                 //    unchanged
  });
  const scan = await hashCandidates(env.grant, await scanRoot(env.grant));
  const plan = buildPlan(buildPreview(scan), { scan, grant: env.grant, sessionId: env.grant.sessionId, deleteMode: 'trash', now: new Date() });
  const bySource = new Map(plan.operations.map((op) => [op.source, op]));
  const opOf = (name: string): PlanOperation => {
    const op = bySource.get(`${F}${name}`);
    assert.ok(op && op.kind === 'move' && op.destination !== null, `${name} is a planned move`);
    return op;
  };
  const [grow, same1, same2, swap, gone, ok] = ['grow.pdf', 'same1.pdf', 'same2.pdf', 'swap.pdf', 'gone.pdf', 'ok.jpg'].map(opOf);
  assert.deepEqual(plan.summary, { move: 6, trash: 0, delete: 0, logicalBytes: plan.summary.logicalBytes });
  assert.notEqual(same1!.expected.sha256, null, 'the same-size pair carries a content hash');

  await savePlan(env.stateDir, plan, env.grant);
  const ids = approvalChoices(plan).find((c) => c.mode === 'organize')!.operationIds;
  const approval = await issueApproval(env.stateDir, { planId: plan.id, operationIds: ids, mode: 'organize',
    confirmation: approvalCode(plan.id, ids, 'organize') });
  const batch = await consumeApproval(env.stateDir, approval.id);
  assert.notEqual(batch.grant.id, env.grant.id, 'consumeApproval re-issued the grant for this process');
  assert.equal(batch.grant.sessionId, plan.sessionId);

  // The files change only now, after the approval was consumed.
  await appendFile(abs(env, grow!.source), '+more');
  await writeFile(abs(env, same1!.source), 'SAME-SIZE-Z');
  await utimes(abs(env, same1!.source), when, when);
  const s1 = await lstat(abs(env, same1!.source), { bigint: true });
  assert.deepEqual([String(s1.size), String(s1.mtimeNs), String(s1.ino)],
    [String(same1!.expected.size), same1!.expected.modifiedNs, same1!.expected.inode], 'only the content differs');
  await writeFile(abs(env, `${F}swap.new`), 'swap-me-please'); // created while the old one exists → necessarily a new inode
  await utimes(abs(env, `${F}swap.new`), when, when);
  await unlink(abs(env, swap!.source));
  await rename(abs(env, `${F}swap.new`), abs(env, swap!.source));
  const sw = await lstat(abs(env, swap!.source), { bigint: true });
  assert.notEqual(String(sw.ino), swap!.expected.inode);
  assert.deepEqual([String(sw.size), String(sw.mtimeNs)], [String(swap!.expected.size), swap!.expected.modifiedNs], 'only the inode differs');
  await unlink(abs(env, gone!.source));
  const changed = { grow: await sha(abs(env, grow!.source)), same1: await sha(abs(env, same1!.source)), swap: await sha(abs(env, swap!.source)) };
  const kept = { same2: await sha(abs(env, same2!.source)), ok: await sha(abs(env, ok!.source)) };

  const report = await executeBatch(batch);
  const result = new Map(report.results.map((r) => [r.opId, r]));
  const status = (op: PlanOperation | undefined): [string, string | null] => [result.get(op!.id)!.status, result.get(op!.id)!.errorCode];
  assert.deepEqual(status(grow), ['failed', 'FILE_CHANGED']);
  assert.deepEqual(status(same1), ['failed', 'FILE_CHANGED']);
  assert.match(result.get(same1!.id)!.detail, /내용이 바뀌었습니다/u, 'caught by the sha256 re-hash, not by size or mtime');
  assert.deepEqual(status(swap), ['failed', 'FILE_CHANGED']);
  assert.deepEqual(status(gone), ['failed', 'SOURCE_MISSING']);
  assert.deepEqual(status(same2), ['moved', null]);
  assert.deepEqual(status(ok), ['moved', null]);

  // Changed files are exactly as the user left them, at their original paths; nothing was created at their destinations.
  assert.equal(await sha(abs(env, grow!.source)), changed.grow);
  assert.equal(await sha(abs(env, same1!.source)), changed.same1);
  assert.equal(await sha(abs(env, swap!.source)), changed.swap);
  assert.equal(String((await lstat(abs(env, swap!.source), { bigint: true })).ino), String(sw.ino));
  for (const op of [grow, same1, swap, gone]) assert.equal(await lstat(abs(env, op!.destination!)).catch(() => null), null, op!.source);
  assert.equal(await lstat(abs(env, gone!.source)).catch(() => null), null);
  // Unchanged files moved with their content.
  assert.equal(await sha(abs(env, same2!.destination!)), kept.same2);
  assert.equal(await sha(abs(env, ok!.destination!)), kept.ok);
  assert.equal(await readFile(abs(env, ok!.destination!), 'utf8'), 'picture');

  const expectedPhases = batch.operations.flatMap((op) => {
    const r = result.get(op.id)!;
    return [`${op.id}:intent`, r.status === 'moved' ? `${op.id}:done` : `${op.id}:failed:${r.errorCode}`];
  });
  assert.deepEqual(phases(await journal(env, report.runId)), expectedPhases);
  await assert.rejects(consumeApproval(env.stateDir, approval.id), (e: unknown) => e instanceof AfoError && e.code === 'APPROVAL_USED');
  await assert.rejects(executeBatch(batch), (e: unknown) => e instanceof AfoError && e.code === 'APPROVAL_USED');
});
