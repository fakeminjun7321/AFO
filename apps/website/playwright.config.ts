import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", workers: 1, retries: 0, timeout: 45000,
  use: { baseURL: "http://127.0.0.1:15183", headless: true, trace: "retain-on-failure" },
  reporter: "list",
  webServer: {
    command: "node scripts/start-emulators.mjs",
    url: "http://127.0.0.1:15183", timeout: 120000, reuseExistingServer: false,
    env: { JAVA_TOOL_OPTIONS: "-Xmx512m" },
  },
});
