import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.E2E_WEB_PORT || 5173);
const apiPort = Number(process.env.E2E_API_PORT || 8787);
const baseURL = `http://127.0.0.1:${webPort}`;
const apiURL = `http://127.0.0.1:${apiPort}`;
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "true";

export default defineConfig({
  testDir: "./e2e",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
  forbidOnly: Boolean(process.env.CI),
  failOnFlakyTests: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: [
    {
      command: "node e2e/support/test-server.mjs",
      url: `${apiURL}/api/health`,
      env: {
        E2E_API_PORT: String(apiPort),
        E2E_WEB_PORT: String(webPort)
      },
      reuseExistingServer,
      timeout: 120_000
    },
    {
      command: `node apps/web/node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: baseURL,
      env: {
        DUALLANE_API_ORIGIN: apiURL
      },
      reuseExistingServer,
      timeout: 120_000
    }
  ]
});
