import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from "firebase/functions";
import { app } from "../../auth/firebase";
import services from "../../config/services.public.json";
export const adminApiEnabled =
  import.meta.env.MODE === "emulator" || services.adminApi === true;
const functions = getFunctions(app, "asia-northeast3");
if (import.meta.env.MODE === "emulator")
  connectFunctionsEmulator(functions, "127.0.0.1", 15193);
export type AdminUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
  disabled: boolean;
  createdAt: string | null;
  lastSignInAt: string | null;
  providers: string[];
};
export type Overview = {
  checkedAt: string;
  server: {
    projectId: string;
    region: string;
    runtime: string;
    uptimeSeconds: number;
    memoryBytes: number;
    emulator: boolean;
    database: { reachable: boolean; latencyMs: number | null };
  };
  users: AdminUser[];
  nextPageToken: string | null;
  pageSize: number;
};
const callable = httpsCallable<{ pageToken?: string }, Overview>(
  functions,
  "adminOverview",
  { timeout: 20000 },
);
export async function getOverview(pageToken?: string) {
  return (await callable(pageToken ? { pageToken } : {})).data;
}
