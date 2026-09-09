import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getCompletedDownload,
  getDownloadableAttachment,
  reserveDownload
} from "../../apps/web/server/services/workspace.mjs";
import {
  createWorkspaceObjectStore,
  workspaceAttachmentObjectKey
} from "../../apps/web/server/services/workspace-object-store.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";
import { resolveWorkspaceStoragePath } from "../../apps/web/server/services/workspace-storage.mjs";

const FIXTURE_PREFIX = "duallane-files-legacy-contract-";
const ATTACHMENT_ID = "att-files-legacy-contract";
const OWNER_ID = "usr_owner";
const FILE_NAME = "legacy report😀.txt";
const CONTENT = Buffer.from("Node legacy attachment bytes\n", "utf8");
const CREATED_AT = "2026-09-06T12:00:00.000Z";

const options = parseArguments(process.argv.slice(2));
try {
  const result = options.check
    ? await checkFixture(options.fixtureDir)
    : await createFixture(options.fixtureDir);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}

async function createFixture(requestedDirectory) {
  const fixtureDir = requestedDirectory
    ? await ensureEmptyFixtureDirectory(requestedDirectory)
    : await mkdtemp(path.join(tmpdir(), FIXTURE_PREFIX));
  const legacyStorageKey = `workspace/spc_default/${ATTACHMENT_ID}/legacy_report__.txt`;
  const deterministicStorageKey = workspaceAttachmentObjectKey({
    spaceId: "spc_default",
    id: ATTACHMENT_ID
  });
  const sourcePath = resolveWorkspaceStoragePath(fixtureDir, legacyStorageKey);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, CONTENT, { mode: 0o600 });

  const db = openTestDatabase(fixtureDir);
  const store = await createWorkspaceObjectStore({
    dataDir: fixtureDir,
    env: { WORKSPACE_STORAGE_DRIVER: "local" }
  });
  try {
    db.prepare(`INSERT INTO attachments (
      id, space_id, uploader_id, conversation_id, visibility, status, file_name,
      mime_type, byte_size, storage_key, upload_transfer_id, created_at, completed_at,
      storage_object_id
    ) VALUES (?, 'spc_default', ?, NULL, 'space', 'available', ?, 'text/plain', ?, ?, NULL, ?, ?, NULL)`)
      .run(ATTACHMENT_ID, OWNER_ID, FILE_NAME, CONTENT.byteLength, legacyStorageKey, CREATED_AT, CREATED_AT);

    const request = {
      id: "files-legacy-contract",
      ip: "127.0.0.1",
      headers: { "user-agent": "duallane-files-legacy-contract" }
    };
    const downloadable = await getDownloadableAttachment(db, request, OWNER_ID, ATTACHMENT_ID);
    assert.equal(downloadable.storageObjectId, null);
    assert.equal(downloadable.storageKey, legacyStorageKey);

    const reservation = await reserveDownload(db, request, {
      actorId: OWNER_ID,
      attachmentId: ATTACHMENT_ID
    });
    assert.equal(reservation.status, "completed");
    const completed = await getCompletedDownload(db, OWNER_ID, ATTACHMENT_ID, reservation.id);
    const delivery = await store.getAttachmentDelivery(completed.attachment);
    assert.equal(delivery.kind, "stream");
    const delivered = await readFile(delivery.path);
    assert.deepEqual(delivered, CONTENT);

    const row = db.prepare(`SELECT id, storage_key AS storageKey,
      storage_object_id AS storageObjectId, byte_size AS byteSize, mime_type AS mimeType,
      status FROM attachments WHERE id = ?`).get(ATTACHMENT_ID);
    assert.deepEqual(plainRecord(row), {
      id: ATTACHMENT_ID,
      storageKey: legacyStorageKey,
      storageObjectId: null,
      byteSize: CONTENT.byteLength,
      mimeType: "text/plain",
      status: "available"
    });
    const audit = db.prepare(`SELECT COUNT(*) AS count FROM audit_logs
      WHERE action = 'file.download.completed' AND target_id = ?`).get(ATTACHMENT_ID);
    assert.equal(Number(audit.count), 1);

    const manifest = {
      contractVersion: 1,
      source: "node.workspace.files.legacy-read",
      owner: "node",
      attachment: {
        id: ATTACHMENT_ID,
        spaceId: "spc_default",
        uploaderId: OWNER_ID,
        fileName: FILE_NAME,
        mimeType: "text/plain",
        byteSize: CONTENT.byteLength,
        status: "available",
        storageObjectId: null,
        legacyStorageKey,
        deterministicStorageKey
      },
      downloadTransferId: reservation.id,
      contentSha256: sha256(delivered)
    };
    const manifestPath = path.join(fixtureDir, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return {
      status: "completed",
      mode: "create",
      fixtureDir,
      manifestPath,
      legacyPath: sourcePath,
      legacyStorageKey,
      deterministicStorageKey,
      attachmentId: ATTACHMENT_ID,
      downloadTransferId: reservation.id,
      contentSha256: manifest.contentSha256
    };
  } finally {
    await Promise.allSettled([store.close?.(), db.close?.()]);
  }
}

async function checkFixture(requestedDirectory) {
  if (!requestedDirectory) {
    throw new Error("--check requires --fixture-dir <synthetic-dir>");
  }
  const fixtureDir = path.resolve(requestedDirectory);
  if (!path.basename(fixtureDir).startsWith(FIXTURE_PREFIX)) {
    throw new Error(`--fixture-dir must be a synthetic ${FIXTURE_PREFIX} directory`);
  }
  const manifestPath = path.join(fixtureDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.contractVersion, 1);
  assert.equal(manifest.source, "node.workspace.files.legacy-read");
  const db = openTestDatabase(fixtureDir);
  const store = await createWorkspaceObjectStore({
    dataDir: fixtureDir,
    env: { WORKSPACE_STORAGE_DRIVER: "local" }
  });
  try {
    const expected = manifest.attachment;
    const row = db.prepare(`SELECT id, space_id AS spaceId, uploader_id AS uploaderId,
      file_name AS fileName, mime_type AS mimeType, byte_size AS byteSize,
      storage_key AS storageKey, storage_object_id AS storageObjectId, status
      FROM attachments WHERE id = ?`).get(expected.id);
    assert.deepEqual(plainRecord(row), {
      id: expected.id,
      spaceId: expected.spaceId,
      uploaderId: expected.uploaderId,
      fileName: expected.fileName,
      mimeType: expected.mimeType,
      byteSize: expected.byteSize,
      storageKey: expected.legacyStorageKey,
      storageObjectId: null,
      status: "available"
    });

    const request = { id: "files-legacy-contract-check", ip: "127.0.0.1", headers: {} };
    const downloadable = await getDownloadableAttachment(db, request, OWNER_ID, expected.id);
    assert.equal(downloadable.storageObjectId, null);
    const completed = await getCompletedDownload(db, OWNER_ID, expected.id, manifest.downloadTransferId);
    const delivery = await store.getAttachmentDelivery(completed.attachment);
    assert.equal(delivery.kind, "stream");
    const delivered = await readFile(delivery.path);
    assert.equal(delivered.byteLength, expected.byteSize);
    assert.equal(sha256(delivered), manifest.contentSha256);
    assert.deepEqual(delivered, CONTENT);

    const sourceStat = await stat(resolveWorkspaceStoragePath(fixtureDir, expected.legacyStorageKey));
    assert.equal(sourceStat.isFile(), true);
    assert.equal(sourceStat.size, expected.byteSize);
    const audits = db.prepare(`SELECT COUNT(*) AS count FROM audit_logs
      WHERE action = 'file.download.completed' AND target_id = ?`).get(expected.id);
    assert.equal(Number(audits.count), 1);
    return {
      status: "completed",
      mode: "check",
      fixtureDir,
      manifestPath,
      attachmentId: expected.id,
      storageObjectId: row.storageObjectId,
      contentSha256: manifest.contentSha256,
      legacyRead: true,
      nodeAuthorization: true,
      nodeDownloadGrant: true,
      nodeAuditCount: Number(audits.count)
    };
  } finally {
    await Promise.allSettled([store.close?.(), db.close?.()]);
  }
}

async function ensureEmptyFixtureDirectory(value) {
  const fixtureDir = path.resolve(value);
  if (!path.basename(fixtureDir).startsWith(FIXTURE_PREFIX)) {
    throw new Error(`--fixture-dir must be a synthetic ${FIXTURE_PREFIX} directory`);
  }
  await mkdir(fixtureDir, { recursive: true });
  const entries = await readdir(fixtureDir);
  if (entries.length !== 0) {
    throw new Error("--fixture-dir must be empty when creating a fixture");
  }
  return fixtureDir;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function plainRecord(value) {
  return value === null || value === undefined ? value : { ...value };
}

function parseArguments(args) {
  const result = { check: false, fixtureDir: "" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      result.check = true;
      continue;
    }
    if (argument === "--fixture-dir") {
      result.fixtureDir = String(args[++index] ?? "").trim();
      if (!result.fixtureDir) throw new Error("--fixture-dir requires a value");
      continue;
    }
    if (argument === "--help") {
      process.stdout.write("node scripts/backend/workspace-files-legacy-contract.mjs [--check --fixture-dir <synthetic-dir>]\n");
      process.exit(0);
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return result;
}
