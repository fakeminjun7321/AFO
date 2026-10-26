import { useEffect, useRef } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Link,
  useLocation,
  Navigate,
} from "react-router-dom";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { FolderDemo } from "./features/demo/FolderDemo";
import { Footer } from "./components/Footer";
import { HelpPage } from "./pages/HelpPage";
import { AuthPage } from "./pages/AuthPage";
import { AccountPage } from "./pages/AccountPage";
import { AdminPage } from "./pages/AdminPage";
import { AuthProvider } from "./auth/AuthProvider";

const titles: Record<string, string> = {
  "/": "파일은 제자리에. 당신은 다음 일에.",
  "/guide": "사용 방법",
  "/help": "도움말",
  "/demo": "직접 체험",
  "/faq": "자주 묻는 질문",
  "/login": "로그인",
  "/signup": "회원가입",
  "/reset-password": "비밀번호 재설정",
  "/account": "내 계정",
  "/admin": "관리자",
};
function Shell() {
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  useEffect(() => {
    document.title = `AFO — ${titles[pathname] || "페이지를 찾을 수 없어요"}`;
    if (previous.current !== pathname) {
      window.scrollTo({ top: 0, behavior: "instant" });
      document.getElementById("main")?.focus({ preventScroll: true });
      previous.current = pathname;
    }
  }, [pathname]);
  return (
    <div className={`site-shell${pathname === "/" ? " home-route" : ""}`}>
      <a className="skip-link" href="#main">
        본문으로 바로가기
      </a>
      <Header />
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Hero />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/guide" element={<Navigate to="/help" replace />} />
          <Route path="/demo" element={<FolderDemo />} />
          <Route path="/faq" element={<Navigate to="/help" replace />} />
          <Route
            path="/login"
            element={<AuthPage key="login" mode="login" />}
          />
          <Route
            path="/signup"
            element={<AuthPage key="signup" mode="signup" />}
          />
          <Route
            path="/reset-password"
            element={<AuthPage key="reset" mode="reset" />}
          />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route
            path="*"
            element={
              <section className="page-heading section-wrap">
                <h1>
                  페이지를
                  <br />
                  찾을 수 없어요.
                </h1>
                <Link className="button button--outline" to="/">
                  처음으로 돌아가기
                </Link>
              </section>
            }
          />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </BrowserRouter>
  );
}
