import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", workers: 1, retries: 0, timeout: 45000,
  use: { baseURL: "http://127.0.0.1:15183", headless: true, trace: "retain-on-failure" },
  reporter: "list",
  webServer: {
    command: "node ../../firebase/node_modules/firebase-tools/lib/bin/firebase.js emulators:start --only auth,firestore,hosting --config firebase.emulator.json --project demo-afo-website --non-interactive",
    url: "http://127.0.0.1:15183", timeout: 120000, reuseExistingServer: false,
    env: { JAVA_TOOL_OPTIONS: "-Xmx512m" },
  },
});
