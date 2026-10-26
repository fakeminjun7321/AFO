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
        <p>어지러운 폴더를, 나다운 정리로.</p>
        <Link className="button button--orange hero-cta" to="/demo">
          정리 흐름 체험하기 <Arrow />
        </Link>
      </div>
      <ul className="principles" id="features" aria-label="AFO의 정리 원칙">
        <li>분류는 자동으로</li>
        <li>규칙은 나답게</li>
        <li>실행은 확인 후에</li>
      </ul>
    </section>
  );
}
