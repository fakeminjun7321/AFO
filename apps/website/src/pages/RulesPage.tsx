import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Link } from "react-router-dom";
import {
  createRuleRepository,
  CleanupPending,
  RevisionConflict,
  RuleSetDraft,
} from "@afo/firebase-foundation";
import type { RuleSetInput } from "@afo/firebase-foundation";
import { useAuth } from "../auth/AuthProvider";
import { auth, cloudRulesEnabled } from "../auth/firebase";
import { firestore } from "../features/rules/cloud";
import {
  emptyRules,
  MAX_IMPORT_BYTES,
  parseRules,
  readLocal,
  rulesError,
  storageKey,
  writeLocal,
} from "../features/rules/local";
import "../features/rules/rules.css";

export function RulesPage() {
  const { user, ready } = useAuth();
  if (!ready)
    return (
      <p className="route-status" role="status">
        로그인 상태를 확인하고 있어요.
      </p>
    );
  // A different identity always gets a fresh editor and fresh async state.
  return <RulesEditor key={user?.uid ?? "guest"} uid={user?.uid} />;
}

function RulesEditor({ uid }: { uid?: string }) {
  const key = storageKey(uid);
  const [draft, setDraft] = useState<RuleSetInput>(emptyRules);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState<number | null | undefined>(
    undefined,
  );
  const [uncertain, setUncertain] = useState(false);
  const active = useRef(true);
  const locked = useRef(false);
  const canCloud = Boolean(uid && cloudRulesEnabled && firestore);
  useEffect(() => {
    active.current = true;
    try {
      setDraft(readLocal(localStorage, key));
    } catch (e) {
      setError(
        `저장한 규칙을 열지 못했습니다. 기존 자료는 보존했습니다. ${rulesError(e)}`,
      );
    }
    return () => {
      active.current = false;
    };
  }, [key]);
  function update(value: RuleSetInput) {
    setDraft(value);
    setDirty(true);
    setMessage("");
    setError("");
  }
  function changeRule(
    index: number,
    patch: Partial<RuleSetInput["rules"][number]>,
  ) {
    update({
      ...draft,
      rules: draft.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    });
  }
  function saveLocal() {
    try {
      writeLocal(localStorage, key, draft);
      setDirty(false);
      setMessage(
        "이 브라우저에 저장했어요. 같은 브라우저에서 다시 열 수 있습니다.",
      );
      setError("");
    } catch (e) {
      setError(rulesError(e));
    }
  }
  function exportJSON() {
    try {
      const value = RuleSetDraft.parse(draft);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "afo-portable-rules.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        "규칙 JSON을 내보냈어요. 파일 내용과 로컬 경로는 포함하지 않습니다.",
      );
      setError("");
    } catch (e) {
      setError(rulesError(e));
    }
  }
  async function importJSON(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      if (file.size > MAX_IMPORT_BYTES)
        throw new Error("규칙 파일은 64 KB 이하만 가져올 수 있습니다.");
      const value = parseRules(await file.text());
      if (!active.current) return;
      update(value);
      setMessage("가져온 규칙을 확인한 뒤 저장해 주세요.");
    } catch (e) {
      if (active.current) setError(rulesError(e));
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function cloud(action: "read" | "save") {
    if (!canCloud || !firestore || locked.current) return;
    if (auth.currentUser?.uid !== uid) {
      setError("계정이 바뀌었습니다. 규칙 화면을 다시 열어 주세요.");
      return;
    }
    const parsed = RuleSetDraft.safeParse(draft);
    if (action === "save" && !parsed.success) {
      setError(rulesError(parsed.error));
      return;
    }
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const repo = createRuleRepository(auth, firestore);
      if (action === "read") {
        const value = await repo.read("personal");
        if (!active.current || auth.currentUser?.uid !== uid) return;
        setRevision(value?.revision ?? null);
        setUncertain(false);
        if (value) {
          setDraft({ formatVersion: 1, name: value.name, rules: value.rules });
          setDirty(true);
          setMessage(
            `클라우드 버전 ${value.revision}을 불러왔어요. 이 브라우저에도 보관하려면 저장해 주세요.`,
          );
        } else
          setMessage(
            "아직 클라우드에 저장한 규칙이 없습니다. 지금 작성한 규칙을 저장할 수 있어요.",
          );
      } else {
        if (revision === undefined || uncertain)
          throw new Error(
            "클라우드에서 먼저 불러와 최신 버전을 확인해 주세요.",
          );
        const next = await repo.save("personal", parsed.data, revision);
        if (!active.current || auth.currentUser?.uid !== uid) return;
        setRevision(next);
        setMessage(`클라우드 버전 ${next}로 저장했어요.`);
      }
    } catch (e) {
      if (!active.current) return;
      if (action === "save") {
        setUncertain(true);
        setRevision(undefined);
      }
      if (e instanceof RevisionConflict)
        setError(
          "다른 창에서 규칙이 바뀌었습니다. 현재 규칙을 JSON으로 보관한 뒤 클라우드에서 다시 불러와 비교해 주세요.",
        );
      else if (e instanceof CleanupPending)
        setError(
          "규칙은 저장됐지만 이전 버전 정리가 끝나지 않았습니다. 다시 저장하지 말고 클라우드에서 불러와 결과를 확인해 주세요.",
        );
      else
        setError(
          `클라우드 ${action === "read" ? "조회 결과" : "저장 결과"}를 확인하지 못했습니다. ${rulesError(e)} 다시 불러와 상태를 확인해 주세요.`,
        );
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <section className="rules-page section-wrap" aria-labelledby="rules-title">
      <div className="page-heading">
        <h1 id="rules-title">나의 규칙</h1>
        <p>
          확장자와 이름을 기준으로 분류 규칙을 만드세요.
          <br />
          규칙만 저장하며 실제 파일은 이동하거나 삭제하지 않습니다.
        </p>
      </div>
      <div className="rules-storage">
        <div>
          <h2>{uid ? "내 계정의 규칙" : "이 브라우저의 규칙"}</h2>
          <p>
            {uid
              ? "브라우저 보관함은 로그인 계정별로 구분됩니다."
              : "로그인 없이 브라우저에 보관하거나 JSON으로 옮길 수 있어요."}
          </p>
        </div>
        <span className="rules-unsaved">
          {dirty ? "브라우저 저장 전" : "편집 준비됨"}
        </span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          saveLocal();
        }}
      >
        <fieldset disabled={busy} className="rules-fieldset">
          <label className="rules-name" htmlFor="rules-name">
            규칙 모음 이름
            <input
              id="rules-name"
              value={draft.name}
              maxLength={80}
              required
              onChange={(e) => update({ ...draft, name: e.target.value })}
            />
          </label>
          <div className="rules-list">
            {draft.rules.length === 0 && (
              <p className="rules-empty">
                아직 규칙이 없어요. 첫 분류 기준을 추가해 보세요.
              </p>
            )}
            {draft.rules.map((rule, index) => (
              <div className="rule-edit" key={rule.id}>
                <span className="rule-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <label>
                  확장자
                  <input
                    aria-label={`규칙 ${index + 1} 확장자`}
                    value={rule.extension}
                    placeholder=".pdf"
                    required
                    maxLength={17}
                    onChange={(e) =>
                      changeRule(index, {
                        extension: e.target.value.trim().toLowerCase(),
                      })
                    }
                  />
                </label>
                <label>
                  이름에 포함 <span className="field-help">선택</span>
                  <input
                    aria-label={`규칙 ${index + 1} 키워드`}
                    value={rule.keyword ?? ""}
                    placeholder="물리"
                    maxLength={80}
                    onChange={(e) =>
                      changeRule(index, { keyword: e.target.value || null })
                    }
                  />
                </label>
                <label>
                  정리할 폴더
                  <input
                    aria-label={`규칙 ${index + 1} 폴더`}
                    value={rule.targetDirectory}
                    placeholder="학교/물리"
                    required
                    maxLength={512}
                    onChange={(e) =>
                      changeRule(index, { targetDirectory: e.target.value })
                    }
                  />
                </label>
                <label className="rule-enabled">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) =>
                      changeRule(index, { enabled: e.target.checked })
                    }
                  />
                  사용
                </label>
                <button
                  type="button"
                  className="quiet-link"
                  aria-label={`규칙 ${index + 1} 제거`}
                  onClick={() =>
                    update({
                      ...draft,
                      rules: draft.rules.filter((_, i) => i !== index),
                    })
                  }
                >
                  제거
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="button button--outline button--small"
            disabled={draft.rules.length >= 20}
            onClick={() =>
              update({
                ...draft,
                rules: [
                  ...draft.rules,
                  {
                    id: crypto.randomUUID(),
                    extension: ".pdf",
                    keyword: null,
                    targetDirectory: "문서",
                    enabled: true,
                  },
                ],
              })
            }
          >
            규칙 추가 ({draft.rules.length}/20)
          </button>
          <p className="field-help">
            폴더는 선택한 작업 폴더 안의 상대 경로입니다. 예: 학교/물리. PC의
            전체 경로는 입력하지 마세요.
            <br />
            같은 파일에 여러 규칙이 맞으면 실제 정리 단계에서 충돌 검토가
            필요합니다.
          </p>
          <div className="rules-actions">
            <button
              type="submit"
              className="button button--orange button--small"
            >
              브라우저에 저장
            </button>
          </div>
          <details className="rules-transfer">
            <summary>JSON으로 가져오기·내보내기</summary>
            <div className="rules-actions">
              <button
                type="button"
                className="button button--outline button--small"
                onClick={exportJSON}
              >
                JSON 내보내기
              </button>
              <label className="button button--outline button--small rules-import">
                JSON 가져오기
                <input
                  type="file"
                  aria-label="규칙 JSON 가져오기"
                  accept=".json,application/json"
                  onChange={importJSON}
                />
              </label>
            </div>
          </details>
        </fieldset>
      </form>
      <div className="rules-cloud">
        <h2>클라우드 보관</h2>
        {!cloudRulesEnabled ? (
          <p>
            클라우드 규칙 저장은 연결 준비 중입니다. 현재는 이 브라우저 저장과
            JSON 가져오기·내보내기를 사용할 수 있습니다.
          </p>
        ) : !uid ? (
          <p>
            <Link className="quiet-link" to="/login">
              로그인
            </Link>
            하면 계정의 클라우드 규칙을 이용할 수 있습니다. 기기 간 이동은
            JSON으로도 가능합니다.
          </p>
        ) : (
          <>
            <p>
              불러오면 현재 편집 중인 규칙이 바뀝니다. 보관할 변경은 먼저
              JSON으로 내보내세요.
            </p>
            <div className="rules-actions">
              <button
                type="button"
                className="button button--outline button--small"
                disabled={busy}
                onClick={() => cloud("read")}
              >
                클라우드에서 불러오기
              </button>
              <button
                type="button"
                className="button button--black button--small"
                disabled={busy || revision === undefined || uncertain}
                onClick={() => cloud("save")}
              >
                클라우드에 저장
              </button>
              <span>
                {revision === undefined
                  ? "최신 버전 확인 필요"
                  : revision === null
                    ? "첫 저장 가능"
                    : `버전 ${revision}`}
              </span>
            </div>
          </>
        )}
      </div>
      {busy && <p role="status">규칙을 확인하고 있어요…</p>}
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="rules-note">
        내보낸 JSON은 웹 규칙 교환용입니다. CLI의 로컬 프로필·파일 작업 승인과
        다르며, CLI 자동 적용은 아직 연결되지 않았습니다.
      </p>
    </section>
  );
}
