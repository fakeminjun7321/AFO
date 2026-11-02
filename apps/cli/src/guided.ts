import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AfoError, CorrectionMatchSchema, TARGET_SEGMENT_MAX_BYTES, TargetDirectorySchema, approvalModeKind, isAfoError }
  from '../../../packages/contracts/src/index.js';
import type { ApprovalMode, ClassificationReason, CorrectionMatch, ExecutionReport, PlanOperation, Preview, ScanProgress }
  from '../../../packages/contracts/src/index.js';
import { extensionOfName } from '../../../packages/engine/src/defaults.js';
import { pathKey, suggestProfile } from '../../../packages/engine/src/index.js';
import { issueReferenceGrant, readReference } from '../../../packages/filesystem/src/index.js';
import { addCorrection } from '../../../packages/filesystem/src/profiles.js';
import { readJson, writeJsonAtomic } from '../../../packages/filesystem/src/state.js';
import { analyzeTarget } from './analyze.js';
import type { ProfileInfo, Target } from './analyze.js';
import { CliResult, applyCommand, askYesNo, runSummaries, undoCommand } from './apply.js';
import type { ExecContext, RunSummary } from './apply.js';
import { createPlan } from './plan.js';
import type { PlanValues } from './plan.js';
import { CliError, expected, isCorrupt, saveDraft } from './rules.js';
import type { Stored } from './rules.js';
import { haeyo } from './words.js';

/**
 * `afo` (or `afo <폴더>`) on a TTY: folder → short summary with the folder tree → menu → plan → yes/no → the same apply path
 * (applyCommand: issueApproval → consumeApproval → executeBatch, with the plan's own code). Only an adapter; no classification
 * or approval logic here. Organizing (undoable) defaults to yes, sending copies to the trash defaults to no.
 * Questions and screens go to stderr (ctx.warn / ctx.ask), the final result is the returned stdout text.
 * Permanent delete is deliberately not offered here (plan --delete-mode permanent + apply only).
 */
const MAX_FOLDER_TRIES = 3;
const MAX_MENU_TRIES = 3;
const MAX_LIST = 20;
const MAX_TREE = 8;
const nothing = '아무것도 바꾸지 않았어요.';
/** A stop the user chose (no code, wrong code, gave up, Ctrl+C before running): no "AFO 오류:" prefix, exit code kept. */
const stop = (message: string, exitCode: 1 | 2 | 4 | 130): CliError => new CliError(message, exitCode, true);

/** Cleans a folder dragged into a terminal: spaces, surrounding quotes, macOS `\ ` escapes (not on Windows), and a leading `~/`. */
export function cleanDroppedPath(input: string, home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  let s = input.trim();
  const quoted = s.length >= 2 && (s[0] === "'" || s[0] === '"') && s.at(-1) === s[0];
  if (quoted) s = s.slice(1, -1);
  else if (platform !== 'win32') s = s.replace(/\\(.)/gu, '$1');
  if (s === '~') return home;
  if (s.startsWith('~/') || (platform === 'win32' && s.startsWith('~\\'))) return path.join(home, s.slice(2));
  return s;
}

const isCancel = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || (error instanceof AfoError && error.code === 'CANCELLED'));
const reasonOf = (error: unknown): string => haeyo((error instanceof Error ? error.message : String(error)).split('\n')[0]!);
const more = (n: number): string[] => n > 0 ? [`  … 외 ${n}개`] : [];

function profileNote(info: ProfileInfo): string {
  return info.source === 'saved' && info.status !== 'disabled' ? '저장된 내 정리 규칙을 적용했어요.'
    : info.source === 'none' ? '저장된 내 정리 규칙이 없어 기본 분류(문서·이미지·영상 등)를 썼어요. 잘 정리해 둔 폴더가 있으면 5)로 그 방식을 따라 할 수 있어요.'
    : info.source === 'saved' ? '내 정리 규칙이 꺼져 있어 기본 분류를 썼어요.'
    : info.source === 'stale' ? '참고 폴더가 바뀐 것 같아 내 정리 규칙은 이번에 쓰지 않았어요(기본 분류).'
    : '저장된 내 정리 규칙을 읽지 못해 기본 분류를 썼어요.';
}

const folderOf = (item: Preview['items'][number]): string => item.category ?? path.posix.dirname(item.destination ?? '.');
/** Short names for why a file is kept or needs a look (reasonCode), in the summary and in 3) 자세히 보기. */
const reviewLabel: Partial<Record<ClassificationReason, string>> = { NO_EXTENSION: '확장자 없음', UNKNOWN_EXTENSION: '종류를 모르는 확장자',
  COMPOUND_EXTENSION: '확장자가 여러 개', DEST_CONFLICT: '목적지 충돌', DEST_COLLISION: '같은 이름이 겹침', PARENT_CONFLICT: '목적지 폴더 충돌',
  DEST_INVALID: '목적지가 올바르지 않음', RULE_CONFLICT: '개인 규칙 충돌', READ_FAILED: '읽지 못함', PROTECTED_REFERENCE: '참고 폴더 보호',
  ALREADY_PLACED: '이미 정리된 위치', INCOMPLETE_DOWNLOAD: '다운로드 중일 수 있음' };
const labelOf = (item: Preview['items'][number]): string => (item.reasonCode && reviewLabel[item.reasonCode]) ?? '기타';
/** Most first, ties by name: deterministic. */
const ranked = (counts: Map<string, number>): [string, number][] =>
  [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

/** The folders a move would fill, most first, with two example names: what the folder will look like, before anything moves. */
function treeLines(moves: Preview['items'], rootName: string): string[] {
  if (!moves.length) return [];
  const byFolder = new Map<string, string[]>();
  for (const i of moves) byFolder.set(folderOf(i), [...byFolder.get(folderOf(i)) ?? [], path.posix.basename(i.source)]);
  const all = ranked(new Map([...byFolder].map(([f, names]) => [f, names.length])));
  const rows = all.slice(0, MAX_TREE).map(([f, n]) => {
    const names = byFolder.get(f)!.sort(byText);
    return `${f}/ ${n}개 (예: ${names.slice(0, 2).join(', ')}${names.length > 2 ? ', …' : ''})`;
  });
  if (all.length > MAX_TREE) rows.push(`… 폴더 ${all.length - MAX_TREE}개 더`);
  return [`    ${rootName}/`, ...rows.map((r, i) => `    ${i === rows.length - 1 ? '└─' : '├─'} ${r}`)];
}

function summaryLines(preview: Preview, info: ProfileInfo, rootName: string): string[] {
  const moves = preview.items.filter((i) => i.action === 'move');
  const keeps = preview.items.filter((i) => i.action === 'keep');
  const reviews = preview.items.filter((i) => i.action === 'review');
  const tally = (items: typeof reviews): string => {
    const byReason = new Map<string, number>();
    for (const i of items) byReason.set(labelOf(i), (byReason.get(labelOf(i)) ?? 0) + 1);
    const reasons = ranked(byReason);
    return reasons.length ? ` — ${reasons.slice(0, 4).map(([r, n]) => `${r} ${n}`).join(' · ')}${reasons.length > 4 ? ' · …' : ''}` : '';
  };
  const dupFiles = preview.duplicates.reduce((n, g) => n + g.candidates.length, 0);
  const example = preview.duplicates.find((g) => g.candidates.length);
  return [`파일 ${preview.items.length}개를 살펴봤어요. (아직 아무것도 바꾸지 않았어요)`,
    `  폴더별로 정리할 수 있는 파일: ${moves.length}개${moves.length ? ' — 정리하면 이렇게 돼요:' : ''}`,
    ...treeLines(moves, rootName),
    ...(keeps.length ? [`  그대로 둘 파일: ${keeps.length}개${tally(keeps)}`] : []),
    `  직접 확인이 필요한 파일: ${reviews.length}개${tally(reviews)}`,
    `  같은 내용의 중복 파일: ${preview.duplicates.length}묶음${example ? `(휴지통으로 보낼 수 있는 사본 ${dupFiles}개) — 예: 남길 파일 '${example.suggestedKeep}', 휴지통 후보 ` +
      `'${example.candidates[0]}'${example.candidates.length > 1 ? ` 외 ${example.candidates.length - 1}개` : ''}` : ''}`,
    `  ${profileNote(info)}`,
    ...(!preview.scanComplete || preview.skipped.length ? [`  참고: 살펴보지 않은 항목 ${preview.skipped.length}개(숨김·링크·읽기 실패 등)` +
      `${preview.scanComplete ? '' : ', 폴더를 끝까지 읽지 못했어요'}`] : [])];
}

function detailLines(preview: Preview): string[] {
  const label = { move: '정리', keep: '그대로', review: '확인 필요' } as const;
  return ['자세히 보기 — 분류 결과(아직 아무것도 바꾸지 않았어요):',
    ...preview.items.map((i) => `  [${label[i.action]}] ${i.source}${i.action === 'move' && i.destination ? ` → ${i.destination}` : ''}` +
      `${i.action === 'move' ? '' : ` — ${labelOf(i)}`}`),
    ...preview.duplicates.map((g) => `  [중복] 남길 파일 '${g.suggestedKeep}' / 휴지통 후보: ${g.candidates.join(', ')}`),
    ...(preview.items.length || preview.duplicates.length ? [] : ['  (분류할 파일이 없어요)'])];
}

type Choice = 'organize' | 'trash' | 'learn' | 'quit';

async function menu(ctx: ExecContext, counts: { organize: number; unknown: number; trash: number; movedCopies: number },
  show: () => void): Promise<Choice> {
  const lines = () => ['무엇을 할까요?',
    `  1) 폴더별로 정리하기(되돌릴 수 있어요)${counts.organize ? ` — 파일 ${counts.organize}개`
      : counts.unknown ? ` — 종류를 모르는 파일 ${counts.unknown}개(옮길 곳을 물어봐요)` : ' — 할 일 없음'}`,
    ...(counts.organize && counts.movedCopies ? [`     같은 내용의 사본 ${counts.movedCopies}개도 함께 옮겨요. 먼저 2)로 정리할 수도 있어요.`] : []),
    ...(counts.organize && counts.unknown ? [`     종류를 모르는 파일 ${counts.unknown}개는 어디로 옮길지 이어서 물어봐요.`] : []),
    `  2) 중복 파일을 휴지통으로 보내기${counts.trash ? `(휴지통에서 다시 꺼낼 수 있어요. afo undo로는 되돌리지 않아요) — 사본 ${counts.trash}개`
      : ' — 할 일 없음'}`,
    '  3) 자세히 보기', '  4) 그만두기', '  5) 내 정리 방식 알려 주기(잘 정리해 둔 폴더를 참고해요)'];
  for (const l of lines()) ctx.warn(l);
  for (let tries = 1; ; tries++) {
    const answer = (await ctx.ask('번호를 입력하세요: ')).trim();
    if (answer === '' || answer === '4') return 'quit';
    if (answer === '3') { show(); for (const l of lines()) ctx.warn(l); tries = 0; continue; }
    if (answer === '1' && (counts.organize || counts.unknown)) return 'organize';
    if (answer === '2' && counts.trash) return 'trash';
    if (answer === '5') return 'learn';
    ctx.warn(answer === '1' || answer === '2' ? '그 작업은 할 일이 없어요. 다른 번호를 골라 주세요.' : '1~5 중에서 골라 주세요.');
    if (tries >= MAX_MENU_TRIES) throw stop(`번호를 알아듣지 못해 그만둘게요. ${nothing}`, 2);
  }
}

function opLine(op: PlanOperation): string {
  return op.kind === 'move' ? `  ${op.source} → ${op.destination}` : `  ${op.source}${op.keeper ? ` (같은 내용의 '${op.keeper}' 파일은 남겨요)` : ''}`;
}

function resultText(report: ExecutionReport, mode: ApprovalMode, ops: Map<string, PlanOperation>, rules: boolean): string {
  const n = (s: string): number => report.results.filter((r) => r.status === s).length;
  const ok = n('moved') + n('trashed');
  const bad = report.results.filter((r) => r.status !== 'moved' && r.status !== 'trashed');
  const name = (opId: string): string => ops.get(opId)?.source ?? opId;
  const stopped = report.results.filter((r) => r.errorCode === 'CANCELLED').length;
  return [`${mode === 'organize' ? '정리' : '휴지통 보내기'}를 ${stopped ? '중간에 멈췄어요' : '마쳤어요'}.`,
    `  ${mode === 'organize' ? `옮김 ${n('moved')}` : `휴지통으로 보냄 ${n('trashed')}`} · 건너뜀 ${n('skipped')} · 실패 ${n('failed')}` +
      `${n('unknown') ? ` · 결과 확인 못 함 ${n('unknown')}` : ''}`,
    ...(stopped ? [`Ctrl+C로 멈춰 남은 파일 ${stopped}개는 그대로 뒀어요. 이미 ${mode === 'organize' ? '옮긴' : '휴지통으로 보낸'} 파일 ${ok}개는 그 상태예요.`] : []),
    ...(bad.length ? ['  옮기지 않은 파일(바꾸지 않았어요):', ...bad.slice(0, MAX_LIST).map((r) => `    ${name(r.opId)} — ${haeyo(r.detail)}`),
      ...more(bad.length - MAX_LIST).map((l) => `  ${l}`)] : []),
    ...(n('unknown') ? ['결과를 확인하지 못한 파일이 있어요. 다시 실행하지 말고 afo recover로 실제 상태를 확인하세요.'] : []),
    ...(mode === 'organize' && n('moved') ? ['되돌리려면: afo undo'] : []),
    ...(mode === 'trash' && ok ? ['휴지통으로 보낸 파일은 Finder 휴지통(Windows는 휴지통)에서 되살릴 수 있어요. afo undo로는 되돌리지 않아요.'] : []),
    `다음에도 afo만 입력하고 Enter를 누르면 이 폴더를 같은 방식으로 정리해요.${rules ? ' 저장한 내 정리 규칙도 계속 적용돼요.' : ''}`,
    '정리 기록은 afo runs로 볼 수 있어요.',
  ].join('\n');
}

/**
 * Files the default table does not know (unknown or no extension), grouped by lower-case extension. '' = no extension, and also
 * digits-only "extensions" (`2024.10.30`, `part.001`): dates or split parts, not a file type, so never saved as a rule.
 */
const UNKNOWN_REASONS: ReadonlySet<ClassificationReason | undefined> = new Set(['UNKNOWN_EXTENSION', 'NO_EXTENSION']);
interface UnknownFile { fileId: string; source: string }
interface UnknownGroup { ext: string; files: UnknownFile[] }
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function unknownGroups(preview: Preview): UnknownGroup[] {
  const byExt = new Map<string, UnknownFile[]>();
  for (const i of preview.items) if (i.action === 'review' && UNKNOWN_REASONS.has(i.reasonCode)) {
    const raw = i.reasonCode === 'NO_EXTENSION' ? '' : extensionOfName(path.posix.basename(i.source));
    const ext = /^\.\d*$/u.test(raw) ? '' : raw;
    byExt.set(ext, [...byExt.get(ext) ?? [], { fileId: i.fileId, source: i.source }]);
  }
  // Most first, ties by extension; "no extension" last. Deterministic.
  return [...byExt].map(([ext, files]) => ({ ext, files: files.sort((a, b) => byText(a.source, b.source)) }))
    .sort((a, b) => Number(a.ext === '') - Number(b.ext === '') || b.files.length - a.files.length || byText(a.ext, b.ext));
}
const groupName = (g: UnknownGroup): string => g.ext === '' ? '확장자 없음' : g.ext;
const example = (g: UnknownGroup): string => path.posix.basename(g.files[0]!.source);
const YES = new Set(['y', 'yes', '예', '네', 'ㅛ', 'ㅇ']);
const MAX_GROUPS_SHOWN = 6;
/** macOS PATH_MAX is 1024 bytes including the terminating NUL. */
const MAX_PATH_BYTES = 1023;
const bytes = (s: string): number => Buffer.byteLength(s.normalize('NFC'), 'utf8');
/** A saved "다음에도" correction: extension only (keyword null), the same kind `rules` lists and `rules forget` removes. */
const matchOf = (ext: string): CorrectionMatch | null => {
  const m = CorrectionMatchSchema.safeParse({ type: 'keyword', extension: ext, keyword: null });
  return ext !== '' && m.success ? m.data : null;
};
/** Already in that folder (the plan would keep it where it is): not counted as a file to move. */
const inFolder = (source: string, folder: string): boolean => pathKey(path.posix.dirname(source)) === pathKey(folder);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
/** Why a typed folder name cannot be used, or null when it can. TargetDirectorySchema decides; this only names the reason. */
function folderProblem(answer: string, root: string, files: UnknownFile[]): string | null {
  const parts = answer.split('/');
  if (!TargetDirectorySchema.safeParse(answer).success) {
    if (parts.some((p) => bytes(p) > TARGET_SEGMENT_MAX_BYTES)) return `이름이 너무 길어요(한 단계 ${TARGET_SEGMENT_MAX_BYTES}바이트까지)`;
    if (answer.startsWith('/') || /^[A-Za-z]:/u.test(answer)) return '절대 경로는 안 돼요';
    if (parts.some((p) => p === '..' || p === '.')) return "'..'·'.'은 쓸 수 없어요";
    if (parts.some((p) => p === '')) return '빈 폴더 이름(//)은 안 돼요';
    if (parts.some((p) => p.startsWith('.'))) return '점(.)으로 시작하는 숨김 폴더는 안 돼요';
    if (parts.some((p) => RESERVED.test(p))) return 'CON·NUL·AUX 같은 Windows 예약 이름은 안 돼요';
    if (parts.some((p) => /[. ]$/u.test(p))) return '이름 끝에 점이나 공백은 안 돼요';
    return '\\ < > : " | ? * 같은 특수 문자나 제어 문자는 안 돼요';
  }
  const longest = files.reduce((n, f) => Math.max(n, bytes(path.posix.basename(f.source))), 0);
  if (bytes(root) + 1 + bytes(answer) + 1 + longest > MAX_PATH_BYTES) return '옮긴 뒤의 전체 경로가 너무 길어요';
  return null;
}

/** What changed so far in this guided run, for the stop messages. */
interface RunState { savedRule: boolean }
const unchanged = (run: RunState): string => run.savedRule ? '파일은 바꾸지 않았어요(저장한 규칙은 남아 있어요).' : nothing;

/**
 * Asks where the unknown files go, once per extension. Returns one-off overrides by file ID for this run only (the same override path
 * as `preview/plan --move`, without building "<path>=<folder>" text) and saves the corrections the user asked to keep.
 * Nothing in the work folder changes here.
 */
async function askUnknown(ctx: ExecContext, groups: UnknownGroup[], saved: Stored, root: string, run: RunState):
  Promise<{ fileId: string; target: string }[]> {
  const say = ctx.warn;
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  say(`종류를 모르는 파일이 있어요: ${groups.slice(0, MAX_GROUPS_SHOWN).map((g) => `${groupName(g)} ${g.files.length}개(예: ${example(g)})`).join(', ')}` +
    `${groups.length > MAX_GROUPS_SHOWN ? ` 외 ${groups.length - MAX_GROUPS_SHOWN}종류` : ''}`);
  say(`  1) 모두 '기타' 폴더로 옮기기`); say('  2) 확장자마다 폴더 정하기'); say('  3) 그대로 두기(기본)');
  let pick = '';
  for (let tries = 1; ; tries++) {
    pick = (await ctx.ask('번호를 입력하세요(그냥 Enter는 3): ')).trim();
    if (pick === '' || pick === '1' || pick === '2' || pick === '3') break;
    say('1, 2, 3 중에서 골라 주세요.');
    if (tries >= MAX_MENU_TRIES) throw stop(`번호를 알아듣지 못해 그만둘게요. ${nothing}`, 2);
  }
  if (pick === '1') {
    const all = groups.flatMap((g) => g.files);
    const moving = all.filter((f) => !inFolder(f.source, '기타'));
    const already = all.length - moving.length;
    say(moving.length ? `종류를 모르는 파일 ${moving.length}개를 '기타' 폴더로 옮기는 계획을 만들게요.` +
      `${already ? ` ('기타' 폴더에 이미 있는 ${already}개는 그대로 둬요)` : ''}` : `종류를 모르는 파일 ${all.length}개는 이미 '기타' 폴더에 있어요.`);
    return moving.map((f) => ({ fileId: f.fileId, target: '기타' }));
  }
  if (pick !== '2') { say(`종류를 모르는 파일 ${total}개는 그대로 둬요.`); return []; }

  const chosen: { fileId: string; target: string }[] = [];
  const keep: { match: CorrectionMatch; ext: string; folder: string }[] = [];
  const canSave = !isCorrupt(saved);
  if (!canSave) say('저장된 내 정리 규칙 파일이 손상돼 이번 정리에만 적용해요.');
  for (const g of groups) {
    const what = g.ext === '' ? `확장자 없는 파일 ${g.files.length}개` : `'${g.ext}' 파일 ${g.files.length}개`;
    let folder: string | null = null;
    for (let tries = 1; folder === null; tries++) {
      const answer = (await ctx.ask(`${what}를 어느 폴더로 옮길까요? (예: 데이터, 그냥 Enter는 그대로 두기): `)).trim().replace(/\/+$/u, '');
      if (answer === '') break;
      const problem = folderProblem(answer, root, g.files);
      if (problem === null) { folder = TargetDirectorySchema.parse(answer); break; }
      if (tries >= MAX_MENU_TRIES) { say(`그 이름은 폴더로 쓸 수 없어요(${problem}). ${what}는 그대로 둘게요.`); break; }
      say(`그 이름은 폴더로 쓸 수 없어요(${problem}). 이 폴더 안에 만들 폴더 이름을 다시 입력해 주세요.`);
    }
    if (folder === null) continue;
    const target = folder;
    const moving = g.files.filter((f) => !inFolder(f.source, target));
    if (moving.length < g.files.length) say(`'${target}' 폴더에 이미 있는 ${g.files.length - moving.length}개는 그대로 둬요.`);
    chosen.push(...moving.map((f) => ({ fileId: f.fileId, target })));
    const match = matchOf(g.ext);
    if (match === null) {
      say(g.ext === '' ? '확장자가 없는(또는 숫자로만 된) 파일은 기억할 수 없어 이번에만 옮겨요.' : `'${g.ext}' 확장자는 기억할 수 없어 이번에만 옮겨요.`);
      continue;
    }
    if (!canSave) continue;
    const again = (await ctx.ask(`다음에도 '${g.ext}' 파일은 '${target}' 폴더로 정리할까요? (y/N): `)).trim().toLowerCase();
    if (YES.has(again)) keep.push({ match, ext: g.ext, folder: target });
  }
  // Saved now, before the plan is built: the plan then binds to the new profile revision. Guarded by the revision this run read.
  let guard = expected(saved);
  for (const k of keep) {
    try {
      const after = await addCorrection(k.match, k.folder, { stateDir: ctx.stateDir(), ...guard });
      guard = { expectedRevision: after.revision };
      run.savedRule = true;
      say(`저장했어요: 다음에도 '${k.ext}' 파일은 '${k.folder}' 폴더로 정리해요. (afo rules list로 보고 afo rules forget으로 지울 수 있어요)`);
      if (after.status === 'disabled') say('참고: 내 정리 규칙이 꺼져 있어 저장한 내용은 afo rules enable-all 뒤에 적용돼요(이번 정리에는 반영해요).');
    } catch (error) {
      if (isCancel(error)) throw error;
      say(`'${k.ext}' 규칙은 저장하지 못했어요(${reasonOf(error)}). 이번 정리에만 적용해요.`);
    }
  }
  return chosen;
}

/** Why a file the user expected to move is not in the plan, from the plan's own analysis (reasonCode), in short 해요체. */
function leftOutReason(item: Preview['items'][number] | undefined, target: string | undefined, files: Set<string>): string {
  if (item === undefined) return '살펴보는 사이 파일이 바뀌었어요';
  switch (item.reasonCode) {
    case 'DEST_CONFLICT': {
      const parents = (target ?? '').split('/').map((_, i, a) => a.slice(0, i + 1).join('/')).filter((p) => p !== '');
      const blocker = parents.find((p) => files.has(pathKey(p)));
      return blocker !== undefined ? `'${blocker}'라는 파일이 이미 있어 그 이름으로 폴더를 만들 수 없어요(이름 충돌)`
        : '옮길 곳에 같은 이름이 이미 있어요(이름 충돌, 덮어쓰지 않아요)';
    }
    case 'DEST_COLLISION': return '옮길 곳에서 다른 파일과 이름이 겹쳐요(덮어쓰지 않아요)';
    case 'PARENT_CONFLICT': return '다른 파일의 위치와 폴더 위치가 겹쳐요';
    case 'DEST_INVALID': return '옮길 경로가 너무 길거나 쓸 수 없는 이름이에요';
    default: return haeyo(item.reason);
  }
}
/** Expected moves the plan left out, grouped by reason; `changed` only when a file is really gone from the plan's analysis. */
function leftOut(wanted: Map<string, { source: string; target: string | undefined }>, planned: Set<string>, preview: Preview):
  { lines: string[]; changed: boolean } {
  const now = new Map(preview.items.map((i) => [i.fileId, i]));
  const files = new Set(preview.items.map((i) => pathKey(i.source)));
  const why = new Map<string, string[]>();
  let changed = false; let n = 0;
  for (const [fileId, w] of wanted) if (!planned.has(fileId)) {
    const item = now.get(fileId);
    if (item === undefined) changed = true;
    const reason = leftOutReason(item, w.target, files);
    why.set(reason, [...why.get(reason) ?? [], w.source]); n += 1;
  }
  return { changed, lines: n ? [`옮기지 못하는 파일 ${n}개(그대로 둬요):`, ...[...why].map(([reason, s]) =>
    `  ${s.slice(0, 3).join(', ')}${s.length > 3 ? ` 외 ${s.length - 3}개` : ''} — ${reason}`)] : [] };
}

/** The guided flow's own memory in the state folder: the folder it last ran on, offered again with Enter. A convenience only. */
const PrefsSchema = z.strictObject({ formatVersion: z.literal(1), lastFolder: z.string().min(1).max(4096).nullable() });
const prefsFile = (stateDir: string): string => path.join(stateDir, 'guided.json');
async function lastFolder(ctx: ExecContext): Promise<string | null> {
  try {
    const folder = (await readJson(prefsFile(ctx.stateDir()), PrefsSchema))?.lastFolder ?? null;
    return folder !== null && (await stat(folder)).isDirectory() ? folder : null;
  } catch { return null; }
}
async function rememberFolder(ctx: ExecContext, folder: string): Promise<void> {
  try { await writeJsonAtomic(prefsFile(ctx.stateDir()), { formatVersion: 1, lastFolder: folder }, PrefsSchema); } catch { /* next time asks as usual */ }
}

/** Scan progress as one rewritten status line, only after the scan has taken a moment (no flicker on small folders). */
function progressLine(show: (text: string) => void): (p: ScanProgress) => void {
  const started = Date.now(); let last = 0;
  return (p) => {
    const now = Date.now();
    if (now - started < 300 || now - last < 150) return;
    last = now;
    show(p.phase === 'hash' ? `같은 내용인지 확인하는 중이에요… ${p.hashedFiles.toLocaleString('ko-KR')} / ${p.hashTargets.toLocaleString('ko-KR')}개`
      : `폴더를 살펴보는 중이에요… 파일 ${p.files.toLocaleString('ko-KR')}개`);
  };
}

/** 이/가 after a word: by the final consonant of a last Hangul syllable, '(이)가' when the word does not end in Hangul. */
const subject = (word: string): string => {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code < 0 || code > 11171 ? '(이)가' : code % 28 ? '이' : '가';
};

/**
 * Menu 5: suggests rules from a folder the user already keeps tidy (names and folders only, never contents), shows them with
 * examples and saves them on yes, the same as `suggest-rules` + `rules save --select <all>`. Returns whether rules were saved.
 */
async function learnRules(ctx: ExecContext, options: { signal?: AbortSignal }, run: RunState): Promise<boolean> {
  const say = ctx.warn;
  say('잘 정리해 둔 폴더를 이 창으로 끌어다 놓아 주세요. 폴더 구조와 파일 이름만 보고(내용은 읽지 않아요) 같은 방식의 규칙을 찾아요.');
  const folder = cleanDroppedPath(await ctx.ask('정리된 폴더(그냥 Enter는 돌아가기): '));
  if (folder === '') return false;
  let draft;
  try { draft = suggestProfile(await readReference(await issueReferenceGrant(folder), options)); }
  catch (error) { if (isCancel(error)) throw error; say(`이 폴더는 참고할 수 없어요: ${reasonOf(error)}`); return false; }
  if (!draft.rules.length) { say('같은 방식으로 놓인 파일이 2개 이상인 곳을 찾지 못해 규칙을 만들지 않았어요. 기본 분류를 그대로 써요.'); return false; }
  say(`찾은 정리 방식 ${draft.rules.length}개:`);
  for (const r of draft.rules) say(`  ${r.keyword === null ? `모든 ${r.extension} 파일` : `이름에 '${r.keyword}'${subject(r.keyword)} 들어간 ${r.extension} 파일`} → ` +
    `${r.targetDirectory}/ (예: ${r.evidence.slice(0, 2).map((e) => path.posix.basename(e)).join(', ')})`);
  say('참고한 폴더의 파일은 옮기거나 지우지 않아요.');
  if (!await askYesNo(ctx, '이 방식을 저장해서 이번 정리와 다음 정리에 쓸까요? (Y/n): ', true)) { say('저장하지 않았어요.'); return false; }
  const { saved } = await saveDraft(draft, draft.rules.map((r) => r.id), ctx.stateDir(), say);
  run.savedRule = true;
  say(`저장했어요: 내 정리 규칙 ${saved.rules.length}개. (afo rules list로 보고 afo rules disable-all로 끌 수 있어요)`);
  return true;
}

export async function guidedCommand(ctx: ExecContext, initialFolder?: string): Promise<CliResult> {
  // Everything before applyCommand only reads files (and saves a plan, rules or prefs in the state folder): a cancel there changed nothing.
  let prepared: Prepared | CliResult;
  const run: RunState = { savedRule: false };
  try { prepared = await prepare(ctx, run, initialFolder); }
  catch (error) { if (isCancel(error)) throw stop(`그만뒀어요(Ctrl+C). ${unchanged(run)}`, 130); throw error; }
  finally { ctx.progress?.(''); }
  if (prepared instanceof CliResult) return prepared;
  const { mode, ops, planId, code, folder, rules } = prepared;

  let result: CliResult;
  try { result = await applyCommand(planId, { mode, confirm: code }, { ...ctx, json: true }); }
  catch (error) {
    if (isAfoError(error, 'APPROVAL_INVALID')) throw stop(`승인을 확인하지 못해 실행하지 않았어요. ${unchanged(run)}`, 4);
    throw error;
  }
  await rememberFolder(ctx, folder);
  const { report } = JSON.parse(result.output) as { report: ExecutionReport };
  return new CliResult(resultText(report, mode, new Map(ops.map((op) => [op.id, op])), rules), result.exitCode);
}

interface Prepared { mode: ApprovalMode; ops: PlanOperation[]; planId: string; code: string; folder: string; rules: boolean }
async function prepare(ctx: ExecContext, run: RunState, initialFolder: string | undefined): Promise<Prepared | CliResult> {
  const say = ctx.warn;
  const options = ctx.signal ? { signal: ctx.signal } : {};
  const scan = { ...options, ...(ctx.progress ? { onProgress: progressLine(ctx.progress) } : {}) };
  const quit = (): CliResult => new CliResult(`그만뒀어요. ${nothing}`, 0);
  say('AFO 파일 정리 도우미예요. 파일을 옮기기 전에 무엇을 할지 보여 주고 꼭 물어봐요. (Ctrl+C로 언제든 그만둘 수 있어요)');

  const last = initialFolder === undefined ? await lastFolder(ctx) : null;
  if (last !== null) say(`지난번에 정리한 폴더: ${last}`);
  const question = last !== null ? '정리할 폴더를 이 창으로 끌어다 놓고 Enter를 누르세요(그냥 Enter는 지난번 폴더, q는 종료): '
    : '정리할 폴더를 이 창으로 끌어다 놓고 Enter를 누르세요(경로를 붙여 넣어도 돼요, 그냥 Enter는 종료): ';
  const analyze = async (folder: string): Promise<Target> => {
    say('폴더를 살펴보는 중이에요…');
    try {
      const found = await analyzeTarget(folder, {}, { warn: say, stateDir: ctx.stateDir, options: scan, writesState: true });
      if (found.analysis.preview.cancelled || found.analysis.scan.cancelled) throw new AfoError('CANCELLED', '분석을 취소했습니다.');
      return found;
    } finally { ctx.progress?.(''); }
  };
  let folder = ''; let target: Target | undefined;
  for (let attempt = 1; target === undefined; attempt++) {
    const typed = attempt === 1 && initialFolder !== undefined ? initialFolder : cleanDroppedPath(await ctx.ask(question));
    if (typed === '' && last !== null) folder = last;
    else if (typed === '' || typed.toLowerCase() === 'q') return quit();
    else folder = typed;
    try { target = await analyze(folder); }
    catch (error) {
      if (isCancel(error)) throw error;
      target = undefined;
      say(`이 폴더는 정리할 수 없어요: ${reasonOf(error)}`);
      if (attempt >= MAX_FOLDER_TRIES) throw stop(`폴더를 ${MAX_FOLDER_TRIES}번 열지 못해 그만둘게요. ${nothing}`, 1);
    }
  }

  let choice: Choice;
  for (let showSummary = true; ; ) {
    const { preview } = target.analysis;
    if (showSummary) for (const l of summaryLines(preview, target.info, path.basename(target.grant.canonicalPath))) say(l);
    const moving = new Set(preview.items.filter((i) => i.action === 'move').map((i) => i.source));
    const counts = { organize: moving.size, unknown: unknownGroups(preview).reduce((n, g) => n + g.files.length, 0),
      trash: preview.duplicates.reduce((n, g) => n + g.candidates.length, 0),
      movedCopies: preview.duplicates.reduce((n, g) => n + g.candidates.filter((c) => moving.has(c)).length, 0) };
    choice = await menu(ctx, counts, () => { for (const l of detailLines(preview)) say(l); });
    if (choice !== 'learn') break;
    showSummary = await learnRules(ctx, options, run);
    if (showSummary) { target = await analyze(folder); say('내 정리 규칙을 적용해 다시 살펴봤어요:'); }
  }
  if (choice === 'quit') return quit();
  const { preview } = target.analysis;
  const groups = unknownGroups(preview);
  const organizeCount = preview.items.filter((i) => i.action === 'move').length;

  // The plan is built (and saved in the state folder only) from a fresh analysis, exactly as `plan` does; files may have changed since.
  const mode: ApprovalMode = choice;
  const values: PlanValues = mode === 'trash' ? { 'delete-duplicates': 'all' } : {};
  if (mode === 'organize') {
    const incomplete = preview.items.filter((i) => i.reasonCode === 'INCOMPLETE_DOWNLOAD');
    if (incomplete.length) say(`다운로드 중일 수 있는 파일 ${incomplete.length}개(예: ${path.posix.basename(incomplete[0]!.source)})는 그대로 둬요.`);
    const chosen = groups.length ? await askUnknown(ctx, groups, target.saved, target.grant.canonicalPath, run) : [];
    if (!chosen.length && !organizeCount) return new CliResult(`옮길 파일이 없어요. ${unchanged(run)}`, 0);
    if (chosen.length) values.overrides = chosen;
  }
  const created = await createPlan(folder, values, { warn: say, stateDir: ctx.stateDir, options });
  const kind = approvalModeKind[mode];
  const ops = created.plan.operations.filter((op) => op.kind === kind);
  const approval = created.choices.find((c) => c.mode === mode);

  // Files the user expected to move (default moves and the unknown files just placed) but the plan left out: say exactly why.
  const wanted = new Map<string, { source: string; target: string | undefined }>();
  if (mode === 'organize') {
    for (const i of preview.items) if (i.action === 'move')
      wanted.set(i.fileId, { source: i.source, target: i.destination ? path.posix.dirname(i.destination) : undefined });
    const sourceOf = new Map(preview.items.map((i) => [i.fileId, i.source]));
    for (const o of values.overrides ?? []) wanted.set(o.fileId, { source: sourceOf.get(o.fileId) ?? o.fileId, target: o.target });
  }
  const left = leftOut(wanted, new Set(ops.map((op) => op.fileId)), created.preview);
  for (const l of left.lines) say(l);
  if (!ops.length || !approval)
    return new CliResult(left.changed ? `살펴보는 사이 파일이 바뀌어 할 일이 없어졌어요. ${unchanged(run)}` : `옮길 수 있는 파일이 없어요. ${unchanged(run)}`, 0);

  say(mode === 'organize' ? `이렇게 정리할게요(파일 ${ops.length}개, 덮어쓰지 않아요):` : `이 사본들을 휴지통으로 보낼게요(${ops.length}개, 남길 파일은 그대로):`);
  for (const op of ops.slice(0, MAX_LIST)) say(opLine(op));
  for (const l of more(ops.length - MAX_LIST)) say(l);
  // Undoable organizing defaults to yes; the trash (not undone by afo undo) needs an explicit y. Permanent delete is not offered here.
  const go = mode === 'organize'
    ? await askYesNo(ctx, '이대로 정리할까요? 나중에 afo undo로 되돌릴 수 있어요. (Y/n): ', true, unchanged(run))
    : await askYesNo(ctx, `이 사본 ${ops.length}개를 휴지통으로 보낼까요? afo undo로는 되돌리지 않아요. (y/N): `, false, unchanged(run));
  if (!go) throw stop(`${mode === 'organize' ? '정리하지' : '휴지통으로 보내지'} 않았어요. ${unchanged(run)}`, 4);
  const rules = run.savedRule || (target.info.source === 'saved' && target.info.status !== 'disabled');
  return { mode, ops, planId: created.plan.id, code: approval.code, folder: target.grant.canonicalPath, rules };
}

/** `undo` without a run ID: the most recent organize run that still has moved, not-yet-undone files, then the usual undoCommand. */
export async function undoLatestCommand(values: { confirm?: string | undefined }, ctx: ExecContext): Promise<CliResult> {
  const rows = await runSummaries(path.resolve(ctx.stateDir()));
  const unreadable = rows.filter((r) => 'error' in r).length;
  if (unreadable) ctx.warn(`참고: 읽을 수 없는 실행 기록 ${unreadable}개는 건너뛰었어요(afo runs로 확인).`);
  const latest = rows.filter((r): r is RunSummary => !('error' in r) && r.undoable).at(-1);
  if (latest === undefined) {
    const text = `되돌릴 수 있는 정리 기록이 없어요. ${nothing}`;
    return new CliResult(ctx.json ? JSON.stringify({ runId: null, report: null, message: text }, null, 2) : text, 0);
  }
  // The only question is the code, asked before undoRun starts: a cancel there changed nothing.
  try { return await undoCommand(latest.runId, values, ctx, true); }
  catch (error) { if (isCancel(error)) throw stop('그만뒀어요(Ctrl+C). 아무것도 되돌리지 않았어요.', 130); throw error; }
}
