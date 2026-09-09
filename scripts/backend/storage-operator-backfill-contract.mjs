import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";
import {
  createWorkspaceObjectStore,
  workspaceContentObjectKey
} from "../../apps/web/server/services/workspace-object-store.mjs";
import { runWorkspaceStorageDedupe } from "../../apps/web/server/services/workspace-storage-dedupe.mjs";
import { resolveWorkspaceStoragePath } from "../../apps/web/server/services/workspace-storage.mjs";

const FIXTURE_PREFIX = "duallane-storage-backfill-contract-";
const RUN_ID = "storage-backfill-20260906";
const NOW = "2026-09-06T12:00:00.000Z";
const SHARED = Buffer.from("Node shared storage backfill fixture\n", "utf8");
const AVATAR = Buffer.from("Node avatar storage backfill fixture\n", "utf8");

const options = parseArgs(process.argv.slice(2));
const temporaryFixture = !options.fixtureDir;
const fixtureDir = options.fixtureDir
  ? await ensureFixtureDirectory(options.fixtureDir)
  : await mkdtemp(path.join(tmpdir(), FIXTURE_PREFIX));
const db = openTestDatabase(fixtureDir);
const store = await createWorkspaceObjectStore({
  dataDir: fixtureDir,
  env: { WORKSPACE_STORAGE_DRIVER: "local" }
});

try {
  await writeLegacyFixture(fixtureDir, "legacy/att-backfill", SHARED);
  await writeLegacyFixture(fixtureDir, "legacy/avatar-backfill", AVATAR);
  await writeLegacyFixture(fixtureDir, "legacy/emote-backfill", SHARED);
  seedDomainFixture(db);

  const first = await runWorkspaceStorageDedupe({
    db,
    store,
    dataDir: fixtureDir,
    runId: RUN_ID,
    mode: "backfill",
    now: () => new Date(NOW)
  });
  assertFirstReport(first);

  const sharedDigest = digest(SHARED);
  const avatarDigest = digest(AVATAR);
  const rows = db.prepare(`SELECT id, sha256, object_key AS objectKey, byte_size AS byteSize
    FROM workspace_storage_objects ORDER BY id`).all();
  assert(rows.length === 2, "Node backfill created an unexpected canonical object count");
  assert(rows.every((row) => row.id === `wso_${row.sha256}`), "Node canonical object id is not digest-derived");
  assert(rows.some((row) => row.sha256 === sharedDigest && row.objectKey === workspaceContentObjectKey(sharedDigest)), "shared digest was not persisted canonically");
  assert(rows.some((row) => row.sha256 === avatarDigest && row.objectKey === workspaceContentObjectKey(avatarDigest)), "avatar digest was not persisted canonically");

  const references = db.prepare(`SELECT id, storage_object_id AS storageObjectId
    FROM attachments WHERE id = 'att-storage-backfill'
    UNION ALL SELECT id, avatar_storage_object_id AS storageObjectId
    FROM users WHERE id = 'usr_storage_avatar'
    UNION ALL SELECT id, storage_object_id AS storageObjectId
    FROM workspace_custom_emotes WHERE id IN ('emote-storage-root', 'emote-storage-clone') ORDER BY id`).all();
  assert(references.length === 4 && references.every((row) => row.storageObjectId), "Node backfill did not bind every reference");
  assert(references.find((row) => row.id === "att-storage-backfill").storageObjectId === references.find((row) => row.id === "emote-storage-root").storageObjectId, "shared digest references diverged");
  assert(references.find((row) => row.id === "emote-storage-root").storageObjectId === references.find((row) => row.id === "emote-storage-clone").storageObjectId, "custom emote clone was not bound to its source");

  await assertLegacy(fixtureDir, "legacy/att-backfill", SHARED);
  await assertLegacy(fixtureDir, "legacy/avatar-backfill", AVATAR);
  await assertLegacy(fixtureDir, "legacy/emote-backfill", SHARED);
  await assertCanonicalBytes(store, sharedDigest, SHARED);
  await assertCanonicalBytes(store, avatarDigest, AVATAR);

  const replay = await runWorkspaceStorageDedupe({
    db,
    store,
    dataDir: fixtureDir,
    runId: `${RUN_ID}-replay`,
    mode: "backfill",
    now: () => new Date(NOW)
  });
  assert(replay.status === "completed" && replay.counts.created === 0 && replay.counts.reused === 3, "Node replay did not reuse all root objects");
  assert(replay.counts.processed === 4 && replay.counts.customEmotes === 2, "Node replay counts are incompatible");

  seedCycleFixture(db);
  let cycleError;
  try {
    await runWorkspaceStorageDedupe({
      db,
      store,
      dataDir: fixtureDir,
      runId: `${RUN_ID}-cycle`,
      mode: "backfill",
      now: () => new Date(NOW)
    });
  } catch (error) {
    cycleError = error;
  }
  assert(cycleError?.code === "storage.dedupe_unresolved_clone", "Node cycle did not use the stable unresolved-clone code");
  assert(cycleError?.record?.id === "emote-cycle-a", "Node cycle did not report the deterministic smallest id");

  const journalTables = db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('workspace_storage_operator_runs', 'workspace_storage_operator_items') ORDER BY name`).all();
  assert(journalTables.length === 2, "032 journal tables were not installed in SQLite fixture");
  process.stdout.write(`${JSON.stringify({
    status: "completed",
    runId: RUN_ID,
    nodeBackfill: first.counts,
    nodeReplay: replay.counts,
    cycleCode: cycleError.code,
    cycleRecord: cycleError.record,
    journalTables: journalTables.map((row) => row.name),
    canonicalObjects: rows.map((row) => ({ id: row.id, sha256: row.sha256, byteSize: row.byteSize }))
  }, null, 2)}\n`);
} finally {
  await Promise.allSettled([store.close?.(), db.close?.()]);
  if (temporaryFixture) await rm(fixtureDir, { recursive: true, force: true });
}

function seedDomainFixture(db) {
  db.prepare(`INSERT INTO users (
    id, github_id, github_login, email, display_name, avatar_url, kind, created_at,
    avatar_storage_key, avatar_version
  ) VALUES (?, NULL, ?, NULL, ?, NULL, 'human', ?, ?, ?)`)
    .run("usr_storage_avatar", "storage-avatar", "Storage Avatar", NOW, "legacy/avatar-backfill", "v1");
  db.prepare(`INSERT INTO attachments (
    id, space_id, uploader_id, conversation_id, visibility, status, file_name,
    mime_type, byte_size, storage_key, upload_transfer_id, created_at, completed_at
  ) VALUES (?, 'spc_default', 'usr_owner', NULL, 'space', 'available', ?, ?, ?, ?, NULL, ?, ?)`)
    .run("att-storage-backfill", "backfill.txt", "text/plain", SHARED.byteLength, "legacy/att-backfill", NOW, NOW);
  db.prepare(`INSERT INTO workspace_custom_emotes (
    id, user_id, source_type, source_attachment_id, source_custom_emote_id, source_emote_key,
    original_file_name, original_mime_type, label, normalized_mime_type, byte_size,
    width, height, frame_count, duration_ms, sha256, storage_key, sort_order, created_at
  ) VALUES (?, 'usr_owner', 'upload', NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 1, ?)`)
    .run("emote-storage-root", "shared.png", "image/png", "Shared", "image/png", SHARED.byteLength, digest(SHARED), "legacy/emote-backfill", NOW);
  db.prepare(`INSERT INTO workspace_custom_emotes (
    id, user_id, source_type, source_attachment_id, source_custom_emote_id, source_emote_key,
    original_file_name, original_mime_type, label, normalized_mime_type, byte_size,
    width, height, frame_count, duration_ms, sha256, storage_key, sort_order, created_at
  ) VALUES (?, 'usr_owner', 'custom', NULL, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 2, ?)`)
    .run("emote-storage-clone", "emote-storage-root", "Clone", "image/png", NOW);
}

function seedCycleFixture(db) {
  const cycleRows = [["emote-cycle-a", "emote-cycle-b", 10], ["emote-cycle-b", "emote-cycle-a", 11]];
  for (const [id, , order] of cycleRows) {
    db.prepare(`INSERT INTO workspace_custom_emotes (
      id, user_id, source_type, source_attachment_id, source_custom_emote_id, source_emote_key,
      original_file_name, original_mime_type, label, normalized_mime_type, byte_size,
      width, height, frame_count, duration_ms, sha256, storage_key, sort_order, created_at
    ) VALUES (?, 'usr_owner', 'custom', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`)
      .run(id, id, "image/png", order, NOW);
  }
  for (const [id, sourceID] of cycleRows) {
    db.prepare(`UPDATE workspace_custom_emotes SET source_custom_emote_id = ? WHERE id = ?`).run(sourceID, id);
  }
}

async function writeLegacyFixture(dataDir, storageKey, content) {
  const target = resolveWorkspaceStoragePath(dataDir, storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, { mode: 0o600, flag: "wx" });
}

async function assertLegacy(dataDir, storageKey, expected) {
  const actual = await readFile(resolveWorkspaceStoragePath(dataDir, storageKey));
  assert(actual.equals(expected), `legacy bytes changed for ${storageKey}`);
}

async function assertCanonicalBytes(store, sha256, expected) {
  const opened = await store.openObject({ sha256, byteSize: expected.byteLength });
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  assert(Buffer.concat(chunks).equals(expected), `canonical bytes mismatch for ${sha256}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertFirstReport(report) {
  assert(report.status === "completed", "Node storage backfill did not complete");
  assert(report.counts.total === 4 && report.counts.processed === 4, "Node storage backfill item counts are incompatible");
  assert(report.counts.created === 2 && report.counts.reused === 1, "Node storage backfill action counts are incompatible");
  assert(report.counts.attachments === 1 && report.counts.avatars === 1 && report.counts.customEmotes === 2, "Node storage backfill kind counts are incompatible");
  assert(report.counts.logicalBytes === (SHARED.byteLength * 3) + AVATAR.byteLength, "Node logical byte count changed");
  assert(report.counts.uniqueBytes === SHARED.byteLength + AVATAR.byteLength, "Node unique byte count changed");
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function ensureFixtureDirectory(value) {
  const resolved = path.resolve(value);
  if (!path.basename(resolved).startsWith(FIXTURE_PREFIX)) {
    throw new Error(`--fixture-dir must be a synthetic ${FIXTURE_PREFIX}* directory`);
  }
  await mkdir(resolved, { recursive: true });
  if ((await readdir(resolved)).length !== 0) throw new Error("--fixture-dir must be empty");
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
      process.stdout.write("node scripts/backend/storage-operator-backfill-contract.mjs [--fixture-dir <synthetic-dir>]\n");
      process.exit(0);
    }
    throw new Error("unknown storage backfill contract option");
  }
  return result;
}
