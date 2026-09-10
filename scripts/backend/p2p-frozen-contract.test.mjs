import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildChildEnvironment,
  compareObservations,
  createNormalizer,
  createSocketClient,
  loadFrozenObservations,
  parseArguments,
  safeFailureMessage
} from "./p2p-frozen-contract.mjs";

const observation = (value) => ({ http: [{ name: "synthetic", value }], websocket: [] });

test("comparison retains error fields, omission, array order, and values without exposing values", () => {
  const baseline = { status: 400, body: { error: "Bad Request", code: "BAD_JSON" } };
  assert.equal(compareObservations(observation(baseline), observation(baseline)).length, 0);
  for (const candidate of [
    { status: 400, body: { error: "Bad Request" } },
    { status: 400, body: { error: "Bad Request", code: null } },
    { status: 400, body: { error: "changed", code: "BAD_JSON" } },
    { status: 200, body: baseline.body }
  ]) assert.equal(compareObservations(observation(baseline), observation(candidate)).length, 1);
  assert.equal(compareObservations(observation([1, 2]), observation([2, 1])).length, 1);
  assert.equal(compareObservations(observation(null), { http: [], websocket: [] }).length, 1);
  assert.equal(compareObservations(observation({ a: 1, b: 2 }), observation({ b: 2, a: 1 })).length, 0);
  const mismatch = compareObservations(observation({ "synthetic-private-key": "synthetic-private-a" }), observation({ "synthetic-private-key": "synthetic-private-b" }));
  assert.doesNotMatch(mismatch.join("\n"), /synthetic-private/);
  assert.equal(safeFailureMessage(new Error("http://example.invalid/#k=synthetic")), "runner or transport error");
});

test("normalization preserves relationships and removes ephemeral localhost ports", () => {
  const normalizer = createNormalizer();
  const roomA = "A".repeat(22);
  const roomB = "B".repeat(22);
  assert.deepEqual(normalizer.normalize({ roomId: roomA, peerId: "peer-a" }), {
    roomId: "<room-1>", peerId: "<peer-1>"
  });
  assert.deepEqual(normalizer.normalize({ roomId: roomB, inviteLink: `http://127.0.0.1:43210/direct/${roomB}` }), {
    roomId: "<room-2>", inviteLink: "http://127.0.0.1:<port>/direct/%3Croom-2%3E"
  });
  assert.deepEqual(normalizer.normalize({ peers: [{ id: "peer-a" }, { id: "peer-b" }], expiresAt: "synthetic-time", appVersion: "candidate" }), {
    peers: [{ id: "<peer-1>" }, { id: "<peer-2>" }],
    expiresAt: "<timestamp>",
    appVersion: "<release-version>"
  });
});

test("child environment disables Workspace, credentials, and persistent P2P storage", () => {
  const environment = buildChildEnvironment({ baseUrl: "http://127.0.0.1:12345", port: 12345, dataDir: "/synthetic" });
  assert.equal(environment.WORKSPACE_ENABLED, "false");
  assert.equal(environment.DUALLANE_DATA_DIR, "/synthetic");
  for (const key of ["DATABASE_URL", "TEST_DATABASE_URL", "NODE_OPTIONS", "GITHUB_CLIENT_SECRET", "HTTP_PROXY"]) {
    assert.equal(Object.hasOwn(environment, key), false);
  }
  assert.equal(environment.DUALLANE_TURN_SHARED_SECRET, "");
  assert.equal(environment.DUALLANE_TURN_USERNAME, "synthetic-turn-user");
  assert.equal(environment.DUALLANE_TURN_CREDENTIAL, "synthetic-turn-credential");
});

test("CLI rejects remote or relative binaries without starting a server", () => {
  assert.throws(() => parseArguments(["--go-binary", "https://example.invalid/p2p"]), /local path/);
  assert.throws(() => parseArguments(["--go-binary", "relative-p2p"]), /absolute/);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./p2p-frozen-contract.mjs", import.meta.url)), "--unsupported"], {
    encoding: "utf8", timeout: 5_000, windowsHide: true
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage error/);
});

test("frozen Node observations have exact provenance, fixture coverage, and integrity", async () => {
  const frozen = await loadFrozenObservations();
  const http = JSON.parse(await readFile(new URL("./testdata/p2p/http.json", import.meta.url), "utf8"));
  assert.equal(http.cases.length, 21);
  assert.deepEqual(frozen.http.map((entry) => entry.name), http.cases.map((entry) => entry.name));
  assert.deepEqual(frozen.requiredObservationCounts, { http: 20, websocket: 19 });
  assert.deepEqual(frozen.observationCounts, { http: 21, websocket: 22 });
  assert.deepEqual(frozen.documentedExtras.http, ["health"]);
  assert.deepEqual(frozen.documentedExtras.websocket, ["leave-close", "room-full-close", "room-not-found-close"]);
  assert.equal(frozen.source.lastRegenerableCommit, "8d346a04317d0d3396293caca14ca1c65c7b5163");
  assert.equal(frozen.source.characterizationTree, "6ebc0f6858d67cf2be516d19ecf062c3ae75b505");
  assert.equal(frozen.source.regeneration, "disabled");
  assert.doesNotMatch(JSON.stringify(http), /#k=/);
  for (const [relative, expected] of Object.entries(frozen.fixtureSources)) {
    const content = (await readFile(new URL(`../../${relative}`, import.meta.url), "utf8")).replace(/\r\n?/g, "\n");
    assert.equal(createHash("sha256").update(content, "utf8").digest("hex"), expected, relative);
  }
  assert.equal(createHash("sha256").update(JSON.stringify({ http: frozen.http, websocket: frozen.websocket }), "utf8").digest("hex"), frozen.observationSha256);
  const source = await readFile(new URL("./p2p-frozen-contract.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /apps[\\/]web[\\/]server/);
  assert.doesNotMatch(source, /p2p-parity/);
});

test("parser-error fixtures retain the fixed safe framework contract", async () => {
  const fixtures = JSON.parse(await readFile(new URL("./testdata/p2p/http.json", import.meta.url), "utf8"));
  const parserErrors = fixtures.cases.filter((entry) => entry.projection === "parser-error");
  assert.equal(parserErrors.length, 4);
  for (const fixture of parserErrors) {
    assert.deepEqual(Object.keys(fixture.errorContract).sort(), ["code", "error", "message", "statusCode"]);
  }
  const oversized = parserErrors.find((entry) => entry.name === "create-oversize-json");
  assert.equal(oversized.expectedStatus, 413);
  assert.equal(oversized.bodyGenerator.count, 1_048_576);
});

test("invalid and excessive WebSocket frames remain a sticky failure", async (t) => {
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
