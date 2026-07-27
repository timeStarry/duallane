import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../apps/web/server/index.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";

const host = "127.0.0.1";
const port = 8787;
const frontendUrl = "http://127.0.0.1:5173";
const dataDir = await mkdtemp(path.join(tmpdir(), "duallane-e2e-"));
const db = openTestDatabase(dataDir);

const app = await createApp({
  dataDir,
  db,
  env: {
    WORKSPACE_ENABLED: "true",
    NODE_ENV: "test",
    SERVE_STATIC: "false",
    PUBLIC_BASE_URL: frontendUrl,
    WORKSPACE_FRONTEND_URL: frontendUrl,
    SESSION_SECRET: "duallane-e2e-session-secret"
  },
  logger: false
});

app.addHook("onClose", async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

let closing = false;
async function close() {
  if (closing) {
    return;
  }
  closing = true;
  await app.close();
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

await app.listen({ host, port });
