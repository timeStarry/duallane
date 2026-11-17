import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5198";
const apiURL = "http://127.0.0.1:8898";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["workspace-v1-acceptance.spec.ts", "agent-platform-acceptance.spec.ts"],
  outputDir: ".private-test-results/workspace-go-browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: true,
  failOnFlakyTests: true,
  retries: 0,
  reporter: "list",
  // AppV1 is the only production UI. The acceptance suite uses its real Go
  // flows; legacy workspace*.spec.ts selectors target the retired UI.
  // All data is synthetic; never reuse a server or publish failure dumps.
  use: { baseURL, trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "chromium-go-workspace", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/support/go-workspace-server.mjs",
      url: `${apiURL}/readyz`,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
      timeout: 240_000
    },
    {
      command: "node apps/web/node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port 5198 --strictPort",
      url: baseURL,
      env: { DUALLANE_API_ORIGIN: apiURL },
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      timeout: 120_000
    }
  ]
});
