import { useState } from "react";
import { Arrow } from "./Icons";

export function Header() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <header className="header">
      <a
        className="wordmark"
        href="#top"
        aria-label="AFO 처음으로"
        onClick={close}
      >
        AFO
      </a>
      <nav
        className={open ? "navigation is-open" : "navigation"}
        id="navigation"
        aria-label="주 메뉴"
      >
        <a href="#features" onClick={close}>
          기능
        </a>
        <a href="#how-it-works" onClick={close}>
          사용 방법
        </a>
        <a href="#faq" onClick={close}>
          자주 묻는 질문
        </a>
      </nav>
      <a className="button button--outline header-cta" href="#demo">
        직접 체험하기 <Arrow diagonal />
      </a>
      <button
        className="menu-toggle"
        type="button"
        aria-expanded={open}
        aria-controls="navigation"
        aria-label={open ? "메뉴 닫기" : "메뉴 열기"}
        onClick={() => setOpen(!open)}
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
        >
          <path d={open ? "M6 6l12 12M6 18 18 6" : "M4 8h16M4 16h16"} />
        </svg>
      </button>
    </header>
  );
}
