export function authError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "이메일 또는 비밀번호를 다시 확인해 주세요.";
    case "auth/email-already-in-use":
      return "가입할 수 없는 이메일입니다. 기존 계정으로 로그인하거나 다른 이메일을 사용해 주세요.";
    case "auth/weak-password":
    case "auth/password-does-not-meet-requirements":
      return "비밀번호가 보안 기준에 맞지 않습니다. 더 긴 비밀번호를 입력해 주세요.";
    case "auth/invalid-email":
      return "올바른 이메일 주소를 입력해 주세요.";
    case "auth/too-many-requests":
      return "요청이 많아 잠시 제한됐습니다. 잠시 후 다시 시도해 주세요.";
    case "auth/network-request-failed":
      return "연결하지 못했습니다. 네트워크 상태를 확인해 주세요.";
    case "auth/configuration-not-found":
    case "auth/operation-not-allowed":
      return "이 로그인 방법을 준비하고 있습니다. 잠시 후 다시 시도해 주세요.";
    case "auth/unauthorized-domain":
      return "이 주소에서의 로그인이 아직 허용되지 않았습니다.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Google 로그인을 취소했습니다. 다시 시도할 수 있어요.";
    case "auth/popup-blocked":
      return "로그인 창이 차단됐습니다. 이 사이트의 팝업을 허용한 뒤 다시 시도해 주세요.";
    case "auth/account-exists-with-different-credential":
      return "이 이메일로 가입한 계정이 있습니다. 기존 로그인 방법으로 먼저 로그인해 주세요.";
    default:
      return "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
}
