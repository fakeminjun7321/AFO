import path from 'node:path';
import { AfoError, PROFILE_EVIDENCE_LIMIT } from '../../../packages/contracts/src/index.js';
import type { Correction, RuleProfile, RuleProfileV2 } from '../../../packages/contracts/src/index.js';
import { confirmProfile, withCorrection } from '../../../packages/engine/src/index.js';
import { disableProfile, enableProfile, loadProfile, profileFromConfirmed, removeCorrection, resetProfile, saveConfirmedProfile, setRuleEnabled }
  from '../../../packages/filesystem/src/profiles.js';
import type { CorruptProfile } from '../../../packages/filesystem/src/profiles.js';

/** CLI adapter for the saved personal rule profile (#18). Policy stays in engine/filesystem; this file only maps commands. */
export class CliError extends Error {
  /** `plain`: a stop the user chose in the guided flow, printed without the "AFO 오류:" prefix. */
  constructor(message: string, readonly exitCode: 1 | 2 | 4 | 130, readonly plain = false) { super(message); this.name = 'CliError'; }
}
export const usage = (message: string): CliError => new CliError(message, 2);

export type Stored = RuleProfileV2 | CorruptProfile | null;
export const isCorrupt = (p: Stored): p is CorruptProfile => p !== null && p.status === 'corrupt';
/** Pins the store state this command saw: a revision, null for "nothing saved", or the damaged file's fingerprint. */
export const expected = (p: Stored): { expectedRevision: number | null } | { expectedCorrupt: string } =>
  p === null ? { expectedRevision: null } : isCorrupt(p) ? { expectedCorrupt: p.fingerprint } : { expectedRevision: p.revision };
export const corruptHint = '`rules reset`으로 비우거나 `rules save`로 다시 저장하세요(손상 파일은 지우지 않고 따로 보관합니다).';

const ruleText = (r: { id: string; extension: string; keyword: string | null; targetDirectory: string }): string =>
  `${r.id} ${r.extension}${r.keyword === null ? '' : ` + 이름에 '${r.keyword}'`} → ${r.targetDirectory}`;
const correctionText = (c: Correction): string =>
  `[${c.id}] ${c.match.type === 'file-name' ? `파일 이름 '${c.match.name}'` : `${c.match.extension}${c.match.keyword === null ? '' : ` + 이름에 '${c.match.keyword}'`}`} → ${c.targetDirectory}`;
const statusText = (p: RuleProfileV2): string => p.status === 'confirmed' ? '켜짐' : '꺼짐(적용하지 않음)';

/** Draft (v1) rules for display: evidence is reference-relative; the reference folder appears only by its last segment. */
export function draftLines(draft: RuleProfile): string[] {
  const label = path.basename(draft.referenceRoot.canonicalPath) || '(이름 없음)';
  return [`참고 폴더 '${label}'에서 규칙 후보 ${draft.rules.length}개 (확인 전에는 적용·저장하지 않습니다)`,
    ...draft.rules.flatMap((r) => [`  [후보] ${ruleText(r)}`,
      `    근거(${r.evidence.length}개): ${r.evidence.slice(0, PROFILE_EVIDENCE_LIMIT).join(', ')}${r.evidence.length > PROFILE_EVIDENCE_LIMIT ? ', …' : ''}`]),
    ...(draft.rules.length ? ['저장: rules save <초안 JSON> --select <규칙ID,...>'] : ['근거가 충분한 규칙 후보가 없습니다. 기본 분류를 사용합니다.'])];
}

export function profileLines(p: RuleProfileV2): string[] {
  return [`저장된 개인 규칙 프로필: ID ${p.id} / revision ${p.revision} / 상태 ${statusText(p)}` +
      (p.referenceRootLabel === null ? '' : ` / 참고 폴더 '${p.referenceRootLabel}'`),
    `규칙 ${p.rules.length}개${p.rules.length ? ':' : ''}`,
    ...p.rules.flatMap((r) => [`  [${r.enabled ? '켜짐' : '꺼짐'}] ${ruleText(r)}`,
      `    근거 예시(전체 ${r.evidenceCount}개 중 ${r.evidence.length}개): ${r.evidence.join(', ')}`]),
    `저장한 수정(이후에도 적용) ${p.corrections.length}개${p.corrections.length ? ':' : ''}`,
    ...p.corrections.map((c) => `  ${correctionText(c)}`)];
}

async function active(stateDir: string): Promise<RuleProfileV2> {
  const p = await loadProfile({ stateDir });
  if (p === null) throw new Error('저장된 개인 규칙 프로필이 없습니다. suggest-rules → rules save로 먼저 저장하세요.');
  if (isCorrupt(p)) throw new AfoError('STATE_CORRUPT', `저장된 프로필이 손상됐습니다: ${p.reason} ${corruptHint}`);
  return p;
}

export interface RulesIo { json: boolean; stateDir: () => string; draft: (file: string) => Promise<RuleProfile>;
  select?: string | undefined; confirm?: string | undefined; isTTY: boolean; ask: (question: string) => Promise<string>;
  warn: (line: string) => void }

const out = (io: RulesIo, data: unknown, lines: string[]): string => io.json ? JSON.stringify(data, null, 2) : lines.join('\n');

export async function rulesCommand(sub: string | undefined, arg: string | undefined, io: RulesIo): Promise<string> {
  const stateDir = io.stateDir();
  const needs = (count: 0 | 1): void => {
    if (count === 1 && arg === undefined) throw usage(`rules ${sub}에는 대상 ID가 필요합니다.`);
    if (count === 0 && arg !== undefined) throw usage(`rules ${sub}에는 추가 인수를 쓰지 않습니다.`);
  };
  if (sub !== 'save' && io.select !== undefined) throw usage('--select는 rules save에서만 씁니다.');
  if (sub !== 'reset' && io.confirm !== undefined) throw usage('--confirm은 rules reset에서만 씁니다.');
  switch (sub) {
    case 'list': {
      needs(0);
      const p = await loadProfile({ stateDir });
      if (p === null) return out(io, { state: 'none' }, ['저장된 개인 규칙이 없습니다. 미리보기는 기본 분류를 사용합니다.']);
      if (isCorrupt(p)) return out(io, { state: 'corrupt', reason: p.reason },
        [`경고: 저장된 개인 규칙 프로필이 손상돼 적용하지 않습니다: ${p.reason}`, corruptHint]);
      return out(io, { state: 'active', profile: p }, profileLines(p));
    }
    case 'save': {
      if (arg === undefined) throw usage('rules save <초안 JSON> --select <규칙ID,...> 형식으로 쓰세요.');
      const ids = (io.select ?? '').split(',').map((s) => s.trim());
      if (io.select === undefined || ids.some((id) => id === '')) throw usage('--select로 저장할 규칙 ID를 하나 이상 쉼표로 명시하세요(빈 선택 거부).');
      const draft = await io.draft(arg);
      if (draft.status === 'disabled') throw new Error('비활성(disabled) 규칙 파일은 저장하지 않습니다.');
      const confirmed = confirmProfile(draft, ids);
      const before = await loadProfile({ stateDir });
      if (isCorrupt(before)) io.warn(`경고: 손상된 기존 프로필(${before.reason})은 따로 보관하고 새로 저장합니다.`);
      // Saved corrections are explicit user choices; replacing the reference rules does not silently drop them.
      const kept = before !== null && !isCorrupt(before) ? before.corrections : [];
      let next = await profileFromConfirmed(confirmed);
      for (const c of kept) next = withCorrection(next, c);
      const saved = await saveConfirmedProfile(next, { stateDir, ...expected(before) });
      const replaced = before !== null && !isCorrupt(before)
        ? [`기존 프로필(revision ${before.revision}, 규칙 ${before.rules.length}개)을 대체했습니다. 저장한 수정 ${kept.length}개는 유지했습니다.`] : [];
      return out(io, { action: 'save', profile: saved, keptCorrections: kept.length },
        [`선택한 규칙 ${saved.rules.length}개를 확인해 앱 로컬 상태에 저장했습니다. 다음 preview부터 자동 적용합니다.`, ...replaced, ...profileLines(saved)]);
    }
    case 'enable': case 'disable': {
      needs(1);
      const before = await active(stateDir);
      const after = await setRuleEnabled(arg!, sub === 'enable', { stateDir, expectedRevision: before.revision });
      const word = sub === 'enable' ? '켰' : '껐';
      return out(io, { action: `${sub}-rule`, ruleId: arg, changed: after.revision !== before.revision, profile: after },
        [after.revision === before.revision ? `규칙 ${arg}은 이미 ${sub === 'enable' ? '켜져' : '꺼져'} 있습니다.` : `규칙 ${arg}을 ${word}습니다 (revision ${after.revision}).`]);
    }
    case 'enable-all': case 'disable-all': {
      needs(0);
      const before = await active(stateDir);
      const options = { stateDir, expectedRevision: before.revision };
      const after = sub === 'enable-all' ? await enableProfile(options) : await disableProfile(options);
      return out(io, { action: sub, changed: after.revision !== before.revision, profile: after },
        [`개인 규칙 프로필 상태: ${statusText(after)}${after.revision === before.revision ? ' (변경 없음)' : ` (revision ${after.revision})`}.`,
          ...(after.status === 'disabled' ? ['꺼진 동안 미리보기는 기본 분류를 사용합니다. 참고한 기존 파일 보호는 계속됩니다.'] : [])]);
    }
    case 'forget': {
      needs(1);
      const before = await active(stateDir);
      const after = await removeCorrection(arg!, { stateDir, expectedRevision: before.revision });
      return out(io, { action: 'forget', correctionId: arg, profile: after }, [`저장한 수정 ${arg}을 지웠습니다 (revision ${after.revision}).`]);
    }
    case 'reset': {
      needs(0);
      if (io.confirm !== undefined && io.confirm !== 'reset') throw new CliError('--confirm 값이 맞지 않습니다. 초기화하려면 --confirm reset을 쓰세요.', 4);
      const before = await loadProfile({ stateDir });
      if (before === null) return out(io, { action: 'reset', changed: false }, ['저장된 개인 규칙이 없어 바꿀 것이 없습니다.']);
      if (io.confirm === undefined) {
        if (!io.isTTY) throw usage('비대화형 실행에서는 --confirm reset이 있어야 초기화합니다. 아무것도 바꾸지 않았습니다.');
        const what = isCorrupt(before) ? '손상된 프로필(따로 보관됨)' : `규칙 ${before.rules.length}개와 저장한 수정 ${before.corrections.length}개`;
        const answer = await io.ask(`저장된 ${what}를 모두 잊습니다. 계속할까요? [y/N] `);
        if (!/^(y|yes|예|ㅇ)$/iu.test(answer.trim())) throw new CliError('초기화를 취소했습니다. 아무것도 바꾸지 않았습니다.', 4);
      }
      await resetProfile({ stateDir, ...expected(before) });
      return out(io, { action: 'reset', changed: true }, ['개인 규칙 프로필을 초기화했습니다. 다음 preview부터 기본 분류를 사용합니다. 작업·참고 폴더의 파일은 바꾸지 않았습니다.']);
    }
    default: throw usage('rules 하위 명령: list | save | enable | disable | enable-all | disable-all | forget | reset');
  }
}
