import { useState } from "react";
import { Arrow } from "./Icons";
import { Link, NavLink, useLocation } from "react-router-dom";

export function Header() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const { pathname } = useLocation();
  return (
    <header className="header">
      <Link
        className="wordmark"
        to="/"
        aria-label="AFO 처음으로"
        onClick={close}
      >
        AFO
      </Link>
      <nav
        className={open ? "navigation is-open" : "navigation"}
        id="navigation"
        aria-label="주 메뉴"
      >
        <NavLink to="/install" onClick={close}>
          설치
        </NavLink>
        <NavLink
          to="/help"
          className={() => (["/help", "/resources", "/downloads"].includes(pathname) ? "nav-active" : "")}
          onClick={close}
        >
          사용 방법
        </NavLink>
        <NavLink
          to="/preview"
          className={() => (["/preview", "/rules"].includes(pathname) ? "nav-active" : "")}
          onClick={close}
        >
          웹 미리보기
        </NavLink>
        <NavLink to="/community" onClick={close}>
          커뮤니티
        </NavLink>
        <NavLink to="/notes" onClick={close}>
          개발 노트
        </NavLink>
      </nav>
      <Link
        className="button button--orange header-cta"
        to="/install"
        onClick={close}
      >
        설치하기 <Arrow />
      </Link>
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
