import { FolderDemo } from "../features/demo/FolderDemo";
import { HowItWorks } from "../components/HowItWorks";
import { FAQ } from "../components/FAQ";
import { Link } from "react-router-dom";

export function HelpPage() {
  return (
    <section className="help-page section-wrap">
      <div className="support-heading">
        <h1>도움말</h1>
        <p>내 폴더를 분석하는 방법과 샘플 예시, 자주 묻는 내용을 모았습니다.</p>
      </div>
      <section className="help-how" aria-labelledby="help-how-title">
        <h2 id="help-how-title">이렇게 분석해요.</h2>
        <HowItWorks />
      </section>
      <section className="guide-note" aria-labelledby="help-preview-title">
        <div><h2 id="help-preview-title">내 폴더도 살펴보세요.</h2><p>웹에서 직접 선택한 폴더의 이름과 크기를 바탕으로 분류를 확인할 수 있습니다. 브라우저에 저장한 활성 개인 규칙도 적용합니다. 파일은 이동하거나 삭제하지 않습니다.</p></div>
        <Link to="/preview" className="quiet-link">내 폴더 미리보기 →</Link>
      </section>
      <section className="guide-note" aria-labelledby="guide-cli-title">
        <div><h2 id="guide-cli-title">명령어로 더 자세하게.</h2><p>로컬 CLI는 Node.js가 필요한 별도 프로그램입니다. 선택한 폴더의 중복 후보를 내용 해시로 확인하고, 참고 폴더에서 제안받은 규칙을 저장해 분류에 다시 씁니다. <code>plan</code>으로 정리 계획을 만든 뒤 <code>apply</code>에 승인 코드를 입력한 항목만 실제로 옮기거나 OS 휴지통으로 보내며, 이동은 <code>undo</code>로 되돌릴 수 있습니다. 영구 삭제는 따로 선택하고 확인 문구를 입력해야 하며 되돌릴 수 없습니다. 웹에 보관한 규칙과 CLI는 자동으로 연결되지 않습니다.</p></div>
      </section>
      <FolderDemo />
      <FAQ />
    </section>
  );
}
