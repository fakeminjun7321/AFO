import { Link } from "react-router-dom";
import { Arrow } from "./Icons";
export function HomeOverview() {
  return (
    <section className="home-overview section-wrap">
      <div className="overview-heading">
        <h2>
          정리의 기준부터,
          <br />
          보관까지 한곳에서.
        </h2>
        <p>AFO가 지금 도와줄 수 있는 일입니다.</p>
      </div>
      <div className="overview-features">
        <article>
          <span>01</span>
          <h3>분류를 먼저 살펴보기</h3>
          <p>샘플 파일이 어디로 분류될지 확인하고 기준을 바꿔보세요.</p>
          <Link to="/demo">
            직접 체험 <Arrow />
          </Link>
        </article>
        <article>
          <span>02</span>
          <h3>나의 기준 만들기</h3>
          <p>확장자·키워드·목적지로 정리 규칙을 편집하고 보관하세요.</p>
          <Link to="/rules">
            나의 규칙 <Arrow />
          </Link>
        </article>
        <article>
          <span>03</span>
          <h3>다른 기기에서 이어가기</h3>
          <p>
            로그인 계정으로 규칙을 저장하고 불러오거나 JSON으로 옮길 수 있어요.
          </p>
          <Link to="/login">
            계정으로 시작 <Arrow />
          </Link>
        </article>
      </div>
      <div className="home-resource-callout">
        <div>
          <h2>
            개인 파일 대신,
            <br />
            테스트 자료로 먼저.
          </h2>
          <p>합성 파일과 예시 규칙을 받아 AFO의 저장 흐름을 확인하세요.</p>
        </div>
        <Link to="/downloads" className="button button--outline">
          테스트 파일 받기 <Arrow />
        </Link>
      </div>
      <div className="home-notes-link">
        <Link to="/resources">
          사용 안내와 개발 노트 <Arrow />
        </Link>
      </div>
    </section>
  );
}
