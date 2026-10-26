import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { onIdTokenChanged, getIdTokenResult } from "firebase/auth";
import type { User } from "firebase/auth";
import { auth } from "./firebase";

type AuthState = {
  user: User | null;
  ready: boolean;
  error: string | null;
  isAdmin: boolean;
  adminAssigned: boolean;
};
const AuthContext = createContext<AuthState>({
  user: null,
  ready: false,
  error: null,
  isAdmin: false,
  adminAssigned: false,
});
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    ready: false,
    error: null,
    isAdmin: false,
    adminAssigned: false,
  });
  useEffect(() => {
    let revision = 0;
    const unsubscribe = onIdTokenChanged(
      auth,
      async (user) => {
        const current = ++revision;
        if (!user) {
          setState({
            user: null,
            ready: true,
            error: null,
            isAdmin: false,
            adminAssigned: false,
          });
          return;
        }
        setState({
          user,
          ready: false,
          error: null,
          isAdmin: false,
          adminAssigned: false,
        });
        try {
          const { claims } = await getIdTokenResult(user);
          if (current !== revision) return;
          setState({
            user,
            ready: true,
            error: null,
            adminAssigned: claims.admin === true,
            isAdmin: claims.admin === true && claims.email_verified === true,
          });
        } catch {
          if (current === revision)
            setState({
              user,
              ready: true,
              isAdmin: false,
              adminAssigned: false,
              error: "계정 권한을 확인하지 못했습니다. 새로고침해 주세요.",
            });
        }
      },
      () =>
        setState({
          user: null,
          ready: true,
          isAdmin: false,
          adminAssigned: false,
          error: "로그인 상태를 확인하지 못했습니다. 새로고침해 주세요.",
        }),
    );
    return () => {
      revision++;
      unsubscribe();
    };
  }, []);
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  return useContext(AuthContext);
}
