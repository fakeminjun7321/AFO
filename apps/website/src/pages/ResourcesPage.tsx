import { Link } from "react-router-dom";
import { Arrow } from "../components/Icons";
export function ResourcesPage() {
  return (
    <section className="resource-page section-wrap">
      <div className="page-heading">
        <h1>안내와 자료</h1>
        <p>AFO를 알아보고, 직접 확인해 보세요.</p>
      </div>
      <div className="resource-list">
        <Link to="/help">
          <span>
            <strong>사용 방법</strong>
            <small>체험 순서와 자주 묻는 질문</small>
          </span>
          <Arrow />
        </Link>
        <Link to="/downloads">
          <span>
            <strong>테스트 파일</strong>
            <small>개인 파일 대신 사용할 합성 자료와 예시 규칙</small>
          </span>
          <Arrow />
        </Link>
        <Link to="/notes">
          <span>
            <strong>개발 노트</strong>
            <small>추가한 기능, 검증한 내용, 다음 작업</small>
          </span>
          <Arrow />
        </Link>
      </div>
    </section>
  );
}
