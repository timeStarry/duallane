import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { createApp } from "./index.mjs";
import { openTestDatabase } from "./services/test-database.mjs";

// Characterize the real raw-stream parser and route; a generic Fastify buffer
// parser has a different body-limit contract and is not an equivalent baseline.
it("keeps avatar stream overages in the domain error contract", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "duallane-avatar-contract-"));
  const db = openTestDatabase(dataDir);
  let app;
  try {
    app = await createApp({ dataDir, db, logger: false, env: {
      WORKSPACE_ENABLED: "true", NODE_ENV: "test", SERVE_STATIC: "false"
    } });
    let observedLength;
    app.addHook("preHandler", async (request) => {
      observedLength = request.headers["content-length"];
    });
    for (const fixture of [
      { name: "declared", body: Buffer.from("small"), length: String(5 * 1024 * 1024 + 1) },
      { name: "received", body: Readable.from([Buffer.alloc(5 * 1024 * 1024 + 1)]) }
    ]) {
      const response = await app.inject({
        method: "PUT", url: "/api/workspace/me/avatar",
        headers: {
          "content-type": "image/png", "x-workspace-user-id": "usr_owner",
          ...(fixture.length ? { "content-length": fixture.length } : { "transfer-encoding": "chunked" })
        }, payload: fixture.body
      });
      expect({ status: response.statusCode, body: response.json() }, fixture.name).toEqual({
        status: 400,
        body: { error: { code: "avatar.invalid_size", message: "头像文件大小应在 5 MiB 以内" } }
      });
      expect(observedLength, fixture.name).toBe(fixture.length);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_storage_objects").get().count).toBe(0);
  } finally {
    await app?.close();
    db.close();
    // This unique synthetic fixture is the only directory owned by the test.
    await rm(dataDir, { recursive: true, force: true });
  }
});
