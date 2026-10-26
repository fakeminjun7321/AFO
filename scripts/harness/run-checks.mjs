#!/usr/bin/env node
// AFO 검사 실행기. 실제 실행 결과로만 통과/실패를 판정한다.
//   node scripts/harness/run-checks.mjs           전체: 하네스 자체 테스트 + 프로젝트 테스트 + 리뷰 테스트 + npm 스크립트
//   node scripts/harness/run-checks.mjs --quick   빠른: 프로젝트 테스트(tests/review 제외) + npm 스크립트
// 결과 요약은 .afo/last-checks.json에 남긴다. 실패가 하나라도 있으면 종료 코드 1.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectDir, writeJson, nowIso } from './lib/core.mjs';

const root = projectDir();
const quick = process.argv.includes('--quick');

function findTests(dirRel, { exclude = [] } = {}) {
  const out = [];
  const start = path.join(root, dirRel);
  if (!fs.existsSync(start)) return out;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (exclude.some((x) => rel.startsWith(x))) continue;
      if (e.isDirectory()) walk(full);
      else if (/\.test\.(mjs|js|cjs)$/.test(e.name)) out.push(rel);
    }
  })(start);
  return out.sort();
}

function runNodeTests(label, files) {
  if (files.length === 0) return { label, skipped: true, reason: '테스트 파일 없음', pass: 0, fail: 0, ok: true };
  // 부모가 node --test이면 NODE_TEST_CONTEXT가 상속되어 자식 출력 형식이 바뀌므로 지운다.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd: root, encoding: 'utf8', timeout: 600_000, env });
  const outText = `${r.stdout || ''}${r.stderr || ''}`;
  const num = (k) => { const m = outText.match(new RegExp(`ℹ ${k} (\\d+)`)); return m ? Number(m[1]) : null; };
  const pass = num('pass') ?? 0;
  const fail = num('fail') ?? (r.status === 0 ? 0 : 1);
  return { label, files, pass, fail, ok: r.status === 0 && fail === 0, output: outText };
}

function runNpmScript(name) {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg.scripts || !pkg.scripts[name]) return null;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', '-s', name], { cwd: root, encoding: 'utf8', timeout: 600_000, shell: process.platform === 'win32' });
  return { label: `npm run ${name}`, ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}` };
}

/** package.json에 의존성이 있는데 node_modules가 없으면 npm 검사를 성공으로 처리하지 않는다. */
function dependencyCheck() {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const missing = Object.keys(deps).filter((d) => !fs.existsSync(path.join(root, 'node_modules', ...d.split('/'))));
  const want = (pkg.engines && pkg.engines.node) || '';
  const major = Number(process.versions.node.split('.')[0]);
  const m = want.match(/>=\s*(\d+)(?:\s*<\s*(\d+))?/);
  const nodeOk = !m || (major >= Number(m[1]) && (!m[2] || major < Number(m[2])));
  return { pkg, missing, nodeOk, want };
}

const results = [];
if (!quick) results.push(runNodeTests('하네스 자체 테스트', findTests('scripts/harness/test')));
results.push(runNodeTests('프로젝트 테스트(.mjs)', findTests('tests', { exclude: ['tests/review/'] })));
if (!quick) results.push(runNodeTests('리뷰 테스트(.mjs)', findTests('tests/review')));

const dep = dependencyCheck();
if (dep && dep.missing.length) {
  results.push({ label: 'npm 검사(typecheck·test)', ok: false, output: `의존성 미설치: ${dep.missing.join(', ')} — 먼저 \`npm ci\`를 실행하세요. 설치 없이 통과로 처리하지 않습니다.` });
} else if (dep) {
  if (!dep.nodeOk) console.log(`주의: Node ${process.versions.node}는 package.json engines(${dep.want})와 다릅니다. 결과가 CI와 다를 수 있습니다.`);
  for (const s of ['lint', 'typecheck', 'test']) {
    const r = runNpmScript(s);
    if (r) results.push(r);
  }
  // TypeScript 리뷰 테스트: npm test가 빌드한 dist/tests/review/**/*.test.js를 따로 실행한다(npm test는 최상위만 실행).
  if (!quick) results.push(runNodeTests('리뷰 테스트(TS 빌드)', findTests('dist/tests/review')));
}

const ok = results.every((r) => r.ok);
for (const r of results) {
  const head = r.skipped ? `- ${r.label}: 건너뜀(${r.reason})`
    : r.pass !== undefined ? `- ${r.label}: ${r.ok ? '통과' : '실패'} (pass ${r.pass}, fail ${r.fail}, 파일 ${r.files.length}개)`
    : `- ${r.label}: ${r.ok ? '통과' : '실패'}`;
  console.log(head);
  if (!r.ok && r.output) console.log(r.output.split('\n').filter((l) => /✖|not ok|Error|expected|actual|fail/i.test(l)).slice(0, 30).join('\n'));
}
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');

writeJson('.afo/last-checks.json', {
  at: nowIso(),
  mode: quick ? 'quick' : 'full',
  ok,
  results: results.map(({ output, ...rest }) => rest),
});
process.exit(ok ? 0 : 1);
