import { Link } from "react-router-dom";
import { Arrow } from "./Icons";

/** Resource entry complements the existing feature overview on the home page. */
export function HomeOverview() {
  return (
    <section className="home-overview section-wrap" aria-label="안내와 테스트 자료">
      <div className="home-resource-callout">
        <div>
          <h2>개인 파일 대신,<br />테스트 자료로 먼저.</h2>
          <p>합성 파일과 예시 규칙을 받아 AFO를 살펴보세요.</p>
        </div>
        <Link to="/downloads" className="button button--outline">
          테스트 파일 받기 <Arrow />
        </Link>
      </div>
      <div className="home-notes-link">
        <Link to="/resources">사용 안내와 개발 노트 <Arrow /></Link>
      </div>
    </section>
  );
}
