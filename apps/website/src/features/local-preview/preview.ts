import type { RuleSetInput } from "@afo/firebase-foundation";
import { defaultCategory, extensionOfName } from "../../../../../packages/engine/src/defaults";

export type SelectedFile = { path: string; name: string; size: number; file: File };
export type PreviewItem = SelectedFile & {
  category: string | null;
  destination: string | null;
  status: "proposed" | "already" | "review";
  reason: string;
};
const key = (value: string) => value.normalize("NFC").toLowerCase();
const defaultReasons = {
  NO_EXTENSION: "확장자가 없어요",
  COMPOUND_EXTENSION: "확장자가 여러 개라 확인이 필요해요",
  UNKNOWN_EXTENSION: "분류 기준이 없어요",
  DEFAULT_EXTENSION: "확장자로 분류했어요",
};

/** Read-only suggestions. File input cannot reveal empty directories or excluded files. */
export function makePreview(files: SelectedFile[], rules: RuleSetInput | null): PreviewItem[] {
  const knownFiles = new Set(files.map((file) => key(file.path)));
  const knownDirectories = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) knownDirectories.add(key(parts.slice(0, i).join("/")));
  }
  const items = files.map((file): PreviewItem => {
    const matches = rules?.rules.filter((rule) => rule.enabled && rule.extension === extensionOfName(file.name) &&
      (rule.keyword === null || key(file.name).includes(key(rule.keyword)))) ?? [];
    const targets = new Set(matches.map((rule) => key(rule.targetDirectory)));
    if (targets.size > 1) return { ...file, category: null, destination: null, status: "review", reason: "개인 규칙의 목적지가 서로 달라요" };
    const fallback = defaultCategory(file.name);
    const directory = matches[0]?.targetDirectory ?? fallback.category;
    if (!directory) return { ...file, category: null, destination: null, status: "review", reason: defaultReasons[fallback.reason] };
    const destination = `${directory}/${file.name}`;
    if (directory.split("/").some((part) => part.startsWith(".")))
      return { ...file, category: directory, destination, status: "review", reason: "숨김 경로는 확인하지 않아 직접 확인이 필요해요" };
    if (key(destination) === key(file.path)) return { ...file, category: directory, destination, status: "already", reason: "이미 같은 위치에 있어요" };
    const parents = directory.split("/").map((_, i, parts) => key(parts.slice(0, i + 1).join("/")));
    if (knownFiles.has(key(destination)) || knownDirectories.has(key(destination)) || parents.some((part) => knownFiles.has(part)))
      return { ...file, category: directory, destination, status: "review", reason: "선택된 목록의 파일 또는 폴더와 위치가 겹쳐요" };
    return { ...file, category: directory, destination, status: "proposed", reason: matches.length ? "저장한 개인 규칙을 적용했어요" : defaultReasons[fallback.reason] };
  });
  const planned = new Map<string, PreviewItem[]>();
  for (const item of items) if (item.status === "proposed" && item.destination) {
    const target = key(item.destination);
    const group = planned.get(target);
    if (group) group.push(item);
    else planned.set(target, [item]);
  }
  for (const same of planned.values()) if (same.length > 1) for (const item of same) {
    item.status = "review"; item.reason = "다른 파일과 제안 위치가 같아요";
  }
  for (const item of items) if (item.destination) {
    const parts = item.destination.split("/");
    for (let i = 1; i < parts.length; i++) {
      for (const parent of planned.get(key(parts.slice(0, i).join("/"))) ?? []) {
        item.status = "review"; item.reason = "제안한 파일과 폴더 위치가 겹쳐요";
        parent.status = "review"; parent.reason = "제안한 파일과 폴더 위치가 겹쳐요";
      }
    }
  }
  return items;
}
