import { Arrow } from "./Icons";
export function Footer() {
  return (
    <>
      <section className="closing" aria-labelledby="closing-title">
        <h2 id="closing-title">
          복잡한 폴더에,
          <br />
          간단한 시작을.
        </h2>
        <a className="button button--black" href="#demo">
          직접 체험하기 <Arrow />
        </a>
      </section>
      <footer className="footer section-wrap">
        <a className="wordmark" href="#top" aria-label="AFO 처음으로">
          AFO
        </a>
        <span className="brand-description">Automated File Organizer</span>
        <span className="footer-note">파일 정리의 시작, AFO.</span>
      </footer>
    </>
  );
}
