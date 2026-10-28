import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Arrow } from "../components/Icons";
import { useState, useEffect, useRef } from "react";
import { adminApiEnabled, getOverview } from "../features/admin/client";
import type { Overview } from "../features/admin/client";

export function AdminPage() {
  const { user, ready, isAdmin, adminAssigned } = useAuth();
  const [data, setData] = useState<Overview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const revision = useRef(0);
  async function load(pageToken?: string) {
    if (!ready || !isAdmin || !adminApiEnabled || busy) return;
    const current = ++revision.current;
    setBusy(true);
    setError("");
    try {
      const result = await getOverview(pageToken);
      if (current === revision.current) setData(result);
    } catch {
      if (current === revision.current)
        setError(
          "관리 정보를 불러오지 못했습니다. 서버 연결과 관리자 권한을 확인해 주세요.",
        );
    } finally {
      if (current === revision.current) setBusy(false);
    }
  }
  useEffect(() => {
    revision.current++;
    setData(null);
    setError("");
    setBusy(false);
    return () => {
      revision.current++;
    };
  }, [user?.uid, isAdmin]);
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
        <h1>관리자</h1>
        <p>
          {adminApiEnabled
            ? "서버 상태와 사용자 정보를 읽기 전용으로 확인합니다."
            : "Firebase 콘솔에서 서비스 상태와 사용자 정보를 확인합니다."}
        </p>
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
      <section className="admin-server" aria-labelledby="admin-server-title">
        <div className="admin-section-title">
          <h2 id="admin-server-title">서버·사용자 조회</h2>
          {adminApiEnabled && (
            <button
              type="button"
              className="button button--outline button--small"
              disabled={busy}
              onClick={() => load()}
            >
              {busy ? "조회 중…" : data ? "새로고침" : "관리 정보 불러오기"}
            </button>
          )}
        </div>
        {!adminApiEnabled && (
          <div>
            <p className="service-pending" role="status">
              무료 Spark 요금제를 유지하며, 사용자와 서버 정보는 아래 Firebase
              콘솔에서 확인합니다.
            </p>
            <p className="admin-console-links">
              <a
                href="https://console.firebase.google.com/project/afo-hackathon-2026-7321/authentication/users"
                target="_blank"
                rel="noopener noreferrer"
              >
                Firebase 사용자 목록
              </a>
              <a
                href="https://console.firebase.google.com/project/afo-hackathon-2026-7321/overview"
                target="_blank"
                rel="noopener noreferrer"
              >
                Firebase 프로젝트 상태
              </a>
              <a
                href="https://console.firebase.google.com/project/afo-hackathon-2026-7321/firestore"
                target="_blank"
                rel="noopener noreferrer"
              >
                Firestore 데이터베이스
              </a>
              <a
                href="https://console.firebase.google.com/project/afo-hackathon-2026-7321/hosting"
                target="_blank"
                rel="noopener noreferrer"
              >
                Hosting 상태
              </a>
            </p>
            <p className="field-help">
              웹사이트 관리자 역할과 별도로, Firebase 프로젝트 권한이 있는
              Google 계정으로 열 수 있습니다.
            </p>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {data && (
          <>
            <p className="admin-checked">
              조회 시각 {new Date(data.checkedAt).toLocaleString("ko-KR")}
            </p>
            <dl className="admin-runtime">
              <div>
                <dt>프로젝트</dt>
                <dd>{data.server.projectId}</dd>
              </div>
              <div>
                <dt>관리 API 지역</dt>
                <dd>{data.server.region}</dd>
              </div>
              <div>
                <dt>런타임</dt>
                <dd>
                  {data.server.runtime}
                  {data.server.emulator ? " · Emulator" : ""}
                </dd>
              </div>
              <div>
                <dt>DB 연결 확인</dt>
                <dd>
                  {data.server.database.reachable
                    ? `연결됨 · ${data.server.database.latencyMs} ms`
                    : "조회 실패"}
                </dd>
              </div>
              <div>
                <dt>이 API의 가동 시간</dt>
                <dd>{data.server.uptimeSeconds}초</dd>
              </div>
              <div>
                <dt>이 API의 메모리 사용</dt>
                <dd>
                  {(data.server.memoryBytes / 1024 / 1024).toFixed(1)} MiB
                </dd>
              </div>
            </dl>
            <h2 className="admin-users-title">
              사용자 <span>이번 페이지 {data.users.length}명</span>
            </h2>
            <div
              className="admin-users-scroll"
              tabIndex={0}
              aria-label="사용자 목록"
            >
              <table className="admin-users">
                <thead>
                  <tr>
                    <th>이메일 / UID</th>
                    <th>로그인 방식</th>
                    <th>상태</th>
                    <th>가입일</th>
                    <th>최근 로그인</th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.uid}>
                      <td>
                        {u.email ?? "이메일 없음"}
                        <small>{u.uid}</small>
                      </td>
                      <td>{u.providers.join(", ") || "미연결"}</td>
                      <td>
                        {u.disabled ? "사용 중지" : "활성"} ·{" "}
                        {u.emailVerified ? "이메일 확인" : "미확인"}
                      </td>
                      <td>
                        {u.createdAt
                          ? new Date(u.createdAt).toLocaleDateString("ko-KR")
                          : "없음"}
                      </td>
                      <td>
                        {u.lastSignInAt
                          ? new Date(u.lastSignInAt).toLocaleString("ko-KR")
                          : "없음"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="admin-pagination">
              <button
                type="button"
                className="button button--outline button--small"
                disabled={busy}
                onClick={() => load()}
              >
                처음으로
              </button>
              <button
                type="button"
                className="button button--outline button--small"
                disabled={busy || !data.nextPageToken}
                onClick={() => load(data.nextPageToken ?? undefined)}
              >
                다음 {data.pageSize}명
              </button>
            </div>
          </>
        )}
      </section>
      <div className="admin-links">
        <Link to="/preview">
          폴더 분석 화면 확인 <Arrow />
        </Link>
        <Link to="/help">
          도움말 <Arrow />
        </Link>
      </div>
      <p className="admin-scope-note">
        {adminApiEnabled
          ? "비밀번호·인증 토큰은 표시하지 않습니다. 서버 수치는 이 관리 API 인스턴스의 관측값이며 프로젝트 전체 트래픽·요금 지표가 아닙니다."
          : "이 웹사이트에서 사용자 정보를 별도로 조회하거나 보관하지 않습니다. 상세 정보는 Firebase 콘솔에서 확인합니다."}{" "}
        사용자 차단·삭제·파일 변경은 이 화면에서 수행하지 않습니다.
      </p>
    </section>
  );
}
