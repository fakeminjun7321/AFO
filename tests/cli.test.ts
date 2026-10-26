import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PreviewSchema, ProfileSchema } from '../packages/contracts/src/index.js';
import { run } from '../apps/cli/src/index.js';
import { fixture, manifest } from './helpers.js';

const cli = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
const invoke = (...args: string[]): ReturnType<typeof spawnSync> =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 });

test('real CLI process suggests, confirms and reloads rules without changing source files', async (t) => {
  const root = await fixture(t, {
    'incoming/물리_새보고서.pdf': 'new file', 'reference/과제/물리/물리_1.pdf': 'reference 1',
    'reference/과제/물리/물리_2.pdf': 'reference 2',
  });
  const source = path.join(root, 'incoming'); const reference = path.join(root, 'reference');
  const pristine = await manifest(root);
  const suggested = invoke('suggest-rules', reference);
  assert.equal(suggested.status, 0, String(suggested.stderr));
  const draft = ProfileSchema.parse(JSON.parse(String(suggested.stdout)));
  assert.equal(draft.status, 'draft'); assert.equal(draft.rules.length, 1);
  assert.deepEqual(await manifest(root), pristine);
  // Explicit save simulates the user's JSON export, not automatic application persistence.
  const draftFile = path.join(root, 'draft.afo-profile.json');
  await writeFile(draftFile, JSON.stringify(draft));
  const confirmed = invoke('confirm-rules', draftFile, '--select', draft.rules[0]!.id);
  assert.equal(confirmed.status, 0, String(confirmed.stderr));
  const profile = ProfileSchema.parse(JSON.parse(String(confirmed.stdout)));
  const profileFile = path.join(root, 'confirmed.afo-profile.json');
  await writeFile(profileFile, JSON.stringify(profile));
  const before = await manifest(root);
  const output = invoke('preview', source, '--profile', profileFile, '--json');
  assert.equal(output.status, 0, String(output.stderr));
  const parsed = JSON.parse(String(output.stdout)) as { preview: unknown };
  const preview = PreviewSchema.parse(parsed.preview);
  assert.equal(preview.items[0]!.destination, '과제/물리/물리_새보고서.pdf');
  assert.equal(preview.executionAvailable, false);
  const restarted = invoke('preview', source, '--profile', profileFile, '--json');
  assert.equal(restarted.status, 0, String(restarted.stderr));
  assert.deepEqual(JSON.parse(String(restarted.stdout)), JSON.parse(String(output.stdout)));
  assert.deepEqual(await manifest(root), before);
});
test('CLI default output clearly identifies recommendations rather than executed operations', async (t) => {
  const root = await fixture(t, { 'a.pdf': 'data' }); const before = await manifest(root);
  const output = invoke('preview', root);
  assert.equal(output.status, 0);
  assert.match(String(output.stdout), /이동 제안/u);
  assert.match(String(output.stdout), /실제 파일은 변경하지 않았습니다/u);
  assert.match(String(output.stdout), /실행 기능: 미구현/u);
  assert.deepEqual(await manifest(root), before);
});
test('unknown commands and flags fail instead of enabling execution', async (t) => {
  const root = await fixture(t, { 'a.pdf': 'x' }); const before = await manifest(root);
  assert.notEqual(invoke('delete', root).status, 0);
  assert.notEqual(invoke('preview', root, '--execute').status, 0);
  await assert.rejects(run(['preview']));
  await assert.rejects(run(['confirm-rules', root]));
  assert.deepEqual(await manifest(root), before);
});
test('corrupt profiles and directory inputs are rejected', async (t) => {
  const root = await fixture(t, { 'bad.afo-profile.json': '{ "status": "confirmed" }', 'a.pdf': 'x' });
  const before = await manifest(root);
  assert.notEqual(invoke('preview', root, '--profile', path.join(root, 'bad.afo-profile.json')).status, 0);
  assert.notEqual(invoke('preview', root, '--profile', root).status, 0);
  assert.deepEqual(await manifest(root), before);
});
test('help needs no implicit filesystem target', async () => {
  assert.match(await run([]), /읽기 전용/u);
  assert.match(await run(['--help']), /이동·삭제·자동 저장은 수행하지 않습니다/u);
});
