import { Link } from "react-router-dom";
import { Arrow } from "../components/Icons";
import { CopyButton, InstallPanel } from "../components/InstallPanel";
import { BeginnerGuide } from "../components/BeginnerGuide";
import { links } from "../data/project";
import "./site-pages.css";

const usage = [
  { command: "afo", body: "폴더를 끌어다 놓고 안내를 따릅니다. 확인 코드를 입력해야 실제로 정리해요." },
  { command: "afo undo", body: "가장 최근 정리를 원래대로 되돌립니다." },
  { command: "afo runs", body: "정리 기록을 봅니다." },
  { command: "afo --version", body: "설치된 버전을 확인합니다." },
  { command: "afo gui", body: "이 컴퓨터에서만 열리는 브라우저 화면으로 미리보기·정리 계획·규칙·실행 기록을 봅니다. 화면은 보기 전용이라 파일을 옮기거나 지우지 않아요." },
  { command: "afo gui \"<폴더 경로>\"", body: "처음부터 그 폴더를 열어 둔 화면을 띄웁니다. 경로 자리에 폴더를 끌어다 놓아도 돼요." },
];

export function InstallPage() {
  return (
    <section className="site-page section-wrap" aria-labelledby="install-title">
      <div className="page-heading">
        <h1 id="install-title">설치</h1>
        <p>명령 한 줄로 설치하고, 터미널에 afo를 입력하세요. macOS와 Windows를 지원합니다.</p>
        <a className="quiet-link" href="#beginner">터미널이 처음이라면 단계별 안내 보기 <Arrow /></a>
      </div>
      <InstallPanel />
      <p className="site-note">
        설치 스크립트는 <a href={links.releases} target="_blank" rel="noreferrer">GitHub Releases</a>에서 내 OS용 실행 파일 하나를 받아
        SHA256SUMS와 대조하고, 다르면 설치하지 않습니다. Node.js 같은 다른 프로그램은 필요 없어요. Linux용 실행 파일은 없습니다.
      </p>

      <BeginnerGuide />

      <section className="site-block" aria-labelledby="install-where">
        <h2 id="install-where">어디에 설치되나요?</h2>
        <div className="site-table" role="table" aria-label="설치 위치">
          <div role="row" className="site-table-head"><span role="columnheader">OS</span><span role="columnheader">설치 위치</span><span role="columnheader">PATH</span></div>
          <div role="row"><span role="cell">macOS (Apple Silicon·Intel)</span><span role="cell"><code>~/.afo/bin/afo</code></span><span role="cell">이미 PATH에 있는 <code>~/.local/bin</code>·<code>/opt/homebrew/bin</code>·<code>/usr/local/bin</code> 중 쓸 수 있는 곳에 링크를 둬서 같은 창에서 바로 쓸 수 있어요. 없으면 <code>~/.zshrc</code>에 한 줄을 더합니다(이때는 새 터미널 필요).</span></div>
          <div role="row"><span role="cell">Windows 10/11 (x64)</span><span role="cell"><code>%LOCALAPPDATA%\Programs\AFO\afo.exe</code></span><span role="cell">사용자 PATH에 추가합니다.</span></div>
        </div>
      </section>

      <section className="site-block" aria-labelledby="install-use">
        <h2 id="install-use">설치한 뒤에 쓰는 명령</h2>
        <ul className="command-list">
          {usage.map((u) => (
            <li key={u.command}><div className="install-line"><code>{u.command}</code><CopyButton text={u.command} label={`${u.command} 복사`} /></div><p>{u.body}</p></li>
          ))}
        </ul>
        <p className="site-note">
          <code>afo gui</code>는 v0.2.0 릴리스부터 들어 있어요. 2026-11-02 현재 최신 릴리스는 v0.1.0이라 아직 없으며, v0.2.0이 나오면 설치 명령을 다시 실행해 업데이트하세요.
        </p>
        <p className="site-note">
          단계별로 쓰고 싶다면 <code>preview</code> → <code>plan</code> → <code>apply</code> → <code>undo</code>, 개인 규칙은 <code>suggest-rules</code>·<code>rules</code>를 씁니다.
          모든 명령과 종료 코드는 <a href={links.cliDocs} target="_blank" rel="noreferrer">CLI 문서</a>에 있어요.
        </p>
      </section>

      <section className="site-block site-callout" aria-labelledby="install-warning">
        <h2 id="install-warning">코드 서명이 없어요</h2>
        <p>
          실행 파일은 코드 서명·공증을 받지 않았습니다. 설치 스크립트로 받으면 macOS에서 바로 실행되지만, 브라우저로 직접 받은 파일은 Gatekeeper가 막을 수 있어요.
          Windows에서는 SmartScreen이나 백신 경고가 나올 수 있습니다. Windows 실제 PC에서의 설치는 아직 확인하지 못했고, GitHub Actions의 Windows VM에서만 확인했습니다.
        </p>
      </section>

      <section className="site-block" aria-labelledby="install-update">
        <h2 id="install-update">업데이트와 제거</h2>
        <p>업데이트는 설치 명령을 다시 실행하면 됩니다. <code>afo --version</code>으로 버전을 확인하세요.</p>
        <p>특정 버전은 환경 변수 <code>AFO_VERSION</code>으로 고릅니다. macOS 예: <code>curl -fsSL https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.sh | AFO_VERSION=0.1.0 sh</code>. PATH를 직접 관리하려면 <code>AFO_NO_MODIFY_PATH=1</code>을 같은 방식으로 씁니다.</p>
        <p><strong>macOS 제거</strong> — <code>rm ~/.afo/bin/afo</code>와 설치 때 안내된 링크(예: <code>rm ~/.local/bin/afo</code>)를 지우고, <code>~/.zshrc</code>에 <code># AFO</code> PATH 줄이 있으면 지웁니다.</p>
        <p><strong>Windows 제거</strong> — <code>Remove-Item "$env:LOCALAPPDATA\Programs\AFO" -Recurse</code> 후 사용자 환경 변수 PATH에서 그 폴더를 지웁니다.</p>
        <p>규칙·계획·정리 기록은 macOS <code>~/Library/Application Support/AFO</code>, Windows <code>%LOCALAPPDATA%\AFO</code>에 따로 저장돼요. 이 폴더를 지우면 저장한 규칙과 <code>afo undo</code> 기록도 사라집니다.</p>
      </section>

      <div className="site-links">
        <a className="quiet-link" href={links.latestRelease} target="_blank" rel="noreferrer">최신 릴리스 받기 <Arrow diagonal /></a>
        <Link className="quiet-link" to="/downloads">시험용 합성 파일 받기 <Arrow /></Link>
      </div>
    </section>
  );
}
