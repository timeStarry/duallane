import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");
const [workflow, config] = await Promise.all([
  read(".github/workflows/ci.yml"),
  read("playwright.workspace-go.config.ts")
]);
const normalizedWorkflow = workflow.replace(/\r\n?/g, "\n");

function jobBlock(name) {
  const marker = `\n  ${name}:\n`;
  const start = normalizedWorkflow.indexOf(marker);
  assert.notEqual(start, -1, `${name} job is missing from CI workflow`);
  const bodyStart = start + marker.length;
  const remainder = normalizedWorkflow.slice(bodyStart);
  const nextJob = remainder.search(/\n  [a-z][a-z0-9-]*:\n/);
  return remainder.slice(0, nextJob === -1 ? remainder.length : nextJob);
}

test("Go Workspace browser coverage is an independent complete 30-minute job", () => {
  const job = jobBlock("go-workspace-browser");
  assert.match(job, /name: Go Workspace Chromium integration and privacy/);
  assert.match(job, /runs-on: ubuntu-latest/);
  assert.match(job, /timeout-minutes: 30/);
  assert.doesNotMatch(job, /\n    needs:/);

  assert.match(job, /actions\/setup-go@v7/);
  assert.match(job, /go-version-file: apps\/backend\/go\.mod/);
  assert.match(job, /cache-dependency-path: apps\/backend\/go\.sum/);
  assert.doesNotMatch(job, /go-version:\s*(latest|stable)/);

  assert.match(job, /pnpm\/action-setup@v4/);
  assert.match(job, /version: 10\.30\.3/);
  assert.match(job, /actions\/setup-node@v4/);
  assert.match(job, /node-version: 22/);
  assert.match(job, /pnpm install --frozen-lockfile/);
});

test("Go Workspace browser coverage provisions only synthetic PostgreSQL and native dependencies", () => {
  const job = jobBlock("go-workspace-browser");
  assert.match(job, /services:\n      postgres:\n/);
  assert.match(job, /image: postgres:17-alpine/);
  assert.match(job, /POSTGRES_DB: duallane/);
  assert.match(job, /POSTGRES_USER: duallane/);
  assert.match(job, /POSTGRES_PASSWORD: duallane-ci-password/);
  assert.match(job, /--health-cmd "pg_isready -U duallane -d duallane"/);

  assert.match(job, /CGO_ENABLED: "1"/);
  assert.match(job, /CC: gcc/);
  const nativeStart = job.indexOf("- name: Provision Go Workspace native dependencies");
  const pnpmStart = job.indexOf("- name: Set up pnpm");
  assert.ok(nativeStart >= 0 && pnpmStart > nativeStart, "native setup must precede Node setup");
  const native = job.slice(nativeStart, pnpmStart);
  assert.match(native, /sudo apt-get update/);
  assert.match(native, /sudo apt-get install --no-install-recommends -y gcc libvips-dev pkg-config/);
  assert.match(native, /command -v gcc/);
  assert.match(native, /command -v pkg-config/);
  assert.match(native, /pkg-config --exists vips/);
  assert.match(native, /test "\$\(go env CGO_ENABLED\)" = "1"/);
  assert.match(native, /test "\$\(go env CC\)" = "gcc"/);
});

test("Go Workspace browser coverage runs the unmodified complete suite without private-output publication", () => {
  const job = jobBlock("go-workspace-browser");
  const chromium = job.indexOf("- name: Install Chromium and system dependencies");
  const gate = job.indexOf("- name: Run complete Go Workspace browser gate");
  assert.ok(chromium >= 0 && gate > chromium, "Chromium must be installed before the browser gate");
  assert.match(job.slice(chromium, gate), /pnpm exec playwright install --with-deps chromium/);

  const gateStep = job.slice(gate);
  assert.match(gateStep, /TEST_DATABASE_URL: postgres:\/\/duallane:duallane-ci-password@127\.0\.0\.1:5432\/duallane\?sslmode=disable/);
  assert.match(gateStep, /DUALLANE_GO_E2E_ALLOW_SCHEMA_CREATION: "true"/);
  assert.match(gateStep, /run: pnpm test:e2e:workspace-go\n/);
  assert.equal((job.match(/run: pnpm test:e2e:workspace-go\n/g) || []).length, 1);
  assert.doesNotMatch(job, /--grep|--project|--retry|--timeout|continue-on-error|testIgnore|testMatch/);

  assert.match(config, /testMatch: "workspace\*\.spec\.ts"/);
  assert.match(config, /outputDir: "\.private-test-results\/workspace-go-browser"/);
  for (const option of ["trace", "screenshot", "video"]) {
    assert.match(config, new RegExp(`${option}: "off"`));
  }
  assert.equal((config.match(/reuseExistingServer: false/g) || []).length, 2);

  assert.doesNotMatch(job, /upload-artifact@|playwright-report|(?:^|\/)test-results\//);
  assert.doesNotMatch(job, /\b(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|S3_SECRET|SMTP_PASSWORD|NTFY_TOKEN|OPENAI_API_KEY|GITHUB_CLIENT_SECRET)\b/);
  assert.doesNotMatch(job, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(job, /\b(?:tee|GITHUB_STEP_SUMMARY|::debug|::notice|::warning)\b/);
});

test("quality gate runs both the Workspace privacy guard and the read-only gateway smoke guard", () => {
  const job = jobBlock("quality-gate");
  const step = job.split(/(?=^      - name: )/m)
    .find((part) => part.startsWith("      - name: Validate backend tooling guards"));
  assert.ok(step, "backend tooling guard step is missing");
  assert.match(step, /\.github\/tests\/ci-go-workspace-privacy\.test\.mjs/);
  assert.match(step, /scripts\/backend\/gateway-readonly-smoke\.test\.mjs/);
});
