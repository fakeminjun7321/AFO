/**
 * Polite-informal (해요체) endings for engine/service sentences that the guided screens reuse (folder refusals, per-file results),
 * so one screen does not mix 합니다체 and 해요체. Only known endings are changed; anything else is left as it is.
 * The detailed commands (preview/plan/apply/undo <ID>) keep the original sentences.
 */
const HANGUL = 0xac00;
const finalOf = (ch: string): number => { const c = ch.charCodeAt(0) - HANGUL; return c >= 0 && c < 11172 ? c % 28 : -1; };
const SSANG_SIOT = 20; // ㅆ: every past-tense syllable (었·았·였·했·렸·뒀·있 …)
const endings: [RegExp, string][] = [
  [/않습니다/gu, '않아요'], [/없습니다/gu, '없어요'], [/아닙니다/gu, '아니에요'], [/겹칩니다/gu, '겹쳐요'], [/됩니다/gu, '돼요'],
  [/합니다/gu, '해요'], [/받습니다/gu, '받아요'],
];
export function haeyo(sentence: string): string {
  let s = sentence.replace(/(.)습니다/gu, (all, prev: string) => finalOf(prev) === SSANG_SIOT ? `${prev}어요` : all);
  s = s.replace(/(.)입니다/gu, (_, prev: string) => `${prev}${finalOf(prev) === 0 ? '예요' : '이에요'}`);
  return endings.reduce((acc, [from, to]) => acc.replace(from, to), s);
}
