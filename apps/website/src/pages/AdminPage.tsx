import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Arrow } from "../components/Icons";

export function AdminPage() {
  const { user, ready, isAdmin, adminAssigned } = useAuth();
  if (!ready)
    return (
      <div className="route-status" role="status">
        관리자 권한을 확인하고 있어요.
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  if (!isAdmin)
    return (
      <section className="page-heading section-wrap">
        <h1>
          관리자 계정이
          <br />
          필요합니다.
        </h1>
        <p>
          {adminAssigned
            ? "Google 로그인으로 이메일 본인 확인을 마친 뒤 이용해 주세요."
            : "현재 로그인한 계정에는 관리자 권한이 없습니다."}
        </p>
        <Link className="button button--outline" to="/account">
          내 계정으로 돌아가기
        </Link>
      </section>
    );
  return (
    <section className="admin-page section-wrap">
      <div className="page-heading">
        <h1>AFO 관리.</h1>
        <p>운영 계정과 서비스 화면을 확인하세요.</p>
      </div>
      <dl className="admin-details">
        <div>
          <dt>운영 계정</dt>
          <dd>{user.email}</dd>
        </div>
        <div>
          <dt>권한</dt>
          <dd>관리자 · 이메일 본인 확인됨</dd>
        </div>
      </dl>
      <div className="admin-links">
        <Link to="/guide">
          사용 방법 확인 <Arrow />
        </Link>
        <Link to="/demo">
          분류 체험 확인 <Arrow />
        </Link>
        <Link to="/faq">
          도움말 확인 <Arrow />
        </Link>
      </div>
      <p className="admin-scope-note">
        현재 관리자 화면은 운영 계정과 접근 권한을 확인하는 범위입니다. 회원
        목록 조회·차단, 다른 사용자의 규칙 수정, 실제 파일 변경 기능은 아직
        제공하지 않습니다.
      </p>
    </section>
  );
}
