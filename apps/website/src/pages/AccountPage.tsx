import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { useAuth } from "../auth/AuthProvider";
import { auth } from "../auth/firebase";
import { authError } from "../auth/errors";
import { Arrow } from "../components/Icons";

export function AccountPage() {
  const { user, ready, error: stateError, isAdmin, adminAssigned } = useAuth();
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
        <h1>내 계정</h1>
        <p>계정 정보와 로그인 상태를 확인하세요.</p>
      </div>
      <div className="account-row">
        <div>
          <span className="account-label">로그인 계정</span>
          <p className="account-email">{user.email}</p>
          <p className="account-role">
            {isAdmin
              ? "AFO 관리자"
              : adminAssigned
                ? "관리자 지정됨 · 이메일 본인 확인 필요"
                : "일반 계정"}
          </p>
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
      {isAdmin && (
        <div className="admin-entry">
          <p>운영 계정으로 로그인했어요.</p>
          <Link to="/admin" className="button button--outline">
            관리자 화면 <Arrow />
          </Link>
        </div>
      )}
      <div className="account-actions">
        <Link to="/preview" className="button button--orange">
          내 폴더 분석하기 <Arrow />
        </Link>
        <Link to="/rules" className="button button--outline">
          나의 규칙
        </Link>
      </div>
    </section>
  );
}
