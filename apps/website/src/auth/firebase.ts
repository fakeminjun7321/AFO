import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import publicConfig from "../config/firebase.public.json";
import services from "../config/services.public.json";

// Browser SDK config is public identification, never an admin credential.
const emulator = import.meta.env.MODE === "emulator";
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
  location.hostname,
);
if (emulator && !loopback) {
  throw new Error("Auth Emulator는 로컬 검증 빌드에서만 사용할 수 있습니다.");
}
export const app = initializeApp(
  emulator
    ? {
        apiKey: "demo-afo-website",
        projectId: "demo-afo-website",
        authDomain: "demo-afo-website.firebaseapp.com",
      }
    : publicConfig,
);
export const auth = getAuth(app);
export const cloudRulesEnabled =
  emulator ||
  (services.cloudRules &&
    services.storageFormatVersion === 2 &&
    import.meta.env.VITE_AFO_CLOUD_RULES !== "disabled");
if (emulator)
  connectAuthEmulator(auth, "http://127.0.0.1:19103", {
    disableWarnings: true,
  });
