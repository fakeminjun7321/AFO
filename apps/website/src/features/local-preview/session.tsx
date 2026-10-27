import { createContext, useContext, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { extensionOfName } from "../../../../../packages/engine/src/defaults";
import type { SelectedFile, PreviewOverride } from "./preview";

export type Selection = { folder: string; files: SelectedFile[]; hidden: number; truncated: boolean };
export type Scope = { directories: string[]; extensions: string[] };
export const emptyScope = (): Scope => ({ directories: [], extensions: [] });
const key = (s: string) => s.normalize("NFC").toLowerCase();
export function inScope(file: SelectedFile, scope: Scope): boolean {
  const path = key(file.path);
  return !scope.directories.some((dir) => path.startsWith(`${key(dir)}/`)) &&
    !scope.extensions.includes(extensionOfName(file.name));
}
type Session = {
  selection: Selection | null; setSelection: Dispatch<SetStateAction<Selection | null>>;
  scope: Scope; setScope: Dispatch<SetStateAction<Scope>>;
  overrides: Record<string, PreviewOverride>; setOverrides: Dispatch<SetStateAction<Record<string, PreviewOverride>>>;
};
const Context = createContext<Session | null>(null);
export function PreviewSessionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [scope, setScope] = useState<Scope>(emptyScope);
  const [overrides, setOverrides] = useState<Record<string, PreviewOverride>>({});
  return <Context.Provider value={{ selection, setSelection, scope, setScope, overrides, setOverrides }}>{children}</Context.Provider>;
}
export function usePreviewSession(): Session {
  const value = useContext(Context);
  if (!value) throw new Error("PreviewSessionProvider가 필요합니다.");
  return value;
}
