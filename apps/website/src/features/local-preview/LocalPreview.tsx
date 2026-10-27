import { useRef, useState } from "react";
import { defaultCategory } from "../../../../../packages/engine/src/defaults";
import "./local-preview.css";

type Item = { path: string; size: number; category: string | null; reason: string };
const LIMIT = 5000;
const DISPLAY_LIMIT = 200;
const labels: Record<string, string> = {
  NO_EXTENSION: "확장자가 없어요", COMPOUND_EXTENSION: "확장자가 여러 개라 확인이 필요해요",
  UNKNOWN_EXTENSION: "분류 기준이 없어요", DEFAULT_EXTENSION: "확장자로 분류했어요",
};
function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = value / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}
export function LocalPreview() {
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ folder: string; items: Item[]; hidden: number; truncated: boolean } | null>(null);
  const [filter, setFilter] = useState("전체");
  const [error, setError] = useState("");
  function choose() {
    if (!input.current) return;
    if (!("webkitdirectory" in input.current)) {
      setError("이 브라우저는 폴더 선택을 지원하지 않습니다. 데스크톱 Chrome 또는 Edge를 이용해 주세요.");
      return;
    }
    setError("");
    input.current.value = "";
    input.current.setAttribute("webkitdirectory", "");
    input.current.click();
  }
  function analyze(files: FileList | null) {
    if (!files?.length) return;
    const first = files[0].webkitRelativePath;
    if (!first || !first.includes("/")) { setError("폴더 정보를 읽지 못했습니다. 지원되는 브라우저에서 다시 선택해 주세요."); return; }
    const folder = first.split("/")[0];
    let hidden = 0, truncated = false;
    const items: Item[] = [];
    for (const file of files) {
      const parts = file.webkitRelativePath.split("/").slice(1);
      if (!parts.length || parts.some((part) => part.startsWith("."))) { hidden++; continue; }
      if (items.length >= LIMIT) { truncated = true; continue; }
      const classification = defaultCategory(file.name);
      items.push({ path: parts.join("/"), size: file.size, category: classification.category, reason: labels[classification.reason] });
    }
    setFilter("전체"); setResult({ folder, items, hidden, truncated });
  }
  const counts = new Map<string, number>();
  result?.items.forEach((item) => counts.set(item.category ?? "확인 필요", (counts.get(item.category ?? "확인 필요") ?? 0) + 1));
  const visible = result?.items.filter((item) => filter === "전체" || (item.category ?? "확인 필요") === filter) ?? [];
  return <section className="local-preview section-wrap" aria-labelledby="local-preview-title">
    <div className="local-intro"><div><span className="local-eyebrow">내 폴더 미리보기</span><h1 id="local-preview-title">폴더를 열고,<br />정리부터 살펴보세요.</h1></div>
      <p>선택한 폴더의 파일 이름과 크기를 이 브라우저에서 분석합니다. 파일을 업로드하거나 변경하지 않습니다.</p></div>
    <input ref={input} type="file" multiple hidden aria-label="분석할 폴더" onChange={(event) => analyze(event.currentTarget.files)} />
    {error && <p className="local-error" role="alert">{error}</p>}
    <div className="local-card"><div className="local-card-top"><div><span className="local-kicker">READ ONLY · 읽기 전용</span><h2>{result ? result.folder : "분석할 폴더를 선택하세요"}</h2><p>{result ? `파일 ${result.items.length.toLocaleString()}개 분석` : "폴더에 있는 파일의 기본 분류를 확인할 수 있어요."}</p></div>
      <button type="button" className="button button--accent" onClick={choose}>{result ? "다른 폴더 선택" : "폴더 선택하기"}</button></div>
      {!result ? <div className="local-empty"><strong>선택한 폴더 안에서만</strong><p>확장자로 문서, 이미지, 영상 등을 나누어 보여 드립니다. 알 수 없는 파일은 직접 확인할 수 있도록 남겨 둡니다.</p><p>폴더 선택이 지원되지 않는 브라우저에서는 Chrome 또는 Edge의 데스크톱 버전을 이용해 주세요.</p></div> : <>
        <div role="status" className="local-notice">{result.truncated ? `파일이 많아 처음 ${LIMIT.toLocaleString()}개만 분석했어요. 전체 결과가 아닙니다. ` : ""}{result.hidden ? `숨김 경로의 파일 ${result.hidden}개는 제외했어요. ` : ""}분류 위치는 제안이며 실제 이동은 제공하지 않습니다.</div>
        <div className="local-filters" aria-label="분류 필터"><button type="button" aria-pressed={filter === "전체"} onClick={() => setFilter("전체")}>전체 {result.items.length}</button>{Array.from(counts, ([name, count]) => <button type="button" key={name} aria-pressed={filter === name} onClick={() => setFilter(name)}>{name} {count}</button>)}</div>
        {visible.length ? <div className="local-list"><div className="local-list-head"><span>현재 위치</span><span>분류 제안</span><span>크기</span></div>{visible.slice(0, DISPLAY_LIMIT).map((item, index) => <div className="local-row" key={`${item.path}-${index}`}><span className="local-path" title={item.path}>{item.path}</span><span><b>{item.category ?? "확인 필요"}</b><small>{item.reason}</small></span><span>{bytes(item.size)}</span></div>)}</div> : <p className="local-empty">분석할 파일이 없습니다. 빈 폴더는 브라우저에서 선택되지 않을 수 있어요.</p>}
        {visible.length > DISPLAY_LIMIT && <p className="local-note">화면에는 선택한 분류의 처음 {DISPLAY_LIMIT}개만 표시합니다. 집계에는 분석한 파일이 모두 포함됩니다.</p>}
        <p className="local-note">기본 확장자 분류만 적용합니다. 개인 규칙, 중복 검사, 대상 위치 충돌 검사는 아직 제공하지 않습니다.</p>
      </>}</div>
  </section>;
}
