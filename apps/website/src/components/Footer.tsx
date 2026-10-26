import { Arrow } from "./Icons";
import { Link } from "react-router-dom";
export function Closing() {
  return (
    <>
      <section className="closing" aria-labelledby="closing-title">
        <h2 id="closing-title">
          복잡한 폴더에,
          <br />
          간단한 시작을.
        </h2>
        <Link className="button button--black" to="/demo">
          직접 체험하기 <Arrow />
        </Link>
      </section>
    </>
  );
}
export function Footer() {
  return (
    <footer className="footer section-wrap">
      <Link className="wordmark" to="/" aria-label="AFO 처음으로">
        AFO
      </Link>
      <span className="brand-description">Automated File Organizer</span>
      <span className="footer-note">파일 정리의 시작, AFO.</span>
    </footer>
  );
}
