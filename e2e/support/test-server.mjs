import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../apps/web/server/index.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";

const host = "127.0.0.1";
const port = Number(process.env.E2E_API_PORT || 8787);
const frontendPort = Number(process.env.E2E_WEB_PORT || 5173);
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
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
    WORKSPACE_NTFY_WORKER_ENABLED: "false",
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
