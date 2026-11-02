import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AFO_VERSION } from '../apps/cli/src/version.js';

const repo = (file: string): string => readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
const cli = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));

test('afo --version prints the package.json version (the release workflow also checks the tag)', () => {
  assert.equal(AFO_VERSION, JSON.parse(repo('package.json')).version);
  const shown = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout.trim(), `afo ${AFO_VERSION}`);
});

test('installers download the archive names that build-binaries.mjs produces', () => {
  const build = repo('scripts/release/build-binaries.mjs');
  for (const target of ['darwin-arm64', 'darwin-x64', 'win-x64']) assert.match(build, new RegExp(`'${target}': \\{`, 'u'));
  assert.match(repo('install.sh'), /archive="afo-\$target\.tar\.gz"/u);
  assert.match(repo('install.sh'), /target="darwin-arm64"/u);
  assert.match(repo('install.sh'), /target="darwin-x64"/u);
  assert.match(repo('install.ps1'), /\$archive = 'afo-win-x64\.zip'/u);
});
