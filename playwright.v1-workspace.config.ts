import { defineConfig, devices } from "@playwright/test";

const webPort = 5298;
const apiPort = 8998;
const baseURL = `http://127.0.0.1:${webPort}`;
const apiURL = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["workspace-v1-acceptance.spec.ts"],
  outputDir: ".private-test-results/v1-workspace-acceptance",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  forbidOnly: true,
  failOnFlakyTests: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium-v1-workspace",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "node e2e/support/go-workspace-server.mjs",
      url: `${apiURL}/readyz`,
      env: {
        E2E_GO_WORKSPACE_API_PORT: String(apiPort),
        E2E_GO_WORKSPACE_WEB_ORIGIN: baseURL,
      },
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
      timeout: 240_000,
    },
    {
      command: `node apps/web/node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: baseURL,
      env: {
        DUALLANE_API_ORIGIN: apiURL,
      },
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      timeout: 120_000,
    },
  ],
});
