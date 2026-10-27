import { Link } from "react-router-dom";
import { HowItWorks } from "../components/HowItWorks";
import { Closing } from "../components/Footer";
import { Arrow } from "../components/Icons";

export function GuidePage() {
  return (
    <>
      <section className="page-heading section-wrap">
        <h1>
          정리의 순서를,
          <br />내 방식대로.
        </h1>
        <p>
          폴더를 살펴보고, 기준을 정하고, 미리 확인하세요.
          <br />
          AFO는 이 순서로 정리를 돕습니다.
        </p>
      </section>
      <HowItWorks />
      <section className="guide-note section-wrap">
        <div>
          <h2>
            웹에서는 가볍게,
            <br />
            파일은 내 컴퓨터에서.
          </h2>
          <p>
            웹에서 직접 선택한 폴더의 이름과 크기를 바탕으로 기본 분류를 확인할
            수 있습니다. 샘플 체험도 제공하며, 현재 웹에서는 파일을 이동하거나
            삭제하지 않습니다. 개인 규칙은 별도로 보관합니다.
          </p>
        </div>
        <Link to="/preview" className="quiet-link">
          내 폴더 미리보기 <Arrow />
        </Link>
      </section>
      <section className="guide-note section-wrap" aria-labelledby="guide-cli-title">
        <div>
          <h2 id="guide-cli-title">명령어로 더 자세하게.</h2>
          <p>
            로컬 CLI는 Node.js가 필요한 별도 프로그램입니다. 선택한 폴더의
            중복 후보를 내용 해시로 확인하고, 참고 폴더에서 제안받은 규칙을
            확인한 뒤 분류 미리보기에 사용할 수 있습니다. 웹에 보관한 규칙과
            CLI는 자동으로 연결되지 않습니다.
          </p>
        </div>
      </section>
      <Closing />
    </>
  );
}
