import { useEffect, useState, type ReactNode } from "react";
import { CopyButton, detectOs } from "./InstallPanel";
import { installCommands, type InstallOs } from "../data/project";
import "./beginner.css";

type Icon = "open" | "paste" | "check" | "run" | "drop";
type Step = { icon: Icon; title: string; body: ReactNode; keys?: string[][]; copy?: string; output?: string[]; note?: ReactNode };

const Kbd = ({ k }: { k: string }) => <kbd>{k}</kbd>;

/** Generic pictograms, deliberately not imitations of real OS screens. */
function StepIcon({ kind }: { kind: Icon }) {
  return (
    <svg className="step-icon" width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true">
      <rect x="6" y="10" width="44" height="34" rx="6" stroke="currentColor" strokeWidth="2" />
      <path d="M6 18h44" stroke="currentColor" strokeWidth="2" />
      {kind === "open" && <path d="M15 27l5 4-5 4M24 36h9" stroke="#f4512c" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />}
      {kind === "paste" && <><rect x="16" y="24" width="14" height="14" rx="2" stroke="#f4512c" strokeWidth="2.2" /><path d="M34 31h8m-3-3 3 3-3 3" stroke="#f4512c" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></>}
      {kind === "check" && <path d="M18 31l6 6 13-13" stroke="#f4512c" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />}
      {kind === "run" && <path d="M14 30h6m4 0h13M14 36h8" stroke="#f4512c" strokeWidth="2.4" strokeLinecap="round" />}
      {kind === "drop" && <><path d="M15 25h7l2 2h9v10H15z" stroke="#f4512c" strokeWidth="2.2" strokeLinejoin="round" /><path d="M38 33l5 0m-2-3 3 3-3 3" stroke="#f4512c" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></>}
    </svg>
  );
}

const guides: Record<InstallOs, { intro: string; steps: Step[]; caution?: ReactNode }> = {
  mac: {
    intro: "macOS에는 '터미널'이라는 앱이 이미 들어 있어요. 관리자 비밀번호는 필요 없습니다.",
    steps: [
      {
        icon: "open",
        title: "터미널 열기",
        keys: [["⌘ Command", "Space"]],
        body: <>Spotlight 검색창이 뜨면 <b>터미널</b>(또는 Terminal)을 입력하고 <Kbd k="Enter" />를 누르세요. Finder에서 <b>응용 프로그램 → 유틸리티 → 터미널</b>을 열어도 돼요.</>,
      },
      {
        icon: "paste",
        title: "설치 명령 붙여 넣기",
        copy: installCommands.mac.command,
        keys: [["⌘ Command", "V"], ["Enter"]],
        body: <>복사 버튼을 눌러 명령을 복사한 뒤 터미널 창을 한 번 클릭하고 붙여 넣은 다음 <Kbd k="Enter" />를 누르세요. 글자를 직접 칠 필요는 없어요.</>,
      },
      {
        icon: "check",
        title: "'설치 완료' 문구 확인",
        output: ["AFO 내려받는 중: afo-darwin-arm64.tar.gz", "설치 완료: afo 0.1.0 → /Users/이름/.afo/bin/afo", "/Users/이름/.local/bin/afo 에 연결했습니다. 이 터미널에서 바로 afo 를 입력하세요."],
        body: <>Mac 종류와 버전에 따라 파일 이름·숫자·경로는 달라요. 마지막 줄이 <b>"새 터미널을 열거나 다음을 실행한 뒤 afo 를 입력하세요"</b>라면 터미널 창을 새로 열어 주세요(<Kbd k="⌘ Command" /> + <Kbd k="N" />).</>,
      },
      {
        icon: "run",
        title: "afo 입력",
        copy: "afo",
        keys: [["Enter"]],
        body: <>같은 창에 <code>afo</code>를 입력하고 <Kbd k="Enter" />를 누르면 정리 도우미가 시작돼요. 언제든 <Kbd k="Control" /> + <Kbd k="C" />로 그만둘 수 있어요.</>,
      },
      {
        icon: "drop",
        title: "폴더를 창으로 끌어다 놓기",
        keys: [["Enter"]],
        body: <>Finder에서 정리할 폴더를 터미널 창 위로 끌어다 놓으면 그 폴더의 경로가 글자로 입력돼요. 그다음 <Kbd k="Enter" />를 누르고, 요약을 본 뒤 번호를 고르고, 화면의 확인 코드를 입력하면 정리합니다.</>,
      },
    ],
  },
  windows: {
    intro: "Windows에서는 'PowerShell'을 씁니다. 관리자 권한은 필요 없어요. '관리자로 실행'을 고르지 않아도 됩니다.",
    caution: <>Windows용 설치는 GitHub Actions의 Windows VM에서만 확인했고, <b>실제 Windows PC에서는 아직 검증하지 않았어요.</b> 실행 파일에 코드 서명이 없어 SmartScreen이나 백신이 경고할 수 있습니다. 문제가 생기면 <a href="https://github.com/fakeminjun7321/AFO/issues" target="_blank" rel="noreferrer">GitHub Issues</a>에 알려 주세요.</>,
    steps: [
      {
        icon: "open",
        title: "PowerShell 열기",
        keys: [["⊞ Windows"]],
        body: <>시작 메뉴에서 <b>PowerShell</b>을 검색해 <b>Windows PowerShell</b>을 열어요. 또는 <Kbd k="⊞ Windows" /> + <Kbd k="X" /> 메뉴에서 <b>터미널</b>(Windows 10은 Windows PowerShell)을 고르세요. 줄 앞에 <code>PS</code>가 보이면 PowerShell이에요. 명령 프롬프트(cmd)에서는 설치 명령이 동작하지 않아요.</>,
      },
      {
        icon: "paste",
        title: "설치 명령 붙여 넣기",
        copy: installCommands.windows.command,
        keys: [["Ctrl", "V"], ["Enter"]],
        body: <>복사 버튼을 눌러 명령을 복사한 뒤 PowerShell 창에 <Kbd k="Ctrl" /> + <Kbd k="V" />로 붙여 넣으세요(창에서 오른쪽 클릭해도 붙여 넣어져요). 그다음 <Kbd k="Enter" />를 누르세요.</>,
      },
      {
        icon: "check",
        title: "'설치 완료' 문구 확인",
        output: ["AFO 내려받는 중: afo-win-x64.zip", "설치 완료: afo 0.1.0 -> C:\\Users\\이름\\AppData\\Local\\Programs\\AFO\\afo.exe", "사용자 PATH에 추가했습니다. 이 창에서 바로, 또는 새 터미널에서 afo 를 입력하세요."],
        body: <>버전 숫자와 경로는 다를 수 있어요. 빨간 글씨로 "AFO 설치 오류"가 나오면 설치하지 않은 것이니, 문구를 그대로 복사해 Issues에 알려 주세요.</>,
      },
      {
        icon: "run",
        title: "afo 입력",
        copy: "afo",
        keys: [["Enter"]],
        body: <>같은 창에 <code>afo</code>를 입력하고 <Kbd k="Enter" />를 누르세요. 처음 실행할 때 SmartScreen이나 백신 경고가 나올 수 있어요. 언제든 <Kbd k="Ctrl" /> + <Kbd k="C" />로 그만둘 수 있습니다.</>,
      },
      {
        icon: "drop",
        title: "폴더 경로 넣기",
        keys: [["Enter"]],
        body: <>파일 탐색기에서 정리할 폴더를 PowerShell 창으로 끌어다 놓거나, 폴더를 오른쪽 클릭 → <b>경로로 복사</b> 후 붙여 넣고 <Kbd k="Enter" />를 누르세요. Windows에서 끌어다 놓기는 실제 PC에서 아직 확인하지 못했어요. 안 되면 '경로로 복사'를 쓰세요.</>,
      },
    ],
  },
};

const troubles = [
  {
    title: "macOS: zsh: command not found: afo",
    body: <>설치한 창이 아직 새 PATH를 모르는 경우예요. 터미널 창을 새로 열거나(<Kbd k="⌘ Command" /> + <Kbd k="N" />) <code>source ~/.zshrc</code>를 입력한 뒤 다시 <code>afo</code>를 입력하세요. bash를 쓰면 <code>source ~/.bash_profile</code>입니다.</>,
  },
  {
    title: "Windows: 'afo' 용어가 … 인식되지 않습니다",
    body: <>PowerShell 창을 모두 닫고 새로 연 뒤 <code>afo</code>를 다시 입력하세요. 그래도 안 되면 설치 명령을 한 번 더 실행해 '설치 완료' 문구가 나오는지 확인해 주세요.</>,
  },
  {
    title: "Windows: 'irm'은(는) … 명령이 아닙니다",
    body: <>명령 프롬프트(cmd)에 붙여 넣은 경우예요. 1단계처럼 PowerShell을 열고 다시 붙여 넣으세요.</>,
  },
  {
    title: "업데이트하고 싶어요",
    body: <>설치할 때와 같은 명령을 다시 실행하면 최신 릴리스로 바뀝니다. <code>afo --version</code>으로 버전을 확인하세요.</>,
  },
  {
    title: "지우고 싶어요",
    body: <>아래 <a href="#install-update">업데이트와 제거</a>(README의 같은 절과 동일)를 따라 주세요. 저장한 규칙과 <code>afo undo</code> 기록이 든 폴더는 따로 지워야 해요.</>,
  },
];

export function BeginnerGuide() {
  const [os, setOs] = useState<InstallOs>("mac");
  useEffect(() => setOs(detectOs()), []);
  const guide = guides[os];
  return (
    <section className="beginner" id="beginner" aria-labelledby="beginner-title">
      <h2 id="beginner-title">터미널이 처음이라면</h2>
      <p className="beginner-intro">설치는 창 하나를 열고, 명령 한 줄을 붙여 넣고, Enter를 누르는 것이 전부예요. 내 컴퓨터에 맞는 쪽을 골라 차례대로 따라 하세요.</p>
      <div className="install-tabs" role="tablist" aria-label="안내할 운영체제">
        {(Object.keys(guides) as InstallOs[]).map((key) => (
          <button key={key} type="button" role="tab" id={`beginner-tab-${key}`} aria-selected={os === key} aria-controls="beginner-steps" className={os === key ? "is-active" : ""} onClick={() => setOs(key)}>
            {installCommands[key].label}
          </button>
        ))}
      </div>
      <div id="beginner-steps" role="tabpanel" aria-labelledby={`beginner-tab-${os}`}>
        <p className="beginner-os-intro">{guide.intro}</p>
        {guide.caution && <p className="beginner-caution">{guide.caution}</p>}
        <ol className="beginner-steps">
          {guide.steps.map((step, i) => (
            <li key={step.title}>
              <div className="beginner-step-head">
                <StepIcon kind={step.icon} />
                <span className="beginner-step-number">{String(i + 1).padStart(2, "0")}</span>
                <h3>{step.title}</h3>
              </div>
              {step.keys && <div className="beginner-keys" aria-hidden="true">{step.keys.map((combo, j) => <span key={j}>{j > 0 && <i>→</i>}{combo.map((k, n) => <span key={k}>{n > 0 && " + "}<Kbd k={k} /></span>)}</span>)}</div>}
              {step.copy && <div className="install-line beginner-copy"><code>{step.copy}</code><CopyButton text={step.copy} label={`${step.title}: 명령 복사`} /></div>}
              <p>{step.body}</p>
              {step.output && <div className="beginner-output" aria-label="화면에 나오는 문구 예시"><span>화면 예시(설치 스크립트의 실제 문구)</span><pre>{step.output.join("\n")}</pre></div>}
            </li>
          ))}
        </ol>
      </div>
      <section className="beginner-trouble" aria-labelledby="beginner-trouble-title">
        <h3 id="beginner-trouble-title">이럴 땐 이렇게</h3>
        <div className="questions">
          {troubles.map((t) => (
            <details key={t.title}>
              <summary>{t.title}<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18" /><path className="plus-vertical" d="M12 3v18" /></svg></summary>
              <p>{t.body}</p>
            </details>
          ))}
        </div>
      </section>
    </section>
  );
}
