import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { confirmProfile } from '../../../packages/engine/src/index.js';
import { analyzeRoot, issueReferenceGrant, issueRootGrant } from '../../../packages/filesystem/src/index.js';
import { createFixture, createManifest, diffManifest, sameManifest } from '../../../tests/fixtures/index.js';
import { startServer } from '../src/server.js';
import type { RunningServer } from '../src/server.js';
import type { FolderKind } from '../src/os.js';

/*
 * Real HTTP against the real server on 127.0.0.1 (in-process, OS-chosen port). Synthetic mkdtemp fixtures only.
 * The native folder dialog is NOT exercised here: the picker is an injected stub.
 */
const ADR_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: () => any }
function send(server: RunningServer, options: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer; chunked?: boolean }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.body !== undefined && !options.chunked && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length'))
      headers['Content-Length'] = String(Buffer.byteLength(options.body));
    const req = request({ host: '127.0.0.1', port: server.port, method: options.method ?? 'GET', path: options.path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      // The server closes the socket after rejecting an oversized body; that can surface as a reset.
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') resolve({ status: -1, headers: {}, text: '', json: () => null });
      else reject(error);
    });
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
const apiHeaders = (server: RunningServer, extra: Record<string, string> = {}): Record<string, string> =>
  ({ 'Content-Type': 'application/json', 'X-AFO-Token': server.token, ...extra });
async function api(server: RunningServer, channel: string, body: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const reply = await send(server, { method: 'POST', path: `/api/${channel}`, headers: apiHeaders(server, extra), body: JSON.stringify(body) });
  return { status: reply.status, body: reply.json() };
}
const ok = (reply: { status: number; body: any }): any => {
  assert.equal(reply.status, 200, JSON.stringify(reply.body)); assert.equal(reply.body.ok, true); return reply.body.data;
};
const refused = (reply: { status: number; body: any }, code: string): void => {
  assert.equal(reply.body?.ok, false, JSON.stringify(reply.body)); assert.equal(reply.body.error.code, code, JSON.stringify(reply.body));
  assert.equal(typeof reply.body.error.message, 'string');
  assert.doesNotMatch(JSON.stringify(reply.body), /\bat .+:\d+:\d+|stack/u); // no stack traces
};
async function waitJob(server: RunningServer, jobId: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const status = ok(await api(server, 'job', { jobId }));
    if (status.state !== 'running') return status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job did not finish');
}
const select = (server: RunningServer, kind: FolderKind, folder: string): Promise<{ status: number; body: any }> =>
  api(server, 'select-folder', { kind, path: folder });

let picks: Array<string | null | Error> = [];
let server: RunningServer;
before(async () => {
  server = await startServer({ picker: async () => {
    const next = picks.shift();
    if (next instanceof Error) throw next;
    return next ?? null;
  } });
});
after(() => server.close());

test('binds 127.0.0.1 on an OS-chosen port and builds the token URL', () => {
  assert.ok(server.port > 0);
  assert.equal(server.origin, `http://127.0.0.1:${server.port}`);
  assert.match(server.token, /^[A-Za-z0-9_-]{43}$/u); // 256 bits base64url
  assert.equal(server.url, `http://127.0.0.1:${server.port}/#t=${server.token}`);
});

test('static files carry the ADR security headers and no CORS headers', async () => {
  for (const [route, type] of [['/', 'text/html'], ['/index.html', 'text/html'], ['/app.js', 'text/javascript'], ['/state.js', 'text/javascript'],
    ['/style.css', 'text/css']] as const) {
    const reply = await send(server, { path: route });
    assert.equal(reply.status, 200, route);
    assert.ok(String(reply.headers['content-type']).startsWith(type), route);
    assert.equal(reply.headers['content-security-policy'], ADR_CSP);
    assert.equal(reply.headers['x-content-type-options'], 'nosniff');
    assert.equal(reply.headers['referrer-policy'], 'no-referrer');
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.match(String(reply.headers['content-security-policy']), /frame-ancestors 'none'/u);
    assert.equal(Object.keys(reply.headers).some((h) => h.startsWith('access-control-')), false);
  }
  const html = (await send(server, { path: '/' })).text;
  assert.match(html, /읽기 전용:<\/strong> 파일을 이동·삭제하지 않습니다/u);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/u); // no inline script (CSP forbids it anyway)
  assert.doesNotMatch(html, /<button[^>]*>[^<]*실행/u); // no "실행" button in the read-only step
  assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/u); // no inline styles or handlers (CSP would block them)
  for (const script of ['/app.js', '/state.js'])
    assert.doesNotMatch((await send(server, { path: script })).text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/u);
  // Enter in a path field submits: each path input sits in a form with a submit button (handled in script, never sent).
  for (const kind of ['work', 'ref'])
    assert.match(html, new RegExp(`<form[^>]*id="${kind}-form"[\\s\\S]*?id="${kind}-path"[\\s\\S]*?type="submit"[^>]*id="${kind}-use"[\\s\\S]*?</form>`, 'u'));
  // API errors carry the same headers and also no CORS.
  const apiReply = await send(server, { method: 'POST', path: '/api/job', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(apiReply.headers['content-security-policy'], ADR_CSP);
  assert.equal(Object.keys(apiReply.headers).some((h) => h.startsWith('access-control-')), false);
});

test('static paths outside the allowlist are 404, including encoded traversal', async () => {
  for (const route of ['/../package.json', '/%2e%2e/package.json', '/%2E%2E%2Fpackage.json', '/app.js/..', '/app.js/../package.json',
    '/public/app.js', '/package.json', '//etc/passwd', '/app.js%00', '/APP.JS', '/index.html/', '/./app.js', '/..%2fpackage.json',
    '/dist/apps/desktop/src/server.js', '/api', '/favicon.ico']) {
    const reply = await send(server, { path: route });
    assert.equal(reply.status, 404, route);
    assert.equal(reply.json().error.code, 'NOT_FOUND', route);
  }
  assert.equal((await send(server, { method: 'POST', path: '/', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 405);
});

test('Host must be exactly 127.0.0.1:<port> (DNS rebinding) for pages and API', async () => {
  for (const host of ['evil.example', `evil.example:${server.port}`, `localhost:${server.port}`, '127.0.0.1', `127.0.0.1:${server.port + 1}`,
    `[::1]:${server.port}`, `127.0.0.1:${server.port}.evil.example`]) {
    const page = await send(server, { path: '/', headers: { Host: host } });
    assert.equal(page.status, 421, host); assert.equal(page.json().error.code, 'BAD_HOST');
    const call = await send(server, { method: 'POST', path: '/api/pick-folder', headers: apiHeaders(server, { Host: host }), body: '{"kind":"work"}' });
    assert.equal(call.status, 421, host); assert.equal(call.json().error.code, 'BAD_HOST');
  }
});

test('a present Origin must be exactly this origin', async () => {
  for (const origin of ['http://evil.example', `http://localhost:${server.port}`, 'null', `https://127.0.0.1:${server.port}`,
    `http://127.0.0.1:${server.port + 1}`, `http://127.0.0.1:${server.port}/`]) {
    const reply = await api(server, 'job', { jobId: 'aaaaaaaa-0000' }, { Origin: origin });
    assert.equal(reply.status, 403, origin); refused(reply, 'FORBIDDEN_ORIGIN');
  }
  const cross = await api(server, 'job', { jobId: 'aaaaaaaa-0000' }, { 'Sec-Fetch-Site': 'cross-site' });
  refused(cross, 'FORBIDDEN_ORIGIN');
  // The same origin passes the requester checks (and then fails only on the unknown job).
  refused(await api(server, 'job', { jobId: 'aaaaaaaa-0000' }, { Origin: server.origin, 'Sec-Fetch-Site': 'same-origin' }), 'UNKNOWN_JOB');
});

test('API requires the per-launch token', async () => {
  const body = JSON.stringify({ jobId: 'aaaaaaaa-0000' });
  const missing = await send(server, { method: 'POST', path: '/api/job', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(missing.status, 401); assert.equal(missing.json().error.code, 'UNAUTHORIZED');
  const wrongSameLength = server.token.slice(0, -1) + (server.token.endsWith('A') ? 'B' : 'A');
  for (const token of [wrongSameLength, 'x', server.token + 'x', '', server.token.toLowerCase() === server.token ? 'Z' : server.token.toLowerCase()]) {
    const reply = await send(server, { method: 'POST', path: '/api/job', headers: { 'Content-Type': 'application/json', 'X-AFO-Token': token }, body });
    assert.equal(reply.status, 401, token);
  }
  const inQuery = await send(server, { method: 'POST', path: `/api/job?t=${server.token}`, headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(inQuery.status, 401);
  const another = await startServer({ picker: async () => null });
  try {
    assert.notEqual(another.token, server.token);
    const crossLaunch = await send(another, { method: 'POST', path: '/api/job', headers: apiHeaders(server), body });
    assert.equal(crossLaunch.status, 401);
  } finally { await another.close(); }
});

test('API accepts only POST with application/json', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    const reply = await send(server, { method, path: '/api/job', headers: apiHeaders(server) });
    assert.equal(reply.status, 405, method);
    if (method !== 'HEAD') assert.equal(reply.json().error.code, 'METHOD_NOT_ALLOWED');
    assert.equal(reply.headers['access-control-allow-origin'], undefined);
  }
  const body = JSON.stringify({ jobId: 'aaaaaaaa-0000' });
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', '']) {
    const reply = await send(server, { method: 'POST', path: '/api/job', headers: { 'X-AFO-Token': server.token, ...(type ? { 'Content-Type': type } : {}) }, body });
    assert.equal(reply.status, 415, type); assert.equal(reply.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');
  }
  refused(await api(server, 'job', { jobId: 'aaaaaaaa-0000' }, { 'Content-Type': 'application/json; charset=utf-8' }), 'UNKNOWN_JOB');
});

test('oversized bodies are refused (declared length and chunked)', async () => {
  const big = JSON.stringify({ kind: 'work', path: '/' + 'a'.repeat(70 * 1024) });
  const declared = await send(server, { method: 'POST', path: '/api/select-folder', headers: apiHeaders(server), body: big });
  assert.ok(declared.status === 413 || declared.status === -1, String(declared.status));
  if (declared.status === 413) assert.equal(declared.json().error.code, 'PAYLOAD_TOO_LARGE');
  const chunked = await send(server, { method: 'POST', path: '/api/select-folder', headers: apiHeaders(server), body: big, chunked: true });
  assert.ok(chunked.status === 413 || chunked.status === -1, String(chunked.status));
  if (chunked.status === 413) assert.equal(chunked.json().error.code, 'PAYLOAD_TOO_LARGE');
  // The server keeps serving afterwards.
  assert.equal((await send(server, { path: '/' })).status, 200);
});

test('malformed JSON, unknown channels and unknown fields are refused', async () => {
  const bad = await send(server, { method: 'POST', path: '/api/job', headers: apiHeaders(server), body: '{"jobId":' });
  assert.equal(bad.status, 400); assert.equal(bad.json().error.code, 'INVALID_JSON');
  const unknownChannel = await send(server, { method: 'POST', path: '/api/execute', headers: apiHeaders(server), body: '{}' });
  assert.equal(unknownChannel.status, 404);
  const fixture = await createFixture({ 'a.pdf': 'a' });
  try {
    refused(await api(server, 'select-folder', { kind: 'work', path: fixture.root, approved: true }), 'INVALID_REQUEST');
    refused(await api(server, 'select-folder', { kind: 'trash', path: fixture.root }), 'INVALID_REQUEST');
    refused(await api(server, 'select-folder', { path: fixture.root }), 'INVALID_REQUEST');
    refused(await api(server, 'select-folder', [fixture.root]), 'INVALID_REQUEST');
    refused(await api(server, 'select-folder', null), 'INVALID_REQUEST');
    refused(await api(server, 'pick-folder', { kind: 'work', path: fixture.root }), 'INVALID_REQUEST');
    refused(await api(server, 'analyze', { rootGrantId: 'a'.repeat(64), referenceGrantId: null }), 'INVALID_REQUEST'); // profileId missing
    refused(await api(server, 'analyze', { rootGrantId: 'a'.repeat(64), referenceGrantId: null, profileId: null, profile: {} }), 'INVALID_REQUEST');
    refused(await api(server, 'confirm-rules', { jobId: 'aaaaaaaa-0000', ruleIds: ['x'], profile: { rules: [] } }), 'INVALID_REQUEST');
    refused(await api(server, 'job', { jobId: '../../etc' }), 'INVALID_REQUEST');
  } finally { await fixture.cleanup(); }
});

test('only grant IDs issued by this server are accepted; scopes are not interchangeable', async (t) => {
  const work = await createFixture({ 'a.pdf': 'a' }, t); const ref = await createFixture({ 'r/x.pdf': 'x' }, t);
  const workGrant = ok(await select(server, 'work', work.root)).selected;
  const refGrant = ok(await select(server, 'reference', ref.root)).selected;
  assert.equal(workGrant.path, work.root); assert.equal(refGrant.kind, 'reference');
  // A grant issued in this process but not through this screen is unknown to the server.
  const outside = await issueRootGrant(work.root);
  for (const rootGrantId of ['f'.repeat(64), outside.id, refGrant.grantId])
    refused(await api(server, 'analyze', { rootGrantId, referenceGrantId: null, profileId: null }), 'ROOT_FORBIDDEN');
  refused(await api(server, 'analyze', { rootGrantId: workGrant.grantId, referenceGrantId: workGrant.grantId, profileId: null }), 'ROOT_FORBIDDEN');
  refused(await api(server, 'analyze', { rootGrantId: workGrant.grantId, referenceGrantId: 'e'.repeat(64), profileId: null }), 'ROOT_FORBIDDEN');
  refused(await api(server, 'analyze', { rootGrantId: workGrant.grantId, referenceGrantId: null, profileId: 'abcdefgh-1234' }), 'UNKNOWN_PROFILE');
  refused(await api(server, 'job', { jobId: 'abcdefgh-1234' }), 'UNKNOWN_JOB');
  refused(await api(server, 'cancel', { jobId: 'abcdefgh-1234' }), 'UNKNOWN_JOB');
  refused(await api(server, 'confirm-rules', { jobId: 'abcdefgh-1234', ruleIds: ['x'] }), 'UNKNOWN_JOB');
  // Re-selecting replaces the previous work folder; the old grant ID no longer works.
  const other = await createFixture({ 'b.pdf': 'b' }, t);
  const second = ok(await select(server, 'work', other.root)).selected;
  assert.notEqual(second.grantId, workGrant.grantId);
  refused(await api(server, 'analyze', { rootGrantId: workGrant.grantId, referenceGrantId: null, profileId: null }), 'ROOT_FORBIDDEN');
});

test('typed paths go through the shared root policy and are refused when unsafe', async (t) => {
  const base = await createFixture({ 'real/a.pdf': 'a', 'file.pdf': 'f', 'proj/package.json': '{}', 'Tool.app/Contents/x.txt': 'x' }, t);
  await symlink(path.join(base.root, 'real'), path.join(base.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const fakeHome = await createFixture({ 'stuff.pdf': 's' }, t);
  const osFolder = process.platform === 'win32' ? (process.env['WINDIR'] ?? 'C:\\Windows') : '/System';
  const diskRoot = path.parse(base.root).root;
  // 'real' would name an allowed folder if resolved against the server's cwd (set to base below); it must still be refused.
  const cases: Array<[string, string]> = [['relative', 'some/folder'], ['relative to cwd', 'real'], ['dot relative', './real'], ['disk root', diskRoot],
    ['os folder', osFolder], ['symlink root', path.join(base.root, 'link')], ['NUL', `${base.root}/real\u0000/x`],
    ['file', path.join(base.root, 'file.pdf')], ['missing', path.join(base.root, 'missing')], ['dot-dot', `${base.root}/real/../real`],
    ['dev project', path.join(base.root, 'proj')], ['app bundle', path.join(base.root, 'Tool.app')], ['home', fakeHome.root]];
  const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
  const cwd = process.cwd();
  process.env['HOME'] = fakeHome.root; process.env['USERPROFILE'] = fakeHome.root; // homedir() → synthetic home
  process.chdir(base.root);
  try {
    for (const kind of ['work', 'reference'] as const) for (const [label, input] of cases) {
      const reply = await select(server, kind, input);
      assert.equal(reply.body.ok, false, `${kind} ${label}`);
      assert.equal(reply.body.error.code, 'ROOT_FORBIDDEN', `${kind} ${label}: ${JSON.stringify(reply.body)}`);
    }
  } finally {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(ok(await select(server, 'work', path.join(base.root, 'real'))).selected.path, path.join(base.root, 'real'));
});

test('folder dialog channel (injected stub, not the native dialog): pick, cancel, refused path, failure', async (t) => {
  const work = await createFixture({ 'a.pdf': 'a' }, t);
  picks = [work.root];
  const picked = ok(await api(server, 'pick-folder', { kind: 'work' })).selected;
  assert.equal(picked.path, work.root); assert.match(picked.grantId, /^[a-f0-9]{64}$/u);
  picks = [null];
  assert.equal(ok(await api(server, 'pick-folder', { kind: 'reference' })).selected, null);
  picks = ['relative/path'];
  refused(await api(server, 'pick-folder', { kind: 'work' }), 'ROOT_FORBIDDEN');
  picks = [path.parse(work.root).root];
  refused(await api(server, 'pick-folder', { kind: 'work' }), 'ROOT_FORBIDDEN');
  picks = [new Error(`osascript failed at ${work.root}`)];
  const failed = await api(server, 'pick-folder', { kind: 'work' });
  refused(failed, 'PICKER_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(failed.body), new RegExp(work.root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('full read-only flow matches analyzeRoot and writes nothing to the work or reference folder', async (t) => {
  const work = await createFixture({ '새 숙제.pdf': 'new homework', '사진 1.jpg': 'img', '같은 내용 1.zip': 'same bytes',
    '같은 내용 2.zip': 'same bytes', '메모.txt': 'memo', '.숨김.txt': 'hidden', '확장자없음': 'x', '빈 폴더/': '' }, t);
  const ref = await createFixture({ '학교/수학 숙제 1.pdf': 'a', '학교/수학 숙제 2.pdf': 'b', '사진첩/여름 1.jpg': 'c', '사진첩/여름 2.jpg': 'd' }, t);
  const before = { work: await createManifest(work.root), ref: await createManifest(ref.root) };

  const workSel = ok(await select(server, 'work', work.root)).selected;
  const refSel = ok(await select(server, 'reference', ref.root)).selected;
  const { jobId } = ok(await api(server, 'analyze', { rootGrantId: workSel.grantId, referenceGrantId: refSel.grantId, profileId: null }));
  const done = await waitJob(server, jobId);
  assert.equal(done.state, 'done', JSON.stringify(done.error));
  assert.equal(done.error, null);
  assert.ok(done.progress === null || ['scan', 'reference', 'hash'].includes(done.progress.phase));

  const direct = await analyzeRoot(await issueRootGrant(work.root), { reference: await issueReferenceGrant(ref.root) });
  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  assert.deepEqual(done.result.preview, plain(direct.preview));
  assert.deepEqual(done.result.suggestedProfile, plain(direct.suggestedProfile));
  assert.deepEqual(done.result.protected, plain(direct.protected));
  assert.equal(done.result.preview.executionAvailable, false);
  assert.equal(done.result.preview.duplicates.length, 1);
  assert.ok(done.result.preview.skipped.some((s: any) => s.code === 'HIDDEN'));

  const rules = done.result.suggestedProfile.rules as Array<{ id: string; extension: string; targetDirectory: string }>;
  const pdfRule = rules.find((r) => r.extension === '.pdf');
  assert.ok(pdfRule); assert.equal(pdfRule.targetDirectory, '학교'); assert.equal(rules.length, 2);
  refused(await api(server, 'confirm-rules', { jobId, ruleIds: ['not-a-rule'] }), 'INVALID_REQUEST');
  refused(await api(server, 'confirm-rules', { jobId, ruleIds: [pdfRule.id, pdfRule.id] }), 'INVALID_REQUEST');
  const confirmed = ok(await api(server, 'confirm-rules', { jobId, ruleIds: [pdfRule.id] }));
  assert.equal(confirmed.saved, false);
  assert.equal(confirmed.profile.status, 'confirmed'); assert.equal(confirmed.profile.revision, 2);
  assert.deepEqual(confirmed.profile.rules.map((r: any) => r.id), [pdfRule.id]);

  const again = await waitJob(server, ok(await api(server, 'analyze',
    { rootGrantId: workSel.grantId, referenceGrantId: refSel.grantId, profileId: confirmed.profileId })).jobId);
  assert.equal(again.state, 'done', JSON.stringify(again.error));
  assert.equal(again.result.profileId, confirmed.profileId);
  assert.equal(again.result.preview.profileRevision, 2);
  const homework = again.result.preview.items.find((i: any) => i.source === '새 숙제.pdf');
  assert.equal(homework.action, 'move'); assert.equal(homework.destination, '학교/새 숙제.pdf'); assert.equal(homework.reasonCode, 'PERSONAL_RULE');
  const directAgain = await analyzeRoot(await issueRootGrant(work.root), { reference: await issueReferenceGrant(ref.root),
    profile: confirmProfile(direct.suggestedProfile, [pdfRule.id]) });
  assert.deepEqual(again.result.preview, plain(directAgain.preview));

  // Without a reference folder: no rule candidates, and confirm-rules has nothing to confirm.
  const noRef = await waitJob(server, ok(await api(server, 'analyze', { rootGrantId: workSel.grantId, referenceGrantId: null, profileId: null })).jobId);
  assert.equal(noRef.state, 'done'); assert.equal(noRef.result.suggestedProfile, null);
  refused(await api(server, 'confirm-rules', { jobId: noRef.jobId, ruleIds: [pdfRule.id] }), 'NO_RULES');

  const afterWork = diffManifest(before.work, await createManifest(work.root));
  const afterRef = diffManifest(before.ref, await createManifest(ref.root));
  assert.ok(sameManifest(afterWork), JSON.stringify(afterWork));
  assert.ok(sameManifest(afterRef), JSON.stringify(afterRef));
});

test('cancellation aborts the running job (real analyzeRoot with the aborted signal) and writes nothing', async (t) => {
  const work = await createFixture({ 'a.pdf': 'a', 'b.jpg': 'b', 'c 1.zip': 'same', 'c 2.zip': 'same' }, t);
  const before = await createManifest(work.root);
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  // Deterministic: hold the job until it is cancelled, then run the real shared analysis with the aborted signal.
  const gated = await startServer({ picker: async () => null, analyze: async (grant, options) => {
    started();
    await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
    return analyzeRoot(grant, options);
  } });
  try {
    const sel = ok(await select(gated, 'work', work.root)).selected;
    const { jobId } = ok(await api(gated, 'analyze', { rootGrantId: sel.grantId, referenceGrantId: null, profileId: null }));
    await startedPromise;
    assert.equal(ok(await api(gated, 'job', { jobId })).state, 'running');
    refused(await api(gated, 'confirm-rules', { jobId, ruleIds: ['x'] }), 'JOB_NOT_DONE');
    assert.equal(ok(await api(gated, 'cancel', { jobId })).cancelRequested, true);
    const status = await waitJob(gated, jobId);
    assert.equal(status.state, 'cancelled'); assert.equal(status.error.code, 'CANCELLED'); assert.equal(status.result, null);
    assert.equal(ok(await api(gated, 'cancel', { jobId })).cancelRequested, false);
  } finally { await gated.close(); }
  assert.ok(sameManifest(diffManifest(before, await createManifest(work.root))));
});

test('unexpected errors are reported without paths or stack traces', async (t) => {
  const work = await createFixture({ 'a.pdf': 'a' }, t);
  const failing = await startServer({ picker: async () => null, analyze: async (grant) => {
    const error = Object.assign(new Error(`EACCES: permission denied, open '${grant.canonicalPath}/a.pdf'`), { code: 'EACCES', path: grant.canonicalPath });
    throw error;
  } });
  try {
    const sel = ok(await select(failing, 'work', work.root)).selected;
    const status = await waitJob(failing, ok(await api(failing, 'analyze', { rootGrantId: sel.grantId, referenceGrantId: null, profileId: null })).jobId);
    assert.equal(status.state, 'failed'); assert.equal(status.error.code, 'INTERNAL');
    assert.equal(JSON.stringify(status).includes('a.pdf'), false);
    assert.equal(JSON.stringify(status).includes('EACCES'), false);
  } finally { await failing.close(); }
});

test('the work folder disappearing after selection is refused by grant re-verification', async (t) => {
  const parent = await createFixture({ 'root/a.pdf': 'a' }, t);
  const root = path.join(parent.root, 'root');
  const sel = ok(await select(server, 'work', root)).selected;
  const { rename } = await import('node:fs/promises');
  await rename(root, path.join(parent.root, 'moved'));
  await mkdir(root); await writeFile(path.join(root, 'b.pdf'), 'b');
  refused(await api(server, 'analyze', { rootGrantId: sel.grantId, referenceGrantId: null, profileId: null }), 'FILE_CHANGED');
});

test('a refused folder choice clears that folder instead of silently keeping the previous one (typed and picked)', async (t) => {
  const work = await createFixture({ 'a.pdf': 'a' }, t); const ref = await createFixture({ 'r/x 1.pdf': 'x', 'r/x 2.pdf': 'y' }, t);
  const analyzeWith = (rootGrantId: string, referenceGrantId: string | null) => api(server, 'analyze', { rootGrantId, referenceGrantId, profileId: null });
  for (const refusal of [{ via: 'typed', input: '/' }, { via: 'typed', input: 'relative/path' }, { via: 'typed', input: '' },
    { via: 'typed', input: 'x'.repeat(5000) }, { via: 'picked', input: '/' }]) {
    const label = `${refusal.via} ${refusal.input.slice(0, 20)}`;
    const choose = (kind: FolderKind): Promise<{ status: number; body: any }> => {
      if (refusal.via === 'typed') return select(server, kind, refusal.input);
      picks = [refusal.input]; return api(server, 'pick-folder', { kind });
    };
    // Work folder: the previous grant no longer analyzes.
    const previous = ok(await select(server, 'work', work.root)).selected;
    refused(await choose('work'), 'ROOT_FORBIDDEN');
    refused(await analyzeWith(previous.grantId, null), 'ROOT_FORBIDDEN');
    // Reference folder: same rule; the work folder is untouched.
    const current = ok(await select(server, 'work', work.root)).selected;
    const previousRef = ok(await select(server, 'reference', ref.root)).selected;
    refused(await choose('reference'), 'ROOT_FORBIDDEN');
    refused(await analyzeWith(current.grantId, previousRef.grantId), 'ROOT_FORBIDDEN');
    assert.equal((await waitJob(server, ok(await analyzeWith(current.grantId, null)).jobId)).state, 'done', label);
  }
  // Not a choice: dialog cancel or a dialog that cannot open keeps the current selection.
  const kept = ok(await select(server, 'work', work.root)).selected;
  picks = [null];
  assert.equal(ok(await api(server, 'pick-folder', { kind: 'work' })).selected, null);
  picks = [new Error('no dialog')];
  refused(await api(server, 'pick-folder', { kind: 'work' }), 'PICKER_UNAVAILABLE');
  assert.equal((await waitJob(server, ok(await analyzeWith(kept.grantId, null)).jobId)).state, 'done');
});

test('confirmed rules stay applied for the same work + reference selection and are released when either changes', async (t) => {
  const work = await createFixture({ '새 숙제.pdf': 'hw', '사진.jpg': 'img' }, t);
  const ref = await createFixture({ '수업자료/물리/역학 1.pdf': 'a', '수업자료/물리/역학 2.pdf': 'b' }, t);
  let workSel = ok(await select(server, 'work', work.root)).selected;
  let refSel = ok(await select(server, 'reference', ref.root)).selected;
  const run = async (profileId: string | null): Promise<any> =>
    waitJob(server, ok(await api(server, 'analyze', { rootGrantId: workSel.grantId, referenceGrantId: refSel.grantId, profileId })).jobId);
  const first = await run(null);
  assert.deepEqual(first.result.appliedRuleIds, []);
  const rule = first.result.suggestedProfile.rules[0];
  assert.equal(rule.targetDirectory, '수업자료/물리');
  const { profileId } = ok(await api(server, 'confirm-rules', { jobId: first.jobId, ruleIds: [rule.id] }));
  const homework = (job: any): any => job.result.preview.items.find((i: any) => i.source === '새 숙제.pdf');
  // Repeated analyses of the same pair keep the confirmed rules.
  for (let i = 0; i < 2; i++) {
    const again = await run(profileId);
    assert.equal(again.result.preview.profileRevision, 2);
    assert.deepEqual(again.result.appliedRuleIds, [rule.id]);
    assert.equal(homework(again).destination, '수업자료/물리/새 숙제.pdf'); assert.equal(homework(again).reasonCode, 'PERSONAL_RULE');
  }
  // A different pair (reference skipped) may not reuse them.
  refused(await api(server, 'analyze', { rootGrantId: workSel.grantId, referenceGrantId: null, profileId }), 'PROFILE_CHANGED');
  // Re-selecting the reference folder (even the same path) releases them.
  refSel = ok(await select(server, 'reference', ref.root)).selected;
  refused(await api(server, 'analyze', { rootGrantId: workSel.grantId, referenceGrantId: refSel.grantId, profileId }), 'UNKNOWN_PROFILE');
  // Same for the work folder, and a refused work choice releases them as well.
  const second = await run(null);
  const p2 = ok(await api(server, 'confirm-rules', { jobId: second.jobId, ruleIds: [rule.id] })).profileId;
  workSel = ok(await select(server, 'work', work.root)).selected;
  refused(await api(server, 'analyze', { rootGrantId: workSel.grantId, referenceGrantId: refSel.grantId, profileId: p2 }), 'UNKNOWN_PROFILE');
  const third = await run(null);
  const p3 = ok(await api(server, 'confirm-rules', { jobId: third.jobId, ruleIds: [rule.id] })).profileId;
  refused(await select(server, 'work', '/'), 'ROOT_FORBIDDEN');
  workSel = ok(await select(server, 'work', work.root)).selected;
  refused(await api(server, 'analyze', { rootGrantId: workSel.grantId, referenceGrantId: refSel.grantId, profileId: p3 }), 'UNKNOWN_PROFILE');
  // A finished job whose folders were re-selected can no longer confirm rules.
  refused(await api(server, 'confirm-rules', { jobId: third.jobId, ruleIds: [rule.id] }), 'PROFILE_CHANGED');
});
