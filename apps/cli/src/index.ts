#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AfoError, ProfileSchema } from '../../../packages/contracts/src/index.js';
import type { CorrectionMatch, RuleProfile } from '../../../packages/contracts/src/index.js';
import { confirmProfile, pathKey, suggestProfile } from '../../../packages/engine/src/index.js';
import { issueReferenceGrant, readReference } from '../../../packages/filesystem/src/index.js';
import { addCorrection } from '../../../packages/filesystem/src/profiles.js';
import { resolveStateDir } from '../../../packages/filesystem/src/state.js';
import { analyzeTarget, profileLine, readJsonFile } from './analyze.js';
import type { AnalyzeValues } from './analyze.js';
import { CliResult, applyCommand, recoverCommand, runsCommand, undoCommand } from './apply.js';
import type { ExecContext } from './apply.js';
import { guiCommand } from './gui.js';
import { planCommand } from './plan.js';
import { CliError, draftLines, expected, isCorrupt, rulesCommand, usage } from './rules.js';
import { guidedCommand, undoLatestCommand } from './guided.js';
import { AFO_VERSION } from './version.js';

const help = `AFO 파일 정리 도우미

가장 쉬운 사용법: afo 를 입력하고 안내를 따르세요.
  afo          폴더를 끌어다 놓기 → 정리 후 모습 보기 → 정리 방법 고르기 → y로 확인 → 정리
  afo <폴더>   그 폴더로 바로 시작(지난번 폴더는 afo 뒤 Enter만 눌러도 돼요)
  afo undo     가장 최근 정리를 원래대로 되돌리기(y로 확인)
  afo runs     지금까지 정리한 기록 보기
대화형 afo도 아래 apply와 같은 승인·실행 경로만 쓰며, 무엇을 할지 보여 준 뒤 물어봅니다: 정리(되돌릴 수 있음)는 Enter·y,
휴지통 보내기는 y를 직접 입력해야 실행합니다. 영구 삭제는 메뉴에 없습니다(apply의 코드와 확인 문구로만).
터미널이 아니면(파이프·스크립트) afo <폴더>는 preview <폴더>와 같습니다.
설치: macOS  curl -fsSL https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.sh | sh
      Windows  irm https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.ps1 | iex
afo --version  설치된 버전 보기

세부 명령(미리보기·개인 규칙·정리 계획·실행):

preview <폴더> [--reference <참고 폴더>] [--profile <JSON>] [--no-saved-rules]
        [--move <상대 경로>=<목적지 폴더>]... [--remember] [--json]
plan <폴더> [preview와 같은 분석 옵션, --remember 제외] [--delete-mode trash|permanent]
     [--delete-duplicates all|<그룹 해시,...>] [--delete-file <상대 경로>]... [--delete-last-copy] [--json]
     정리 계획을 상태 폴더에 저장하고 작업 ID·이유·방식별 승인 코드를 출력(파일은 바꾸지 않음)
apply <계획 ID> --mode organize|trash|permanent-delete [--only <작업ID,...>]
      [--confirm <승인 코드>] [--phrase <확인 문구>] [--json]
     저장된 계획의 한 방식 작업을 보여 주고 승인 코드(영구 삭제는 문구 "영구 삭제"도)를 확인한 뒤 실제로 실행
undo [<실행 ID>] [--confirm <실행 ID 앞 8자>] [--json]   이동(organize) 실행만 원래 위치로 되돌림(ID를 빼면 가장 최근의 되돌릴 수 있는 실행)
runs [<실행 ID>] [--json]                실행 기록 요약 또는 한 실행의 항목별 결과
recover [--json]                         끝나지 않은 실행·결과 불명 항목 보고(자동 재실행·원복·삭제 없음)
gui [<폴더>] [--port <번호>] [--no-open]  이 컴퓨터에서만 열리는 브라우저 화면으로 미리보기·계획·규칙·실행 기록·복구 점검을 봄
     (화면은 파일을 옮기거나 지우지 않음. 실행은 화면이 알려 주는 apply 명령으로 CLI에서). Ctrl+C로 종료
suggest-rules <참고 폴더> [--json]       규칙 후보(초안) JSON을 stdout에, 요약을 stderr에 출력
rules save <초안 JSON> --select <규칙ID,...>
rules list [--json]
rules enable|disable <규칙ID>
rules enable-all|disable-all
rules forget <수정ID>
rules reset [--confirm reset]
confirm-rules <규칙 JSON> --select <규칙ID,...>   (이전 방식: 확인한 JSON만 출력)

preview는 저장된 개인 규칙을 자동 적용합니다. --move는 이번 미리보기에만 적용하고,
--remember를 붙이면 그 수정을 이후에도 적용하도록 저장합니다.
plan의 --delete-mode 기본값은 trash(휴지통)입니다. permanent(영구 삭제)는 되돌릴 수 없습니다.
--delete-file로 같은 내용의 사본을 모두 고르면 거부합니다. 마지막 사본까지 지우려면 --delete-last-copy를 붙입니다.
preview·plan·suggest-rules·rules·runs·recover·gui는 사용자 파일을 바꾸지 않습니다. 사용자 파일을 옮기거나 지우는 명령은
apply와 undo뿐이며, 둘 다 확인 코드를 직접 입력해야 합니다(TTY가 아니면 --confirm 필수, 없으면 종료 코드 4).
apply는 승인 한 번에 한 번만 실행하고 실행 직전 파일을 다시 확인해 바뀐 파일은 건너뜁니다. 덮어쓰지 않습니다.
휴지통으로 보낸 파일은 OS 휴지통에서 직접 복원하고, 영구 삭제는 되돌릴 수 없습니다.
상태(규칙·계획·승인·실행 기록)는 앱 로컬 상태 폴더(AFO_STATE_DIR)에 씁니다.
종료 코드: 0 성공, 1 오류, 2 사용법 오류, 3 일부 실패·결과 불명, 4 승인 거부·무효, 130 취소.
`;

const readDraft = async (file: string): Promise<RuleProfile> => ProfileSchema.parse(await readJsonFile(file));

export interface CliIo {
  /** Human notes and warnings (stderr). stdout carries only the returned string. */
  warn?: (line: string) => void;
  isTTY?: boolean;
  ask?: (question: string) => Promise<string>;
  /** Defaults to resolveStateDir() (AFO_STATE_DIR or the OS app-data folder), resolved only when a command needs it. */
  stateDir?: string;
  /** Rewrites one status line (scan progress in the guided flow); the process entry sets it when stderr is a TTY. */
  progress?: (text: string) => void;
}

const isFolder = async (p: string): Promise<boolean> => { try { return (await stat(p)).isDirectory(); } catch { return false; } };

/** Each command's accepted options; anything else is a usage error rather than being ignored. */
const allowed: Record<string, readonly string[]> = {
  preview: ['profile', 'reference', 'json', 'no-saved-rules', 'move', 'remember'],
  plan: ['profile', 'reference', 'json', 'no-saved-rules', 'move', 'delete-mode', 'delete-duplicates', 'delete-file', 'delete-last-copy'],
  'suggest-rules': ['json'], 'confirm-rules': ['select'], rules: ['json', 'select', 'confirm'],
  apply: ['mode', 'only', 'confirm', 'phrase', 'json'], undo: ['confirm', 'json'], runs: ['json'], recover: ['json'],
  gui: ['port', 'no-open'],
};

/** Output only; exit codes of apply/undo/recover are lost here. The process entry point uses runCli. */
export async function run(args: string[], signal?: AbortSignal, io: CliIo = {}): Promise<string> {
  return (await runCli(args, signal, io)).output;
}

export async function runCli(args: string[], signal?: AbortSignal, io: CliIo = {}): Promise<CliResult> {
  const result = await dispatch(args, signal, io);
  return typeof result === 'string' ? new CliResult(result, 0) : result;
}

async function dispatch(args: string[], signal: AbortSignal | undefined, io: CliIo): Promise<string | CliResult> {
  // No arguments on a TTY: the guided flow (guided.ts). Without a TTY (pipes, scripts, tests) it stays the help text.
  if (args.length === 0 && io.isTTY === true && io.ask !== undefined)
    return guidedCommand({ json: false, warn: io.warn ?? ((line: string) => { console.error(line); }), signal, isTTY: true, ask: io.ask,
      progress: io.progress, stateDir: () => io.stateDir ?? resolveStateDir() });
  // `afo <폴더>`: an existing folder that is not a command name starts the guided flow there (a preview outside a terminal).
  if (args.length === 1 && !args[0]!.startsWith('-') && !(args[0]! in allowed) && await isFolder(args[0]!)) {
    if (io.isTTY !== true || io.ask === undefined) return dispatch(['preview', args[0]!], signal, io);
    return guidedCommand({ json: false, warn: io.warn ?? ((line: string) => { console.error(line); }), signal, isTTY: true, ask: io.ask,
      progress: io.progress, stateDir: () => io.stateDir ?? resolveStateDir() }, args[0]!);
  }
  if (args.length === 0 || args[0] === '--help') return help;
  if (args.length === 1 && args[0] === '--version') return `afo ${AFO_VERSION}`;
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      profile: { type: 'string' }, reference: { type: 'string' }, select: { type: 'string' }, json: { type: 'boolean' },
      'no-saved-rules': { type: 'boolean' }, move: { type: 'string', multiple: true }, remember: { type: 'boolean' },
      confirm: { type: 'string' }, 'delete-mode': { type: 'string' }, 'delete-duplicates': { type: 'string' },
      'delete-file': { type: 'string', multiple: true }, 'delete-last-copy': { type: 'boolean' },
      mode: { type: 'string' }, only: { type: 'string' }, phrase: { type: 'string' },
      port: { type: 'string' }, 'no-open': { type: 'boolean' },
    } });
  } catch (error) {
    throw usage(`옵션을 해석할 수 없습니다(${error instanceof Error ? error.message : String(error)}). --help 참고`);
  }
  const { values, positionals } = parsed;
  const [command, target, extra, more] = positionals;
  if (command === undefined || !(command in allowed)) throw usage('지원하지 않는 명령입니다. --help 참고');
  const bad = Object.keys(values).filter((k) => !allowed[command]!.includes(k));
  if (bad.length) throw usage(`${command}에는 ${bad.map((k) => `--${k}`).join(', ')} 옵션을 쓸 수 없습니다.`);
  const warn = io.warn ?? ((line: string) => { console.error(line); });
  const stateDir = (): string => io.stateDir ?? resolveStateDir();
  const options = signal ? { signal } : {};
  const json = values.json === true;

  if (command === 'rules') {
    if (more !== undefined) throw usage('rules 명령의 인수가 너무 많습니다.');
    return rulesCommand(target, extra, { json, stateDir, draft: readDraft, select: values.select, confirm: values.confirm,
      isTTY: io.isTTY ?? false, ask: io.ask ?? (() => Promise.reject(new Error('대화형 입력을 사용할 수 없습니다.'))), warn });
  }
  const exec: ExecContext = { json, warn, stateDir, signal, isTTY: io.isTTY ?? false,
    ask: io.ask ?? (() => Promise.reject(new Error('대화형 입력을 사용할 수 없습니다.'))) };
  if (command === 'undo' && positionals.length === 1) return undoLatestCommand(values, exec);
  if (command === 'runs' || command === 'recover') {
    if (positionals.length > (command === 'runs' ? 2 : 1)) throw usage(`${command} 명령의 인수가 너무 많습니다.`);
    return command === 'runs' ? runsCommand(target, exec) : recoverCommand(exec);
  }
  if (command === 'gui') {
    if (positionals.length > 2) throw usage('gui에는 작업 폴더를 하나만 지정할 수 있습니다(생략 가능).');
    return guiCommand(target, values, { warn, stateDir, signal });
  }
  if (positionals.length !== 2 || !target) throw usage('명령과 대상(폴더, 규칙 파일, 계획 ID 또는 실행 ID)을 하나 명시하세요. --help 참고');
  if (command === 'apply') return applyCommand(target, values, exec);
  if (command === 'undo') return undoCommand(target, values, exec);
  if (command === 'suggest-rules') {
    const reference = await readReference(await issueReferenceGrant(target), options);
    if (reference.cancelled) throw new AfoError('CANCELLED', '참고 폴더 읽기를 취소했습니다.');
    const draft = suggestProfile(reference);
    if (!json) for (const line of draftLines(draft)) warn(line);
    return JSON.stringify(draft, null, 2);
  }
  if (command === 'confirm-rules') {
    if (!values.select) throw usage('--select로 확인할 규칙 ID만 명시하세요.');
    return JSON.stringify(confirmProfile(await readDraft(target), values.select.split(',')), null, 2);
  }
  if (command === 'plan') return planCommand(target, values, { json, warn, stateDir, options });
  return preview(target, values, { json, warn, stateDir, options });
}

async function preview(target: string, values: AnalyzeValues, ctx: { json: boolean; warn: (line: string) => void;
  stateDir: () => string; options: { signal?: AbortSignal } }): Promise<string> {
  const moves = values.move ?? [];
  if (values.remember && !moves.length) throw usage('--remember는 --move와 함께 써야 합니다.');
  if (values.remember && (values.profile !== undefined || values['no-saved-rules']))
    throw usage('--remember는 저장된 프로필에 기록하므로 --profile·--no-saved-rules와 함께 쓸 수 없습니다.');
  const { analysis, info, saved, picked } = await analyzeTarget(target, values, { ...ctx, writesState: values.remember === true });

  // "이후에도 적용": stored only now, after the preview succeeded, guarded by the revision this preview used.
  const remembered: { correctionId: string; name: string; targetDirectory: string; revision: number }[] = [];
  if (values.remember) {
    let guard = expected(saved);
    for (const p of picked) {
      const name = path.posix.basename(p.relativePath);
      const match: CorrectionMatch = { type: 'file-name', name };
      const after = await addCorrection(match, p.target, { stateDir: ctx.stateDir(), ...guard });
      const c = after.corrections.find((x) => x.match.type === 'file-name' && pathKey(x.match.name) === pathKey(name))!;
      remembered.push({ correctionId: c.id, name, targetDirectory: c.targetDirectory, revision: after.revision });
      guard = { expectedRevision: after.revision };
    }
    if (saved !== null && !isCorrupt(saved) && saved.status === 'disabled')
      ctx.warn('참고: 개인 규칙 프로필이 꺼져 있어 저장한 수정은 rules enable-all 뒤에 적용됩니다.');
  }

  if (ctx.json) return JSON.stringify({ preview: analysis.preview, suggestedProfile: analysis.suggestedProfile, profile: info,
    ...(values.remember ? { remembered } : {}) }, null, 2);
  const { preview: result } = analysis;
  const labels = { move: '이동 제안', keep: '유지', review: '검토 필요' };
  const once = new Set(picked.map((p) => p.fileId));
  return ['AFO 정리 미리보기 — 실제 파일은 변경하지 않았습니다.',
    `분석: ${result.items.length}개 / 스캔 ${result.scanComplete ? '완료' : '일부 미완료'} / 제외·오류 ${result.skipped.length}개`,
    profileLine(info, analysis.preview.profileNotice?.code === 'PROFILE_STALE'),
    ...(result.profileNotice ? [`경고: ${result.profileNotice.reason} 'rules list'로 확인한 뒤 suggest-rules → rules save로 다시 저장하세요.`] : []),
    ...result.items.map((item) => `[${labels[item.action]}] ${item.source}${item.destination ? ` → ${item.destination}` : ''}` +
      `${once.has(item.fileId) ? values.remember ? ' (사용자 수정, 이후에도 적용 저장)' : ' (이번만 적용)' : ''}\n  ${item.reason}`),
    ...result.duplicates.map((group) => `[중복 후보] 남길 파일 제안: ${group.suggestedKeep}\n  확인할 파일: ${group.candidates.join(', ')} / 논리 크기 ${group.logicalCandidateBytes} B (확보량 아님)`),
    ...(analysis.suggestedProfile ? draftLines(analysis.suggestedProfile).map((l) => l.replace('저장: rules save <초안 JSON>',
      '저장: suggest-rules <참고 폴더> > 초안.json 뒤 rules save 초안.json')) : []),
    ...remembered.map((r) => `이후에도 적용하도록 저장: 파일 이름 '${r.name}' → ${r.targetDirectory} (수정 ID ${r.correctionId}, revision ${r.revision}). 다음 preview부터 적용됩니다.`),
    '미리보기는 파일을 바꾸지 않습니다. 실행하려면 plan으로 계획을 저장한 뒤 apply로 승인·실행합니다.'].join('\n');
}

/** docs/CLI.md: 0 success, 1 error, 2 usage, 3 partial failure/unknown (CliResult), 4 approval refused/invalid, 130 cancelled. */
export function exitCodeOf(error: unknown): number {
  if (error instanceof CliError) return error.exitCode;
  if (error instanceof Error && (error.name === 'AbortError' || (error instanceof AfoError && error.code === 'CANCELLED'))) return 130;
  if (error instanceof AfoError && /^(APPROVAL_|PLAN_CHANGED$|MODE_MISMATCH$)/u.test(error.code)) return 4;
  return 1;
}
export function errorLine(error: unknown): string {
  if (error instanceof CliError && error.plain) return error.message;
  if (error instanceof Error && error.name === 'AbortError' && !(error instanceof AfoError)) return 'AFO: 취소했습니다(Ctrl+C). 실행 전이었다면 아무것도 바꾸지 않았습니다.';
  if (error instanceof AfoError) return `AFO 오류[${error.code}]: ${error.message}`;
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    return `AFO 오류: 입력이 계약과 다릅니다${first?.path.length ? ` (${first.path.join('.')})` : ''}: ${first?.message ?? ''}`;
  }
  if (error instanceof SyntaxError) return 'AFO 오류: JSON 파일을 해석할 수 없습니다.';
  return `AFO 오류: ${error instanceof Error ? error.message : '알 수 없는 오류'}`;
}

/** Real paths on both sides: `npm link` runs this file through a symlink (process.argv[1]) while Node resolves import.meta.url. */
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

/** Runs the CLI for this process. The `afo` bin file and the single executable (apps/cli/src/sea.ts) both start here. */
export async function main(): Promise<void> {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const ask = async (question: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    // In a TTY, readline reads Ctrl+C as a key instead of a signal: cancel the same way (exit 130, nothing changed).
    rl.on('SIGINT', () => controller.abort());
    try { return await rl.question(question, { signal: controller.signal }); } finally { rl.close(); }
  };
  try {
    const progress = process.stderr.isTTY ? (text: string) => { process.stderr.write(`\r\x1b[2K${text}`); } : undefined;
    const result = await runCli(process.argv.slice(2), controller.signal, { isTTY: process.stdin.isTTY === true, ask, ...(progress ? { progress } : {}) });
    console.log(result.output);
    process.exitCode = result.exitCode;
  }
  catch (error) {
    console.error(errorLine(error));
    process.exitCode = exitCodeOf(error);
  }
}

if (isEntryPoint()) void main();
