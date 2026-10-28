import { useState } from "react";
import type { FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
} from "firebase/auth";
import { auth } from "../auth/firebase";
import { useAuth } from "../auth/AuthProvider";
import { authError } from "../auth/errors";
import { Arrow } from "../components/Icons";

type Mode = "login" | "signup" | "reset";
export function AuthPage({ mode }: { mode: Mode }) {
  const { user, ready } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const title =
    mode === "signup"
      ? "회원가입"
      : mode === "reset"
        ? "비밀번호 재설정"
        : "로그인";
  async function googleLogin() {
    if (busy) return;
    setError("");
    setMessage("");
    setBusy(true);
    setGoogleBusy(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (e) {
      setError(authError(e));
    } finally {
      setBusy(false);
      setGoogleBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setMessage("");
    if (mode === "signup" && password !== confirm) {
      setError("비밀번호가 서로 다릅니다.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "signup")
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      else if (mode === "login")
        await signInWithEmailAndPassword(auth, email.trim(), password);
      else {
        await sendPasswordResetEmail(auth, email.trim());
        setMessage(
          "가입된 이메일이라면 비밀번호 재설정 안내가 전송됩니다. 메일함을 확인해 주세요.",
        );
      }
      setPassword("");
      setConfirm("");
    } catch (e) {
      setError(authError(e));
    } finally {
      setBusy(false);
    }
  }
  if (!ready)
    return (
      <div className="route-status" role="status">
        로그인 상태를 확인하고 있어요.
      </div>
    );
  if (user) return <Navigate to="/account" replace />;
  return (
    <section className="auth-page section-wrap" aria-labelledby="auth-title">
      <div className="auth-intro">
        <h1 id="auth-title">{title}</h1>
        <p>
          {mode === "reset"
            ? "재설정 안내를 받을 이메일을 입력하세요."
            : "Google 계정 또는 이메일을 사용하세요."}
        </p>
      </div>
      <div className="auth-form-wrap">
        <div className="auth-tabs">
          <Link
            to="/login"
            aria-current={mode === "login" ? "page" : undefined}
          >
            로그인
          </Link>
          <Link
            to="/signup"
            aria-current={mode === "signup" ? "page" : undefined}
          >
            회원가입
          </Link>
        </div>
        {mode !== "reset" && (
          <>
            <button
              type="button"
              className="google-signin"
              disabled={busy}
              onClick={googleLogin}
            >
              <img src="/assets/google-g.png" alt="" width="20" height="20" />
              <span>
                {googleBusy ? "Google 로그인 확인 중…" : "Google로 계속하기"}
              </span>
            </button>
            <div className="auth-divider">
              <span>또는 이메일로</span>
            </div>
          </>
        )}
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <label htmlFor="email">이메일</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
            {mode !== "reset" && (
              <>
                <label htmlFor="password">비밀번호</label>
                <input
                  id="password"
                  type="password"
                  autoComplete={
                    mode === "signup" ? "new-password" : "current-password"
                  }
                  required
                  minLength={mode === "signup" ? 8 : undefined}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-describedby={
                    mode === "signup" ? "password-help" : undefined
                  }
                />
                {mode === "signup" && (
                  <>
                    <p id="password-help" className="field-help">
                      8자 이상으로 입력해 주세요.
                    </p>
                    <label htmlFor="confirm">비밀번호 확인</label>
                    <input
                      id="confirm"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={8}
                      maxLength={128}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                    />
                  </>
                )}
              </>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {message && (
              <p className="form-message" role="status">
                {message}
              </p>
            )}
            <button className="button button--orange auth-submit" type="submit">
              {busy
                ? "처리하고 있어요…"
                : mode === "signup"
                  ? "계정 만들기"
                  : mode === "reset"
                    ? "재설정 메일 받기"
                    : "로그인"}
              {!busy && <Arrow />}
            </button>
          </fieldset>
        </form>
        {mode === "login" ? (
          <Link className="auth-help" to="/reset-password">
            비밀번호를 잊으셨나요?
          </Link>
        ) : (
          <Link className="auth-help" to="/login">
            로그인으로 돌아가기
          </Link>
        )}
        <Link className="auth-back-demo" to="/preview">
          로그인 없이 내 폴더 분석하기
        </Link>
      </div>
    </section>
  );
}
