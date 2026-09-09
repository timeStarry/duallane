import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildChildEnvironment, compareObservations, createNormalizer,
  createSocketClient, parseArguments, safeFailureMessage
} from "./p2p-parity.mjs";

const observation = (value) => ({ http: [{ name: "synthetic", value }], websocket: [] });

test("comparison retains error fields, omission, array order and values", () => {
  const baseline = { status: 400, body: { error: "Bad Request", code: "BAD_JSON" } };
  assert.equal(compareObservations(observation(baseline), observation(baseline)).length, 0);
  for (const candidate of [
    { status: 400, body: { error: "Bad Request" } },
    { status: 400, body: { error: "Bad Request", code: null } },
    { status: 400, body: { error: "changed", code: "BAD_JSON" } },
    { status: 200, body: baseline.body }
  ]) {
    assert.equal(compareObservations(observation(baseline), observation(candidate)).length, 1);
  }
  assert.equal(compareObservations(observation([1, 2]), observation([2, 1])).length, 1);
  assert.equal(compareObservations(observation(null), { http: [], websocket: [] }).length, 1);
  assert.equal(compareObservations(observation({ a: 1, b: 2 }), observation({ b: 2, a: 1 })).length, 0);
  assert.equal(compareObservations(
    observation({ status: 200, headers: { "x-content-type-options": "nosniff" } }),
    observation({ status: 200, headers: { "x-content-type-options": "same-origin" } })
  ).length, 1);
});

test("normalization preserves relationships between distinct generated identities", () => {
  const normalizer = createNormalizer();
  assert.deepEqual(normalizer.normalize({ roomId: "room-a", peerId: "peer-a" }), {
    roomId: "<room-1>", peerId: "<peer-1>"
  });
  assert.deepEqual(normalizer.normalize({ roomId: "room-b", peers: [{ id: "peer-a" }, { id: "peer-b" }] }), {
    roomId: "<room-2>", peers: [{ id: "<peer-1>" }, { id: "<peer-2>" }]
  });
  assert.deepEqual(normalizer.normalize({ expiresAt: "synthetic-time", appVersion: "candidate", error: "unchanged", extra: null }), {
    expiresAt: "<timestamp>", appVersion: "<release-version>", error: "unchanged", extra: null
  });
});

test("failure summaries never print response values or unknown exception messages", () => {
  const mismatches = compareObservations(observation({ error: "synthetic-private-a" }), observation({ error: "synthetic-private-b" }));
  assert.doesNotMatch(mismatches.join("\n"), /synthetic-private/);
  assert.doesNotMatch(compareObservations(observation({ "synthetic-private-key": 1 }), observation({ "synthetic-private-key": 2 })).join("\n"), /synthetic-private/);
  assert.equal(safeFailureMessage(new Error("http://example.invalid/#k=synthetic")), "runner or transport error");
});

test("child environment explicitly disables Workspace and omits application credentials", () => {
  const environment = buildChildEnvironment({ baseUrl: "http://127.0.0.1:12345", port: 12345, dataDir: "/synthetic", implementation: "node" });
  assert.equal(environment.WORKSPACE_ENABLED, "false");
  assert.equal(environment.HOST, "127.0.0.1");
  assert.equal(environment.SERVE_STATIC, "false");
  for (const key of ["DATABASE_URL", "TEST_DATABASE_URL", "NODE_OPTIONS", "GITHUB_CLIENT_SECRET", "HTTP_PROXY"]) {
    assert.equal(Object.hasOwn(environment, key), false);
  }
  assert.equal(environment.DUALLANE_TURN_SHARED_SECRET, "");
  assert.equal(environment.DUALLANE_TURN_USERNAME, "synthetic-turn-user");
  assert.equal(environment.DUALLANE_TURN_CREDENTIAL, "synthetic-turn-credential");
});

test("CLI rejects nonlocal or relative binaries without starting a server", () => {
  assert.throws(() => parseArguments(["--go-binary", "https://example.invalid/p2p"]), /local path/);
  assert.throws(() => parseArguments(["--go-binary", "relative-p2p"]), /absolute/);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./p2p-parity.mjs", import.meta.url)), "--unsupported"], {
    encoding: "utf8", timeout: 5_000, windowsHide: true
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage error/);
});

test("HTTP fixtures have unique names and never substitute status-only evidence", async () => {
  const fixtures = JSON.parse(await readFile(new URL("./testdata/p2p/http.json", import.meta.url), "utf8"));
  assert.equal(fixtures.cases.length, 21);
  assert.equal(new Set(fixtures.cases.map((entry) => entry.name)).size, 21);
  for (const fixture of fixtures.cases) {
    assert.notEqual(fixture.projection, "status");
    assert.ok(fixture.path.startsWith("/"));
    assert.ok(!fixture.path.includes("#"));
  }
  assert.doesNotMatch(JSON.stringify(fixtures), /#k=/);
});

test("parser-error fixtures assert the fixed safe framework fields", async () => {
  const fixtures = JSON.parse(await readFile(new URL("./testdata/p2p/http.json", import.meta.url), "utf8"));
  const parserErrors = fixtures.cases.filter((entry) => entry.projection === "parser-error");
  assert.equal(parserErrors.length, 4);
  for (const fixture of parserErrors) {
    assert.deepEqual(Object.keys(fixture.errorContract).sort(), ["code", "error", "message", "statusCode"]);
    assert.equal(typeof fixture.errorContract.code, "string");
    assert.equal(typeof fixture.errorContract.message, "string");
  }
  const oversized = parserErrors.find((entry) => entry.name === "create-oversize-json");
  assert.ok(oversized);
  assert.equal(oversized.expectedStatus, 413);
  assert.equal(oversized.bodyGenerator.count, 1_048_576);
  assert.ok(oversized.bodyGenerator.count < 2 * 1024 * 1024);
});

test("unsolicited invalid or excessive WebSocket frames remain a sticky failure", async (t) => {
  const original = globalThis.WebSocket;
  let latest;
  class FakeSocket extends EventTarget {
    constructor() {
      super();
      latest = this;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    close() { this.dispatchEvent(new Event("close")); }
  }
  globalThis.WebSocket = FakeSocket;
  t.after(() => { globalThis.WebSocket = original; });
  const emit = (data) => latest.dispatchEvent(new MessageEvent("message", { data }));
  for (const invalid of [new Uint8Array([1]), "{", "x".repeat(128 * 1024 + 1)]) {
    const client = createSocketClient("ws://127.0.0.1:12345", "test", "invalid", Date.now() + 5_000);
    await client.open();
    emit(invalid);
    emit('{"type":"system"}');
    await assert.rejects(client.next(), /frame/);
    await assert.rejects(client.next(), /frame/);
    await client.dispose();
  }
  const client = createSocketClient("ws://127.0.0.1:12345", "test", "queue", Date.now() + 5_000);
  await client.open();
  for (let index = 0; index < 65; index += 1) emit("{}");
  await assert.rejects(client.next(), /queue exceeded/);
  await client.dispose();
});
