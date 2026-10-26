import { RuleSetDraft } from "@afo/firebase-foundation";
import type { RuleSetInput } from "@afo/firebase-foundation";

export const MAX_IMPORT_BYTES = 64 * 1024;
export const emptyRules = (): RuleSetInput => ({
  formatVersion: 1,
  name: "나의 분류 규칙",
  rules: [],
});
export function storageKey(uid?: string) {
  return `afo.rules.v1:${uid ?? "guest"}`;
}
export function parseRules(text: string): RuleSetInput {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES)
    throw new Error("규칙 파일은 64 KB 이하만 가져올 수 있습니다.");
  return RuleSetDraft.parse(JSON.parse(text));
}
export function readLocal(
  storage: Pick<Storage, "getItem">,
  key: string,
): RuleSetInput {
  const saved = storage.getItem(key);
  return saved === null ? emptyRules() : parseRules(saved);
}
export function writeLocal(
  storage: Pick<Storage, "setItem">,
  key: string,
  input: unknown,
): RuleSetInput {
  const value = RuleSetDraft.parse(input);
  storage.setItem(key, JSON.stringify(value));
  return value;
}
export function rulesError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "permission-denied")
    return "계정의 접근 권한 또는 서비스 연결 상태를 확인해 주세요.";
  if (code === "unauthenticated") return "다시 로그인한 뒤 이용해 주세요.";
  if (["unavailable", "deadline-exceeded", "aborted"].includes(code))
    return "네트워크에 연결한 뒤 다시 확인해 주세요.";
  if (error instanceof Error && error.name === "ZodError")
    return "규칙을 확인해 주세요. 확장자는 .pdf처럼, 폴더는 학교/물리처럼 입력합니다. 절대 경로·상위 폴더·예약 이름은 사용할 수 없습니다.";
  if (error instanceof SyntaxError)
    return "규칙 JSON을 읽지 못했습니다. AFO에서 내보낸 규칙 파일인지 확인해 주세요.";
  if (error instanceof Error && error.name === "QuotaExceededError")
    return "브라우저 저장 공간이 부족합니다. 규칙을 JSON으로 내보내 보관해 주세요.";
  if (error instanceof Error && error.name === "SecurityError")
    return "현재 브라우저 설정에서 규칙을 보관할 수 없습니다. JSON으로 내보내 보관해 주세요.";
  return error instanceof Error ? error.message : "규칙을 처리하지 못했습니다.";
}
