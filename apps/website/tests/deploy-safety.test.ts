import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const project = "afo-hackathon-2026-7321";
const credential = JSON.stringify({ type: "service_account", project_id: project,
  client_email: `afo-hosting-cd@${project}.iam.gserviceaccount.com`, private_key: "-----BEGIN PRIVATE KEY-----\nFAKE\n" });
const source = resolve("scripts");
function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim(); }
function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), "afo-deploy-test-"));
  const repo = join(tmp, "repo"), remote = join(tmp, "remote.git"), runner = join(tmp, "runner");
  mkdirSync(repo); mkdirSync(runner); git(tmp, "init", "--bare", "--quiet", remote);
  git(tmp, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "AFO Test"); git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "core.hooksPath", "/dev/null"); git(repo, "remote", "add", "origin", remote);
  for (const dir of ["apps/website/scripts", "apps/website/src/config", "apps/website/dist", "firebase/node_modules/firebase-tools/lib/bin"]) mkdirSync(join(repo, dir), { recursive: true });
  copyFileSync(join(source, "deploy-hosting.sh"), join(repo, "apps/website/scripts/deploy-hosting.sh"));
  copyFileSync(join(source, "check-hosting-build.mjs"), join(repo, "apps/website/scripts/check-hosting-build.mjs"));
  writeFileSync(join(repo, "apps/website/firebase.json"), JSON.stringify({ hosting: { site: project, public: "dist", rewrites: [{ source: "**", destination: "/index.html" }] } }));
  writeFileSync(join(repo, "apps/website/src/config/services.public.json"), JSON.stringify({ adminApi: false }));
  writeFileSync(join(repo, "apps/website/dist/index.html"), "test build");
  writeFileSync(join(repo, "firebase/node_modules/firebase-tools/lib/bin/firebase.js"), `const fs=require('fs');const p=process.env.GOOGLE_APPLICATION_CREDENTIALS;const c=JSON.parse(fs.readFileSync(p));if(c.project_id!==${JSON.stringify(project)})process.exit(2);fs.writeFileSync(process.env.AFO_FAKE_CAPTURE,JSON.stringify({args:process.argv.slice(2),mode:fs.statSync(p).mode & 0o777,path:p}));`);
  git(repo, "add", "--force", "."); git(repo, "commit", "--quiet", "-m", "initial"); git(repo, "push", "--quiet", "-u", "origin", "main");
  const sha = git(repo, "rev-parse", "HEAD"), capture = join(tmp, "capture.json");
  const bin = join(tmp, "bin"); mkdirSync(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, `#!/bin/sh\nif [ "\${AFO_FIREBASE_CREDENTIALS+x}" = x ]; then exit 93; fi\nexec '${realGit}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  const env = { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "fakeminjun7321/AFO", GITHUB_SHA: sha,
    AFO_HOSTING_AUTODEPLOY: "enabled", AFO_FIREBASE_CREDENTIALS: credential, RUNNER_TEMP: runner, AFO_FAKE_CAPTURE: capture, PATH: `${bin}:${process.env.PATH ?? ""}` };
  const run = (changes: Record<string, string> = {}) => spawnSync("bash", ["apps/website/scripts/deploy-hosting.sh"], { cwd: repo, env: { ...env, ...changes }, encoding: "utf8" });
  return { tmp, repo, remote, runner, capture, run, sha };
}

test("deployment guard refuses unapproved contexts and removes temporary credentials", () => {
  const f = fixture();
  try {
    for (const changed of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_REF: "refs/heads/feature" },
      { GITHUB_REPOSITORY: "other/repo" }, { AFO_HOSTING_AUTODEPLOY: "disabled" }, { GITHUB_SHA: "invalid" },
      { AFO_FIREBASE_CREDENTIALS: "" }, { AFO_FIREBASE_CREDENTIALS: '{"type":"bad"}' }]) {
      const result = f.run(changed);
      assert.notEqual(result.status, 0, JSON.stringify(changed));
      assert.equal(existsSync(f.capture), false);
      assert.deepEqual(readdirSync(f.runner), []);
      assert.equal(`${result.stdout}${result.stderr}`.includes("FAKE"), false);
    }
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(readFileSync(f.capture, "utf8"));
    assert.deepEqual(record.args, ["deploy", "--only", "hosting", "--project", project, "--config", "firebase.json", "--non-interactive", "--message", `GitHub main ${f.sha}`]);
    assert.equal(record.mode, 0o600); assert.equal(existsSync(record.path), false);
    assert.deepEqual(readdirSync(f.runner), []);
  } finally { rmSync(f.tmp, { recursive: true, force: true }); }
});

test("newer relevant main changes prevent an older build from deploying", () => {
  const f = fixture();
  try {
    const second = join(f.tmp, "second");
    git(f.tmp, "clone", "--quiet", f.remote, second);
    git(second, "config", "user.name", "AFO Test"); git(second, "config", "user.email", "test@example.invalid"); git(second, "config", "core.hooksPath", "/dev/null");
    writeFileSync(join(second, "apps/website/dist/index.html"), "newer website");
    git(second, "add", "."); git(second, "commit", "--quiet", "-m", "new website"); git(second, "push", "--quiet");
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /newer relevant main change/); assert.equal(existsSync(f.capture), false);
  } finally { rmSync(f.tmp, { recursive: true, force: true }); }
});

test("a later unrelated main change does not suppress the verified website deployment", () => {
  const f = fixture();
  try {
    const second = join(f.tmp, "second");
    git(f.tmp, "clone", "--quiet", f.remote, second);
    git(second, "config", "user.name", "AFO Test"); git(second, "config", "user.email", "test@example.invalid"); git(second, "config", "core.hooksPath", "/dev/null");
    writeFileSync(join(second, "unrelated.md"), "documentation only");
    git(second, "add", "."); git(second, "commit", "--quiet", "-m", "documentation"); git(second, "push", "--quiet");
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(f.capture), true);
  } finally { rmSync(f.tmp, { recursive: true, force: true }); }
});

test("hosting build validation rejects a different site, functions and enabled admin API", () => {
  const f = fixture();
  try {
    const config = join(f.repo, "apps/website/firebase.json"), services = join(f.repo, "apps/website/src/config/services.public.json");
    const check = () => spawnSync("node", ["scripts/check-hosting-build.mjs"], { cwd: join(f.repo, "apps/website"), encoding: "utf8" });
    assert.equal(check().status, 0);
    writeFileSync(config, JSON.stringify({ hosting: { site: "wrong", public: "dist" } })); assert.notEqual(check().status, 0);
    writeFileSync(config, JSON.stringify({ hosting: { site: project, public: "dist" }, functions: [{}] })); assert.notEqual(check().status, 0);
    writeFileSync(config, JSON.stringify({ hosting: { site: project, public: "dist" } })); writeFileSync(services, JSON.stringify({ adminApi: true })); assert.notEqual(check().status, 0);
    writeFileSync(services, JSON.stringify({ adminApi: false }));
    symlinkSync(join(f.tmp, "outside"), join(f.repo, "apps/website/dist/link")); assert.notEqual(check().status, 0);
  } finally { rmSync(f.tmp, { recursive: true, force: true }); }
});
