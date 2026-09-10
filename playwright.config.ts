import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.E2E_WEB_PORT || 5173);
const apiPort = Number(process.env.E2E_API_PORT || 8787);
const baseURL = `http://127.0.0.1:${webPort}`;
const apiURL = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: "./e2e",
  // The default gate keeps the original P2P assertions, but its server is the
  // Go P2P candidate. Workspace has a separate complete Go browser job.
  testMatch: ["p2p.spec.ts", "p2p-ime.spec.ts"],
  outputDir: ".private-test-results/p2p-go-default",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
  forbidOnly: Boolean(process.env.CI),
  failOnFlakyTests: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    contextOptions: {
      reducedMotion: "reduce"
    },
    trace: "off",
    screenshot: "off",
    video: "off"
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
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      timeout: 120_000
    },
    {
      command: `node apps/web/node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: baseURL,
      env: {
        DUALLANE_API_ORIGIN: apiURL
      },
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      timeout: 120_000
    }
  ]
});
