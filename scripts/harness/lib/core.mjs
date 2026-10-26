// AFO 하네스 공용 라이브러리: 경로·정책·상태 파일 처리.
// 외부 의존성 없이 Node 내장 모듈만 쓴다(Windows·macOS 동일 동작).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 프로젝트 루트: 훅 실행 시 CLAUDE_PROJECT_DIR, 아니면 이 파일 기준 세 단계 위. */
export function projectDir() {
  const fromEnv = process.env.AFO_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR;
  return path.resolve(fromEnv || path.join(here, '..', '..', '..'));
}

export const P = {
  tasks: 'docs/status/tasks.json',
  current: 'docs/status/current-task.json',
  status: 'docs/status/STATUS.md',
  log: 'docs/status/log.md',
  violations: 'docs/status/violations.jsonl',
  stateDir: '.afo/state',
};

export function abs(rel, root = projectDir()) {
  return path.join(root, rel);
}

/** 절대 경로를 프로젝트 기준 상대 경로('/' 구분, NFC)로. 프로젝트 밖이면 null. */
export function toRel(p, root = projectDir()) {
  if (!p) return null;
  const resolved = path.resolve(root, p);
  const rel = path.relative(root, resolved);
  if (rel === '' ) return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/').normalize('NFC');
}

// ---------- glob ----------
/** 간단한 glob → RegExp. 지원: **, *, ?. 대소문자 구분(정책 경로는 소문자로 작성). */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' 는 0개 이상의 디렉터리, 끝의 '**' 는 아무 것
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

export function matchesAny(rel, globs = []) {
  return globs.some((g) => globToRegExp(g).test(rel));
}

// ---------- JSON 상태 ----------
export function readJson(rel, fallback = null, root = projectDir()) {
  try {
    return JSON.parse(fs.readFileSync(abs(rel, root), 'utf8'));
  } catch {
    return fallback;
  }
}

/** 같은 폴더의 임시 파일에 쓰고 rename(하네스 자기 상태 파일 전용). */
export function writeJson(rel, data, root = projectDir()) {
  const target = abs(rel, root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, target);
}

export function appendLine(rel, line, root = projectDir()) {
  const target = abs(rel, root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, line.endsWith('\n') ? line : line + '\n');
}

export function currentTask(root = projectDir()) {
  return readJson(P.current, null, root);
}

// ---------- 역할 ----------
// HARNESS.md의 역할 이름. 메인 세션(agent_type 없음)이 coordinator다.
export const BUILDERS = ['core-builder', 'interface-builder'];
export const VERIFIER = 'verifier';
export const isBuilder = (role) => BUILDERS.includes(role);
export const isWorker = (role) => isBuilder(role) || role === VERIFIER;

// ---------- 편집 정책 ----------
const ALWAYS_DENY = ['.git/**', '.env', '.env.*', '**/.env', '**/.env.*'];
const COORDINATOR_CODE_AREAS = ['packages/**', 'apps/**', 'tests/**', 'sandbox/**'];
const DEV_DENY = [
  'tests/review/**', 'docs/status/**', 'docs/reviews/**', 'docs/harness/**', 'docs/plan/**', 'docs/decisions/**',
  '.claude/**', 'scripts/harness/**', 'AGENTS.md', 'CLAUDE.md', '**/CLAUDE.md', 'CLAUDE.local.md', '.afo/**',
];

/**
 * 편집 허용 여부.
 * @param {{role: string, rel: string|null, task: object|null}} a
 *   role: 'main'(coordinator) | 'core-builder' | 'interface-builder' | 'verifier' | 기타 에이전트 이름
 * @returns {{decision: 'allow'|'deny'|'ask', reason: string}}
 */
export function decideEdit({ role, rel, task }) {
  if (rel === null) {
    return role === 'main'
      ? { decision: 'ask', reason: '프로젝트 폴더 밖 파일 편집입니다.' }
      : { decision: 'deny', reason: '서브에이전트는 프로젝트 폴더 밖 파일을 편집할 수 없습니다.' };
  }
  if (matchesAny(rel, ALWAYS_DENY)) {
    return { decision: 'deny', reason: `${rel}: .git·.env 파일은 누구도 편집하지 않습니다.` };
  }
  if (role === 'main') {
    if (matchesAny(rel, COORDINATOR_CODE_AREAS)) {
      return { decision: 'ask', reason: `${rel}: coordinator(메인 세션)는 구현·테스트를 구현 담당·verifier에게 맡깁니다. 사용자가 직접 지시한 경우에만 진행하세요.` };
    }
    return { decision: 'allow', reason: 'coordinator 편집 범위' };
  }
  if (isBuilder(role)) {
    if (!task) return { decision: 'deny', reason: '활성 과업이 없습니다(docs/status/current-task.json). coordinator가 task.mjs start로 과업을 시작해야 합니다.' };
    if (task.role && isBuilder(task.role) && task.role !== role) {
      return { decision: 'deny', reason: `과업 ${task.id}의 담당 역할은 ${task.role}입니다(${role} 아님). 경로 소유권 규칙(HARNESS.md)에 따라 편집할 수 없습니다.` };
    }
    if (matchesAny(rel, DEV_DENY)) {
      return { decision: 'deny', reason: `${rel}: 구현 담당 편집 금지 경로입니다(verifier 테스트·상태 기록·하네스·지침).` };
    }
    if (matchesAny(rel, task.protectedPaths || [])) {
      return { decision: 'deny', reason: `${rel}: 과업 ${task.id}에서 보호된 경로입니다(먼저 작성된 수용 테스트 등). 고치지 말고 실패 근거를 보고하세요.` };
    }
    if (matchesAny(rel, task.allowedPaths || []) || matchesAny(rel, ['tests/**'])) {
      return { decision: 'allow', reason: '과업 허용 경로' };
    }
    return { decision: 'deny', reason: `${rel}: 과업 ${task.id}의 allowedPaths 밖입니다. 필요하면 수정하지 말고 coordinator에게 보고하세요.` };
  }
  if (role === VERIFIER) {
    if (!task) return { decision: 'deny', reason: '활성 과업이 없습니다.' };
    if (matchesAny(rel, ['docs/reviews/**', `tests/review/${task.id}/**`])) {
      return { decision: 'allow', reason: 'verifier 보고서·추가 테스트 경로' };
    }
    return { decision: 'deny', reason: `${rel}: verifier는 docs/reviews/와 tests/review/${task.id}/ 외에는 편집할 수 없습니다(구현·기존 테스트 수정 금지).` };
  }
  return { decision: 'deny', reason: `에이전트 '${role}'에게는 편집 권한이 없습니다. 구현은 core-builder·interface-builder, 검증은 verifier가 합니다.` };
}

/** 서브에이전트 종료 시 변경 탐지에 쓰는 허용 판정(셸 우회 포함). */
export function allowedForRole(role, rel, task) {
  const d = decideEdit({ role, rel, task });
  return d.decision === 'allow';
}

// ---------- 셸 명령 정책 ----------
const REAL_USER_DIR = new RegExp(
  [
    String.raw`(~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)[\\/]+(Desktop|Documents|Downloads|Pictures|Music|Movies|Videos|OneDrive|iCloud Drive|Library[\\/]+Mobile Documents)`,
    String.raw`/(Users|home)/[^/\s"']+/(Desktop|Documents|Downloads|Pictures|Music|Movies|Videos|OneDrive|Library/Mobile Documents)`,
    String.raw`[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+[\\/]+(Desktop|Documents|Downloads|Pictures|Music|Videos|OneDrive)`,
  ].join('|'),
  'i',
);

const CATASTROPHIC = [
  /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*\s+(-[a-zA-Z]*\s+)*("|')?(\/|~|\$HOME|[A-Za-z]:\\)("|')?(\s|$)/,
  /\b(rmdir|rd)\s+\/s\b/i,
  /\bdel\s+\/s\b/i,
  /Remove-Item\b[^\n]*-Recurse[^\n]*(~|\$HOME|\$env:USERPROFILE|[A-Za-z]:\\\s*$)/i,
  /\bformat\s+[A-Za-z]:/i,
  /\bmkfs\b/,
];

const SUBAGENT_GIT_FORBIDDEN = /\bgit\s+(commit|push|checkout|switch|reset|restore|stash|rebase|merge|cherry-pick|tag|branch\s+-[dDmM]|clean|apply|am)\b/;

/**
 * @param {{role: string, command: string}} a
 * @returns {{decision: 'allow'|'deny'|'ask', reason: string}}
 */
export function decideBash({ role, command }) {
  const cmd = String(command || '');
  if (REAL_USER_DIR.test(cmd)) {
    return { decision: 'deny', reason: '실제 사용자 폴더(바탕화면·문서·다운로드 등)를 가리키는 명령은 금지입니다. 테스트는 os.tmpdir()/afo-test-* 만 사용하세요.' };
  }
  if (CATASTROPHIC.some((r) => r.test(cmd))) {
    return { decision: 'deny', reason: '루트·홈 전체 삭제나 디스크 포맷 같은 파괴적 명령은 금지입니다.' };
  }
  if (/\bgit\s+push\b[^\n]*(--force|\s-f\b|--force-with-lease)/.test(cmd)) {
    return { decision: 'deny', reason: '강제 푸시는 금지입니다.' };
  }
  const isMain = role === 'main';
  if (/\bgh\s+pr\s+merge\b/.test(cmd) || /\bgit\s+push\b[^\n]*\b(main|master)\b/.test(cmd)) {
    return isMain
      ? { decision: 'ask', reason: 'PR 병합·main 푸시는 사용자의 별도 명시 승인이 필요합니다(OK로 갈음 불가).' }
      : { decision: 'deny', reason: '서브에이전트는 병합·푸시를 할 수 없습니다.' };
  }
  if (!isMain) {
    if (SUBAGENT_GIT_FORBIDDEN.test(cmd)) {
      return { decision: 'deny', reason: 'git 이력·브랜치·작업 트리 되돌리기는 coordinator만 합니다. 읽기 명령(status, diff, log, show)만 쓰세요.' };
    }
    if (/\bgh\s+(pr|issue|release|repo)\s+(create|edit|close|delete|merge|comment)\b/.test(cmd)) {
      return { decision: 'deny', reason: 'GitHub 쓰기 작업은 coordinator만 합니다.' };
    }
  }
  if (isMain && /\bgit\s+push\b/.test(cmd)) {
    return { decision: 'ask', reason: '원격 푸시는 사용자 확인 후에 합니다.' };
  }
  return { decision: 'allow', reason: '' };
}

// ---------- 파일 스냅샷(변경 탐지) ----------
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', '.afo', 'dist', 'coverage']);
const SNAPSHOT_SKIP = ['.git/**', 'node_modules/**', '**/node_modules/**', '.afo/**', 'docs/status/violations.jsonl', '.claude/worktrees/**'];

function walk(dirAbs, root, out) {
  let entries;
  try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dirAbs, e.name);
    const rel = toRel(full, root);
    if (rel === null) continue;
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name) || rel === '.claude/worktrees') continue;
      walk(full, root, out);
      continue;
    }
    if (matchesAny(rel, SNAPSHOT_SKIP)) continue;
    if (e.isFile() || e.isSymbolicLink()) out.push(rel);
  }
}

export function hashFile(fileAbs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(fileAbs)).digest('hex');
  } catch {
    return null;
  }
}

/** 프로젝트의 모든 파일 → sha256 지도. */
export function snapshot(root = projectDir()) {
  const files = [];
  walk(root, root, files);
  const map = {};
  for (const rel of files.sort()) map[rel] = hashFile(path.join(root, rel));
  return map;
}

/** 두 스냅샷의 차이: 추가·삭제·변경된 상대 경로 목록. */
export function diffSnapshots(before, after) {
  const changed = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of [...keys].sort()) {
    if (before[k] !== after[k]) {
      changed.push({ path: k, kind: !(k in before) ? 'added' : !(k in after) ? 'removed' : 'modified' });
    }
  }
  return changed;
}

export function nowIso() {
  return new Date().toISOString();
}

/** 훅 입력(stdin JSON) 읽기. */
export async function readStdinJson() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

/** 훅 입력에서 역할 판별: agent_type이 없으면 메인 세션. */
export function roleOf(input) {
  return input && input.agent_type ? String(input.agent_type) : 'main';
}
