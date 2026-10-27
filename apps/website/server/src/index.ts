import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { requireAdmin, parsePageToken, publicUser } from "./access.js";

if (!getApps().length) initializeApp();
export const adminOverview = onCall(
  {
    region: "asia-northeast3",
    minInstances: 0,
    maxInstances: 1,
    memory: "256MiB",
    cpu: "gcf_gen1",
    concurrency: 1,
    timeoutSeconds: 20,
    serviceAccount:
      "afo-admin-reader@afo-hackathon-2026-7321.iam.gserviceaccount.com",
    cors:
      process.env.FUNCTIONS_EMULATOR === "true"
        ? ["http://127.0.0.1:15183", "http://127.0.0.1:15173"]
        : ["https://afo-hackathon-2026-7321--website-design-l2p0zktg.web.app"],
  },
  async (request) => {
    try {
      requireAdmin(request.auth);
    } catch {
      throw new HttpsError(
        request.auth ? "permission-denied" : "unauthenticated",
        "본인 인증을 마친 관리자만 조회할 수 있습니다.",
      );
    }
    let pageToken: string | undefined;
    try {
      pageToken = parsePageToken(request.data);
    } catch {
      throw new HttpsError(
        "invalid-argument",
        "페이지 정보가 유효하지 않습니다.",
      );
    }
    try {
      const listed = await getAuth().listUsers(50, pageToken);
      const started = Date.now();
      let database: { reachable: boolean; latencyMs: number | null };
      try {
        await getFirestore().doc("afoAdminHealth/probe").get();
        database = { reachable: true, latencyMs: Date.now() - started };
      } catch (e) {
        if (process.env.FUNCTIONS_EMULATOR === "true")
          console.warn(
            "admin-db-probe",
            e instanceof Error ? e.message.slice(0, 240) : "unknown",
          );
        database = { reachable: false, latencyMs: null };
      }
      return {
        checkedAt: new Date().toISOString(),
        server: {
          projectId:
            process.env.GCLOUD_PROJECT ??
            process.env.GOOGLE_CLOUD_PROJECT ??
            "unknown",
          region: "asia-northeast3",
          runtime: process.version,
          uptimeSeconds: Math.floor(process.uptime()),
          memoryBytes: process.memoryUsage().rss,
          emulator: process.env.FUNCTIONS_EMULATOR === "true",
          database,
        },
        users: listed.users.map(publicUser),
        nextPageToken: listed.pageToken ?? null,
        pageSize: 50,
      };
    } catch {
      throw new HttpsError(
        "internal",
        "사용자 정보를 조회하지 못했습니다. 서버 권한과 상태를 확인해 주세요.",
      );
    }
  },
);
