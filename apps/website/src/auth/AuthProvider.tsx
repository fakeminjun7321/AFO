import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { onAuthStateChanged } from "firebase/auth";
import type { User } from "firebase/auth";
import { auth } from "./firebase";

type AuthState = { user: User | null; ready: boolean; error: string | null };
const AuthContext = createContext<AuthState>({
  user: null,
  ready: false,
  error: null,
});
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    ready: false,
    error: null,
  });
  useEffect(
    () =>
      onAuthStateChanged(
        auth,
        (user) => setState({ user, ready: true, error: null }),
        () =>
          setState({
            user: null,
            ready: true,
            error: "로그인 상태를 확인하지 못했습니다. 새로고침해 주세요.",
          }),
      ),
    [],
  );
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  return useContext(AuthContext);
}
