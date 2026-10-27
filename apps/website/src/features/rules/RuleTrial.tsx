import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RuleSetDraft } from "@afo/firebase-foundation";
import type { RuleSetInput } from "@afo/firebase-foundation";
import { makePreview, matchingRules } from "../local-preview/preview";
import { inScope, usePreviewSession } from "../local-preview/session";
import "./trial.css";

export function RuleTrial({ draft }: { draft: RuleSetInput }) {
  const { selection, scope } = usePreviewSession();
  const [shown, setShown] = useState(50);
  const value = useMemo(() => {
    const parsed = RuleSetDraft.safeParse(draft);
    if (!parsed.success || !selection) return null;
    const files = selection.files.filter((file) => inScope(file, scope));
    const matches = makePreview(files, parsed.data, {}, selection.files).filter((item) => matchingRules(item.name, parsed.data).length > 0);
    return { matches, count: files.length };
  }, [draft, selection, scope]);
  return <section className="rule-trial" aria-labelledby="rule-trial-title"><h2 id="rule-trial-title">저장하기 전 규칙 시험</h2>
    <p>선택한 파일 목록에 현재 편집 중인 규칙을 적용해 봅니다. 미리보기만 하며 규칙을 저장하거나 파일을 변경하지 않습니다.</p>
    {!selection ? <p>먼저 <Link to="/preview">내 폴더 미리보기에서 폴더를 선택</Link>해 주세요. 선택한 목록은 이 탭에서만 유지됩니다.</p> : !value ? <p role="status">확장자와 폴더 등 규칙을 올바르게 입력하면 시험 결과가 표시됩니다.</p> : <>
      <p role="status">분석 범위 {value.count}개 중 활성 규칙에 맞는 파일 {value.matches.length}개{selection.truncated ? " · 선택 목록이 한도로 잘렸습니다" : ""}</p>
      {value.matches.length ? <ul>{value.matches.slice(0, shown).map((item) => <li key={item.path}><span>{item.path}</span><strong>{item.status === "review" ? "확인 필요" : item.destination ?? "확인 필요"}</strong><small>{item.status === "review" ? item.reason : "편집 중인 규칙의 제안"}</small></li>)}</ul> : <p>현재 분석 범위에서 일치하는 파일이 없습니다.</p>}
      {value.matches.length > shown && <button type="button" onClick={() => setShown((n) => n + 50)}>결과 더 보기</button>}
      <p>빈 폴더·숨김 항목은 포함되지 않을 수 있고, 파일별 수동 변경은 이 규칙 시험에 적용되지 않습니다.</p>
      <p><Link to="/preview">선택한 폴더 미리보기로 돌아가기</Link></p>
    </>}
  </section>;
}
