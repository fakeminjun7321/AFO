import { Arrow } from "./Icons";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { links } from "../data/project";
export function Closing() {
  return (
    <>
      <section className="closing" aria-labelledby="closing-title">
        <h2 id="closing-title">
          복잡한 폴더에,
          <br />
          간단한 시작을.
        </h2>
        <Link className="button button--black" to="/install">
          AFO 설치하기 <Arrow />
        </Link>
      </section>
    </>
  );
}
export function Footer() {
  const { user, ready } = useAuth();
  return (
    <footer className="footer section-wrap">
      <Link className="wordmark" to="/" aria-label="AFO 처음으로">
        AFO
      </Link>
      <span className="brand-description">Automated File Organizer · Apache-2.0</span>
      <nav className="footer-nav" aria-label="하단 메뉴">
        <Link to="/install">설치</Link>
        <Link to="/help">사용 방법</Link>
        <Link to="/preview">웹 미리보기</Link>
        <Link to="/rules">나의 규칙</Link>
        <Link to="/community">커뮤니티</Link>
        <Link to="/notes">개발 노트</Link>
        <a href={links.repo} target="_blank" rel="noreferrer">GitHub</a>
        <Link to={user ? "/account" : "/login"}>{!ready ? "계정 확인 중" : user ? "내 계정" : "로그인"}</Link>
      </nav>
      <span className="footer-note">파일 정리의 시작, AFO.</span>
    </footer>
  );
}
