import { useEffect, useRef, useState } from "react";
import { installCommands, type InstallOs } from "../data/project";
import "./install.css";

export function detectOs(): InstallOs {
  if (typeof navigator === "undefined") return "mac";
  return /Windows/i.test(navigator.userAgent) ? "windows" : "mac";
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be missing (http, older browsers); fall back to a hidden selection.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <>
      <button
        type="button"
        className="copy-button"
        aria-label={label}
        onClick={async () => {
          setState((await copyText(text)) ? "done" : "failed");
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setState("idle"), 2200);
        }}
      >
        {state === "done" ? "복사했어요" : "복사"}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === "done" ? "명령을 복사했어요." : state === "failed" ? "복사하지 못했어요. 명령을 직접 선택해 복사해 주세요." : ""}
      </span>
    </>
  );
}

export function InstallPanel() {
  const [os, setOs] = useState<InstallOs>("mac");
  useEffect(() => setOs(detectOs()), []);
  const current = installCommands[os];
  return (
    <div className="install-panel">
      <div className="install-tabs" role="tablist" aria-label="운영체제 선택">
        {(Object.keys(installCommands) as InstallOs[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`install-tab-${key}`}
            aria-selected={os === key}
            aria-controls="install-command"
            className={os === key ? "is-active" : ""}
            onClick={() => setOs(key)}
          >
            {installCommands[key].label}
          </button>
        ))}
      </div>
      <div className="install-command" id="install-command" role="tabpanel" aria-labelledby={`install-tab-${os}`}>
        <span className="install-shell">{current.shell}에 붙여 넣기</span>
        <div className="install-line">
          <code>{current.command}</code>
          <CopyButton text={current.command} label={`${current.label} 설치 명령 복사`} />
        </div>
      </div>
      <div className="install-command install-command--next">
        <span className="install-shell">설치가 끝나면 같은 창에서</span>
        <div className="install-line">
          <code>afo</code>
          <CopyButton text="afo" label="afo 명령 복사" />
        </div>
      </div>
    </div>
  );
}
