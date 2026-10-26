#!/usr/bin/env node
// SubagentStart: 구현 담당·verifier가 시작할 때 프로젝트 파일 스냅샷을 저장한다.
// 종료 시(subagent-stop) 이 스냅샷과 비교해 셸로 우회한 범위 밖 변경까지 탐지한다.
import { readStdinJson, roleOf, isWorker, isBuilder, VERIFIER, snapshot, writeJson, currentTask, projectDir, nowIso } from '../lib/core.mjs';

const input = await readStdinJson();
const role = roleOf(input);
if (isWorker(role)) {
  const root = projectDir();
  const task = currentTask(root);
  writeJson(`.afo/state/agents/${input.agent_id || 'unknown'}.json`, {
    agentId: input.agent_id,
    role,
    taskId: task ? task.id : null,
    reviewRound: task ? task.reviewRound : null,
    startedAt: nowIso(),
    stopBlocks: 0,
    files: snapshot(root),
  }, root);
}
process.exit(0);
