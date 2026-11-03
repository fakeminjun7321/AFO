import { Link } from "react-router-dom";
import { Arrow } from "./Icons";
import { InstallPanel } from "./InstallPanel";
import { notes } from "../data/notes";
import { links } from "../data/project";
import "./home-content.css";

const steps = [
  { number: "01", title: "폴더를 끌어다 놓기", body: "터미널에 afo를 입력하고, 정리할 폴더를 창으로 끌어다 놓은 뒤 Enter를 누릅니다. 경로를 붙여 넣어도 돼요." },
  { number: "02", title: "요약 보기", body: "분류별 파일 수, 확인이 필요한 파일과 그대로 둘 파일, 같은 내용의 사본을 짧게 보여 줍니다. 아직 아무것도 바꾸지 않아요." },
  { number: "03", title: "정리 방법 고르기", body: "폴더별로 정리할지, 중복 사본을 휴지통으로 보낼지 번호로 고릅니다. 자세히 보기나 그만두기도 있어요." },
  { number: "04", title: "확인 코드 입력", body: "화면에 나온 코드를 직접 입력해야 파일이 움직입니다. 코드를 넣지 않으면 아무것도 바뀌지 않아요." },
];

const features = [
  { title: "종류별 폴더 정리", body: "문서·이미지·영상·음악·압축·설치·디자인·글꼴·전자책·코드·데이터로 나눠 폴더를 만들고 옮깁니다. 모르는 확장자는 어디로 보낼지 물어봐요." },
  { title: "확인한 중복만 지우기", body: "이름이 아니라 내용(SHA-256)이 같은 파일만 중복으로 봅니다. 기본은 OS 휴지통이고, 영구 삭제는 따로 고르고 \"영구 삭제\"를 입력해야 하며 되돌릴 수 없어요." },
  { title: "afo undo로 되돌리기", body: "가장 최근 폴더 정리를 원래 자리로 되돌립니다. 원래 자리가 비어 있고 내용이 그대로일 때만 옮겨요. 휴지통으로 보낸 파일은 OS 휴지통에서 꺼냅니다." },
  { title: "내 정리 방식 기억하기", body: "이미 정리해 둔 폴더를 참고해 규칙을 제안받고, 확인한 규칙만 저장해 다음 정리에 씁니다. 참고한 폴더의 파일은 옮기지 않아요." },
  { title: "내 컴퓨터에서만, 로그인 없이", body: "파일은 서버로 보내지 않고 계정도 필요 없습니다. 고른 폴더 안의 파일만 다루고, 이름이 겹치면 덮어쓰지 않고 검토 대상으로 남겨요." },
];

const terminal = [
  "$ afo",
  "AFO 파일 정리 도우미예요. 파일을 실제로 옮기기 전에 꼭 확인 코드를 물어봐요. (Ctrl+C로 언제든 그만둘 수 있어요)",
  "정리할 폴더를 이 창으로 끌어다 놓고 Enter를 누르세요(경로를 붙여 넣어도 돼요, 그냥 Enter는 종료):",
  "…",
  "  1) 폴더별로 정리하기(되돌릴 수 있어요)",
  "  2) 중복 파일을 휴지통으로 보내기",
  "  3) 자세히 보기",
  "  4) 그만두기",
  "번호를 입력하세요:",
];

export function HomeContent() {
  return <div className="home-content">
    <section className="home-install section-wrap" id="install" aria-labelledby="home-install-title">
      <div className="home-install-copy">
        <p className="home-overline">설치</p>
        <h2 id="home-install-title">한 줄이면<br />설치 끝.</h2>
        <p>명령을 복사해 터미널(Windows는 PowerShell)에 붙여 넣으세요. Node.js 같은 다른 프로그램은 필요 없습니다. 설치 스크립트가 GitHub Releases에서 내 OS용 실행 파일을 받아 SHA256SUMS와 대조한 뒤 설치해요.</p>
        <div className="home-install-links"><Link className="home-light-link" to="/install#beginner">터미널이 처음이라면 <Arrow /></Link><Link className="home-light-link" to="/install">설치 위치·업데이트·제거 <Arrow /></Link></div>
      </div>
      <InstallPanel />
    </section>

    <section className="home-intro" aria-labelledby="home-flow-title">
      <div className="section-wrap">
        <div className="home-intro-heading"><p className="home-overline">사용 방법</p><h2 id="home-flow-title">afo 하나로,<br /><span>네 단계면 정리 끝.</span></h2><p className="home-intro-description">명령어를 외울 필요가 없어요. afo가 묻는 대로 답하면 되고, 마지막 확인 코드를 넣기 전까지 파일은 그대로입니다.</p></div>
        <div className="home-flow">
          <ol className="home-steps">{steps.map((step) => <li key={step.number}><span>{step.number}</span><div><h3>{step.title}</h3><p>{step.body}</p></div></li>)}</ol>
          <figure className="home-terminal" aria-label="afo 실행 화면의 안내 문구 일부">
            <div className="home-terminal-bar" aria-hidden="true"><i /><i /><i /></div>
            <pre>{terminal.join("\n")}</pre>
            <figcaption>실제 안내 문구 일부입니다. 폴더를 넣으면 요약 뒤에 메뉴가 나와요.</figcaption>
          </figure>
        </div>
        <div className="home-commands">
          <div><code>afo undo</code><span>가장 최근 정리 되돌리기</span></div>
          <div><code>afo runs</code><span>정리 기록 보기</span></div>
          <div><code>afo help --all</code><span>모든 명령 보기</span></div>
        </div>
        <Link className="home-text-link" to="/help">사용 방법 자세히 보기 <Arrow /></Link>
      </div>
    </section>

    <section className="home-process section-wrap" aria-labelledby="home-features-title">
      <div className="home-process-header"><div><p className="home-overline">할 수 있는 일</p><h2 id="home-features-title">정리는 자동으로,<br />결정은 내가.</h2></div><p>AFO는 크기나 날짜만 보고 지울 파일을 정하지 않습니다. 실행 직전에 파일을 다시 확인해, 그사이 바뀐 파일은 건너뛰어요.</p></div>
      <ul className="home-features">{features.map((f, i) => <li key={f.title}><span>0{i + 1}</span><h3>{f.title}</h3><p>{f.body}</p></li>)}</ul>
    </section>

    <section className="home-intro home-web" aria-labelledby="home-web-title">
      <div className="section-wrap">
        <div className="home-intro-heading"><p className="home-overline">웹 도구</p><h2 id="home-web-title">설치 전에,<br /><span>웹에서 먼저 살펴보기.</span></h2><p className="home-intro-description">웹은 읽기 전용입니다. 폴더를 골라 분류를 미리 보거나 규칙을 연습할 수 있지만, 파일을 옮기거나 지우지 않아요.</p></div>
        <div className="home-other-features home-other-features--three">
          <article><span className="home-index">웹 미리보기</span><h3>내 폴더의<br />분류 미리 보기.</h3><p>브라우저에서 폴더를 고르면 기본 분류와 중복 후보를 이 기기 안에서 보여 줍니다. 파일은 업로드하지 않아요.</p><Link className="home-text-link" to="/preview">내 폴더 분석하기 <Arrow /></Link></article>
          <article><span className="home-index">나의 규칙</span><h3>분류 기준<br />연습하기.</h3><p>확장자와 이름으로 규칙을 만들어 브라우저·JSON·계정에 보관합니다. 웹 규칙은 CLI와 자동으로 연결되지 않아요.</p><Link className="home-text-link" to="/rules">나의 규칙 살펴보기 <Arrow /></Link></article>
          <article><span className="home-index">테스트 파일</span><h3>개인 파일 대신<br />합성 자료로.</h3><p>문서·이미지·중복 사본이 든 작은 ZIP을 받아 웹 미리보기나 afo로 먼저 시험해 보세요.</p><Link className="home-text-link" to="/downloads">테스트 파일 받기 <Arrow /></Link></article>
        </div>
      </div>
    </section>

    <section className="home-trust"><div className="section-wrap home-trust-layout">
      <div><p className="home-overline">오픈소스 · Apache-2.0</p><h2>함께 고치고,<br />함께 만들어요.</h2><p className="home-trust-intro">코드와 진행 기록은 모두 GitHub에 공개돼 있어요. 버그나 불편한 점은 Issues에 남겨 주세요.</p><div className="home-trust-links"><a className="home-light-link" href={links.repo} target="_blank" rel="noreferrer">GitHub 저장소 <Arrow diagonal /></a><Link className="home-light-link" to="/community">참여 방법 <Arrow /></Link></div></div>
      <div className="home-trust-details" aria-label="최근 개발 노트">{notes.slice(0, 3).map((n) => <article key={n.title}><time>{n.date}</time><strong>{n.title}</strong></article>)}<Link className="home-light-link" to="/notes">개발 노트 전체 보기 <Arrow /></Link></div>
    </div></section>

    <section className="home-start"><div className="section-wrap home-start-layout"><div><p className="home-overline">지금 시작하기</p><h2>복잡한 폴더에,<br />간단한 시작을.</h2><p>설치하고 터미널에 afo를 입력하세요. 처음에는 테스트 파일이나 새로 만든 폴더로 시작해 보는 걸 권해요.</p></div><div className="home-start-links"><a className="button button--black" href="#install">설치 명령 보기 <Arrow /></a><a className="home-sample-link" href={links.latestRelease} target="_blank" rel="noreferrer">최신 릴리스 <Arrow diagonal /></a></div></div></section>
  </div>;
}
