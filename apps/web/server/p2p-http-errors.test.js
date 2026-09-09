import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./index.mjs";

describe("active P2P JSON parser compatibility", () => {
  let app;
  let dataDir;
  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "duallane-p2p-errors-"));
    app = await createApp({
      dataDir, logger: false,
      env: { NODE_ENV: "test", WORKSPACE_ENABLED: "false", SERVE_STATIC: "false" }
    });
  });
  afterAll(async () => {
    await app?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it.each([
    ["empty", "", 400, "FST_ERR_CTP_EMPTY_JSON_BODY", "Body cannot be empty when content-type is set to 'application/json'"],
    ["whitespace", " \n", 400, "FST_ERR_CTP_INVALID_JSON_BODY", "Body is not valid JSON but content-type is set to 'application/json'"],
    ["invalid", '{"private":"synthetic-sensitive-marker",', 400, "FST_ERR_CTP_INVALID_JSON_BODY", "Body is not valid JSON but content-type is set to 'application/json'"],
    ["trailing", '{"maxPeers":2}{}', 400, "FST_ERR_CTP_INVALID_JSON_BODY", "Body is not valid JSON but content-type is set to 'application/json'"],
    ["oversize", JSON.stringify({ maxPeers: 2, padding: "x".repeat(1024 * 1024) }), 413, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large"]
  ])("returns the complete content-free object for %s", async (_name, payload, statusCode, code, message) => {
    const response = await app.inject({ method: "POST", url: "/api/p2p/rooms", headers: { "content-type": "application/json" }, payload });
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ statusCode, code, error: statusCode === 413 ? "Payload Too Large" : "Bad Request", message });
    expect(response.body).not.toContain("synthetic-sensitive-marker");
  });
});
