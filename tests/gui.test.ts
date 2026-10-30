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

/* #9 local GUI: a real `gui` child process on 127.0.0.1, synthetic folders, AFO_STATE_DIR in the same temp fixture. */
const cli = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

async function startGui(t: TestContext) {
  const { root: base } = await createFixture({
    'work/report.pdf': 'same-pdf', 'work/report copy.pdf': 'same-pdf', 'work/사진.jpg': 'jpg', 'work/clip.mp4': 'video',
    'work/notes': 'no extension', 'state/': '',
    // Markup in a file name must reach the page as data. Windows forbids < > in names, so that case runs elsewhere only.
    ...(process.platform === 'win32' ? {} : { 'work/<img src=x onerror=alert(1)>.txt': 'odd name' }),
  }, t);
  const dirs = { work: path.join(base, 'work'), state: path.join(base, 'state') };
  const child = spawn(process.execPath, [cli, 'gui', dirs.work, '--no-open'], { env: { ...process.env, AFO_STATE_DIR: dirs.state } });
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

test('gui: API refuses missing/wrong token, foreign Host or Origin, non-JSON and relative folders; there is no execute endpoint', async (t) => {
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
  for (const route of ['/api/apply', '/api/undo', '/api/execute']) assert.equal((await call('POST', route, { body: {} })).status, 404);
});

test('gui: preview matches CLI preview --json and changes nothing; plan is saved exactly as returned', async (t) => {
  const { json, runCli, dirs } = await startGui(t);
  const work = await manifest(dirs.work); const state = await manifest(dirs.state);
  const info = await json('GET', '/api/info');
  assert.equal(info.initialFolder, dirs.work);
  assert.equal(info.executes, false);

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

  // Plan in the GUI, execute in the CLI (the only writer), then read the run back in the GUI.
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
