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
import { helpText } from './help.js';
import { AFO_VERSION } from './version.js';

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
  gui: ['port', 'no-open', 'exit-when-closed'],
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
  // `afo help [--all]` (before the folder shortcut, so a folder named help needs ./help); --help and -h stay as aliases.
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    const rest = args.slice(1);
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--all')) throw usage('help 뒤에는 --all만 쓸 수 있습니다. 예: afo help --all');
    return helpText(rest.length === 1);
  }
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
  if (args.length === 0) return helpText(false);
  if (args.length === 1 && args[0] === '--version') return `afo ${AFO_VERSION}`;
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      profile: { type: 'string' }, reference: { type: 'string' }, select: { type: 'string' }, json: { type: 'boolean' },
      'no-saved-rules': { type: 'boolean' }, move: { type: 'string', multiple: true }, remember: { type: 'boolean' },
      confirm: { type: 'string' }, 'delete-mode': { type: 'string' }, 'delete-duplicates': { type: 'string' },
      'delete-file': { type: 'string', multiple: true }, 'delete-last-copy': { type: 'boolean' },
      mode: { type: 'string' }, only: { type: 'string' }, phrase: { type: 'string' },
      port: { type: 'string' }, 'no-open': { type: 'boolean' }, 'exit-when-closed': { type: 'boolean' },
    } });
  } catch (error) {
    throw usage(`옵션을 해석할 수 없습니다(${error instanceof Error ? error.message : String(error)}). afo help 참고`);
  }
  const { values, positionals } = parsed;
  const [command, target, extra, more] = positionals;
  if (command === undefined || !(command in allowed)) throw usage('지원하지 않는 명령입니다. afo help 참고');
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
  if (positionals.length !== 2 || !target) throw usage('명령과 대상(폴더, 규칙 파일, 계획 ID 또는 실행 ID)을 하나 명시하세요. afo help --all 참고');
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
