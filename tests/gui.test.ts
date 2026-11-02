import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { OperationPlanSchema, PreviewSchema } from '../packages/contracts/src/index.js';
import { approvalCode } from '../packages/engine/src/index.js';
import { loadSavedPlan } from '../packages/filesystem/src/approvals.js';
import { appJs } from '../apps/cli/src/gui-assets.js';
import { createFixture, manifest } from './helpers.js';
import type { FixtureSpec, Manifest } from './helpers.js';

/*
 * #9 local GUI: a real `gui` child process on 127.0.0.1, synthetic folders, AFO_STATE_DIR in the same temp fixture.
 * File results of /api/apply and /api/undo are checked with the independent manifest oracle (paths, sha256), not with the API reply.
 */
const cli = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

const defaultSpec = (): FixtureSpec => ({
  'work/report.pdf': 'same-pdf', 'work/report copy.pdf': 'same-pdf', 'work/사진.jpg': 'jpg', 'work/clip.mp4': 'video',
  'work/notes': 'no extension', 'state/': '',
  // Markup in a file name must reach the page as data. Windows forbids < > in names, so that case runs elsewhere only.
  ...(process.platform === 'win32' ? {} : { 'work/<img src=x onerror=alert(1)>.txt': 'odd name' }),
});

async function startGui(t: TestContext, opts: { spec?: FixtureSpec; args?: string[]; env?: Record<string, string> } = {}) {
  const { root: base } = await createFixture(opts.spec ?? defaultSpec(), t);
  const dirs = { work: path.join(base, 'work'), state: path.join(base, 'state') };
  const child = spawn(process.execPath, [cli, 'gui', dirs.work, '--no-open', ...(opts.args ?? [])],
    { env: { ...process.env, AFO_STATE_DIR: dirs.state, ...opts.env } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gui did not start: ${stderr}`)), 15_000);
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
      const m = /AFO GUI: (http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{48})/u.exec(stderr);
      if (m) { clearTimeout(timer); resolve(m[1]!); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`gui exited ${code}: ${stderr}`)); });
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const origin = url.slice(0, url.indexOf('/#'));
  const token = url.slice(url.indexOf('token=') + 6);
  const host = origin.slice('http://'.length);
  const call = (method: string, route: string, opts: { body?: unknown; headers?: Record<string, string>; raw?: string } = {}): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const data = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
      const req = request(`${origin}${route}`, { method, headers: { 'x-afo-token': token,
        ...(data !== undefined && opts.raw === undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers } }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end(data);
    });
  const json = async (method: string, route: string, body?: unknown): Promise<any> => {
    const r = await call(method, route, body === undefined ? {} : { body });
    assert.equal(r.status, 200, r.body);
    return JSON.parse(r.body);
  };
  const runCli = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, AFO_STATE_DIR: dirs.state } });
  return { dirs, child, url, host, token, call, json, runCli, out: () => stdout };
}

test('gui: page and assets carry a strict CSP; the client never uses innerHTML for data', async (t) => {
  const { call, url } = await startGui(t);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/#token=/u, 'loopback only, token in the fragment');
  for (const [route, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/app.css', 'text/css']] as const) {
    const r = await call('GET', route, { headers: { 'x-afo-token': '' } });
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), new RegExp(`^${type}`, 'u'));
    assert.match(String(r.headers['content-security-policy']), /default-src 'none'; script-src 'self'/u);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
  assert.equal((await call('GET', '/../../etc/passwd')).status, 404);
  assert.doesNotMatch(appJs, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/u);
});

test('gui: API refuses missing/wrong token, foreign Host or Origin, non-JSON and relative folders', async (t) => {
  const { call, host, dirs } = await startGui(t);
  assert.equal((await call('GET', '/api/info', { headers: { 'x-afo-token': '' } })).status, 403);
  assert.equal((await call('GET', '/api/info', { headers: { 'x-afo-token': 'f'.repeat(48) } })).status, 403);
  assert.equal((await call('GET', '/api/info', { headers: { host: 'evil.example:80' } })).status, 403, 'DNS rebinding Host');
  assert.equal((await call('GET', '/', { headers: { host: 'evil.example' } })).status, 403, 'page also checks Host');
  assert.equal((await call('GET', '/api/info', { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await call('GET', '/api/info', { headers: { origin: `http://${host}` } })).status, 200);
  assert.equal((await call('POST', '/api/preview', { raw: JSON.stringify({ folder: dirs.work }), headers: { 'content-type': 'text/plain' } })).status, 415);
  const relative = await call('POST', '/api/preview', { body: { folder: 'work' } });
  assert.equal(relative.status, 400);
  assert.equal((await call('POST', '/api/preview', { body: { folder: dirs.work, extra: true } })).status, 400, 'strict request schema');
  for (const route of ['/api/execute', '/api/delete']) assert.equal((await call('POST', route, { body: {} })).status, 404);
  assert.equal((await call('GET', '/api/apply')).status, 404, 'apply is POST only');
});

test('gui: preview matches CLI preview --json and changes nothing; plan is saved exactly as returned', async (t) => {
  const { json, runCli, dirs } = await startGui(t);
  const work = await manifest(dirs.work); const state = await manifest(dirs.state);
  const info = await json('GET', '/api/info');
  assert.equal(info.initialFolder, dirs.work);
  assert.deepEqual(info.executes, ['organize', 'trash'], 'no permanent-delete from the page');

  const fromGui = await json('POST', '/api/preview', { folder: dirs.work });
  const fromCli = JSON.parse(runCli(['preview', dirs.work, '--json']).stdout) as { preview: unknown };
  const strip = (p: ReturnType<typeof PreviewSchema.parse>) => p.items.map((i) => [i.source, i.action, i.destination, i.reason]).sort();
  assert.deepEqual(strip(PreviewSchema.parse(fromGui.preview)), strip(PreviewSchema.parse(fromCli.preview)));
  // The scanner skips names other OSes cannot hold (UNSUPPORTED_NAME); the page still lists them, as text, under 제외·오류.
  if (process.platform !== 'win32') assert.ok(fromGui.preview.skipped.some((s: { relativePath: string }) => s.relativePath.startsWith('<img')), 'odd names arrive as data');
  assert.deepEqual(await manifest(dirs.work), work, 'preview does not touch the work folder');
  assert.deepEqual(await manifest(dirs.state), state, 'preview does not write the state folder');

  const planned = await json('POST', '/api/plan', { folder: dirs.work, deleteDuplicates: 'all' });
  const plan = OperationPlanSchema.parse(planned.plan);
  assert.equal(planned.planId, plan.id);
  const saved = await loadSavedPlan(dirs.state, plan.id);
  assert.ok(saved);
  assert.deepEqual(saved.plan, plan);
  assert.ok(plan.operations.some((op) => op.kind === 'trash' && op.keeper !== null), 'duplicate candidate with its keeper');
  for (const c of planned.approvalChoices) assert.equal(c.code, approvalCode(plan.id, c.operationIds, c.mode));
  assert.deepEqual(await manifest(dirs.work), work, 'plan does not touch the work folder');
});

test('gui: rules, runs and recover read the same state the CLI writes', async (t) => {
  const { json, call, runCli, dirs } = await startGui(t);
  assert.deepEqual(await json('GET', '/api/rules'), { state: 'none' });
  assert.deepEqual(await json('GET', '/api/runs'), { runs: [] });
  assert.deepEqual(await json('GET', '/api/recover'), { checked: 0, runs: [] });

  // Plan in the GUI, execute in the CLI, then read the run back in the GUI.
  const planned = await json('POST', '/api/plan', { folder: dirs.work });
  const organize = planned.approvalChoices.find((c: { mode: string }) => c.mode === 'organize');
  assert.ok(organize);
  const applied = runCli(['apply', planned.planId, '--mode', 'organize', '--confirm', organize.code, '--json']);
  assert.equal(applied.status, 0, applied.stderr);
  const { runId } = JSON.parse(applied.stdout) as { runId: string };

  const runs = await json('GET', '/api/runs');
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0].runId, runId);
  assert.equal(runs.runs[0].undoable, true);
  const detail = await json('GET', `/api/runs/${runId}`);
  assert.equal(detail.run.runId, runId);
  assert.ok(detail.operations.some((op: { source: string; destination: string }) => op.source === 'clip.mp4' && op.destination === '영상/clip.mp4'));
  assert.equal((await call('GET', '/api/runs/not-an-id!')).status, 400);
  assert.equal((await call('GET', `/api/runs/${'0'.repeat(32)}`)).status, 404);
  const recover = await json('GET', '/api/recover');
  assert.equal(recover.checked, 1);
  assert.deepEqual(recover.runs, []);
});

test('gui: Ctrl+C stops the server with exit 0', { skip: process.platform === 'win32' ? 'SIGINT cannot be sent to a child on Windows' : false }, async (t) => {
  const { child, out } = await startGui(t);
  const exited = new Promise<number | null>((resolve) => { (child as ChildProcess).once('exit', (code) => resolve(code)); });
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.match(out(), /AFO GUI를 종료했습니다/u);
});

test('gui: usage errors exit 2 without starting a server', () => {
  for (const args of [['gui', 'a', 'b'], ['gui', '--port', '80'], ['gui', '--port', 'x'], ['gui', '--json']]) {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /AFO GUI:/u);
  }
});

type Choice = { mode: string; operationIds: string[]; code: string };
const runFiles = async (state: string): Promise<string[]> => Object.keys(await manifest(state)).filter((k) => /^runs\/.+\.json$/u.test(k));
/** Every move of the plan landed at its destination with the same bytes, and its source is gone; everything else is unchanged. */
function assertMoved(before: Manifest, after: Manifest, moves: { source: string; destination: string }[]): void {
  for (const m of moves) {
    const was = before[m.source]; const now = after[m.destination];
    assert.ok(was?.type === 'file' && now?.type === 'file', `${m.source} → ${m.destination}`);
    assert.equal(now.sha256, was.sha256, `hash preserved for ${m.destination}`);
    assert.equal(after[m.source], undefined, `${m.source} left its old place`);
  }
  const touched = new Set(moves.flatMap((m) => [m.source, m.destination]));
  for (const [name, entry] of Object.entries(before)) if (!touched.has(name)) assert.deepEqual(after[name], entry, `${name} unchanged`);
}

test('gui: apply organize via API really moves files (hashes kept), a replay is refused, undo via API restores', async (t) => {
  const { json, call, dirs } = await startGui(t);
  const planned = await json('POST', '/api/plan', { folder: dirs.work, deleteDuplicates: 'all' });
  const plan = OperationPlanSchema.parse(planned.plan);
  const moves = plan.operations.filter((op) => op.kind === 'move').map((op) => ({ source: op.source, destination: op.destination! }));
  assert.ok(moves.length >= 2);
  const before = await manifest(dirs.work);

  const applied = await json('POST', '/api/apply', { planId: plan.id, mode: 'organize' });
  assert.equal(applied.exitCode, 0);
  assert.equal(applied.report.results.length, moves.length);
  assert.ok(applied.report.results.every((r: { status: string }) => r.status === 'moved'));
  const after = await manifest(dirs.work);
  assertMoved(before, after, moves);
  assert.ok(after['report.pdf'] && after['report copy.pdf'], 'organize does not touch the trash candidates');

  const replay = await call('POST', '/api/apply', { body: { planId: plan.id, mode: 'organize' } });
  assert.equal(replay.status, 422, replay.body);
  assert.equal(JSON.parse(replay.body).error.code, 'APPROVAL_USED');
  assert.deepEqual(await manifest(dirs.work), after, 'replay changed nothing');

  const runs = await json('GET', '/api/runs');
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0].undoable, true);
  const undone = await json('POST', '/api/undo', { runId: applied.runId });
  assert.equal(undone.exitCode, 0);
  assert.ok(undone.report.results.every((r: { status: string }) => r.status === 'moved'));
  assert.deepEqual(await manifest(dirs.work), before, 'every file back at its old path with the same bytes and mtime; created folders removed');
  const again = await json('POST', '/api/undo', { runId: applied.runId });
  assert.equal(again.report, null, 'nothing left to undo');
  assert.deepEqual(await manifest(dirs.work), before);
});

test('gui: apply refuses permanent-delete, missing/wrong token, foreign Origin and unknown fields with nothing changed', async (t) => {
  const { json, call, dirs } = await startGui(t);
  const planned = await json('POST', '/api/plan', { folder: dirs.work, deleteMode: 'permanent', deleteDuplicates: 'all' });
  assert.ok(planned.approvalChoices.some((c: Choice) => c.mode === 'permanent-delete'), 'the plan does contain a permanent delete');
  const work = await manifest(dirs.work);
  const body = { planId: planned.planId, mode: 'organize' };
  const refused: [string, Parameters<typeof call>[2], number][] = [
    ['permanent-delete', { body: { planId: planned.planId, mode: 'permanent-delete' } }, 400],
    ['no token', { body, headers: { 'x-afo-token': '' } }, 403],
    ['wrong token', { body, headers: { 'x-afo-token': 'f'.repeat(48) } }, 403],
    ['foreign Origin', { body, headers: { origin: 'http://evil.example' } }, 403],
    ['unknown field', { body: { ...body, confirm: 'deadbeef' } }, 400],
    ['missing mode', { body: { planId: planned.planId } }, 400],
    ['not JSON', { raw: JSON.stringify(body), headers: { 'content-type': 'text/plain' } }, 415],
  ];
  for (const [label, opts, status] of refused) assert.equal((await call('POST', '/api/apply', opts)).status, status, label);
  for (const [label, opts, status] of [['no token', { body: { runId: '0'.repeat(32) }, headers: { 'x-afo-token': '' } }, 403],
    ['unknown field', { body: { runId: '0'.repeat(32), confirm: '00000000' } }, 400]] as const)
    assert.equal((await call('POST', '/api/undo', opts)).status, status, `undo ${label}`);
  assert.match((await call('POST', '/api/apply', refused[0]![1])).body, /영구 삭제는 화면에서 실행하지 않아요/u);
  assert.deepEqual(await manifest(dirs.work), work, 'nothing moved or deleted');
  assert.deepEqual(await runFiles(dirs.state), [], 'no run was started');
  assert.equal(Object.keys(await manifest(dirs.state)).filter((k) => k.startsWith('approvals/') && k !== 'approvals').length, 0, 'no approval issued');
  assert.equal((await call('POST', '/api/apply', { body: { planId: 'a'.repeat(64), mode: 'organize' } })).status, 422, 'unknown plan');
  assert.equal((await call('POST', '/api/undo', { body: { runId: '0'.repeat(32) } })).status, 400, 'unknown run (CLI exit 1)');
});

test('gui: trash via API sends one synthetic afo-test- duplicate to the real OS trash (AFO_REAL_TRASH_TEST=1 only)', {
  skip: process.env.AFO_REAL_TRASH_TEST === '1' ? false : 'set AFO_REAL_TRASH_TEST=1 to send one synthetic file to the real OS trash',
}, async (t) => {
  const name = `afo-test-gui-${process.pid}-${Date.now()}`;
  const { json, call, dirs } = await startGui(t, { spec: { 'work/other.txt': 'unrelated', [`work/${name}.txt`]: `only for the AFO gui trash test ${name}`,
    [`work/${name} copy.txt`]: `only for the AFO gui trash test ${name}`, 'state/': '' } });
  const planned = await json('POST', '/api/plan', { folder: dirs.work, deleteDuplicates: 'all' });
  const trash = OperationPlanSchema.parse(planned.plan).operations.filter((op) => op.kind === 'trash');
  assert.deepEqual(trash.map((op) => [op.source, op.keeper]), [[`${name} copy.txt`, `${name}.txt`]], 'exactly the one synthetic copy, keeper named');
  const before = await manifest(dirs.work);
  const applied = await json('POST', '/api/apply', { planId: planned.planId, mode: 'trash' });
  assert.deepEqual(applied.report.results.map((r: { status: string }) => r.status), ['trashed']);
  const after = await manifest(dirs.work);
  assert.equal(after[`${name} copy.txt`], undefined);
  assert.deepEqual(after[`${name}.txt`], before[`${name}.txt`], 'keeper unchanged');
  assert.deepEqual(after['other.txt'], before['other.txt']);
  const undo = await call('POST', '/api/undo', { body: { runId: applied.runId } });
  assert.equal(undo.status, 400, 'trash runs are not undone by AFO');
  assert.match(undo.body, /휴지통 이동·영구 삭제는 되돌리지 않습니다/u);
  t.diagnostic(`trashed synthetic ${name} copy.txt; this test never empties or reads the trash`);
});

test('gui --exit-when-closed: exits 0 without a page load, stays while pinged or a presence stream is open, exits after it closes', async (t) => {
  const env = { AFO_GUI_FIRST_LOAD_MS: '600', AFO_GUI_IDLE_MS: '600' };
  const exitOf = (child: ChildProcess) => new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode); else child.once('exit', (code) => resolve(code));
  });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const [never, plain, pinged] = await Promise.all([startGui(t, { args: ['--exit-when-closed'], env }), startGui(t, { env }),
    startGui(t, { args: ['--exit-when-closed'], env })]);
  await pinged.json('GET', '/api/info');
  for (let i = 0; i < 6; i += 1) { await sleep(250); await pinged.json('POST', '/api/ping', {}); }
  assert.equal(pinged.child.exitCode, null, 'alive while heartbeats arrive');
  assert.equal(await exitOf(never.child), 0, 'no page within the first-load window');
  assert.match(never.out(), /저절로 끝냄/u);
  assert.equal(plain.child.exitCode, null, 'without the option the GUI keeps running');
  assert.equal((await pinged.call('POST', '/api/ping', { body: { extra: 1 } })).status, 400, 'ping body is strict');
  assert.equal((await pinged.call('POST', '/api/ping', { body: {}, headers: { 'x-afo-token': '' } })).status, 403, 'ping needs the token');
  const held = request(`${pinged.url.slice(0, pinged.url.indexOf('/#'))}/api/presence`, { headers: { 'x-afo-token': pinged.token } });
  const opened = new Promise<number>((resolve) => { held.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); }); });
  held.on('error', () => {});
  held.end();
  assert.equal(await opened, 200);
  await sleep(1_000);
  assert.equal(pinged.child.exitCode, null, 'alive while the page holds the presence stream (no pings)');
  held.destroy();
  assert.equal(await exitOf(pinged.child), 0, 'exits after the page is gone');
  assert.match(pinged.out(), /AFO GUI를 종료했습니다\(화면이 닫혀 있어 저절로 끝냄\)/u);
});
