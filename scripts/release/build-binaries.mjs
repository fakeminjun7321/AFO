#!/usr/bin/env node
// Builds the single executables that install.sh and install.ps1 download from GitHub Releases.
//   node scripts/release/build-binaries.mjs [--targets darwin-arm64,darwin-x64,win-x64] [--out release]
// Node.js single executable application (SEA): one CommonJS bundle of apps/cli/src/sea.ts, a blob made by this same
// Node version, injected into each target's official Node binary (downloaded from nodejs.org and checked against
// SHASUMS256.txt). macOS targets need a macOS host for the ad-hoc `codesign` that arm64 requires.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { inject } from 'postject';

const root = path.resolve(import.meta.dirname, '../..');
const node = process.version;
const targets = {
  'darwin-arm64': { dist: `node-${node}-darwin-arm64.tar.gz`, binary: `node-${node}-darwin-arm64/bin/node`, exe: 'afo', archive: 'tar.gz' },
  'darwin-x64': { dist: `node-${node}-darwin-x64.tar.gz`, binary: `node-${node}-darwin-x64/bin/node`, exe: 'afo', archive: 'tar.gz' },
  'win-x64': { dist: `node-${node}-win-x64.zip`, binary: `node-${node}-win-x64/node.exe`, exe: 'afo.exe', archive: 'zip' },
};
const hostTarget = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;

const { values } = parseArgs({ options: { targets: { type: 'string' }, out: { type: 'string' }, 'update-fixture': { type: 'boolean' } } });
const out = path.resolve(root, values.out ?? 'release');
if (values['update-fixture'] && (!values.out || out === path.join(root, 'release')))
  throw new Error('업데이트 검증 빌드는 공개 release 폴더 밖의 별도 --out 경로가 필요합니다.');
const wanted = (values.targets ?? Object.keys(targets).join(',')).split(',');
for (const name of wanted) if (!(name in targets)) throw new Error(`알 수 없는 대상: ${name} (가능: ${Object.keys(targets).join(', ')})`);
if (wanted.some((name) => name.startsWith('darwin-')) && process.platform !== 'darwin')
  throw new Error('macOS 실행 파일은 codesign이 필요해 macOS에서만 만들 수 있습니다.');

const { version: packageVersion } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = values['update-fixture'] ? '0.0.0' : packageVersion;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const run = (file, args) => execFileSync(file, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();

await rm(out, { recursive: true, force: true });
const work = path.join(out, 'work');
await mkdir(work, { recursive: true });

// import.meta.url → undefined: isEntryPoint() in index.ts is then false and only sea.ts starts the CLI.
const bundle = path.join(work, 'afo.cjs');
await build({
  entryPoints: [path.join(root, 'apps/cli/src/sea.ts')], outfile: bundle, bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', define: { 'import.meta.url': 'undefined' }, logLevel: 'warning',
  // A synthetic older updater exercises self-replacement on every runner, without editing the checkout or publishing it.
  plugins: values['update-fixture'] ? [{ name: 'update-fixture-version', setup(builder) {
    builder.onLoad({ filter: /[/\\]apps[/\\]cli[/\\]src[/\\]version\.ts$/ }, () => ({
      contents: "export const AFO_VERSION = '0.0.0';", loader: 'ts',
    }));
  } }] : [],
});
const seaConfig = path.join(work, 'sea-config.json');
const blob = path.join(work, 'sea-prep.blob');
await writeFile(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
run(process.execPath, ['--experimental-sea-config', seaConfig]);
const blobData = await readFile(blob);

const sums = (await (await fetch(`https://nodejs.org/dist/${node}/SHASUMS256.txt`)).text()).split('\n');
const notices = [[path.join(root, 'LICENSE'), 'LICENSE'], [path.join(root, 'node_modules/zod/LICENSE'), 'LICENSE-zod']];
const lines = [];
for (const name of wanted) {
  const t = targets[name];
  const dir = path.join(work, name);
  await mkdir(dir, { recursive: true });
  const response = await fetch(`https://nodejs.org/dist/${node}/${t.dist}`);
  if (!response.ok) throw new Error(`${t.dist} 다운로드 실패: HTTP ${response.status}`);
  const download = Buffer.from(await response.arrayBuffer());
  const expected = sums.find((line) => line.endsWith(`  ${t.dist}`))?.split('  ')[0];
  if (!expected || expected !== sha256(download)) throw new Error(`${t.dist}의 SHA-256이 nodejs.org SHASUMS256.txt와 다릅니다.`);
  await writeFile(path.join(dir, t.dist), download);
  // bsdtar (macOS, Windows) reads both .tar.gz and .zip.
  run('tar', ['-xf', path.join(dir, t.dist), '-C', dir, t.binary, t.binary.replace(/(bin\/)?node(\.exe)?$/u, 'LICENSE')]);

  const exe = path.join(dir, t.exe);
  await copyFile(path.join(dir, t.binary), exe);
  await chmod(exe, 0o755);
  if (name.startsWith('darwin-')) run('codesign', ['--remove-signature', exe]);
  await inject(exe, 'NODE_SEA_BLOB', blobData, {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(name.startsWith('darwin-') ? { machoSegmentName: 'NODE_SEA' } : {}),
  });
  if (name.startsWith('darwin-')) run('codesign', ['--sign', '-', exe]);
  if (name === hostTarget) {
    const shown = run(exe, ['--version']).trim();
    if (shown !== `afo ${version}`) throw new Error(`${name} 실행 확인 실패: "${shown}" (기대: "afo ${version}")`);
  }

  for (const [from, to] of notices) await copyFile(from, path.join(dir, to));
  await copyFile(path.join(dir, t.binary.replace(/(bin\/)?node(\.exe)?$/u, 'LICENSE')), path.join(dir, 'LICENSE-node'));
  const archive = `afo-${name}.${t.archive}`;
  const files = [t.exe, ...notices.map(([, to]) => to), 'LICENSE-node'];
  run('tar', [...(t.archive === 'zip' ? ['--format', 'zip', '-cf'] : ['-czf']), path.join(out, archive), '-C', dir, ...files]);
  const data = await readFile(path.join(out, archive));
  lines.push(`${sha256(data)}  ${archive}`);
  console.log(`${archive}  ${(data.length / 1024 / 1024).toFixed(1)} MiB`);
}
await writeFile(path.join(out, 'SHA256SUMS'), `${lines.join('\n')}\n`);
await rm(work, { recursive: true, force: true });
console.log(`afo ${version} (Node ${node}) → ${path.relative(root, out) || '.'}`);
