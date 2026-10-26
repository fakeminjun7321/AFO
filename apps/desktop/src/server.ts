import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, isChannel, toErrorBody } from './service.js';
import type { Analyze } from './service.js';
import { nativeFolderPicker } from './os.js';
import type { FolderPicker } from './os.js';

/**
 * Local web screen (ADR 0002). Binds 127.0.0.1 on an OS-chosen port. Every request must name exactly that Host
 * (DNS rebinding); a present Origin must be exactly this origin; the API is POST + application/json + X-AFO-Token.
 * No CORS headers are ever sent, so a foreign page cannot make a custom-header request pass preflight.
 */
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const BODY_LIMIT = 64 * 1024;
const securityHeaders = {
  'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;
/** The only static files. Any other path, including encoded or dot segments, is 404. */
const staticFiles: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
// Compiled to apps/desktop/dist/apps/desktop/src/server.js; static files stay in apps/desktop/public/.
const defaultPublicDir = fileURLToPath(new URL('../../../../public/', import.meta.url));

export interface ServerOptions { picker?: FolderPicker; analyze?: Analyze; publicDir?: string }
export interface RunningServer { port: number; token: string; origin: string; url: string; close: () => Promise<void> }

class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const digestToken = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const publicDir = options.publicDir ?? defaultPublicDir;
  const assets = new Map<string, Buffer>();
  // Read once at start: the served set is fixed for the life of the process.
  for (const { file } of Object.values(staticFiles)) if (!assets.has(file)) assets.set(file, await readFile(path.join(publicDir, file)));
  const token = randomBytes(32).toString('base64url');
  const tokenDigest = digestToken(token);
  const service = createService({ picker: options.picker ?? nativeFolderPicker, ...(options.analyze ? { analyze: options.analyze } : {}) });
  let origin = '';

  const send = (res: ServerResponse, status: number, body: Buffer | string, type: string, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { ...securityHeaders, 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body)), ...extra });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void =>
    send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', extra);
  const fail = (res: ServerResponse, error: HttpError, extra: Record<string, string> = {}): void =>
    json(res, error.status, { ok: false, error: { code: error.code, message: error.message } }, extra);

  const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > BODY_LIMIT) { reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다.')); return; }
    const chunks: Buffer[] = []; let size = 0; let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > BODY_LIMIT) { over = true; chunks.length = 0; reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다.')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => reject(new HttpError(400, 'INVALID_REQUEST', '요청을 읽지 못했습니다.')));
  });

  const tokenMatches = (header: string | string[] | undefined): boolean =>
    typeof header === 'string' && header.length > 0 && header.length <= 256 && timingSafeEqual(digestToken(header), tokenDigest);

  async function api(req: IncomingMessage, res: ServerResponse, channel: string): Promise<void> {
    if (!isChannel(channel)) throw new HttpError(404, 'NOT_FOUND', '알 수 없는 채널입니다.');
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'API는 POST만 받습니다.');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'FORBIDDEN_ORIGIN', '다른 출처의 요청은 받지 않습니다.');
    if (!tokenMatches(req.headers['x-afo-token'])) throw new HttpError(401, 'UNAUTHORIZED', '화면 토큰이 없거나 틀립니다. 터미널에 표시된 주소로 다시 여세요.');
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type은 application/json이어야 합니다.');
    const text = await readBody(req);
    let body: unknown;
    try { body = JSON.parse(text) as unknown; } catch { throw new HttpError(400, 'INVALID_JSON', 'JSON 본문이 올바르지 않습니다.'); }
    try { json(res, 200, { ok: true, data: await service.handle(channel, body) }); }
    catch (error) {
      const err = toErrorBody(error);
      json(res, err.code === 'INTERNAL' ? 500 : 400, { ok: false, error: err });
    }
  }

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    void (async () => {
      try {
        if (req.headers.host !== `127.0.0.1:${port}`) throw new HttpError(421, 'BAD_HOST', 'Host가 이 화면의 주소와 다릅니다.');
        if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new HttpError(403, 'FORBIDDEN_ORIGIN', '다른 출처의 요청은 받지 않습니다.');
        const url = req.url ?? '';
        const route = url.split('?')[0]!;
        if (route.startsWith('/api/')) { await api(req, res, route.slice('/api/'.length)); return; }
        const asset = Object.hasOwn(staticFiles, route) ? staticFiles[route] : undefined;
        if (!asset) throw new HttpError(404, 'NOT_FOUND', '없는 경로입니다.');
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '정적 파일은 GET만 받습니다.');
        const body = assets.get(asset.file)!;
        if (req.method === 'HEAD') { res.writeHead(200, { ...securityHeaders, 'Content-Type': asset.type, 'Content-Length': String(body.length) }); res.end(); return; }
        send(res, 200, body, asset.type);
      } catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        const httpError = error instanceof HttpError ? error : new HttpError(500, 'INTERNAL', '요청을 처리하지 못했습니다.');
        // After an oversized body stop reading the rest of it.
        if (httpError.status === 413) { fail(res, httpError, { Connection: 'close' }); res.on('finish', () => req.destroy()); return; }
        fail(res, httpError);
      }
    })();
  });
  server.requestTimeout = 60_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  return {
    port, token, origin, url: `${origin}/#t=${token}`,
    close: () => new Promise<void>((resolve) => { service.shutdown(); server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
