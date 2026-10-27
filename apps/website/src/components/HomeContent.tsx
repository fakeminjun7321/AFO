import { Link } from "react-router-dom";
import { Arrow, FileIcon } from "./Icons";
import "./home-content.css";

const examples = [
  { name: "물리_실험보고서.pdf", kind: "pdf" as const, target: "문서" },
  { name: "여행_사진.jpg", kind: "image" as const, target: "이미지" },
  { name: "발표자료.pptx", kind: "slides" as const, target: "문서" },
];
const steps = [
  { number: "01", title: "폴더 선택", body: "분석할 폴더를 직접 고릅니다. 설치나 로그인 없이 시작할 수 있어요." },
  { number: "02", title: "분류 살펴보기", body: "파일의 확장자를 기준으로 어떤 종류에 속하는지 확인합니다." },
  { number: "03", title: "기준 정리하기", body: "나의 규칙 화면에서 원하는 분류 기준을 따로 만들고 보관해요." },
];

export function HomeContent() {
  return <div className="home-content">
    <section className="home-intro" aria-labelledby="home-intro-title">
      <div className="section-wrap">
        <div className="home-intro-heading"><p className="home-overline">AFO와 함께하는 파일 정리</p><h2 id="home-intro-title">쌓인 파일 정리,<br /><span>어디서부터 시작할까요?</span></h2><p className="home-intro-description">무작정 폴더를 옮기기 전에 먼저 살펴보세요. AFO는 선택한 파일을 분류해 보여 주고, 나만의 정리 기준을 만들어 둘 수 있도록 돕습니다.</p></div>
        <div className="home-preview-feature">
          <div className="home-feature-copy"><span className="home-index">01 / 내 폴더 분석</span><h3>내 폴더를<br />한눈에 살펴보기.</h3><p>폴더를 선택하면 파일 이름과 크기를 읽어 기본 분류와 저장한 개인 규칙에 따른 위치를 보여 드립니다. 분류가 어려운 파일은 확인 대상으로 남겨요.</p><Link className="home-text-link" to="/preview">내 폴더 분석하기 <Arrow /></Link><small>분류와 중복 검사는 읽기 전용입니다.</small></div>
          <div className="home-example" aria-label="확장자 분류 예시"><div className="home-example-top"><div><span>분류 미리보기</span><strong>내 폴더</strong></div><span className="home-example-label">예시</span></div><div className="home-example-head"><span>파일 이름</span><span>분류</span></div>{examples.map((item) => <div className="home-example-row" key={item.name}><span><FileIcon kind={item.kind} />{item.name}</span><b>{item.target}</b></div>)}<p>이 화면은 이해를 돕기 위한 예시입니다.</p></div>
        </div>
        <div className="home-other-features">
          <article><span className="home-index">02 / 나의 정리 기준</span><h3>자주 쓰는 기준을<br />내 방식으로.</h3><p>확장자와 파일 이름에 맞춰 원하는 폴더를 정해 보세요. 브라우저에 저장한 활성 규칙은 웹 미리보기에 적용되고, JSON으로 옮기거나 로그인 후 클라우드에도 보관할 수 있습니다.</p><Link className="home-text-link" to="/rules">나의 규칙 살펴보기 <Arrow /></Link><small>클라우드에만 있는 규칙은 불러온 뒤 브라우저에 저장해 주세요.</small></article>
          <article><span className="home-index">03 / CLI</span><h3>더 자세한 분석은<br />로컬 CLI에서.</h3><p>명령어로 선택한 폴더의 중복 후보와 분류 미리보기를 확인할 수 있습니다. 참고 폴더에서 규칙을 제안받아 확인한 뒤 재사용하는 기능도 준비되어 있어요.</p><Link className="home-text-link" to="/guide">사용 방법 알아보기 <Arrow /></Link><small>CLI의 실행과 설치는 웹과 별도입니다.</small></article>
        </div>
      </div>
    </section>
    <section className="home-process section-wrap" aria-labelledby="home-process-title"><div className="home-process-header"><div><p className="home-overline">HOW IT WORKS</p><h2 id="home-process-title">복잡한 준비 없이,<br />차근차근.</h2></div><p>처음이라면 내 폴더 미리보기부터 시작해 보세요. 실제 파일은 그대로 두고 결과를 확인할 수 있어요.</p></div><ol>{steps.map((step) => <li key={step.number}><span>{step.number}</span><h3>{step.title}</h3><p>{step.body}</p></li>)}</ol><Link className="home-light-link" to="/guide">사용 방법 자세히 보기 <Arrow /></Link></section>
    <section className="home-trust"><div className="section-wrap home-trust-layout"><div><p className="home-overline">당신이 선택한 범위에서</p><h2>파일은 그대로.<br />결과부터 확인하세요.</h2><p className="home-trust-intro">기본 미리보기는 파일 이름과 크기를 사용합니다. 중복 검사 버튼을 누르면 내용을 이 기기에서 비교하며, 파일은 서버로 보내거나 변경하지 않습니다.</p><Link className="home-light-link" to="/faq">자주 묻는 질문 <Arrow /></Link></div><div className="home-trust-details"><article><strong>브라우저에서 분석</strong><p>선택한 폴더 목록과 중복 검사 결과는 현재 브라우저에서 처리합니다.</p></article><article><strong>보관할 때만 저장</strong><p>규칙은 직접 저장을 선택할 때 브라우저나 계정에 보관합니다. 파일 자체를 저장하는 기능은 아닙니다.</p></article><article><strong>현재 제공 범위</strong><p>웹에서는 실제 이동·삭제를 제공하지 않습니다. 승인 후 실행과 복구는 앞으로 개발할 기능입니다.</p><Link className="home-light-link" to="/status">개발 현황 보기 <Arrow /></Link></article></div></div></section>
    <section className="home-start"><div className="section-wrap home-start-layout"><div><p className="home-overline">지금 시작하기</p><h2>정리의 첫 단계,<br />가볍게 시작해요.</h2><p>내 폴더를 분석하거나 준비된 샘플로 먼저 살펴볼 수 있습니다.</p></div><div className="home-start-links"><Link className="button button--black" to="/preview">내 폴더 미리보기 <Arrow /></Link><Link className="home-sample-link" to="/demo">샘플로 체험하기 <Arrow /></Link></div></div></section>
  </div>;
}
