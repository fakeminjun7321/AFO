import { homedir } from 'node:os';
import path from 'node:path';
import { AfoError, CorrectionMatchSchema, TargetDirectorySchema, approvalModeKind, isAfoError } from '../../../packages/contracts/src/index.js';
import type { ApprovalMode, ClassificationReason, CorrectionMatch, ExecutionReport, PlanOperation, Preview }
  from '../../../packages/contracts/src/index.js';
import { extensionOfName } from '../../../packages/engine/src/defaults.js';
import { addCorrection } from '../../../packages/filesystem/src/profiles.js';
import { analyzeTarget } from './analyze.js';
import type { ProfileInfo, Target } from './analyze.js';
import { CliResult, applyCommand, runSummaries, undoCommand } from './apply.js';
import type { ExecContext, RunSummary } from './apply.js';
import { createPlan } from './plan.js';
import type { PlanValues } from './plan.js';
import { CliError, expected, isCorrupt } from './rules.js';
import type { Stored } from './rules.js';
import { haeyo } from './words.js';

/**
 * `afo` with no arguments on a TTY: folder → short summary → menu → plan → typed approval code → the same apply path
 * (applyCommand: issueApproval → consumeApproval → executeBatch). Only an adapter; no classification or approval logic here.
 * Questions and screens go to stderr (ctx.warn / ctx.ask), the final result is the returned stdout text.
 * Permanent delete is deliberately not offered here (plan --delete-mode permanent + apply only).
 */
const MAX_FOLDER_TRIES = 3;
const MAX_MENU_TRIES = 3;
const MAX_LIST = 20;
const nothing = '아무것도 바꾸지 않았어요.';
/** A stop the user chose (no code, wrong code, gave up, Ctrl+C before running): no "AFO 오류:" prefix, exit code kept. */
const stop = (message: string, exitCode: 1 | 2 | 4 | 130): CliError => new CliError(message, exitCode, true);
const CANCELLED_BEFORE = `그만뒀어요(Ctrl+C). ${nothing}`;

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
    : info.source === 'none' ? '저장된 내 정리 규칙이 없어 기본 분류(문서·이미지·영상 등)를 썼어요.'
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

function summaryLines(preview: Preview, info: ProfileInfo): string[] {
  const moves = preview.items.filter((i) => i.action === 'move');
  const keeps = preview.items.filter((i) => i.action === 'keep');
  const reviews = preview.items.filter((i) => i.action === 'review');
  const byFolder = new Map<string, number>();
  for (const i of moves) byFolder.set(folderOf(i), (byFolder.get(folderOf(i)) ?? 0) + 1);
  const tally = (items: typeof reviews): string => {
    const byReason = new Map<string, number>();
    for (const i of items) byReason.set(labelOf(i), (byReason.get(labelOf(i)) ?? 0) + 1);
    const reasons = ranked(byReason);
    return reasons.length ? ` — ${reasons.slice(0, 4).map(([r, n]) => `${r} ${n}`).join(' · ')}${reasons.length > 4 ? ' · …' : ''}` : '';
  };
  const dupFiles = preview.duplicates.reduce((n, g) => n + g.candidates.length, 0);
  const example = preview.duplicates.find((g) => g.candidates.length);
  return [`파일 ${preview.items.length}개를 살펴봤어요. (아직 아무것도 바꾸지 않았어요)`,
    `  폴더별로 정리할 수 있는 파일: ${moves.length}개${byFolder.size ? ` — ${ranked(byFolder).map(([f, n]) => `${f} ${n}`).join(' · ')}` : ''}`,
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

type Choice = 'organize' | 'trash' | 'quit';

async function menu(ctx: ExecContext, counts: { organize: number; unknown: number; trash: number; movedCopies: number },
  show: () => void): Promise<Choice> {
  const lines = () => ['무엇을 할까요?',
    `  1) 폴더별로 정리하기(되돌릴 수 있어요)${counts.organize ? ` — 파일 ${counts.organize}개`
      : counts.unknown ? ` — 종류를 모르는 파일 ${counts.unknown}개(옮길 곳을 물어봐요)` : ' — 할 일 없음'}`,
    ...(counts.organize && counts.movedCopies ? [`     같은 내용의 사본 ${counts.movedCopies}개도 함께 옮겨요. 먼저 2)로 정리할 수도 있어요.`] : []),
    ...(counts.organize && counts.unknown ? [`     종류를 모르는 파일 ${counts.unknown}개는 어디로 옮길지 이어서 물어봐요.`] : []),
    `  2) 중복 파일을 휴지통으로 보내기${counts.trash ? `(휴지통에서 다시 꺼낼 수 있어요. afo undo로는 되돌리지 않아요) — 사본 ${counts.trash}개`
      : ' — 할 일 없음'}`,
    '  3) 자세히 보기', '  4) 그만두기'];
  for (const l of lines()) ctx.warn(l);
  for (let tries = 1; ; tries++) {
    const answer = (await ctx.ask('번호를 입력하세요: ')).trim();
    if (answer === '' || answer === '4') return 'quit';
    if (answer === '3') { show(); for (const l of lines()) ctx.warn(l); tries = 0; continue; }
    if (answer === '1' && (counts.organize || counts.unknown)) return 'organize';
    if (answer === '2' && counts.trash) return 'trash';
    ctx.warn(answer === '1' || answer === '2' ? '그 작업은 할 일이 없어요. 다른 번호를 골라 주세요.' : '1, 2, 3, 4 중에서 골라 주세요.');
    if (tries >= MAX_MENU_TRIES) throw stop(`번호를 알아듣지 못해 그만둘게요. ${nothing}`, 2);
  }
}

function opLine(op: PlanOperation): string {
  return op.kind === 'move' ? `  ${op.source} → ${op.destination}` : `  ${op.source}${op.keeper ? ` (같은 내용의 '${op.keeper}' 파일은 남겨요)` : ''}`;
}

function resultText(report: ExecutionReport, mode: ApprovalMode, ops: Map<string, PlanOperation>): string {
  const n = (s: string): number => report.results.filter((r) => r.status === s).length;
  const ok = n('moved') + n('trashed');
  const bad = report.results.filter((r) => r.status !== 'moved' && r.status !== 'trashed');
  const name = (opId: string): string => ops.get(opId)?.source ?? opId;
  const stopped = report.results.filter((r) => r.errorCode === 'CANCELLED').length;
  return [`${mode === 'organize' ? '정리' : '휴지통 보내기'}를 ${stopped ? '중간에 멈췄어요' : '마쳤어요'}. (실행 ID ${report.runId.slice(0, 8)})`,
    `  ${mode === 'organize' ? `옮김 ${n('moved')}` : `휴지통으로 보냄 ${n('trashed')}`} · 건너뜀 ${n('skipped')} · 실패 ${n('failed')}` +
      `${n('unknown') ? ` · 결과 확인 못 함 ${n('unknown')}` : ''}`,
    ...(stopped ? [`Ctrl+C로 멈춰 남은 파일 ${stopped}개는 그대로 뒀어요. 이미 ${mode === 'organize' ? '옮긴' : '휴지통으로 보낸'} 파일 ${ok}개는 그 상태예요.`] : []),
    ...(bad.length ? ['  옮기지 않은 파일(바꾸지 않았어요):', ...bad.slice(0, MAX_LIST).map((r) => `    ${name(r.opId)} — ${haeyo(r.detail)}`),
      ...more(bad.length - MAX_LIST).map((l) => `  ${l}`)] : []),
    ...(n('unknown') ? ['결과를 확인하지 못한 파일이 있어요. 다시 실행하지 말고 afo recover로 실제 상태를 확인하세요.'] : []),
    ...(mode === 'organize' && n('moved') ? ['되돌리려면: afo undo'] : []),
    ...(mode === 'trash' && ok ? ['휴지통으로 보낸 파일은 Finder 휴지통(Windows는 휴지통)에서 되살릴 수 있어요. afo undo로는 되돌리지 않아요.'] : []),
    '전체 실행 ID와 기록은 afo runs로 볼 수 있어요.',
  ].join('\n');
}

/** Files the default table does not know (unknown or no extension), grouped by lower-case extension ('' = no extension). */
const UNKNOWN_REASONS: ReadonlySet<ClassificationReason | undefined> = new Set(['UNKNOWN_EXTENSION', 'NO_EXTENSION']);
interface UnknownGroup { ext: string; sources: string[] }
function unknownGroups(preview: Preview): UnknownGroup[] {
  const byExt = new Map<string, string[]>();
  for (const i of preview.items) if (i.action === 'review' && UNKNOWN_REASONS.has(i.reasonCode)) {
    const ext = i.reasonCode === 'NO_EXTENSION' ? '' : extensionOfName(path.posix.basename(i.source));
    byExt.set(ext, [...byExt.get(ext) ?? [], i.source]);
  }
  // Most first, ties by extension; "no extension" last. Deterministic.
  return [...byExt].map(([ext, sources]) => ({ ext, sources: sources.sort() }))
    .sort((a, b) => Number(a.ext === '') - Number(b.ext === '') || b.sources.length - a.sources.length || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0));
}
const groupName = (g: UnknownGroup): string => g.ext === '' ? '확장자 없음' : g.ext;
const example = (g: UnknownGroup): string => path.posix.basename(g.sources[0]!);
const YES = new Set(['y', 'yes', '예', '네', 'ㅛ', 'ㅇ']);
const MAX_GROUPS_SHOWN = 6;
/** A saved "다음에도" correction: extension only (keyword null), the same kind `rules` lists and `rules forget` removes. */
const matchOf = (ext: string): CorrectionMatch | null => {
  const m = CorrectionMatchSchema.safeParse({ type: 'keyword', extension: ext, keyword: null });
  return ext !== '' && m.success ? m.data : null;
};

/**
 * Asks where the unknown files go, once per extension. Returns `--move` specs for this run only (the same one-off override path as
 * `preview/plan --move`) and saves the corrections the user asked to keep. Nothing in the work folder changes here.
 */
async function askUnknown(ctx: ExecContext, groups: UnknownGroup[], saved: Stored): Promise<string[]> {
  const say = ctx.warn;
  const total = groups.reduce((n, g) => n + g.sources.length, 0);
  say(`종류를 모르는 파일이 있어요: ${groups.slice(0, MAX_GROUPS_SHOWN).map((g) => `${groupName(g)} ${g.sources.length}개(예: ${example(g)})`).join(', ')}` +
    `${groups.length > MAX_GROUPS_SHOWN ? ` 외 ${groups.length - MAX_GROUPS_SHOWN}종류` : ''}`);
  say(`  1) 모두 '기타' 폴더로 옮기기`); say('  2) 확장자마다 폴더 정하기'); say('  3) 그대로 두기(기본)');
  let pick = '';
  for (let tries = 1; ; tries++) {
    pick = (await ctx.ask('번호를 입력하세요(그냥 Enter는 3): ')).trim();
    if (pick === '' || pick === '1' || pick === '2' || pick === '3') break;
    say('1, 2, 3 중에서 골라 주세요.');
    if (tries >= MAX_MENU_TRIES) throw stop(`번호를 알아듣지 못해 그만둘게요. ${nothing}`, 2);
  }
  if (pick === '1') { say(`종류를 모르는 파일 ${total}개를 '기타' 폴더로 옮기는 계획을 만들게요.`); return groups.flatMap((g) => g.sources.map((s) => `${s}=기타`)); }
  if (pick !== '2') { say(`종류를 모르는 파일 ${total}개는 그대로 둬요.`); return []; }

  const specs: string[] = [];
  const keep: { match: CorrectionMatch; ext: string; folder: string }[] = [];
  const canSave = !isCorrupt(saved);
  if (!canSave) say('저장된 내 정리 규칙 파일이 손상돼 이번 정리에만 적용해요.');
  for (const g of groups) {
    const what = g.ext === '' ? `확장자 없는 파일 ${g.sources.length}개` : `'${g.ext}' 파일 ${g.sources.length}개`;
    let folder: string | null = null;
    for (let tries = 1; folder === null; tries++) {
      const answer = (await ctx.ask(`${what}를 어느 폴더로 옮길까요? (예: 데이터, 그냥 Enter는 그대로 두기): `)).trim().replace(/\/+$/u, '');
      if (answer === '') break;
      const parsed = TargetDirectorySchema.safeParse(answer);
      if (parsed.success) { folder = parsed.data; break; }
      say('그 이름은 폴더로 쓸 수 없어요(숨김 폴더·..·절대 경로·특수 문자는 안 돼요). 이 폴더 안의 폴더 이름을 입력해 주세요.');
      if (tries >= MAX_MENU_TRIES) { say(`${what}는 그대로 둘게요.`); break; }
    }
    if (folder === null) continue;
    specs.push(...g.sources.map((s) => `${s}=${folder}`));
    const match = matchOf(g.ext);
    // No extension: there is no extension condition to save, so it applies to this run only.
    if (match === null || !canSave) continue;
    const again = (await ctx.ask(`다음에도 '${g.ext}' 파일은 '${folder}' 폴더로 정리할까요? (y/N): `)).trim().toLowerCase();
    if (YES.has(again)) keep.push({ match, ext: g.ext, folder });
  }
  // Saved now, before the plan is built: the plan then binds to the new profile revision. Guarded by the revision this run read.
  let guard = expected(saved);
  for (const k of keep) {
    try {
      const after = await addCorrection(k.match, k.folder, { stateDir: ctx.stateDir(), ...guard });
      guard = { expectedRevision: after.revision };
      say(`저장했어요: 다음에도 '${k.ext}' 파일은 '${k.folder}' 폴더로 정리해요. (afo rules list로 보고 afo rules forget으로 지울 수 있어요)`);
      if (after.status === 'disabled') say('참고: 내 정리 규칙이 꺼져 있어 저장한 내용은 afo rules enable-all 뒤에 적용돼요(이번 정리에는 반영해요).');
    } catch (error) {
      if (isCancel(error)) throw error;
      say(`'${k.ext}' 규칙은 저장하지 못했어요(${reasonOf(error)}). 이번 정리에만 적용해요.`);
    }
  }
  return specs;
}

export async function guidedCommand(ctx: ExecContext): Promise<CliResult> {
  // Everything before applyCommand only reads files (and saves a plan in the state folder): a cancel there changed nothing.
  let prepared: Prepared | CliResult;
  try { prepared = await prepare(ctx); }
  catch (error) { if (isCancel(error)) throw stop(CANCELLED_BEFORE, 130); throw error; }
  if (prepared instanceof CliResult) return prepared;
  const { mode, ops, planId, typed } = prepared;

  let result: CliResult;
  try { result = await applyCommand(planId, { mode, confirm: typed }, { ...ctx, json: true }); }
  catch (error) {
    if (isAfoError(error, 'APPROVAL_INVALID')) throw stop(`코드가 맞지 않아 실행하지 않았어요. ${nothing}`, 4);
    throw error;
  }
  const { report } = JSON.parse(result.output) as { report: ExecutionReport };
  return new CliResult(resultText(report, mode, new Map(ops.map((op) => [op.id, op]))), result.exitCode);
}

interface Prepared { mode: ApprovalMode; ops: PlanOperation[]; planId: string; typed: string }
async function prepare(ctx: ExecContext): Promise<Prepared | CliResult> {
  const say = ctx.warn;
  const options = ctx.signal ? { signal: ctx.signal } : {};
  const quit = (): CliResult => new CliResult(`그만뒀어요. ${nothing}`, 0);
  say('AFO 파일 정리 도우미예요. 파일을 실제로 옮기기 전에 꼭 확인 코드를 물어봐요. (Ctrl+C로 언제든 그만둘 수 있어요)');

  let folder = ''; let target: Target | undefined;
  for (let attempt = 1; target === undefined; attempt++) {
    folder = cleanDroppedPath(await ctx.ask('정리할 폴더를 이 창으로 끌어다 놓고 Enter를 누르세요(경로를 붙여 넣어도 돼요, 그냥 Enter는 종료): '));
    if (folder === '') return quit();
    try {
      say('폴더를 살펴보는 중이에요…');
      target = await analyzeTarget(folder, {}, { warn: say, stateDir: ctx.stateDir, options, writesState: true });
      if (target.analysis.preview.cancelled || target.analysis.scan.cancelled) throw new AfoError('CANCELLED', '분석을 취소했습니다.');
    } catch (error) {
      if (isCancel(error)) throw error;
      target = undefined;
      say(`이 폴더는 정리할 수 없어요: ${reasonOf(error)}`);
      if (attempt >= MAX_FOLDER_TRIES) throw stop(`폴더를 ${MAX_FOLDER_TRIES}번 열지 못해 그만둘게요. ${nothing}`, 1);
    }
  }

  const { preview } = target.analysis;
  for (const l of summaryLines(preview, target.info)) say(l);
  const moving = new Set(preview.items.filter((i) => i.action === 'move').map((i) => i.source));
  const groups = unknownGroups(preview);
  const counts = { organize: moving.size, unknown: groups.reduce((n, g) => n + g.sources.length, 0),
    trash: preview.duplicates.reduce((n, g) => n + g.candidates.length, 0),
    movedCopies: preview.duplicates.reduce((n, g) => n + g.candidates.filter((c) => moving.has(c)).length, 0) };
  const choice = await menu(ctx, counts, () => { for (const l of detailLines(preview)) say(l); });
  if (choice === 'quit') return quit();

  // The plan is built (and saved in the state folder only) from a fresh analysis, exactly as `plan` does; files may have changed since.
  const mode: ApprovalMode = choice;
  const values: PlanValues = mode === 'trash' ? { 'delete-duplicates': 'all' } : {};
  if (mode === 'organize') {
    const incomplete = preview.items.filter((i) => i.reasonCode === 'INCOMPLETE_DOWNLOAD');
    if (incomplete.length) say(`다운로드 중일 수 있는 파일 ${incomplete.length}개(예: ${path.posix.basename(incomplete[0]!.source)})는 그대로 둬요.`);
    const moves = groups.length ? await askUnknown(ctx, groups, target.saved) : [];
    if (!moves.length && !counts.organize) return new CliResult(`옮길 파일이 없어요. ${nothing}`, 0);
    if (moves.length) values.move = moves;
  }
  const created = await createPlan(folder, values, { warn: say, stateDir: ctx.stateDir, options });
  const kind = approvalModeKind[mode];
  const ops = created.plan.operations.filter((op) => op.kind === kind);
  const approval = created.choices.find((c) => c.mode === mode);
  if (!ops.length || !approval) return new CliResult(`살펴보는 사이 파일이 바뀌어 할 일이 없어졌어요. ${nothing}`, 0);

  say(mode === 'organize' ? `이렇게 정리할게요(파일 ${ops.length}개, 덮어쓰지 않아요):` : `이 사본들을 휴지통으로 보낼게요(${ops.length}개, 남길 파일은 그대로):`);
  for (const op of ops.slice(0, MAX_LIST)) say(opLine(op));
  for (const l of more(ops.length - MAX_LIST)) say(l);
  say(`계속하려면 아래 코드를 입력하세요: ${approval.code}`);
  const typed = (await ctx.ask('코드(그냥 Enter는 취소): ')).trim();
  if (typed === '') throw stop(`코드를 입력하지 않아 실행하지 않았어요. ${nothing}`, 4);
  return { mode, ops, planId: created.plan.id, typed };
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
