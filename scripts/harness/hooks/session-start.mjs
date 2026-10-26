#!/usr/bin/env node
// SessionStart: 저장된 작업 상태를 짧게 출력한다(세션 재개용 맥락).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { projectDir } from '../lib/core.mjs';

const root = projectDir();
const r = spawnSync(process.execPath, [path.join(root, 'scripts/harness/task.mjs'), 'status', '--brief'], { cwd: root, encoding: 'utf8' });
process.stdout.write(`[AFO 작업 상태 — 세션 시작 시 자동 출력]\n${(r.stdout || '').trim()}\n자세한 내용: docs/status/STATUS.md · 이어서 진행하려면 /afo-resume\n`);
process.exit(0);
