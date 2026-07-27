import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "./e2e",
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
      url: "http://127.0.0.1:8787/api/health",
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: "pnpm --filter @duallane/web exec vite --host 127.0.0.1 --port 5173 --strictPort",
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
