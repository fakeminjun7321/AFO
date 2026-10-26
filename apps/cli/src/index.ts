import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { AfoError, ProfileSchema } from '../../../packages/contracts/src/index.js';
import type { CorrectionMatch, RuleProfile } from '../../../packages/contracts/src/index.js';
import { confirmProfile, pathKey, suggestProfile } from '../../../packages/engine/src/index.js';
import { issueReferenceGrant, readReference } from '../../../packages/filesystem/src/index.js';
import { addCorrection } from '../../../packages/filesystem/src/profiles.js';
import { resolveStateDir } from '../../../packages/filesystem/src/state.js';
import { analyzeTarget, profileLine, readJsonFile } from './analyze.js';
import type { AnalyzeValues } from './analyze.js';
import { planCommand } from './plan.js';
import { CliError, draftLines, expected, isCorrupt, rulesCommand, usage } from './rules.js';

const help = `AFO 미리보기·개인 규칙·정리 계획 (사용자 파일은 읽기 전용)

preview <폴더> [--reference <참고 폴더>] [--profile <JSON>] [--no-saved-rules]
        [--move <상대 경로>=<목적지 폴더>]... [--remember] [--json]
plan <폴더> [preview와 같은 분석 옵션, --remember 제외] [--delete-mode trash|permanent]
     [--delete-duplicates all|<그룹 해시,...>] [--delete-file <상대 경로>]... [--json]
     정리 계획을 상태 폴더에 저장하고 작업 ID·이유·방식별 승인 코드를 출력
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
이 버전은 파일을 읽고 결과를 출력합니다. 사용자 파일의 이동·삭제는 수행하지 않습니다. 실행 명령은 다음 버전에서 제공합니다.
규칙 저장과 plan은 앱 로컬 상태 폴더(AFO_STATE_DIR)에만 씁니다.
`;

const readDraft = async (file: string): Promise<RuleProfile> => ProfileSchema.parse(await readJsonFile(file));

export interface CliIo {
  /** Human notes and warnings (stderr). stdout carries only the returned string. */
  warn?: (line: string) => void;
  isTTY?: boolean;
  ask?: (question: string) => Promise<string>;
  /** Defaults to resolveStateDir() (AFO_STATE_DIR or the OS app-data folder), resolved only when a command needs it. */
  stateDir?: string;
}

/** Each command's accepted options; anything else is a usage error rather than being ignored. */
const allowed: Record<string, readonly string[]> = {
  preview: ['profile', 'reference', 'json', 'no-saved-rules', 'move', 'remember'],
  plan: ['profile', 'reference', 'json', 'no-saved-rules', 'move', 'delete-mode', 'delete-duplicates', 'delete-file'],
  'suggest-rules': ['json'], 'confirm-rules': ['select'], rules: ['json', 'select', 'confirm'],
};

export async function run(args: string[], signal?: AbortSignal, io: CliIo = {}): Promise<string> {
  if (args.length === 0 || args[0] === '--help') return help;
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      profile: { type: 'string' }, reference: { type: 'string' }, select: { type: 'string' }, json: { type: 'boolean' },
      'no-saved-rules': { type: 'boolean' }, move: { type: 'string', multiple: true }, remember: { type: 'boolean' },
      confirm: { type: 'string' }, 'delete-mode': { type: 'string' }, 'delete-duplicates': { type: 'string' },
      'delete-file': { type: 'string', multiple: true },
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
  if (positionals.length !== 2 || !target) throw usage('명령과 대상 폴더 또는 규칙 파일을 하나 명시하세요. --help 참고');
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
    profileLine(info),
    ...result.items.map((item) => `[${labels[item.action]}] ${item.source}${item.destination ? ` → ${item.destination}` : ''}` +
      `${once.has(item.fileId) ? values.remember ? ' (사용자 수정, 이후에도 적용 저장)' : ' (이번만 적용)' : ''}\n  ${item.reason}`),
    ...result.duplicates.map((group) => `[중복 후보] 남길 파일 제안: ${group.suggestedKeep}\n  확인할 파일: ${group.candidates.join(', ')} / 논리 크기 ${group.logicalCandidateBytes} B (확보량 아님)`),
    ...(analysis.suggestedProfile ? draftLines(analysis.suggestedProfile).map((l) => l.replace('저장: rules save <초안 JSON>',
      '저장: suggest-rules <참고 폴더> > 초안.json 뒤 rules save 초안.json')) : []),
    ...remembered.map((r) => `이후에도 적용하도록 저장: 파일 이름 '${r.name}' → ${r.targetDirectory} (수정 ID ${r.correctionId}, revision ${r.revision}). 다음 preview부터 적용됩니다.`),
    '실행 기능: 미구현. 파일 이동·삭제는 수행하지 않습니다.'].join('\n');
}

/** docs/CLI.md: 0 success, 1 error, 2 usage, 4 approval refused/invalid, 130 cancelled. */
export function exitCodeOf(error: unknown): number {
  if (error instanceof CliError) return error.exitCode;
  if (error instanceof Error && (error.name === 'AbortError' || (error instanceof AfoError && error.code === 'CANCELLED'))) return 130;
  if (error instanceof AfoError && /^(APPROVAL_|PLAN_CHANGED$|MODE_MISMATCH$)/u.test(error.code)) return 4;
  return 1;
}
export function errorLine(error: unknown): string {
  if (error instanceof AfoError) return `AFO 오류[${error.code}]: ${error.message}`;
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    return `AFO 오류: 입력이 계약과 다릅니다${first?.path.length ? ` (${first.path.join('.')})` : ''}: ${first?.message ?? ''}`;
  }
  if (error instanceof SyntaxError) return 'AFO 오류: JSON 파일을 해석할 수 없습니다.';
  return `AFO 오류: ${error instanceof Error ? error.message : '알 수 없는 오류'}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const ask = async (question: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try { return await rl.question(question, { signal: controller.signal }); } finally { rl.close(); }
  };
  try { console.log(await run(process.argv.slice(2), controller.signal, { isTTY: process.stdin.isTTY === true, ask })); }
  catch (error) {
    console.error(errorLine(error));
    process.exitCode = exitCodeOf(error);
  }
}
