import { parentPort, workerData } from 'node:worker_threads';
import { unzipSync } from 'fflate';
import * as exifr from 'exifr';
import { plainTextExtensions, xmlDocumentExtensions } from '../../engine/src/formats.js';

const LIMIT = 200_000;
let limited = false;
const decodeEntities = (text: string): string => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_, name: string) => {
  if (name.startsWith('#')) { const n = name[1]!.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()] ?? '';
});
const stripXml = (text: string): string => {
  const result = decodeEntities(text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ').trim();
  if (result.length > LIMIT) limited = true;
  return result.slice(0, LIMIT);
};
function textOf(data: Uint8Array): string {
  const buffer = Buffer.from(data);
  let text: string;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2));
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2));
  else { try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { text = new TextDecoder('euc-kr', { fatal: true }).decode(buffer); } }
  if ((text.match(/[\u0000-\u0008\u000e-\u001f]/gu)?.length ?? 0) > Math.max(1, text.length / 100)) throw new Error('텍스트로 해독할 수 없는 바이너리입니다.');
  if (text.length > LIMIT) limited = true;
  return text.slice(0, LIMIT);
}
function rtf(data: Uint8Array): string {
  const buffer = Buffer.from(data); const header = buffer.subarray(0, 256).toString('latin1');
  const codepage = /\\ansicpg(\d+)/u.exec(header)?.[1] ?? '1252';
  const encoding = ({ '949':'euc-kr','1252':'windows-1252','65001':'utf-8','932':'shift_jis','936':'gbk','950':'big5' } as Record<string,string>)[codepage];
  if (!encoding) throw new Error(`지원하지 않는 RTF 문자 인코딩입니다: ${codepage}`);
  const decode = (bytes: Uint8Array): string => new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const text = decode(data); let result = ''; let fallback = 0;
  const states = [{ skip: false, uc: 1 }];
  for (let i = 0; i < text.length && result.length < LIMIT;) {
    const state = states.at(-1)!; const ch = text[i++]!;
    if (ch === '{') { if (states.length > 512) throw new Error('RTF 중첩 한도 초과'); states.push({ ...state }); continue; }
    if (ch === '}') { if (states.length > 1) states.pop(); continue; }
    if (ch !== '\\') { if (fallback > 0) fallback--; else if (!state.skip && ch !== '\r' && ch !== '\n') result += ch; continue; }
    const next = text[i];
    if (next === '\\' || next === '{' || next === '}') { i++; if (fallback > 0) fallback--; else if (!state.skip) result += next; continue; }
    if (next === '*') { i++; state.skip = true; continue; }
    if (next === "'") {
      const bytes: number[] = [];
      while (text[i - 1] === '\\' && text[i] === "'" && /^[0-9a-f]{2}$/iu.test(text.slice(i + 1, i + 3))) {
        bytes.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 3;
        if (text[i] === '\\' && text[i + 1] === "'") i++; else break;
      }
      const skip = Math.min(fallback, bytes.length); fallback -= skip;
      if (!state.skip && bytes.length > skip) result += decode(new Uint8Array(bytes.slice(skip)));
      continue;
    }
    const word = /^([a-z]+)(-?\d+)? ?/iu.exec(text.slice(i));
    if (!word) { i++; continue; }
    i += word[0].length; const name = word[1]!.toLowerCase(); const n = Number(word[2] ?? 0);
    if (['fonttbl','colortbl','stylesheet','info','pict','object','fldinst','header','footer'].includes(name)) state.skip = true;
    else if (name === 'uc') state.uc = Math.max(0, Math.min(16, n));
    else if (name === 'u') { if (!state.skip) result += String.fromCharCode(n & 0xffff); fallback = state.uc; }
    else if (name === 'bin') i += Math.max(0, Math.min(text.length - i, n));
    else if (!state.skip && ['par','line','tab'].includes(name)) result += name === 'tab' ? '\t' : '\n';
  }
  if (result.length >= LIMIT) limited = true;
  return result.trim().slice(0, LIMIT);
}
function office(data: Uint8Array, ext: string): string {
  const files: { name: string; size: number }[] = [];
  unzipSync(data, { filter: (entry) => { files.push({ name: entry.name, size: entry.originalSize }); return false; } });
  if (files.length > 2000 || files.some((f) => !Number.isSafeInteger(f.size) || f.size < 0) || files.reduce((n, f) => n + f.size, 0) > 32 * 1024 * 1024)
    throw new Error('압축 문서의 항목 수 또는 해제 크기 한도를 넘었습니다.');
  const allowed = (name: string): boolean => /^(word\/(document|header\d+|footer\d+)\.xml|ppt\/slides\/slide\d+\.xml|xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)|Contents\/section\d+\.xml|content\.xml)$/iu.test(name)
    || (ext === 'epub' && /\.(xhtml|html|htm)$/iu.test(name));
  if (files.some((file) => allowed(file.name) && file.size > 8 * 1024 * 1024)) throw new Error('문서 본문 XML 한 항목의 해제 크기 한도(8 MiB)를 넘었습니다.');
  const extracted = unzipSync(data, { filter: (entry) => allowed(entry.name) && entry.originalSize <= 8 * 1024 * 1024 });
  const strings = extracted['xl/sharedStrings.xml'] ? (textOf(extracted['xl/sharedStrings.xml']).match(/<si\b[^>]*>[\s\S]*?<\/si>/gu) ?? []).map(stripXml) : [];
  const result = Object.keys(extracted).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).filter((name) => name !== 'xl/sharedStrings.xml').map((name) => {
    let xml = textOf(extracted[name]!);
    if (name.startsWith('xl/')) xml = xml.replace(/<c\b[^>]*\bt="s"[^>]*>[\s\S]*?<v>(\d+)<\/v>[\s\S]*?<\/c>/gu,
      (_, n: string) => strings[Number(n)] ?? '');
    return stripXml(xml);
  }).join('\n');
  if (result.length > LIMIT) limited = true;
  return result.slice(0, LIMIT);
}
async function parse(data: Uint8Array, extension: string): Promise<{ text: string; method: string }> {
  const ext = extension.replace(/^\./u, '').toLowerCase();
  if (['fb2', 'fodt', 'fodp', 'fods'].includes(ext)) return { text: stripXml(textOf(data)), method: 'xml-text' };
  if (xmlDocumentExtensions.includes(ext)) return { text: office(data, ext), method: 'office-xml' };
  if (!plainTextExtensions.includes(ext)) throw new Error('본문 추출을 지원하지 않는 형식입니다.');
  if (ext === 'rtf') return { text: rtf(data), method: 'text' };
  let text = textOf(data);
  if (ext === 'ipynb') { const notebook = JSON.parse(text) as { cells?: { source?: string[] | string }[] }; text = (notebook.cells ?? []).map((cell) => Array.isArray(cell.source) ? cell.source.join('') : cell.source ?? '').join('\n'); }
  else if (['html', 'htm', 'xhtml', 'xml', 'smi'].includes(ext)) text = stripXml(text);
  return { text: text.trim().slice(0, LIMIT), method: 'text' };
}

async function inspect(): Promise<{ text: string; method: string; capturedDate?: string | null }> {
  if (workerData.kind !== 'exif') return parse(workerData.bytes as Uint8Array, workerData.extension as string);
  const metadata = await exifr.parse(Buffer.from(workerData.bytes as Uint8Array), { pick: ['DateTimeOriginal'], reviveValues: false }) as Record<string, unknown> | undefined;
  const date = metadata?.DateTimeOriginal;
  return { text: '', method: 'exif', capturedDate: typeof date === 'string' ? date : null };
}
void inspect().then((result) => parentPort!.postMessage({ ok: true, ...result, limited }),
  (error: unknown) => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }));
