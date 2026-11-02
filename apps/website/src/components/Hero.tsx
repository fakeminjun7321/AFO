import { Arrow } from "./Icons";
import { Link } from "react-router-dom";

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <picture>
        <source
          media="(max-width: 760px)"
          srcSet="/assets/hero-art-mobile.png"
        />
        <img
          className="hero-art"
          src="/assets/hero-art.png"
          alt=""
          fetchPriority="high"
          width="1586"
          height="992"
        />
      </picture>
      <div className="hero-copy">
        <h1 id="hero-title">
          <span>파일은 제자리에.</span>
          <span>당신은 다음 일에.</span>
        </h1>
        <p>폴더를 끌어다 놓으면, 종류별로 정리해 드려요.</p>
        <p className="hero-platforms">macOS · Windows용 명령줄 프로그램 · 로그인 없이 내 컴퓨터에서</p>
        <div className="hero-actions">
          <a className="button button--orange hero-cta" href="#install">
            설치하기 <Arrow />
          </a>
          <Link className="hero-secondary" to="/preview">
            설치 전에 웹에서 미리보기
          </Link>
        </div>
      </div>
      <ul className="principles" id="features" aria-label="AFO의 정리 원칙">
        <li>종류별로 자동 정리</li>
        <li>확인 코드로만 실행</li>
        <li>afo undo로 되돌리기</li>
      </ul>
    </section>
  );
}
