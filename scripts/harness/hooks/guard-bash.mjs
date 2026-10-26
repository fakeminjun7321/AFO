#!/usr/bin/env node
// PreToolUse(Bash): 실제 사용자 폴더 접근, 파괴적 명령, 서브에이전트의 git 쓰기·병합을 막는다.
// 문자열 검사이므로 보안 경계가 아니라 사고 방지 장치다. 셸 우회 변경은 subagent-stop이 탐지한다.
import { readStdinJson, roleOf, decideBash, projectDir, appendLine, nowIso } from '../lib/core.mjs';

const input = await readStdinJson();
const root = projectDir();
const role = roleOf(input);
const command = (input.tool_input || {}).command || '';
const d = decideBash({ role, command });

if (d.decision !== 'allow') {
  appendLine('.afo/state/hook.log', JSON.stringify({ ts: nowIso(), hook: 'guard-bash', role, command: command.slice(0, 300), decision: d.decision, reason: d.reason }), root);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d.decision,
      permissionDecisionReason: `[AFO 하네스] ${d.reason}`,
    },
  }));
}
process.exit(0);
