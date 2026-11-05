import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { AfoError, ComplexRuleSchema, OpaqueIdSchema, RelativePathSchema, SmartOptionsSchema } from '../../../packages/contracts/src/index.js';
import { approvalChoices } from '../../../packages/engine/src/index.js';
import { loadSavedPlan } from '../../../packages/filesystem/src/approvals.js';
import { readRun } from '../../../packages/filesystem/src/executor.js';
import { disableProfile, enableProfile, loadProfile, removeComplexRule, setRuleEnabled, upsertComplexRule } from '../../../packages/filesystem/src/profiles.js';
import { aiModels } from '../../../packages/filesystem/src/features.js';
import { readerFormats } from '../../../packages/engine/src/formats.js';
import { complexMatches, conditionMatches } from '../../../packages/engine/src/smart.js';
import { AFO_VERSION } from './version.js';
import { analyzeTarget } from './analyze.js';
import { applyCommand, recoverReport, runSummaries, undoCommand } from './apply.js';
import type { CliResult, ExecContext } from './apply.js';
import { appCss, smartCss, appJs, pageHtml } from './gui-assets.js';
import { createPlan } from './plan.js';
import { CliError, isCorrupt, usage } from './rules.js';

/**
 * `gui` (#9): a local browser view over the same adapters the CLI uses (analyzeTarget, createPlan, runSummaries, recoverReport).
 * It shows analyses, saves plans and reads rules/runs/recovery. It changes user files only through POST /api/apply (organize or trash,
 * never permanent-delete) and POST /api/undo, which call the CLI's applyCommand/undoCommand (issueApproval → consumeApproval →
 * executeBatch, undoRun) after the user confirmed the listed operations on the page; the server fills in the plan's own approval code.
 * Requests are accepted only on 127.0.0.1, with this process's random token, the expected Host and no foreign Origin.
 * --exit-when-closed (Finder Quick Action, Windows SendTo): the process ends once no page has been connected for a while.
 */
export interface GuiValues { port?: string | undefined; 'no-open'?: boolean | undefined; 'exit-when-closed'?: boolean | undefined }
export interface GuiContext { warn: (line: string) => void; stateDir: () => string; signal?: AbortSignal | undefined;
  /** Test hook: receives the URL instead of opening a browser when set. */
  onListening?: (url: string) => void }

const MAX_BODY = 64 * 1024;
const FolderSchema = z.string().trim().min(1).max(4096);
const RenameSchema = z.strictObject({ fileId: z.string().regex(/^[a-f0-9]{64}$/u), name: RelativePathSchema.refine((name) => !name.includes('/') && !name.includes('\\') && !name.startsWith('.'), '파일 이름 하나가 필요합니다.') });
const PreviewRequest = z.strictObject({ folder: FolderSchema, reference: FolderSchema.optional(), noSavedRules: z.boolean().optional(),
  smart: SmartOptionsSchema.optional(), skips: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(1000).optional(), renames: z.array(RenameSchema).max(1000).optional(),
  overrides: z.array(z.strictObject({ fileId: z.string().regex(/^[a-f0-9]{64}$/u), target: RelativePathSchema })).max(1000).optional() });
const PlanRequest = z.strictObject({ folder: FolderSchema, reference: FolderSchema.optional(), noSavedRules: z.boolean().optional(),
  deleteMode: z.enum(['trash', 'permanent']).optional(), deleteDuplicates: z.enum(['none', 'all']).optional(),
  smart: SmartOptionsSchema.optional(), skips: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(1000).optional(), renames: z.array(RenameSchema).max(1000).optional(),
  overrides: z.array(z.strictObject({ fileId: z.string().regex(/^[a-f0-9]{64}$/u), target: RelativePathSchema })).max(1000).optional() });
const ManualRuleInput = ComplexRuleSchema.omit({ id: true }).extend({ id: z.string().regex(/^[a-f0-9]{16}$/u).optional() });
const SaveRuleRequest = z.strictObject({ rule: ManualRuleInput, expectedRevision: z.number().int().positive().nullable() });
const DeleteRuleRequest = z.strictObject({ id: z.string().regex(/^[a-f0-9]{16}$/u), expectedRevision: z.number().int().positive() });
const ToggleRuleRequest = z.strictObject({ id: z.string().min(1).max(128), enabled: z.boolean(), expectedRevision: z.number().int().positive() });
const ProfileStatusRequest = z.strictObject({ enabled: z.boolean(), expectedRevision: z.number().int().positive() });
const TestRuleRequest = z.strictObject({ rule: ManualRuleInput, name: RelativePathSchema, size: z.number().int().nonnegative().optional(), modified: z.string().datetime().optional() });
/** permanent-delete is not offered here: it stays in the terminal with its typed phrase. */
const ApplyRequest = z.strictObject({ planId: z.string().regex(/^[a-f0-9]{64}$/u), mode: z.enum(['organize', 'trash']) });
const UndoRequest = z.strictObject({ runId: OpaqueIdSchema });
const PingRequest = z.strictObject({});
/** Page heartbeat timeouts for --exit-when-closed; the env overrides exist for tests only. */
const FIRST_LOAD_MS = 120_000;
const IDLE_MS = 60_000;
const envMs = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const securityHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
};

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { ...securityHeaders, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const sendJson = (res: ServerResponse, status: number, data: unknown): void => send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(;|$)/iu.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'BAD_REQUEST', 'JSON 요청만 받습니다.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'BAD_REQUEST', '요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'BAD_REQUEST', 'JSON을 해석할 수 없습니다.'); }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, 'BAD_REQUEST', `요청 형식이 다릅니다: ${result.error.issues[0]?.message ?? ''}`);
  return result.data;
}

/** The browser sends folders as typed; like the CLI, only absolute paths are accepted (no cwd guessing from a web page). */
function folderOf(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new HttpError(400, 'BAD_REQUEST', `${label}는 절대 경로로 입력하세요.`);
  return value;
}

function errorBody(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (error instanceof HttpError) return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  if (error instanceof AfoError) return { status: 422, body: { error: { code: error.code, message: error.message } } };
  if (error instanceof CliError) return { status: 400, body: { error: { code: 'BAD_REQUEST', message: error.message } } };
  if (error instanceof Error && error.name === 'AbortError') return { status: 499, body: { error: { code: 'CANCELLED', message: '취소했습니다.' } } };
  return { status: 422, body: { error: { code: 'ERROR', message: error instanceof Error ? error.message : '알 수 없는 오류' } } };
}

/** How the page tells the user to run a command in the terminal: this same CLI entry, relative to the current folder when it is inside it. */
function cliPrefix(): string {
  const quote = (p: string): string => /[\s"'$`\\]/u.test(p) ? JSON.stringify(p) : p;
  // Single executable: argv[1] is the executable itself, there is no script to hand to node.
  if (process.argv[1] && path.resolve(process.argv[1]) === process.execPath) return quote(process.execPath);
  const script = process.argv[1] ? path.resolve(process.argv[1]) : path.resolve('dist/apps/cli/src/index.js');
  const relative = path.relative(process.cwd(), script);
  const shown = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : script;
  return `node ${quote(shown)}`;
}

function openBrowser(url: string, warn: (line: string) => void): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] as const
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] as const : ['xdg-open', [url]] as const;
  try {
    const child = spawn(cmd, [...args], { stdio: 'ignore', detached: true });
    child.on('error', () => { warn('브라우저를 자동으로 열지 못했습니다. 위 주소를 브라우저에 붙여 넣으세요.'); });
    child.unref();
  } catch { warn('브라우저를 자동으로 열지 못했습니다. 위 주소를 브라우저에 붙여 넣으세요.'); }
}

export async function guiCommand(folder: string | undefined, values: GuiValues, ctx: GuiContext): Promise<string> {
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (port !== 0 && port < 1024))
    throw usage('--port는 1024–65535 사이의 정수입니다(생략하면 빈 포트를 고릅니다).');
  const initialFolder = folder === undefined ? null : path.resolve(folder);
  const stateDir = path.resolve(ctx.stateDir());
  const token = randomBytes(24).toString('hex');
  const tokenBuffer = Buffer.from(token);
  let busy = false;
  let actualPort = 0;
  let executed = 0;
  // --exit-when-closed: an authorized request (page load, ping, any API call) or an open presence stream counts as a page being there.
  let seen = false;
  let lastSeen = Date.now();
  let presence = 0;
  const touch = (): void => { seen = true; lastSeen = Date.now(); };

  const allowedHosts = (): Set<string> => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
  const authorize = (req: IncomingMessage): void => {
    if (!allowedHosts().has(req.headers.host ?? '')) throw new HttpError(403, 'FORBIDDEN', '허용하지 않은 Host입니다.');
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedHosts().has(origin.replace(/^http:\/\//u, ''))) throw new HttpError(403, 'FORBIDDEN', '허용하지 않은 Origin입니다.');
    const given = Buffer.from(String(req.headers['x-afo-token'] ?? ''));
    if (given.length !== tokenBuffer.length || !timingSafeEqual(given, tokenBuffer)) throw new HttpError(403, 'FORBIDDEN', '토큰이 없거나 다릅니다. 터미널에 나온 주소로 다시 여세요.');
    touch();
  };
  /**
   * One analysis/plan/apply/undo at a time. An analysis is cancelled when the browser drops the request; a file operation is not
   * (it is cancelled only when the GUI stops, like Ctrl+C in the CLI), so a closed tab never leaves a batch half done on purpose.
   */
  const exclusive = async <T>(res: ServerResponse | null, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (busy) throw new HttpError(409, 'BUSY', '다른 작업이 진행 중이에요. 끝난 뒤 다시 시도하세요.');
    busy = true;
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    res?.on('close', () => { if (!res.writableEnded) abort(); });
    ctx.signal?.addEventListener('abort', abort, { once: true });
    try { return await work(controller.signal); }
    finally { busy = false; ctx.signal?.removeEventListener('abort', abort); }
  };
  const analyzeContext = (signal: AbortSignal) => ({ warn: () => {}, stateDir: () => stateDir, options: { signal } });
  const execContext = (signal: AbortSignal): ExecContext => ({ json: true, warn: ctx.warn, stateDir: () => stateDir, signal, isTTY: false,
    ask: () => Promise.reject(new Error('화면에서는 대화형 입력을 쓰지 않습니다.')) });
  const reply = (result: CliResult): unknown => ({ exitCode: result.exitCode, ...(JSON.parse(result.output) as object) });

  const api = async (req: IncomingMessage, res: ServerResponse, route: string): Promise<unknown> => {
    if (req.method === 'GET' && route === '/api/info')
      return { initialFolder, stateDir, version: AFO_VERSION, platform: process.platform, executes: ['organize', 'trash'], undo: true,
        exitWhenClosed: values['exit-when-closed'] === true, cli: cliPrefix() };
    if (req.method === 'POST' && route === '/api/ping') { parse(PingRequest, await readBody(req)); return { ok: true }; }
    if (req.method === 'POST' && route === '/api/preview') {
      const body = parse(PreviewRequest, await readBody(req));
      return exclusive(res, async (signal) => {
        const { analysis, info } = await analyzeTarget(folderOf(body.folder, '폴더'), {
          ...(body.reference ? { reference: folderOf(body.reference, '참고 폴더') } : {}), 'no-saved-rules': body.noSavedRules === true,
          smart: body.smart, skips: body.skips, renames: body.renames, overrides: body.overrides,
        }, { ...analyzeContext(signal), writesState: false });
        return { preview: analysis.preview, suggestedProfile: analysis.suggestedProfile, profile: info };
      });
    }
    if (req.method === 'POST' && route === '/api/plan') {
      const body = parse(PlanRequest, await readBody(req));
      return exclusive(res, async (signal) => {
        const created = await createPlan(folderOf(body.folder, '폴더'), {
          ...(body.reference ? { reference: folderOf(body.reference, '참고 폴더') } : {}), 'no-saved-rules': body.noSavedRules === true,
          smart: body.smart, skips: body.skips, renames: body.renames, overrides: body.overrides,
          'delete-mode': body.deleteMode ?? 'trash', ...(body.deleteDuplicates === 'all' ? { 'delete-duplicates': 'all' } : {}),
        }, analyzeContext(signal));
        return { planId: created.plan.id, plan: created.plan, approvalChoices: created.choices, preview: created.preview, profile: created.info };
      });
    }
    if (req.method === 'POST' && route === '/api/apply') {
      const raw = await readBody(req);
      if (raw !== null && typeof raw === 'object' && (raw as { mode?: unknown }).mode === 'permanent-delete')
        throw new HttpError(400, 'BAD_REQUEST', '영구 삭제는 화면에서 실행하지 않아요. 터미널의 apply로 확인 문구까지 입력해야 해요.');
      const body = parse(ApplyRequest, raw);
      // The page showed this plan's operations of this mode and the user confirmed them there; the code is the one plan printed.
      const saved = await loadSavedPlan(stateDir, body.planId);
      const code = saved === null ? undefined : approvalChoices(saved.plan).find((c) => c.mode === body.mode)?.code;
      return exclusive(null, async (signal) => {
        const result = await applyCommand(body.planId, { mode: body.mode, confirm: code ?? '' }, execContext(signal));
        executed += 1;
        return reply(result);
      });
    }
    if (req.method === 'POST' && route === '/api/undo') {
      const body = parse(UndoRequest, await readBody(req));
      return exclusive(null, async (signal) => {
        const result = reply(await undoCommand(body.runId, { confirm: body.runId.slice(0, 8) }, execContext(signal))) as { report: unknown };
        if (result.report !== null) executed += 1;
        return result;
      });
    }
    if (req.method === 'GET' && route === '/api/rules') {
      const p = await loadProfile({ stateDir });
      return p === null ? { state: 'none' } : isCorrupt(p) ? { state: 'corrupt', reason: p.reason } : { state: 'active', profile: p };
    }
    if (req.method === 'GET' && route === '/api/formats') return { formats: readerFormats() };
    if (req.method === 'POST' && route === '/api/ai-models') {
      const body = parse(z.strictObject({ url: z.string().optional() }), await readBody(req));
      return { models: await aiModels(body.url) };
    }
    if (req.method === 'POST' && route === '/api/rules/complex') {
      const body = parse(SaveRuleRequest, await readBody(req));
      const rule = ComplexRuleSchema.parse({ ...body.rule, id: body.rule.id ?? randomBytes(8).toString('hex') });
      return { profile: await upsertComplexRule(rule, { stateDir, expectedRevision: body.expectedRevision }) };
    }
    if (req.method === 'POST' && route === '/api/rules/complex/delete') {
      const body = parse(DeleteRuleRequest, await readBody(req));
      return { profile: await removeComplexRule(body.id, { stateDir, expectedRevision: body.expectedRevision }) };
    }
    if (req.method === 'POST' && route === '/api/rules/toggle') {
      const body = parse(ToggleRuleRequest, await readBody(req));
      return { profile: await setRuleEnabled(body.id, body.enabled, { stateDir, expectedRevision: body.expectedRevision }) };
    }
    if (req.method === 'POST' && route === '/api/rules/status') {
      const body = parse(ProfileStatusRequest, await readBody(req));
      return { profile: await (body.enabled ? enableProfile : disableProfile)({ stateDir, expectedRevision: body.expectedRevision }) };
    }
    if (req.method === 'POST' && route === '/api/rules/test') {
      const body = parse(TestRuleRequest, await readBody(req));
      const rule = ComplexRuleSchema.parse({ ...body.rule, id: body.rule.id ?? '0'.repeat(16) });
      const metadata = { ...(body.size !== undefined ? { size: body.size } : {}), ...(body.modified !== undefined ? { modifiedNs: String(BigInt(Date.parse(body.modified)) * 1_000_000n) } : {}) };
      return { matched: complexMatches(rule, body.name, metadata), virtualInput: true,
        conditions: rule.conditions.map((condition) => ({ condition, matched: conditionMatches(condition, body.name, metadata) })) };
    }
    if (req.method === 'GET' && route === '/api/runs') return { runs: await runSummaries(stateDir) };
    const runMatch = /^\/api\/runs\/([^/]+)$/u.exec(route);
    if (req.method === 'GET' && runMatch) {
      const runId = decodeURIComponent(runMatch[1]!);
      if (!OpaqueIdSchema.safeParse(runId).success) throw new HttpError(400, 'BAD_REQUEST', '실행 ID 형식이 아닙니다.');
      const found = await readRun(stateDir, runId);
      if (found === null) throw new HttpError(404, 'NOT_FOUND', '해당 실행 기록이 없습니다.');
      // Results carry operation IDs only; the saved plan names the files (null when it is gone or unreadable, as in `runs <id>`).
      let operations: { id: string; kind: string; source: string; destination: string | null }[] | null = null;
      try {
        const saved = await loadSavedPlan(stateDir, found.run.planId);
        if (saved) operations = saved.plan.operations.map((op) => ({ id: op.id, kind: op.kind, source: op.source, destination: op.destination }));
      } catch { operations = null; }
      return { ...found, operations };
    }
    if (req.method === 'GET' && route === '/api/recover') {
      const { all, open } = await recoverReport(stateDir);
      return { checked: all.length, runs: open };
    }
    throw new HttpError(404, 'NOT_FOUND', '없는 API입니다.');
  };

  const server = createServer((req, res) => {
    const route = (req.url ?? '/').split('?')[0]!;
    if (route.startsWith('/api/')) {
      void (async () => {
        try {
          authorize(req);
          if (req.method === 'GET' && route === '/api/presence') {
            // Held open by the page while it is shown (browsers throttle timers in background tabs, not open requests).
            presence += 1;
            res.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
            res.write('ok\n');
            res.on('close', () => { presence -= 1; touch(); });
            return;
          }
          sendJson(res, 200, await api(req, res, route));
        } catch (error) {
          const { status, body } = errorBody(error);
          if (!res.headersSent && !res.destroyed) sendJson(res, status, body);
        }
      })();
      return;
    }
    // Static page: the same three assets for everyone on this loopback port; it carries no data and no token.
    if (req.method !== 'GET' || !allowedHosts().has(req.headers.host ?? '')) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    if (route === '/') return send(res, 200, 'text/html; charset=utf-8', pageHtml);
    if (route === '/app.js') return send(res, 200, 'text/javascript; charset=utf-8', appJs);
    if (route === '/app.css') return send(res, 200, 'text/css; charset=utf-8', appCss + smartCss);
    return send(res, 404, 'text/plain; charset=utf-8', 'not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'EADDRINUSE' ? new CliError(`포트 ${port}를 이미 쓰고 있습니다. --port를 바꾸거나 생략하세요.`, 1) : error));
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  actualPort = typeof address === 'object' && address !== null ? address.port : port;
  // The token travels in the fragment, which browsers never send to the server or in Referer.
  const url = `http://127.0.0.1:${actualPort}/#token=${token}`;
  ctx.warn(`AFO GUI: ${url}`);
  ctx.warn('이 주소는 이 컴퓨터에서만 열려요. 화면에서 목록을 확인하고 [정리하기]·[휴지통으로 보내기]·[되돌리기]를 눌러야만 파일이 바뀌어요' +
    '(영구 삭제는 터미널에서만).');
  ctx.warn(values['exit-when-closed'] === true ? '브라우저 화면을 닫으면 잠시 뒤 저절로 끝나요. 바로 끝내려면 Ctrl+C.' : '끝내려면 Ctrl+C.');
  if (ctx.onListening) ctx.onListening(url);
  else if (values['no-open'] !== true) openBrowser(url, ctx.warn);

  let closedByIdle = false;
  await new Promise<void>((resolve) => {
    let stopping = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      clearInterval(idleTimer);
      server.close(() => resolve());
      server.closeAllConnections();
    };
    if (values['exit-when-closed'] === true) {
      const firstMs = envMs('AFO_GUI_FIRST_LOAD_MS', FIRST_LOAD_MS); const idleMs = envMs('AFO_GUI_IDLE_MS', IDLE_MS);
      idleTimer = setInterval(() => {
        if (busy || presence > 0) { lastSeen = Date.now(); return; }
        if (Date.now() - lastSeen > (seen ? idleMs : firstMs)) { closedByIdle = true; stop(); }
      }, Math.max(20, Math.min(5_000, Math.floor(Math.min(firstMs, idleMs) / 5))));
    }
    if (ctx.signal?.aborted) stop();
    else ctx.signal?.addEventListener('abort', stop, { once: true });
    if (!ctx.signal) server.once('close', () => resolve());
  });
  return `AFO GUI를 종료했습니다${closedByIdle ? '(화면이 닫혀 있어 저절로 끝냄)' : ''}. ` +
    (executed ? `화면에서 실행·되돌리기 ${executed}번을 했어요. 결과는 afo runs로 볼 수 있어요.` : '파일은 바꾸지 않았습니다.');
}
