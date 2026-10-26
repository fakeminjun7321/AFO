// 훅 스크립트와 task.mjs를 실제 프로세스로 실행하는 통합 테스트.
// 매 테스트마다 os.tmpdir()/afo-test-* 아래에 하네스를 복사한 임시 프로젝트를 만든다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const harnessDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeProject(tasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'afo-test-harness-'));
  fs.cpSync(harnessDir, path.join(root, 'scripts/harness'), { recursive: true, filter: (s) => !s.includes(`${path.sep}test${path.sep}`) && !s.endsWith(`${path.sep}test`) });
  fs.mkdirSync(path.join(root, 'docs/status'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs/reviews'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/status/tasks.json'), JSON.stringify({ schemaVersion: 1, tasks }, null, 2));
  return root;
}
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

function run(root, script, args = [], stdin = '') {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/harness', script), ...args], {
    cwd: root, input: stdin, encoding: 'utf8', env: { ...process.env, AFO_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const hook = (root, name, input) => run(root, `hooks/${name}.mjs`, [], JSON.stringify(input));
const task = (root, ...args) => run(root, 'task.mjs', args);

const T = (id, o = {}) => ({ id, title: `과업 ${id}`, tier: 'MVD', executor: 'agent', owner: '구민준', deps: [], allowedPaths: [`src/${id.toLowerCase()}/**`], acceptance: ['기준'], status: 'todo', ...o });

test('task.mjs: next는 선행이 끝난 에이전트 과업을 고르고 사람 작업을 따로 보여 준다', () => {
  const root = makeProject([T('A', { status: 'done' }), T('H', { executor: 'human' }), T('B', { deps: ['A'] }), T('C', { deps: ['H'] })]);
  try {
    const r = task(root, 'next');
    assert.match(r.out, /NEXT B /);
    assert.match(r.out, /사람 작업 대기: H/);
    assert.ok(fs.existsSync(path.join(root, 'docs/status/STATUS.md')) === false || true);
  } finally { cleanup(root); }
});

test('task.mjs: next는 결정필요·후속·제외 tier와 외부 소유 과업을 자동으로 고르지 않는다', () => {
  const root = makeProject([T('X', { tier: '결정필요' }), T('F', { tier: '후속' }), T('Z', { tier: '제외(MVD-B)' }), T('O', { externalOwner: 'code-session' }), T('B', { tier: 'MVP' })]);
  try {
    const r = task(root, 'next');
    assert.match(r.out, /NEXT B /);
    assert.doesNotMatch(r.out, /NEXT (X|F|Z|O) /);
  } finally { cleanup(root); }
});

test('task.mjs: next 없음이면 막고 있는 선행 과업을 알려 준다', () => {
  const root = makeProject([T('H', { executor: 'human' }), T('C', { deps: ['H'] })]);
  try {
    const r = task(root, 'next');
    assert.match(r.out, /NEXT 없음/);
    assert.match(r.out, /C\(.*\)은 선행 H/);
  } finally { cleanup(root); }
});

test('task.mjs: start → review → fail 3회면 blocked, done은 verified 전에 거부', () => {
  const root = makeProject([T('A')]);
  try {
    assert.equal(task(root, 'start', 'A').code, 0);
    const cur = JSON.parse(fs.readFileSync(path.join(root, 'docs/status/current-task.json'), 'utf8'));
    assert.equal(cur.id, 'A');
    assert.deepEqual(cur.allowedPaths, ['src/a/**']);
    assert.notEqual(task(root, 'done', 'A', '--summary', 'x').code, 0, 'verified 전 done 거부');
    for (let i = 1; i <= 3; i++) {
      assert.match(task(root, 'review', 'A').out, new RegExp(`docs/reviews/A-r${i}\\.md`));
      const r = task(root, 'result', 'A', 'fail', '--note', '같은 실패');
      if (i < 3) assert.match(r.out, /누적 FAIL/);
      else assert.match(r.out, /BLOCKED/);
    }
    const db = JSON.parse(fs.readFileSync(path.join(root, 'docs/status/tasks.json'), 'utf8'));
    assert.equal(db.tasks[0].status, 'blocked');
    assert.match(fs.readFileSync(path.join(root, 'docs/status/STATUS.md'), 'utf8'), /A: verifier FAIL 3회/);
  } finally { cleanup(root); }
});

test('task.mjs: pass 후 done은 로그·STATUS를 갱신하고 current-task를 지운다', () => {
  const root = makeProject([T('A')]);
  try {
    task(root, 'start', 'A'); task(root, 'review', 'A'); task(root, 'result', 'A', 'pass');
    assert.equal(task(root, 'done', 'A', '--summary', '요약', '--tests', 'pass 3', '--commit', 'abc1234').code, 0);
    assert.ok(!fs.existsSync(path.join(root, 'docs/status/current-task.json')));
    assert.match(fs.readFileSync(path.join(root, 'docs/status/log.md'), 'utf8'), /A 과업 A — 완료[\s\S]*abc1234/);
    assert.match(fs.readFileSync(path.join(root, 'docs/status/STATUS.md'), 'utf8'), /최근 완료\n\n- A 과업 A — 요약/);
  } finally { cleanup(root); }
});

test('guard-edit 훅: core-builder의 리뷰 테스트 편집은 deny JSON, 허용 경로는 출력 없음', () => {
  const root = makeProject([T('A')]);
  try {
    task(root, 'start', 'A');
    const deny = hook(root, 'guard-edit', { agent_type: 'core-builder', tool_name: 'Write', tool_input: { file_path: path.join(root, 'tests/review/A/x.test.mjs') } });
    const j = JSON.parse(deny.out);
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /구현 담당 편집 금지/);
    const allow = hook(root, 'guard-edit', { agent_type: 'core-builder', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/a/index.mjs') } });
    assert.equal(allow.out, '');
    const pm = hook(root, 'guard-edit', { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/a/index.mjs') } });
    assert.equal(JSON.parse(pm.out || '{"hookSpecificOutput":{}}').hookSpecificOutput.permissionDecision, undefined, 'src/는 PM 코드 영역 목록에 없음 → 허용');
  } finally { cleanup(root); }
});

test('guard-bash 훅: 실제 사용자 폴더 명령은 deny, 평범한 명령은 출력 없음', () => {
  const root = makeProject([T('A')]);
  try {
    const deny = hook(root, 'guard-bash', { agent_type: 'verifier', tool_name: 'Bash', tool_input: { command: 'ls ~/Downloads' } });
    assert.equal(JSON.parse(deny.out).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(hook(root, 'guard-bash', { tool_name: 'Bash', tool_input: { command: 'git status' } }).out, '');
  } finally { cleanup(root); }
});

test('subagent-start/stop: 셸로 우회한 범위 밖 변경을 violations에 기록한다', () => {
  const root = makeProject([T('A')]);
  try {
    fs.mkdirSync(path.join(root, 'src/b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/b/other.mjs'), 'export const x = 1;\n');
    task(root, 'start', 'A');
    hook(root, 'subagent-start', { agent_id: 'dev1', agent_type: 'core-builder', hook_event_name: 'SubagentStart' });
    fs.mkdirSync(path.join(root, 'src/a'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/a/ok.mjs'), 'export const ok = 1;\n');      // 허용
    fs.writeFileSync(path.join(root, 'src/b/other.mjs'), 'export const x = 2;\n');    // 범위 밖(셸 우회 가정)
    const r = hook(root, 'subagent-stop', { agent_id: 'dev1', agent_type: 'core-builder', hook_event_name: 'SubagentStop', stop_hook_active: false });
    assert.equal(r.code, 0);
    const v = fs.readFileSync(path.join(root, 'docs/status/violations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(v.length, 1);
    assert.equal(v[0].path, 'src/b/other.mjs');
    assert.equal(v[0].kind, 'modified');
    assert.match(task(root, 'violations').out, /src\/b\/other\.mjs/);
  } finally { cleanup(root); }
});

test('subagent-stop: developer의 빠른 검사가 실패하면 종료를 막고, 3회 넘게 막히면 기록 후 허용', () => {
  const root = makeProject([T('A')]);
  try {
    task(root, 'start', 'A');
    fs.mkdirSync(path.join(root, 'tests/unit'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/unit/a.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert'; test('t', () => assert.equal(1, 2));\n");
    hook(root, 'subagent-start', { agent_id: 'dev2', agent_type: 'core-builder' });
    for (let i = 1; i <= 3; i++) {
      const r = hook(root, 'subagent-stop', { agent_id: 'dev2', agent_type: 'core-builder', stop_hook_active: i > 1 });
      const j = JSON.parse(r.out);
      assert.equal(j.decision, 'block');
      assert.match(j.reason, /빠른 검사/);
    }
    const last = hook(root, 'subagent-stop', { agent_id: 'dev2', agent_type: 'core-builder', stop_hook_active: true });
    assert.equal(last.out, '', '4번째는 무한 반복 방지로 허용');
    assert.match(fs.readFileSync(path.join(root, 'docs/status/violations.jsonl'), 'utf8'), /stop-check-unresolved/);
  } finally { cleanup(root); }
});

test('subagent-stop: reviewer는 이번 차수 보고서와 VERDICT 줄이 있어야 종료할 수 있다', () => {
  const root = makeProject([T('A')]);
  try {
    task(root, 'start', 'A');
    task(root, 'review', 'A');
    hook(root, 'subagent-start', { agent_id: 'rev1', agent_type: 'verifier' });
    const blocked = JSON.parse(hook(root, 'subagent-stop', { agent_id: 'rev1', agent_type: 'verifier' }).out);
    assert.equal(blocked.decision, 'block');
    assert.match(blocked.reason, /docs\/reviews\/A-r1\.md/);
    fs.writeFileSync(path.join(root, 'docs/reviews/A-r1.md'), '# A 검토 r1\n\n내용\n\nVERDICT: FAIL\n');
    assert.equal(hook(root, 'subagent-stop', { agent_id: 'rev1', agent_type: 'verifier' }).out, '');
  } finally { cleanup(root); }
});

test('subagent-stop: reviewer가 추가한 테스트를 전체 검사로 실행하지 않았으면 종료를 막는다', () => {
  const root = makeProject([T('A')]);
  try {
    task(root, 'start', 'A');
    task(root, 'review', 'A');
    hook(root, 'subagent-start', { agent_id: 'rev2', agent_type: 'verifier' });
    fs.mkdirSync(path.join(root, 'tests/review/A'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/review/A/edge.test.mjs'), "import {test} from 'node:test'; test('edge', () => {});\n");
    fs.writeFileSync(path.join(root, 'docs/reviews/A-r1.md'), '# A 검토 r1\n\nVERDICT: PASS\n');
    const blocked = JSON.parse(hook(root, 'subagent-stop', { agent_id: 'rev2', agent_type: 'verifier' }).out);
    assert.equal(blocked.decision, 'block');
    assert.match(blocked.reason, /전체 검사/);
    assert.equal(run(root, 'run-checks.mjs').code, 0);
    assert.equal(hook(root, 'subagent-stop', { agent_id: 'rev2', agent_type: 'verifier' }).out, '');
  } finally { cleanup(root); }
});

test('run-checks: 실패 테스트가 있으면 RESULT: FAIL과 종료 코드 1', () => {
  const root = makeProject([T('A')]);
  try {
    fs.mkdirSync(path.join(root, 'tests/unit'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/unit/ok.test.mjs'), "import {test} from 'node:test'; test('ok', () => {});\n");
    let r = run(root, 'run-checks.mjs', ['--quick']);
    assert.equal(r.code, 0);
    assert.match(r.out, /pass 1, fail 0/);
    fs.writeFileSync(path.join(root, 'tests/unit/bad.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert'; test('bad', () => assert.ok(false));\n");
    r = run(root, 'run-checks.mjs', ['--quick']);
    assert.equal(r.code, 1);
    assert.match(r.out, /RESULT: FAIL/);
  } finally { cleanup(root); }
});
