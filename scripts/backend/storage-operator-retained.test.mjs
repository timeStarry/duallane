import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function requireText(source, text, label) {
  assert.ok(source.includes(text), `${label} is missing ${JSON.stringify(text)}`);
}

function serviceBlock(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `Compose service ${name} is missing`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("  ") && !line.startsWith("    ") && line.endsWith(":")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

test("retained Node storage commands and modes remain explicit", () => {
  const scripts = JSON.parse(read("apps/web/package.json")).scripts;
  const expectedScripts = {
    "db:migrate": "node server/migrate.mjs",
    "storage:provision": "node server/storage-provision.mjs",
    "storage:migrate": "node server/storage-migrate.mjs",
    "storage:dedupe": "node server/storage-dedupe.mjs"
  };
  for (const [name, command] of Object.entries(expectedScripts)) {
    assert.equal(scripts[name], command, `@duallane/web ${name} entrypoint changed`);
  }

  requireText(read("apps/web/server/migrate.mjs"), "openDatabase(env.DATABASE_URL", "Node schema migration runner");
  requireText(read("apps/web/server/storage-provision.mjs"), "provisionWorkspaceS3Bucket({ env: process.env })", "Node S3 provisioner");

  const storageMigration = read("apps/web/server/services/workspace-s3-migration.mjs");
  requireText(storageMigration, 'if (!["backfill", "verify"].includes(mode))', "Node S3 migration modes");
  requireText(storageMigration, 'record.kind === "archive"', "Node S3 archive inventory");
  requireText(storageMigration, "store.ensureObject(record)", "Node S3 migration backfill");
  requireText(storageMigration, "store.verifyObject(record)", "Node S3 migration verification");

  const storageDedupe = read("apps/web/server/services/workspace-storage-dedupe.mjs");
  requireText(storageDedupe, 'const MODES = new Set(["backfill", "verify", "finalize"]);', "Node dedupe modes");
  requireText(storageDedupe, "registry.withObjectLock(record.storageObjectId", "Node dedupe object lock");
  requireText(storageDedupe, "store.deleteLegacyObject(record)", "Node dedupe finalization");

  const runbook = read("docs/backend/STORAGE_OPERATOR.md");
  requireText(runbook, "explicitly close the legacy", "finalization compatibility gate");
  requireText(runbook, "compatibility window first", "finalization compatibility gate");
  requireText(runbook, "independent, recoverable backup and its", "finalization recovery backup gate");
  requireText(runbook, "any rollback that\ndepends on the deleted legacy bytes is no longer available", "finalization rollback boundary");
});

test("default Compose keeps retained storage commands profile-gated and one-shot", () => {
  const compose = read("docker-compose.yml");
  const services = [
    ["storage-provision", "storage-migration", "storage:provision"],
    ["storage-migrate", "storage-migration", "storage:migrate"],
    ["storage-dedupe", "storage-dedupe", "storage:dedupe"]
  ];
  for (const [name, profile, command] of services) {
    const block = serviceBlock(compose, name);
    requireText(block, `profiles: ["${profile}"]`, `${name} profile`);
    requireText(block, `command: ["pnpm", "--filter", "@duallane/web", "${command}"]`, `${name} command`);
    requireText(block, 'restart: "no"', `${name} restart policy`);
  }

  const migrate = serviceBlock(compose, "migrate");
  requireText(migrate, 'command: ["pnpm", "--filter", "@duallane/web", "db:migrate"]', "default schema migration command");
  assert.equal(migrate.includes("profiles:"), false, "default schema migration unexpectedly became profile-gated");

  const api = serviceBlock(compose, "api");
  for (const command of ["storage:provision", "storage:migrate", "storage:dedupe"]) {
    assert.equal(api.includes(command), false, `api service unexpectedly invokes ${command}`);
  }
});

test("Go storage surface is candidate plan/verify/provision and not a backfill CLI", () => {
  const storageMain = read("apps/backend/cmd/storage/main.go");
  for (const command of ["plan", "verify", "provision"]) {
    requireText(storageMain, `case "${command}":`, `Go storage ${command} dispatch`);
  }
  requireText(storageMain, "usage: storage <plan|verify|provision> [flags]", "Go storage usage");
  for (const command of ["archive", "backfill", "dedupe", "finalize", "migrate"]) {
    assert.equal(storageMain.includes(`case "${command}":`), false, `Go storage unexpectedly exposes ${command}`);
  }

  const backfill = read("apps/backend/internal/workspace/storageops/backfill.go");
  requireText(backfill, "It intentionally does not", "Go backfill library boundary");
  requireText(backfill, "own a scheduler, CLI flag, owner transition", "Go backfill coordinator boundary");
  assert.equal(backfill.includes("func main()"), false, "Go backfill library unexpectedly became an executable");
});

test("Go runtime and worker entrypoints do not attach Node offline tools", () => {
  const forbiddenStartupReferences = [
    '"os/exec"',
    "exec.Command(",
    "server/migrate.mjs",
    "storage:provision",
    "storage:migrate",
    "storage:dedupe",
    "duallane-storage"
  ];
  for (const relativePath of ["apps/backend/cmd/workspace/main.go", "apps/backend/cmd/worker/main.go"]) {
    const source = read(relativePath);
    for (const reference of forbiddenStartupReferences) {
      assert.equal(source.includes(reference), false, `${relativePath} unexpectedly references ${reference}`);
    }
  }
});
