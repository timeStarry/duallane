import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { mkdtemp, realpath } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertLocalTestDatabase,
  childEnvironment,
  loadArtifact,
  materializeFixture,
  parseArguments,
  removeOwnedFixture,
  runTarget,
  validateArtifact
} from "./frozen-legacy-contract.test.mjs";

test("frozen legacy CLI defaults to files and exposes the full opt-in matrix", () => {
  assert.deepEqual(parseArguments([]), { help: false, targets: ["files"] });
  assert.deepEqual(parseArguments(["--all"]), { help: false, targets: ["files", "emotes"] });
  assert.deepEqual(parseArguments(["--emotes"]), { help: false, targets: ["emotes"] });
  assert.deepEqual(parseArguments(["--help"]), { help: true, targets: [] });
  assert.throws(() => parseArguments(["--production"]), /unknown option/);
});

test("frozen legacy emote target is independently fail-closed without a local database", async () => {
  const previous = process.env.TEST_DATABASE_URL;
  delete process.env.TEST_DATABASE_URL;
  try {
    await assert.rejects(runTarget("emotes"), /explicit TEST_DATABASE_URL/);
  } finally {
    if (previous === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = previous;
  }
});

test("frozen legacy PostgreSQL guard accepts only explicit disposable loopback state", () => {
  assertLocalTestDatabase({ TEST_DATABASE_URL: "postgres://test:test@127.0.0.1:55436/duallane?sslmode=disable" });
  assertLocalTestDatabase({ TEST_DATABASE_URL: "postgres://test:test@[::1]:55436/duallane?sslmode=disable" });
  for (const value of [
    "postgres://test:test@example.invalid/duallane",
    "postgres://test:test@localhost/duallane",
    "postgres://test:test@127.0.0.1/postgres",
    "postgres://test:test@127.0.0.1/template1",
    "postgres://test:test@127.0.0.1/duallane?options=-c%20search_path%3Dpublic",
    "postgres://test:test@127.0.0.1/duallane?search_path=public",
    "postgres://test:test@127.0.0.1/duallane#fragment",
    "not-a-url"
  ]) {
    assert.throws(() => assertLocalTestDatabase({ TEST_DATABASE_URL: value }), (error) => !error.message.includes(value));
  }
});

test("frozen legacy Go children do not inherit ambient PostgreSQL routing or credentials", () => {
  const environment = childEnvironment({
    DATABASE_URL: "postgres://ambient:secret@example.invalid/production",
    PGHOST: "production.example.invalid",
    PGHOSTADDR: "203.0.113.10",
    PGPORT: "5432",
    PGDATABASE: "production",
    PGUSER: "ambient",
    PGPASSWORD: "secret",
    PGSERVICE: "production",
    PGSERVICEFILE: "C:/private/service.conf",
    PGPASSFILE: "C:/private/passfile",
    PGOPTIONS: "-c search_path=public",
    TEST_DATABASE_URL: "postgres://test:test@127.0.0.1:55436/duallane?sslmode=disable"
  });
  for (const key of [
    "DATABASE_URL", "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD",
    "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE", "PGOPTIONS"
  ]) assert.equal(environment[key], undefined, `${key} leaked into Go child`);
  assert.equal(environment.TEST_DATABASE_URL, "postgres://test:test@127.0.0.1:55436/duallane?sslmode=disable");
});

test("frozen artifacts materialize only expected bytes and clean their exact Go fixture prefix", async () => {
  const artifact = await loadArtifact("files");
  validateArtifact("files", artifact);
  const tempRoot = await realpath(tmpdir());
  const fixtureDir = await mkdtemp(path.join(tempRoot, "duallane-files-legacy-contract-"));
  try {
    await materializeFixture("files", artifact, fixtureDir);
    const entries = (await readdir(fixtureDir, { recursive: true })).map((entry) => entry.replaceAll(path.sep, "/"));
    assert.ok(entries.includes("manifest.json"));
    assert.ok(entries.includes("workspace-files/workspace/spc_default/att-files-legacy-contract/legacy_report__.txt"));
    assert.equal(entries.some((entry) => /(?:sqlite|\.db|\.wal|\.shm)$/i.test(entry)), false);
  } finally {
    await removeOwnedFixture(fixtureDir, tempRoot, "duallane-files-legacy-contract-");
  }
});
