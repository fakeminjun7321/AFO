import { FolderDemo } from "../features/demo/FolderDemo";
import { HowItWorks } from "../components/HowItWorks";
import { FAQ } from "../components/FAQ";
import { Link } from "react-router-dom";

export function HelpPage() {
  return (
    <section className="help-page section-wrap">
      <div className="support-heading">
        <h1>도움말</h1>
        <p>설치한 afo로 정리하는 방법, 웹 미리보기, 샘플 예시와 자주 묻는 내용을 모았습니다.</p>
      </div>
      <section className="help-how" aria-labelledby="help-how-title">
        <h2 id="help-how-title">afo로 이렇게 정리해요.</h2>
        <HowItWorks />
      </section>
      <section className="guide-note" aria-labelledby="guide-cli-title">
        <div><h2 id="guide-cli-title">명령어로 더 자세하게.</h2><p>스크립트처럼 쓰려면 <code>preview</code>로 정리안만 보고, <code>plan</code>으로 계획 ID와 방식별 승인 코드를 받은 뒤 <code>apply</code>에 코드를 넣어 실행하고, <code>undo</code>로 되돌립니다. 이동은 되돌릴 수 있고, 휴지통으로 보낸 파일은 OS 휴지통에서 꺼냅니다. 영구 삭제는 따로 선택하고 확인 문구를 입력해야 하며 되돌릴 수 없습니다. 기존 정리 폴더를 참고하는 개인 규칙은 <code>suggest-rules</code>와 <code>rules</code>로 다룹니다. 웹에 보관한 규칙과 CLI는 자동으로 연결되지 않습니다.</p></div>
        <Link to="/install" className="quiet-link">설치와 명령 목록 →</Link>
      </section>
      <section className="guide-note" aria-labelledby="help-preview-title">
        <div><h2 id="help-preview-title">설치 전에 웹에서 살펴보기.</h2><p>웹에서 직접 선택한 폴더의 이름과 크기를 바탕으로 분류를 미리 볼 수 있습니다. 브라우저에 저장한 활성 개인 규칙도 적용합니다. 웹은 파일을 이동하거나 삭제하지 않습니다.</p></div>
        <Link to="/preview" className="quiet-link">내 폴더 미리보기 →</Link>
      </section>
      <FolderDemo />
      <FAQ />
    </section>
  );
}
