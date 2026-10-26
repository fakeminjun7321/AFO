import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { useAuth } from "../auth/AuthProvider";
import { auth } from "../auth/firebase";
import { authError } from "../auth/errors";
import { Arrow } from "../components/Icons";

export function AccountPage() {
  const { user, ready, error: stateError } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!ready)
    return (
      <div className="route-status" role="status">
        로그인 상태를 확인하고 있어요.
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  async function logout() {
    setBusy(true);
    setError("");
    try {
      await signOut(auth);
    } catch (e) {
      setError(authError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="account-page section-wrap">
      <div className="page-heading">
        <h1>나의 AFO.</h1>
        <p>로그인한 계정을 확인하고, 정리 흐름을 이어가세요.</p>
      </div>
      <div className="account-row">
        <div>
          <span className="account-label">로그인 계정</span>
          <p className="account-email">{user.email}</p>
        </div>
        <button
          type="button"
          className="button button--outline button--small"
          disabled={busy}
          onClick={logout}
        >
          {busy ? "로그아웃 중…" : "로그아웃"}
        </button>
      </div>
      {(error || stateError) && (
        <p className="form-error" role="alert">
          {error || stateError}
        </p>
      )}
      <div className="account-next">
        <h2>
          정리하기 전에,
          <br />
          먼저 살펴보세요.
        </h2>
        <p>
          샘플 파일로 분류 흐름을 체험할 수 있어요.
          <br />
          개인 규칙의 클라우드 저장은 아직 연결하지 않았습니다.
        </p>
        <Link to="/demo" className="button button--orange">
          정리 흐름 체험하기 <Arrow />
        </Link>
      </div>
    </section>
  );
}
