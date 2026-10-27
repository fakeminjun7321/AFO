import { useMemo, useState } from "react";
import { CloudRule } from "@afo/firebase-foundation";
import { extensionOfName } from "../../../../../packages/engine/src/defaults";
import type { DuplicateResult } from "./duplicates";
import type { PreviewItem, PreviewOverride, SelectedFile } from "./preview";
import type { Scope } from "./session";
import "./preview-tools.css";

export function OverrideEditor({ item, value, onChange }: { item: PreviewItem; value?: PreviewOverride; onChange: (value?: PreviewOverride) => void }) {
  const [directory, setDirectory] = useState(value?.mode === "move" ? value.directory : item.category ?? "");
  const [error, setError] = useState("");
  return <details className="override-editor"><summary>위치 변경</summary><form onSubmit={(event) => {
    event.preventDefault();
    const result = CloudRule.safeParse({ id: "override", extension: ".txt", keyword: null, enabled: true, targetDirectory: directory });
    if (!result.success) { setError("선택한 폴더 안의 상대 경로를 입력해 주세요. 절대 경로, .., 예약 이름은 사용할 수 없습니다."); return; }
    setError(""); onChange({ mode: "move", directory: result.data.targetDirectory });
  }}><label>제안 폴더 <input aria-label={`${item.path} 제안 폴더`} value={directory} onChange={(e) => setDirectory(e.target.value)} placeholder="예: 학교/물리" maxLength={512} /></label>
    <div className="tool-buttons"><button type="submit">위치 적용</button><button type="button" onClick={() => { setError(""); onChange({ mode: "keep" }); }}>그대로 두기</button><button type="button" onClick={() => { setError(""); onChange(); }}>자동 분류로 되돌리기</button></div>
    {error && <p role="alert">{error}</p>}<small>이번 화면의 제안만 변경되며 파일은 이동하지 않습니다.</small></form></details>;
}

export function ScopeControls({ files, scope, onChange }: { files: SelectedFile[]; scope: Scope; onChange: (scope: Scope) => void }) {
  const [directory, setDirectory] = useState("");
  const [extension, setExtension] = useState("__select__");
  const options = useMemo(() => {
    const dirs = new Set<string>(); const exts = new Set<string>();
    for (const file of files) {
      const parts = file.path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      exts.add(extensionOfName(file.name));
    }
    return { dirs: [...dirs].sort(), exts: [...exts].sort() };
  }, [files]);
  return <details className="scope-controls"><summary>분석 범위 바꾸기</summary><p>선택한 파일 목록에서 하위 폴더 또는 확장자를 제외합니다. 제외한 파일은 중복 검사와 결과 내보내기에서도 빠집니다.</p>
    <div className="scope-selects"><div><label htmlFor="scope-directory">하위 폴더</label><select id="scope-directory" value={directory} onChange={(e) => setDirectory(e.target.value)}><option value="">폴더 선택</option>{options.dirs.map((dir) => <option key={dir} value={dir}>{dir}</option>)}</select><button type="button" disabled={!directory || scope.directories.includes(directory)} onClick={() => onChange({ ...scope, directories: [...scope.directories, directory] })}>폴더 제외</button></div>
    <div><label htmlFor="scope-extension">파일 종류</label><select id="scope-extension" value={extension} onChange={(e) => setExtension(e.target.value)}><option value="__select__">확장자 선택</option>{options.exts.map((ext) => <option key={ext || "none"} value={ext}>{ext || "확장자 없음"}</option>)}</select><button type="button" disabled={extension === "__select__" || scope.extensions.includes(extension)} onClick={() => onChange({ ...scope, extensions: [...scope.extensions, extension] })}>종류 제외</button></div></div>
    {(scope.directories.length > 0 || scope.extensions.length > 0) && <div className="scope-chips"><strong>제외 중</strong>{scope.directories.map((dir) => <button type="button" key={dir} onClick={() => onChange({ ...scope, directories: scope.directories.filter((item) => item !== dir) })}>폴더 {dir} 제외 해제 ×</button>)}{scope.extensions.map((ext) => <button type="button" key={ext || "none"} onClick={() => onChange({ ...scope, extensions: scope.extensions.filter((item) => item !== ext) })}>종류 {ext || "확장자 없음"} 제외 해제 ×</button>)}</div>}
    <small>제외한 파일도 이미 존재하는 위치 충돌을 확인할 때는 참고합니다. 숨김 항목과 빈 폴더는 보이지 않을 수 있습니다.</small></details>;
}

type Node = { dirs: Map<string, Node>; files: { name: string; status: PreviewItem["status"] }[] };
const makeNode = (): Node => ({ dirs: new Map(), files: [] });
function buildTree(items: PreviewItem[], proposed: boolean): Node {
  const root = makeNode();
  for (const item of items) {
    const path = proposed && item.status === "proposed" && item.destination ? item.destination : item.path;
    const parts = path.split("/"); let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, makeNode());
      node = node.dirs.get(part)!;
    }
    node.files.push({ name: parts[parts.length - 1], status: item.status });
  }
  return root;
}
function TreeChildren({ node, proposed }: { node: Node; proposed: boolean }) {
  const [shown, setShown] = useState(100);
  const entries = [...[...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => ({ name, child })),
    ...[...node.files].sort((a, b) => a.name.localeCompare(b.name)).map((file) => ({ name: file.name, file }))];
  return <ul>{entries.slice(0, shown).map((entry, i) => <li key={`${entry.name}-${i}`}>{"child" in entry && entry.child ? <TreeBranch name={entry.name} node={entry.child} proposed={proposed} /> : <span className="tree-file">{entry.name}{"file" in entry && entry.file?.status === "review" && proposed ? " · 확인 필요" : ""}</span>}</li>)}{shown < entries.length && <li><button type="button" onClick={() => setShown((n) => n + 100)}>이 폴더 항목 더 보기</button></li>}</ul>;
}
function TreeBranch({ name, node, proposed }: { name: string; node: Node; proposed: boolean }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(e) => setOpen(e.currentTarget.open)}><summary>{name}/</summary>{open && <TreeChildren node={node} proposed={proposed} />}</details>;
}
export function FolderTrees({ items }: { items: PreviewItem[] }) {
  const before = useMemo(() => buildTree(items, false), [items]);
  const after = useMemo(() => buildTree(items, true), [items]);
  return <section className="tree-view" aria-label="폴더 구조 비교"><p>선택한 분석 범위만 표시합니다. 확인이 필요한 파일은 제안 구조에서도 현재 위치에 남겨 두었습니다.</p><div className="tree-columns"><div><h3>현재 구조</h3><TreeChildren node={before} proposed={false} /></div><div><h3>제안 구조</h3><TreeChildren node={after} proposed /></div></div></section>;
}

function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function ExportTools({ items, scope, hidden, truncated, excluded, duplicates }: { items: PreviewItem[]; scope: Scope; hidden: number; truncated: boolean; excluded: number; duplicates: DuplicateResult | null }) {
  function download(kind: "json" | "csv") {
    const groupOf = new Map<string, number>();
    duplicates?.groups.forEach((group, index) => group.forEach((path) => groupOf.set(path, index + 1)));
    const summary = items.map(({ path, destination, size, status, reason }) => ({ path, destination, size, status, reason,
      duplicateGroup: groupOf.get(path) ?? null }));
    const body = kind === "json" ? JSON.stringify({ formatVersion: 1, mode: "preview-only", hidden, truncated, excluded, scope, items: summary, duplicateCheck: duplicates }, null, 2)
      : "\ufeff" + [["현재 위치", "제안 위치", "크기(바이트)", "상태", "이유", "중복 후보 그룹"], ...summary.map((item) => [item.path, item.destination ?? "", item.size, item.status, item.reason, item.duplicateGroup ?? (duplicates ? "미확정" : "미검사")])].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([body], { type: kind === "json" ? "application/json" : "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `afo-preview.${kind}`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="export-tools"><h3>결과 내보내기</h3><p>현재 분석 범위의 전체 결과를 저장합니다. 검색·화면 필터와 관계없이 파일명과 상대 경로가 포함되며 파일 내용은 포함되지 않습니다. JSON에는 중복 검사 결과와 제외 범위도 포함됩니다.</p><div className="tool-buttons"><button type="button" onClick={() => download("json")}>JSON 저장</button><button type="button" onClick={() => download("csv")}>CSV 저장</button></div><small>CSV는 스프레드시트의 수식 실행을 막기 위해 수식처럼 시작하는 값 앞에 작은따옴표를 붙입니다.</small></section>;
}
