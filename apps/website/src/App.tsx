import { lazy, Suspense, useEffect, useRef } from "react";
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
import { HomeContent } from "./components/HomeContent";
import { Footer } from "./components/Footer";
import { HelpPage } from "./pages/HelpPage";
import { AuthPage } from "./pages/AuthPage";
import { AccountPage } from "./pages/AccountPage";
const RulesPage = lazy(() =>
  import("./pages/RulesPage").then((module) => ({ default: module.RulesPage })),
);
const LocalPreview = lazy(() =>
  import("./features/local-preview/LocalPreview").then((module) => ({ default: module.LocalPreview })),
);
import { AdminPage } from "./pages/AdminPage";
import { AuthProvider } from "./auth/AuthProvider";
import { PreviewSessionProvider } from "./features/local-preview/session";
import { ResourcesPage } from "./pages/ResourcesPage";
import { DownloadsPage } from "./pages/DownloadsPage";
import { NotesPage } from "./pages/NotesPage";
import { InstallPage } from "./pages/InstallPage";
import { CommunityPage } from "./pages/CommunityPage";

const titles: Record<string, string> = {
  "/": "폴더를 끌어다 놓으면 정리되는 파일 정리 프로그램",
  "/install": "설치",
  "/community": "커뮤니티",
  "/guide": "사용 방법",
  "/help": "도움말",
  "/status": "개발 현황",
  "/preview": "내 폴더 미리보기",
  "/faq": "자주 묻는 질문",
  "/login": "로그인",
  "/signup": "회원가입",
  "/reset-password": "비밀번호 재설정",
  "/account": "내 계정",
  "/rules": "나의 정리 기준",
  "/admin": "관리자",
  "/resources": "안내와 자료",
  "/downloads": "테스트 파일",
  "/notes": "개발 노트",
};
function Shell() {
  const { pathname, hash } = useLocation();
  const previous = useRef(pathname);
  useEffect(() => {
    document.title = `AFO — ${titles[pathname] || "페이지를 찾을 수 없어요"}`;
    // Links such as /install#beginner land on the section instead of the page top.
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    if (target) {
      target.scrollIntoView({ behavior: "instant", block: "start" });
      previous.current = pathname;
    } else if (previous.current !== pathname) {
      window.scrollTo({ top: 0, behavior: "instant" });
      document.getElementById("main")?.focus({ preventScroll: true });
      previous.current = pathname;
    }
  }, [pathname, hash]);
  return (
    <div className={`site-shell${pathname === "/" ? " home-route" : ""}`}>
      <a className="skip-link" href="#main">
        본문으로 바로가기
      </a>
      <Header />
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <Hero />
                <HomeContent />
              </>
            }
          />
          <Route path="/resources" element={<ResourcesPage />} />
          <Route path="/downloads" element={<DownloadsPage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/install" element={<InstallPage />} />
          <Route path="/community" element={<CommunityPage />} />
          <Route path="/status" element={<Navigate to="/notes" replace />} />
          <Route path="/guide" element={<Navigate to="/help" replace />} />
          <Route path="/demo" element={<Navigate to="/help" replace />} />
          <Route path="/preview" element={<Suspense fallback={<p className="route-status" role="status">폴더 분석 화면을 열고 있어요.</p>}><LocalPreview /></Suspense>} />
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
          <Route
            path="/rules"
            element={
              <Suspense
                fallback={
                  <p className="route-status" role="status">
                    규칙 화면을 열고 있어요.
                  </p>
                }
              >
                <RulesPage />
              </Suspense>
            }
          />
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
        <PreviewSessionProvider><Shell /></PreviewSessionProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
