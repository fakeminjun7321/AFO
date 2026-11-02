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
        <Link to="/install">
          <span>
            <strong>설치</strong>
            <small>macOS·Windows 한 줄 설치, 설치 위치·업데이트·제거</small>
          </span>
          <Arrow />
        </Link>
        <Link to="/help">
          <span>
            <strong>사용 방법</strong>
            <small>afo 사용 단계, 웹 미리보기, 샘플 예시와 자주 묻는 질문</small>
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
            <small>추가한 기능, 검증 상태, 남은 일</small>
          </span>
          <Arrow />
        </Link>
        <Link to="/community">
          <span>
            <strong>커뮤니티</strong>
            <small>GitHub 저장소, 버그 제보·제안, 참여 방법</small>
          </span>
          <Arrow />
        </Link>
      </div>
    </section>
  );
}
