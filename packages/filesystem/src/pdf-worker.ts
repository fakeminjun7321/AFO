import { parentPort, workerData } from 'node:worker_threads';
import DOMMatrix from '@thednp/dommatrix';
import { unzipSync } from 'fflate';

// PDF.js 6 removed the legacy dynamic glyph-code generator. Only text extraction is used; no PDF scripting/rendering API.
Object.assign(globalThis, { DOMMatrix });
const core = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
Object.assign(globalThis, { pdfjsWorker: { WorkerMessageHandler: core.WorkerMessageHandler } });
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
class BundledDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const directory = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : null;
    if (!directory || !/^[A-Za-z0-9_.-]{1,120}$/u.test(filename)) throw new Error('허용하지 않은 PDF 자원 이름입니다.');
    const name = `${directory}/${filename}`;
    const files = unzipSync(new Uint8Array(workerData.pdfData as Uint8Array), { filter: (entry) => entry.name === name });
    if (!files[name]) throw new Error('이 PDF에 필요한 내장 문자표/글꼴을 찾을 수 없습니다.');
    return files[name];
  }
}
async function extract(): Promise<{ text: string; method: string; limited: boolean }> {
  const bytes = new Uint8Array(workerData.bytes as Uint8Array);
  if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') throw new Error('PDF 헤더가 아닙니다.');
  const task = pdfjs.getDocument({ data: bytes, useWorkerFetch: false, useWasm: false, disableFontFace: true,
    useSystemFonts: false, enableXfa: false, stopAtErrors: true, maxImageSize: 4_000_000, isOffscreenCanvasSupported: false,
    BinaryDataFactory: BundledDataFactory, cMapUrl: 'bundled:/cmaps/', standardFontDataUrl: 'bundled:/standard_fonts/', verbosity: 0 });
  const document = await task.promise;
  let text = ''; let pagesRead = 0;
  try {
    for (let page = 1; page <= Math.min(document.numPages, 12); page++) {
      const current = await document.getPage(page);
      const content = await current.getTextContent();
      text += content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('') + '\n';
      current.cleanup(); pagesRead++;
      if (text.length >= 200_000) break;
    }
    return { text: text.slice(0, 200_000).trim(), method: 'pdfjs-text', limited: pagesRead < document.numPages || text.length >= 200_000 };
  } finally { await task.destroy(); }
}
void extract().then((result) => parentPort!.postMessage({ ok: true, ...result }),
  (error: unknown) => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }));
