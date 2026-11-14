import { defineConfig, devices } from "@playwright/test";

const webPort = 5297;
const apiPort = 8997;
const baseURL = `http://127.0.0.1:${webPort}`;
const apiURL = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["v1-p2p-acceptance.spec.ts"],
  outputDir: ".private-test-results/v1-p2p-acceptance",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: true,
  failOnFlakyTests: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    actionTimeout: 10_000,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium-v1-p2p",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "node e2e/support/go-p2p-server.mjs",
      url: `${apiURL}/api/health`,
      env: {
        E2E_GO_P2P_API_PORT: String(apiPort),
        E2E_GO_P2P_WEB_ORIGIN: baseURL,
      },
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      timeout: 120_000,
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
