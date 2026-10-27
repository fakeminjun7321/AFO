import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RuleSetInput } from "@afo/firebase-foundation";
import { useAuth } from "../../auth/AuthProvider";
import { readLocal, rulesError, storageKey } from "../rules/local";
import { findDuplicates } from "./duplicates";
import type { DuplicateResult } from "./duplicates";
import { makePreview } from "./preview";
import type { SelectedFile } from "./preview";
import "./local-preview.css";

type Selection = { folder: string; files: SelectedFile[]; hidden: number; truncated: boolean };
type RulesSnapshot = { key: string; rules: RuleSetInput | null; error: string };
const LIMIT = 5000;
const PAGE_SIZE = 100;
function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = value / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

export function LocalPreview() {
  const input = useRef<HTMLInputElement>(null);
  const work = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const { user, ready, error: authError } = useAuth();
  const key = storageKey(user?.uid);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [snapshot, setSnapshot] = useState<RulesSnapshot | null>(null);
  const [filter, setFilter] = useState("전체");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const [duplicates, setDuplicates] = useState<DuplicateResult | null>(null);
  const [duplicateError, setDuplicateError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [groupsShown, setGroupsShown] = useState(20);

  useEffect(() => {
    if (!ready || (authError && !user)) return;
    const load = () => {
      try { setSnapshot({ key, rules: readLocal(localStorage, key), error: "" }); }
      catch (e) { setSnapshot({ key, rules: null, error: `저장된 규칙을 읽지 못했어요. 기본 분류만 표시합니다. ${rulesError(e)}` }); }
    };
    load();
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) load(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, ready, authError, user]);
  useEffect(() => () => { generation.current++; work.current?.abort(); }, []);

  const currentRules = ready && !(authError && !user) && snapshot?.key === key ? snapshot.rules : null;
  useEffect(() => { setFilter("전체"); setPage(0); }, [currentRules]);
  const items = useMemo(() => makePreview(selection?.files ?? [], currentRules), [selection, currentRules]);
  const counts = new Map<string, number>();
  const categoryOf = (item: (typeof items)[number]) => item.status === "review" ? "확인 필요" : item.category ?? "확인 필요";
  for (const item of items) { const category = categoryOf(item); counts.set(category, (counts.get(category) ?? 0) + 1); }
  const needle = query.trim().normalize("NFC").toLowerCase();
  const visible = items.filter((item) => (filter === "전체" || categoryOf(item) === filter) &&
    (!needle || `${item.path} ${item.destination ?? ""}`.normalize("NFC").toLowerCase().includes(needle)));
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const activeRules = currentRules?.rules.filter((rule) => rule.enabled).length ?? 0;

  function choose() {
    if (!input.current) return;
    if (!("webkitdirectory" in input.current)) {
      setError("이 브라우저는 폴더 선택을 지원하지 않습니다. 데스크톱 Chrome 또는 Edge를 이용해 주세요.");
      return;
    }
    setError(""); input.current.value = "";
    input.current.setAttribute("webkitdirectory", ""); input.current.click();
  }
  function analyze(files: FileList | null) {
    if (!files?.length) return;
    const first = files[0].webkitRelativePath;
    if (!first || !first.includes("/")) { setError("폴더 정보를 읽지 못했습니다. 지원되는 브라우저에서 다시 선택해 주세요."); return; }
    generation.current++; work.current?.abort(); work.current = null;
    setProgress(null); setDuplicates(null); setDuplicateError(""); setGroupsShown(20);
    let hidden = 0, truncated = false;
    const selected: SelectedFile[] = [];
    for (const file of files) {
      const parts = file.webkitRelativePath.split("/").slice(1);
      if (!parts.length || parts.some((part) => part.startsWith("."))) { hidden++; continue; }
      if (selected.length >= LIMIT) { truncated = true; continue; }
      selected.push({ path: parts.join("/"), name: file.name, size: file.size, file });
    }
    setFilter("전체"); setQuery(""); setPage(0);
    setSelection({ folder: first.split("/")[0], files: selected, hidden, truncated });
  }
  async function checkDuplicates() {
    if (!selection || work.current) return;
    if (!globalThis.crypto?.subtle) { setDuplicateError("이 환경에서는 안전한 해시 검사를 사용할 수 없습니다. HTTPS 또는 지원되는 브라우저에서 열어 주세요."); return; }
    const controller = new AbortController(); work.current = controller;
    const token = ++generation.current;
    setDuplicates(null); setDuplicateError(""); setProgress({ done: 0, total: 0 }); setGroupsShown(20);
    try {
      const result = await findDuplicates(selection.files, controller.signal, (done, total) => {
        if (token === generation.current) setProgress({ done, total });
      });
      if (token === generation.current && !controller.signal.aborted) setDuplicates(result);
    } catch (e) {
      if (token === generation.current) setDuplicateError(controller.signal.aborted ? "중복 검사를 취소했습니다." : `중복 검사를 마치지 못했어요. ${e instanceof Error ? e.message : ""}`);
    } finally {
      if (token === generation.current) { work.current = null; setProgress(null); }
    }
  }
  return <section className="local-preview section-wrap" aria-labelledby="local-preview-title">
    <div className="local-intro"><div><span className="local-eyebrow">내 폴더 미리보기</span><h1 id="local-preview-title">폴더를 열고,<br />정리부터 살펴보세요.</h1></div>
      <p>선택한 폴더를 이 브라우저에서 분석합니다. 중복 검사는 별도로 선택하며, 파일을 업로드하거나 변경하지 않습니다.</p></div>
    <input ref={input} type="file" multiple hidden aria-label="분석할 폴더" onChange={(event) => analyze(event.currentTarget.files)} />
    {error && <p className="local-error" role="alert">{error}</p>}
    <div className="local-card"><div className="local-card-top"><div><span className="local-kicker">READ ONLY · 읽기 전용</span><h2>{selection ? selection.folder : "분석할 폴더를 선택하세요"}</h2><p>{selection ? `파일 ${selection.files.length.toLocaleString()}개 분석` : "폴더에 있는 파일의 분류와 제안 위치를 확인할 수 있어요."}</p></div>
      <button type="button" className="button button--accent" onClick={choose}>{selection ? "다른 폴더 선택" : "폴더 선택하기"}</button></div>
      {!selection ? <div className="local-empty"><strong>먼저 샘플로 살펴볼 수도 있어요</strong><p>폴더를 선택하면 확장자와 저장한 규칙으로 분류 결과를 보여 드립니다. 실제 파일은 변경하지 않아요.</p><p>폴더 선택이 지원되지 않는 브라우저에서는 데스크톱 Chrome 또는 Edge를 이용해 주세요.</p><Link className="local-inline-link" to="/demo">샘플 체험하기 →</Link></div> : <>
        <div role="status" className="local-notice">{selection.truncated ? `파일이 많아 처음 ${LIMIT.toLocaleString()}개만 분석했어요. 전체 결과가 아닙니다. ` : ""}{selection.hidden ? `숨김 경로의 파일 ${selection.hidden}개는 제외했어요. ` : ""}제안은 읽기 전용이며 실제 이동은 제공하지 않습니다.</div>
        <div className="local-rules"><div><strong>적용 기준</strong><p>{!ready ? "로그인 상태를 확인하고 있어요." : authError && !user ? "계정 상태를 확인하지 못해 개인 규칙을 적용하지 않았어요." : snapshot?.key !== key ? "브라우저의 규칙을 확인하고 있어요." : snapshot.error ? snapshot.error : `${user ? "로그인 계정" : "비로그인"}의 브라우저 보관함 · 사용 중인 개인 규칙 ${activeRules}개. 맞는 규칙이 없으면 기본 분류를 사용합니다.`}</p><p>클라우드에만 있는 규칙은 나의 규칙에서 불러온 뒤 이 브라우저에 저장해 주세요.</p></div><Link to="/rules" className="local-inline-link">규칙 편집 →</Link></div>
        <div className="local-search"><label htmlFor="preview-search">파일이나 제안 위치 검색</label><input id="preview-search" type="search" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} placeholder="파일 이름 또는 폴더" /></div>
        <div className="local-filters" aria-label="분류 필터"><button type="button" aria-pressed={filter === "전체"} onClick={() => { setFilter("전체"); setPage(0); }}>전체 {items.length}</button>{Array.from(counts, ([name, count]) => <button type="button" key={name} aria-pressed={filter === name} onClick={() => { setFilter(name); setPage(0); }}>{name} {count}</button>)}</div>
        {visible.length ? <div className="local-list" role="table" aria-label="파일 분류 미리보기"><div className="local-list-head" role="row"><span role="columnheader">현재 위치</span><span role="columnheader">제안 위치와 상태</span><span role="columnheader">크기</span></div>{visible.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE).map((item) => <div className="local-row" role="row" key={item.path}><span role="cell" className="local-path">{item.path}</span><span role="cell" className="local-destination"><b>{item.destination ?? "확인 필요"}</b><small>{item.status === "review" ? "확인 필요 · " : item.status === "already" ? "현재 위치 · " : "제안 · "}{item.reason}</small></span><span role="cell">{bytes(item.size)}</span></div>)}</div> : <p className="local-empty">{selection.files.length ? "검색이나 선택한 분류에 해당하는 파일이 없어요." : "분석할 파일이 없습니다. 빈 폴더는 브라우저에서 선택되지 않을 수 있어요."}</p>}
        {pageCount > 1 && <div className="local-pagination"><button type="button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>이전</button><span>{safePage + 1} / {pageCount} 페이지 · {visible.length}개</span><button type="button" disabled={safePage + 1 >= pageCount} onClick={() => setPage(safePage + 1)}>다음</button></div>}
        <p className="local-note">겹침은 선택된 파일 목록에서만 확인합니다. 빈 폴더, 숨김 항목, 분석 한도를 넘은 파일 등은 확인할 수 없어 실제 충돌이 없다는 보장은 아닙니다.</p>
        <section className="local-duplicates" aria-labelledby="duplicates-title"><h3 id="duplicates-title">중복 파일 확인</h3><p>같은 크기인 파일의 내용을 이 기기에서 SHA-256으로 비교합니다. 검사 버튼을 누를 때만 파일 내용을 읽으며 서버로 보내지 않습니다.</p><p>파일당 64 MiB, 전체 512 MiB까지 검사합니다. 빈 파일과 크기가 서로 다른 파일은 비교하지 않아요.</p>
          <button type="button" className="local-action" aria-disabled={Boolean(progress)} onClick={checkDuplicates}>중복 검사 시작</button>{progress && <button type="button" className="local-action local-action--secondary" onClick={() => work.current?.abort()}>검사 취소</button>}
          {progress && <p role="status">검사 중 {progress.done} / {progress.total}개</p>}
          {duplicateError && <p role="alert">{duplicateError}</p>}
          {duplicates && <div className="local-duplicate-results"><strong role="status">{duplicates.groups.length ? `동일한 해시의 후보 ${duplicates.groups.length}그룹` : "검사한 파일에서 일치하는 후보를 찾지 못했어요"}</strong><p>검사 {duplicates.compared}개 · 한도 제외 {duplicates.skipped}개 · 읽기 실패 {duplicates.failed}개 · 빈 파일 {duplicates.empty}개 제외</p>{(duplicates.skipped > 0 || duplicates.failed > 0 || selection.truncated || selection.hidden > 0 || duplicates.empty > 0) && <p>제외된 파일을 확인하지 않아 전체 폴더에 중복이 없다고 판단할 수 없습니다.</p>}<p>결과는 검사 시점의 후보이며 파일을 삭제하거나 원본을 선택하지 않습니다.</p>{duplicates.groups.slice(0, groupsShown).map((group, index) => <div className="local-duplicate-group" key={group.join("\u0000")}><strong>그룹 {index + 1}</strong><ul>{group.map((path) => <li key={path}>{path}</li>)}</ul></div>)}{duplicates.groups.length > groupsShown && <button className="local-action local-action--secondary" type="button" onClick={() => setGroupsShown((n) => n + 20)}>그룹 더 보기</button>}</div>}
        </section>
      </>}</div>
  </section>;
}
