import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist/resources');
await mkdir(out, { recursive: true });
await build({ entryPoints: [path.join(root, 'packages/filesystem/src/text-worker.ts')], outfile: path.join(out, 'text-worker.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'warning' });
await build({ entryPoints: [path.join(root, 'packages/filesystem/src/pdf-worker.ts')], outfile: path.join(out, 'pdf-worker.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning', external: ['@napi-rs/canvas'] });
const pdfData = {};
for (const directory of ['cmaps', 'standard_fonts']) for (const name of await readdir(path.join(root, 'node_modules/pdfjs-dist', directory)))
  if (/\.(bcmap|pfb|ttf)$/u.test(name)) pdfData[`${directory}/${name}`] = new Uint8Array(await readFile(path.join(root, 'node_modules/pdfjs-dist', directory, name)));
await writeFile(path.join(out, 'pdf-data.zip'), zipSync(pdfData, { level: 6 }));
if (process.platform === 'darwin') {
  const source = path.join(root, 'packages/filesystem/native/Inspect.swift');
  const fingerprint = createHash('sha256').update(await readFile(source)).update('universal-macos13-v1').digest('hex');
  const binary = path.join(out, 'afo-native'); const marker = path.join(out, 'native.sha256');
  let cached = false;
  try { cached = (await readFile(marker, 'utf8')) === fingerprint; await access(binary); } catch { cached = false; }
  if (!cached) {
    for (const arch of ['arm64', 'x86_64']) execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos13.0`,
      source, '-o', `${binary}-${arch}`, '-framework', 'Vision', '-framework', 'PDFKit', '-framework', 'ImageIO', '-framework', 'CoreGraphics'], { stdio: 'inherit' });
    execFileSync('/usr/bin/lipo', ['-create', `${binary}-arm64`, `${binary}-x86_64`, '-output', binary], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--sign', '-', binary], { stdio: 'inherit' });
    await writeFile(marker, fingerprint);
  }
}
