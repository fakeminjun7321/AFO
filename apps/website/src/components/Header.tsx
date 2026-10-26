import { useState } from "react";
import { Arrow } from "./Icons";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

export function Header() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const { user, ready } = useAuth();
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
        <NavLink to="/demo" onClick={close}>
          직접 체험
        </NavLink>
        <NavLink to="/rules" onClick={close}>
          나의 규칙
        </NavLink>
        <NavLink
          to="/resources"
          className={() =>
            ["/resources", "/help", "/downloads", "/notes"].includes(pathname)
              ? "nav-active"
              : ""
          }
          onClick={close}
        >
          안내와 자료
        </NavLink>
      </nav>
      <Link
        className="button button--outline header-cta"
        to={user ? "/account" : "/login"}
        onClick={close}
      >
        {!ready ? "확인 중" : user ? "내 계정" : "로그인"} <Arrow diagonal />
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
