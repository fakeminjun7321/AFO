#!/usr/bin/env node
// SubagentStop: 구현 담당·verifier 종료 시 검사한다.
//  1) 시작 스냅샷 대비 변경된 파일 중 역할 허용 범위 밖 변경 → docs/status/violations.jsonl에 기록
//  2) 구현 담당: 빠른 검사(run-checks --quick)가 실패하면 종료를 막고 실패 내용을 돌려준다
//  3) verifier: 이번 차수 보고서(docs/reviews/<ID>-r<n>.md)와 VERDICT 줄이 없으면 종료를 막는다
// 같은 에이전트가 3번 막히면 무한 반복을 피하려고 종료를 허용하고 그 사실을 기록한다.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  readStdinJson, roleOf, isWorker, isBuilder, VERIFIER, snapshot, diffSnapshots, readJson, writeJson, appendLine,
  allowedForRole, currentTask, projectDir, nowIso, P,
} from '../lib/core.mjs';

const MAX_BLOCKS = 3;
const input = await readStdinJson();
const role = roleOf(input);
if (!isWorker(role)) process.exit(0);

const root = projectDir();
const stateRel = `.afo/state/agents/${input.agent_id || 'unknown'}.json`;
const state = readJson(stateRel, null, root);
const task = currentTask(root);
const problems = [];

// 1) 범위 밖 변경 탐지
let changed = [];
if (state && state.files) {
  changed = diffSnapshots(state.files, snapshot(root));
  for (const c of changed) {
    if (!allowedForRole(role, c.path, task)) {
      appendLine(P.violations, JSON.stringify({ ts: nowIso(), agentId: input.agent_id, role, taskId: task?.id ?? null, path: c.path, kind: c.kind }), root);
      problems.push(`범위 밖 변경(${c.kind}): ${c.path} — 기록됨. 되돌리려 하지 말고 보고서에 적으세요.`);
    }
  }
}

// 2) 구현 담당: 빠른 검사
let block = null;
if (isBuilder(role)) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/harness/run-checks.mjs'), '--quick'], { cwd: root, encoding: 'utf8', timeout: 540_000 });
  if (r.status !== 0) {
    const tail = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n').slice(-25).join('\n');
    block = `빠른 검사(node scripts/harness/run-checks.mjs --quick)가 실패했습니다. 고친 뒤 다시 실행하고 끝내세요. 고칠 수 없다면 실패 사실을 보고서에 그대로 적으세요.\n${tail}`;
  }
}

// 3) verifier: 보고서 확인
if (role === VERIFIER && task) {
  const reportRel = `docs/reviews/${task.id}-r${task.reviewRound}.md`;
  const reportAbs = path.join(root, reportRel);
  const touched = changed.some((c) => c.path === reportRel);
  let ok = false;
  if (fs.existsSync(reportAbs) && touched) {
    const lines = fs.readFileSync(reportAbs, 'utf8').trim().split(/\r?\n/);
    ok = /^VERDICT: (PASS|FAIL)$/.test(lines[lines.length - 1].trim());
  }
  if (!ok) block = `검토 보고서 ${reportRel}를 이번 검토에서 작성하고, 마지막 줄을 정확히 'VERDICT: PASS' 또는 'VERDICT: FAIL'로 끝내세요.`;

  // 추가한 리뷰 테스트를 실제로 실행했는지: 전체 검사 기록이 리뷰 테스트의 마지막 수정보다 나중이어야 한다.
  const reviewDir = path.join(root, 'tests/review', task.id);
  if (!block && fs.existsSync(reviewDir)) {
    let latest = 0;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else latest = Math.max(latest, fs.statSync(full).mtimeMs);
      }
    })(reviewDir);
    const checks = readJson('.afo/last-checks.json', null, root);
    const ranAfter = checks && checks.mode === 'full' && Date.parse(checks.at) >= latest;
    if (!ranAfter) block = `tests/review/${task.id}/의 테스트를 작성·수정한 뒤 전체 검사(node scripts/harness/run-checks.mjs)를 다시 실행하지 않았습니다. 실행하고 결과를 보고서에 반영한 뒤 끝내세요.`;
  }
}

if (block && state) {
  state.stopBlocks = (state.stopBlocks || 0) + 1;
  if (state.stopBlocks > MAX_BLOCKS) {
    appendLine(P.violations, JSON.stringify({ ts: nowIso(), agentId: input.agent_id, role, taskId: task?.id ?? null, kind: 'stop-check-unresolved', detail: block.split('\n')[0] }), root);
    writeJson(stateRel, { ...state, endedAt: nowIso(), unresolved: block }, root);
    process.exit(0);
  }
  writeJson(stateRel, state, root);
  const reason = [block, ...problems].join('\n');
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

if (state) writeJson(stateRel, { ...state, files: undefined, endedAt: nowIso(), changed, problems }, root);
process.exit(0);
