import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("../../deploy/production/release-helper.sh", import.meta.url));
const source = readFileSync(new URL("../../deploy/production/deploy.sh", import.meta.url), "utf8");
const start = source.indexOf("release_verify_activation_authority\nif ");
const end = source.indexOf('\nif [[ "${RELEASE_PROFILE_NAME}" == "node-default" ]]', start);
assert.ok(start > 0 && end > start, "the real migration sequence must be identifiable");
const sequence = source.slice(start, end);
const previousImage = `sha256:${"a".repeat(64)}`;
const targetImage = `sha256:${"b".repeat(64)}`;

function runBash(lines, args = []) {
  return spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", lines.join("\n"),
    "schema-upgrade-gate", helper, ...args], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
  });
}

function runGate({ verifierStatus = 0, validated = true, upgrade = true,
  authorityStatus = 0, recordStatus = 0, previous = previousImage, target = targetImage } = {}) {
  return runBash([
    'source "$1"',
    "RELEASE_PROFILE_NAME=go-full",
    `RELEASE_GO_UPGRADE=${upgrade}`,
    `RELEASE_GO_UPGRADE_VALIDATED=${validated}`,
    'RELEASE_GO_UPGRADE_OLD_WORKSPACE_IMAGE_ID="$2"',
    'RELEASE_GO_IMAGE_ID="$3"',
    `release_verify_activation_authority() { printf 'authority\\n'; return ${authorityStatus}; }`,
    `node() { printf 'verify:%s\\n' "$*"; return ${verifierStatus}; }`,
    `release_append_recovery_record() { printf 'record:%s\\n' "$1"; return ${recordStatus}; }`,
    "release_run_go_migration_and_verify() { printf 'migration\\n'; }",
    sequence,
  ], [previous, target]);
}

test("an incompatible previous image stops the real release sequence before migration", () => {
  const result = runGate({ verifierStatus: 7 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^authority$/m);
  assert.doesNotMatch(result.stdout, /^migration$|^record:/m);
});

test("compatibility verification uses exact image IDs and records success before migration", () => {
  const result = runGate();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`verify --previous-image ${previousImage} --target-image ${targetImage}`));
  assert.ok(result.stdout.indexOf("go_schema_upgrade_compatibility_verified=true") < result.stdout.indexOf("\nmigration\n"));
});

test("missing previous-release verification cannot invoke the schema checker or migrator", () => {
  const result = runGate({ validated: false });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /^verify:|^migration$|^record:/m);
});

test("the Go-upgrade gate does not pretend a first cutover has a previous Go image", () => {
  const result = runGate({ upgrade: false, validated: false });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^verify:|^record:/m);
  assert.match(result.stdout, /^migration$/m);
});

test("authority and recovery-record failures stop the sequence before migration", () => {
  for (const options of [{ authorityStatus: 6 }, { recordStatus: 7 }]) {
    const result = runGate(options);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /^migration$/m);
    if (options.authorityStatus) assert.doesNotMatch(result.stdout, /^verify:|^record:/m);
  }
});

test("malformed IDs are rejected before the verifier and migration", () => {
  for (const invalid of ["", "workspace:latest", "sha256:abc"]) {
    for (const key of ["previous", "target"]) {
      const result = runGate({ [key]: invalid });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout, /^verify:|^record:|^migration$/m);
    }
  }
});

function directMigrationProbe({ verify = true, mutate = "", recheckFails = false } = {}) {
  return runBash([
    'source "$1"',
    'exec 3>&1',
    "RELEASE_PROFILE_NAME=go-full",
    "RELEASE_GO_UPGRADE=true",
    "RELEASE_GO_UPGRADE_VALIDATED=true",
    `RELEASE_GO_UPGRADE_OLD_WORKSPACE_IMAGE_ID=${previousImage}`,
    `RELEASE_GO_IMAGE_ID=${targetImage}`,
    "node() { return 0; }",
    "release_append_recovery_record() { return 0; }",
    "compose() { printf 'compose_probe\\n' >&3; return 73; }",
    ...(verify ? ["release_verify_schema_upgrade_compatibility"] : []),
    mutate,
    ...(recheckFails ? ["node() { return 1; }", "release_verify_schema_upgrade_compatibility || true"] : []),
    "release_run_go_migration_and_verify",
  ]);
}

test("direct migration calls require a fresh compatibility proof for the same image pair", () => {
  const allowed = directMigrationProbe();
  assert.equal(allowed.error, undefined);
  assert.match(allowed.stdout, /^compose_probe$/m);
  for (const options of [
    { verify: false },
    { mutate: `RELEASE_GO_IMAGE_ID=sha256:${"c".repeat(64)}` },
    { mutate: `RELEASE_GO_UPGRADE_OLD_WORKSPACE_IMAGE_ID=sha256:${"c".repeat(64)}` },
    { mutate: "RELEASE_GO_UPGRADE_VALIDATED=false" },
    { mutate: "RELEASE_GO_IMAGE_ID=mutable; RELEASE_GO_SCHEMA_COMPATIBLE_TARGET_IMAGE_ID=mutable" },
    { recheckFails: true },
  ]) {
    const result = directMigrationProbe(options);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /^compose_probe$/m);
    assert.match(result.stderr, /schema compatibility was not verified/);
  }
});
