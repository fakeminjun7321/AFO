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
            웹 체험에서는 샘플 파일의 분류 전후를 살펴봅니다. 실제 파일을 읽는
            작업은 로컬 CLI가 맡아요. 로그인과 실제 파일 변경 승인은 서로 다른
            단계입니다.
          </p>
        </div>
        <Link to="/demo" className="quiet-link">
          샘플로 먼저 살펴보기 <Arrow />
        </Link>
      </section>
      <Closing />
    </>
  );
}
