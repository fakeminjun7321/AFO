#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit|NotebookEdit): 역할별 편집 범위를 강제한다.
// 서브에이전트 호출이면 훅 입력에 agent_type이 들어오므로 하나의 프로젝트 훅으로 역할을 구분한다.
import { readStdinJson, roleOf, toRel, decideEdit, currentTask, projectDir, appendLine, nowIso } from '../lib/core.mjs';

const input = await readStdinJson();
const root = projectDir();
const role = roleOf(input);
const ti = input.tool_input || {};
const filePath = ti.file_path || ti.notebook_path || ti.path;
const rel = toRel(filePath, root);
const d = decideEdit({ role, rel, task: currentTask(root) });

if (d.decision !== 'allow') {
  appendLine('.afo/state/hook.log', JSON.stringify({ ts: nowIso(), hook: 'guard-edit', role, path: rel ?? filePath, decision: d.decision, reason: d.reason }), root);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d.decision,
      permissionDecisionReason: `[AFO 하네스] ${d.reason}`,
    },
  }));
}
process.exit(0);
