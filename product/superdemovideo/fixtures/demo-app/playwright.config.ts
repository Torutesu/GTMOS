import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env["BASE_URL"] ?? "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/user.json" },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "npm start",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
