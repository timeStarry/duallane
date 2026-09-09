import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createWorkspaceObjectStore,
  workspaceContentObjectKey
} from "../../apps/web/server/services/workspace-object-store.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";
import { runWorkspaceStorageDedupe } from "../../apps/web/server/services/workspace-storage-dedupe.mjs";
import { resolveWorkspaceStoragePath } from "../../apps/web/server/services/workspace-storage.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(SCRIPT_DIR, "../../apps/web/server/migrations");
const RUN_ID = "storage-contract-20260906";
const CONTENT = Buffer.from("Node storage operator contract bytes\n", "utf8");
const LEGACY_KEY = "workspace/spc_default/att-storage-contract/contract.bin";

const options = parseArgs(process.argv.slice(2));
const fixtureDir = options.fixtureDir
  ? await ensureFixtureDirectory(options.fixtureDir)
  : await mkdtemp(path.join(tmpdir(), "duallane-storage-contract-"));
const objectRoot = path.join(fixtureDir, "workspace-files");
const manifestPath = path.join(fixtureDir, "manifest.json");
const db = openTestDatabase(fixtureDir);
const store = await createWorkspaceObjectStore({
  dataDir: fixtureDir,
  env: { WORKSPACE_STORAGE_DRIVER: "local" }
});

try {
  const sourcePath = resolveWorkspaceStoragePath(fixtureDir, LEGACY_KEY);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, CONTENT, { mode: 0o600 });
  const now = "2026-09-06T12:00:00.000Z";
  db.prepare(`INSERT INTO attachments (
    id, space_id, uploader_id, conversation_id, visibility, status, file_name,
    mime_type, byte_size, storage_key, upload_transfer_id, created_at, completed_at
  ) VALUES (?, 'spc_default', 'usr_owner', NULL, 'space', 'available', ?,
    'application/octet-stream', ?, ?, NULL, ?, ?)`)
    .run("att-storage-contract", "contract.bin", CONTENT.byteLength, LEGACY_KEY, now, now);

  const backfill = await runWorkspaceStorageDedupe({
    db,
    store,
    dataDir: fixtureDir,
    runId: RUN_ID,
    mode: "backfill"
  });
  const verify = await runWorkspaceStorageDedupe({
    db,
    store,
    dataDir: fixtureDir,
    runId: RUN_ID,
    mode: "verify"
  });
  if (backfill.status !== "completed" || verify.status !== "completed") {
    throw new Error("Node storage contract fixture did not complete");
  }

  const digest = createHash("sha256").update(CONTENT).digest("hex");
  const object = db.prepare(`SELECT id, sha256, object_key AS objectKey,
    byte_size AS byteSize, deleted_at AS deletedAt
    FROM workspace_storage_objects WHERE id = ?`).get(`wso_${digest}`);
  const resource = db.prepare(`SELECT id, space_id AS spaceId,
    uploader_id AS ownerId, storage_object_id AS storageObjectId,
    byte_size AS byteSize FROM attachments WHERE id = ?`).get("att-storage-contract");
  if (!object || !resource || object.objectKey !== workspaceContentObjectKey(digest)) {
    throw new Error("Node storage contract fixture did not bind canonical object");
  }

  const schema = (await readdir(MIGRATIONS_DIR))
    .filter((name) => /^\d+.*\.sql$/.test(name) && name !== "030_workspace_event_notifications.sql")
    .sort();
  const manifest = {
    contractVersion: 1,
    runId: RUN_ID,
    schema: { expected: schema, applied: schema },
    owner: { current: "node", fenced: false, admissionDrained: false },
    backup: {
      id: "backup-storage-contract",
      sha256: createHash("sha256").update("synthetic-storage-backup").digest("hex"),
      verified: true,
      retainUntil: "2099-01-01T00:00:00Z"
    },
    quotas: [{
      subjectId: "usr_owner",
      day: "2026-09-06",
      limitBytes: 2 * 1024 * 1024 * 1024,
      usedBytes: 0,
      reservedBytes: 0
    }],
    resources: [{
      kind: "attachment",
      id: resource.id,
      spaceId: resource.spaceId,
      ownerId: resource.ownerId,
      storageObjectId: resource.storageObjectId,
      byteSize: resource.byteSize,
      legacyStorageKey: LEGACY_KEY
    }],
    objects: [{
      id: object.id,
      sha256: object.sha256,
      objectKey: object.objectKey,
      byteSize: object.byteSize,
      referenceCount: 1,
      deleted: object.deletedAt !== null
    }]
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    status: "completed",
    runId: RUN_ID,
    fixtureDir,
    manifestPath,
    objectRoot,
    nodeBackfill: backfill.counts,
    nodeVerify: verify.counts
  }, null, 2)}\n`);
} finally {
  await Promise.allSettled([store.close?.(), db.close?.()]);
}

async function ensureFixtureDirectory(value) {
  const resolved = path.resolve(value);
  if (!path.basename(resolved).startsWith("duallane-storage-contract-")) {
    throw new Error("--fixture-dir must be a synthetic duallane-storage-contract-* directory");
  }
  await mkdir(resolved, { recursive: true });
  if ((await readdir(resolved)).length !== 0) {
    throw new Error("--fixture-dir must be empty");
  }
  return resolved;
}

function parseArgs(args) {
  const result = { fixtureDir: "" };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--fixture-dir") {
      result.fixtureDir = String(args[++index] ?? "").trim();
      if (!result.fixtureDir) throw new Error("--fixture-dir requires a value");
      continue;
    }
    if (args[index] === "--help") {
      process.stdout.write("node scripts/backend/storage-operator-contract.mjs [--fixture-dir <synthetic-dir>]\n");
      process.exit(0);
    }
    throw new Error("unknown storage contract option");
  }
  return result;
}
