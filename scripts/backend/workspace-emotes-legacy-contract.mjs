import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";
import { createWorkspaceCustomEmoteService } from "../../apps/web/server/services/workspace-custom-emotes.mjs";
import { createWorkspaceObjectStore } from "../../apps/web/server/services/workspace-object-store.mjs";
import { createWorkspaceStorageObjectRegistry } from "../../apps/web/server/services/workspace-storage-objects.mjs";
import { resolveWorkspaceStoragePath } from "../../apps/web/server/services/workspace-storage.mjs";

const FIXTURE_PREFIX = "duallane-emotes-legacy-contract-";
const OWNER_ID = "usr_owner";
const DENIED_ID = "usr_legacy_denied";
const NOW = "2026-09-07T12:00:00.000Z";
const TOMBSTONE_AT = "2026-09-07T12:01:00.000Z";
const SOURCE = "node.workspace.custom-emotes.legacy-read";

const options = parseArguments(process.argv.slice(2));
const temporaryFixture = !options.fixtureDir;
let fixtureDir;

try {
  fixtureDir = options.fixtureDir
    ? await prepareFixtureDirectory(options.fixtureDir, options.check)
    : await mkdtemp(path.join(await realpath(tmpdir()), FIXTURE_PREFIX));
  const result = options.check
    ? await checkFixture(fixtureDir)
    : await createFixture(fixtureDir);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryFixture && fixtureDir) await removeOwnedFixture(fixtureDir);
}

async function createFixture(dataDir) {
  const runtime = await openRuntime(dataDir);
  try {
    seedHuman(runtime.db, DENIED_ID, "legacy-denied");

    const primaryUpload = await uploadSynthetic(runtime.service, "legacy-root.webp", [32, 128, 224]);
    const primary = await makeLegacyOnly(runtime, primaryUpload.id);
    const cloneOne = await insertLegacyClone(runtime.db, "legacy-clone-one", primary.row.id, 1);
    const cloneTwo = await insertLegacyClone(runtime.db, "legacy-clone-two", cloneOne.id, 2);

    const fallbackUpload = await uploadSynthetic(runtime.service, "canonical-missing.webp", [220, 80, 32]);
    const canonicalMissing = await makeLegacyFallback(runtime, fallbackUpload.id);

    const privateUpload = await uploadSynthetic(runtime.service, "private-legacy.webp", [80, 32, 220]);
    const privateLegacy = await makeLegacyOnly(runtime, privateUpload.id);

    const tombstoneUpload = await uploadSynthetic(runtime.service, "tombstone.webp", [220, 32, 160]);
    const tombstone = await makeTombstone(runtime, tombstoneUpload.id);
    const malformed = await insertMalformed(runtime.db);

    const manifest = {
      contractVersion: 1,
      source: SOURCE,
      synthetic: true,
      content: {
        sha256: primary.sha256,
        byteSize: primary.byteSize,
        contentType: "image/webp"
      },
      records: [
        manifestRecord(primary.row),
        manifestRecord(cloneOne),
        manifestRecord(cloneTwo),
        manifestRecord(canonicalMissing.row, canonicalMissing.canonicalObjectKey),
        manifestRecord(privateLegacy.row),
        manifestRecord(tombstone.row),
        manifestRecord(malformed)
      ],
      cases: [
        {
          name: "legacy-clone-chain",
          actorId: OWNER_ID,
          recordIds: [primary.row.id, cloneOne.id, cloneTwo.id],
          expected: { outcome: "read", sha256: primary.sha256, byteSize: primary.byteSize }
        },
        {
          name: "canonical-missing-fallback",
          actorId: OWNER_ID,
          recordIds: [canonicalMissing.row.id],
          expected: { outcome: "read", sha256: canonicalMissing.sha256, byteSize: canonicalMissing.byteSize }
        },
        {
          name: "tombstone",
          actorId: OWNER_ID,
          recordIds: [tombstone.row.id],
          expected: { outcome: "reject", code: "emote.not_found", statusCode: 404 }
        },
        {
          name: "malformed",
          actorId: OWNER_ID,
          recordIds: [malformed.id],
          expected: { outcome: "reject", code: "file.invalid_storage_key", statusCode: 500 }
        },
        {
          name: "permission",
          actorId: DENIED_ID,
          recordIds: [privateLegacy.row.id],
          expected: { outcome: "reject", code: "permission.denied", statusCode: 403 }
        }
      ]
    };

    await verifyFixture(runtime, dataDir, manifest);
    const manifestPath = path.join(dataDir, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return summarize(manifest, dataDir, manifestPath, "create");
  } finally {
    await closeRuntime(runtime);
  }
}

async function checkFixture(dataDir) {
  const manifestPath = path.join(dataDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const runtime = await openRuntime(dataDir);
  try {
    await verifyFixture(runtime, dataDir, manifest);
    return summarize(manifest, dataDir, manifestPath, "check");
  } finally {
    await closeRuntime(runtime);
  }
}

async function verifyFixture(runtime, dataDir, manifest) {
  assert.equal(manifest.contractVersion, 1);
  assert.equal(manifest.source, SOURCE);
  assert.equal(manifest.synthetic, true);
  assert.ok(manifest.content?.sha256?.match(/^[a-f0-9]{64}$/));
  assert.ok(Number.isSafeInteger(manifest.content.byteSize) && manifest.content.byteSize > 0);
  assert.equal(manifest.content.contentType, "image/webp");
  assert.ok(Array.isArray(manifest.records) && manifest.records.length >= 7);
  assert.ok(Array.isArray(manifest.cases) && manifest.cases.length === 5);

  const serialized = JSON.stringify(manifest);
  for (const forbidden of ["contentBytes", "rawContent", "password", "secretKey", "credentials"]) {
    assert.equal(serialized.includes(forbidden), false, `manifest contains forbidden field ${forbidden}`);
  }

  const rowsById = new Map();
  for (const record of manifest.records) {
    assert.match(record.id, /^[a-z0-9_-]+$/);
    assert.equal(rowsById.has(record.id), false, `duplicate manifest record ${record.id}`);
    const row = readEmoteRow(runtime.db, record.id);
    assert.ok(row, `missing emote row ${record.id}`);
    assert.deepEqual(manifestRecord(row), withoutCanonicalObjectKey(record));
    rowsById.set(record.id, row);
  }

  const primaryCase = requireCase(manifest, "legacy-clone-chain");
  for (const id of primaryCase.recordIds) {
    const bytes = await readNodeContent(runtime.service, primaryCase.actorId, id);
    assertContent(bytes, primaryCase.expected, `clone ${id}`);
  }
  assert.equal(rowsById.get(primaryCase.recordIds[1]).sourceCustomEmoteId, primaryCase.recordIds[0]);
  assert.equal(rowsById.get(primaryCase.recordIds[2]).sourceCustomEmoteId, primaryCase.recordIds[1]);

  const fallbackCase = requireCase(manifest, "canonical-missing-fallback");
  const fallbackRecord = manifest.records.find((record) => record.id === fallbackCase.recordIds[0]);
  assert.ok(fallbackRecord?.storageObjectId?.startsWith("wso_"));
  assert.match(fallbackRecord.canonicalObjectKey ?? "", /^workspace\/objects\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/);
  await assertMissing(dataDir, fallbackRecord.canonicalObjectKey);
  const fallbackBytes = await readNodeContent(runtime.service, fallbackCase.actorId, fallbackRecord.id);
  assertContent(fallbackBytes, fallbackCase.expected, "canonical-missing fallback");

  const tombstoneCase = requireCase(manifest, "tombstone");
  await assertNodeRejection(runtime.service, tombstoneCase, "tombstone");
  assert.ok(rowsById.get(tombstoneCase.recordIds[0]).removedAt);

  const malformedCase = requireCase(manifest, "malformed");
  await assertNodeRejection(runtime.service, malformedCase, "malformed storage key");

  const permissionCase = requireCase(manifest, "permission");
  await assertNodeRejection(runtime.service, permissionCase, "private emote permission");

  const primaryRecord = manifest.records.find((record) => record.id === primaryCase.recordIds[0]);
  assert.match(primaryRecord.storageKey ?? "", /^custom-emotes\/usr_owner\/[a-z0-9_-]+\/content\.webp$/);
  assert.equal(primaryRecord.storageObjectId, null);
  assert.equal(primaryRecord.metadata.originalFileName, "legacy-root.webp");
  for (const id of primaryCase.recordIds.slice(1)) {
    const record = manifest.records.find((candidate) => candidate.id === id);
    assert.equal(record.storageKey, null);
    assert.equal(record.storageObjectId, null);
    assert.equal(record.byteSize, null);
    assert.equal(record.sha256, null);
    assert.equal(record.metadata.originalFileName, null);
    assert.equal(record.metadata.originalMimeType, null);
    assert.equal(record.metadata.normalizedMimeType, null);
  }
}

async function openRuntime(dataDir) {
  const db = openTestDatabase(dataDir);
  const objectStore = await createWorkspaceObjectStore({
    dataDir,
    env: { WORKSPACE_STORAGE_DRIVER: "local" }
  });
  const storageObjects = createWorkspaceStorageObjectRegistry({ db, objectStore });
  const service = createWorkspaceCustomEmoteService({ db, objectStore, storageObjects });
  return { dataDir, db, objectStore, storageObjects, service };
}

async function closeRuntime(runtime) {
  await Promise.allSettled([runtime.objectStore.close?.(), runtime.db.close?.()]);
}

async function uploadSynthetic(service, fileName, color) {
  return await service.upload({
    actorId: OWNER_ID,
    stream: Readable.from(createOnePixelBmp(color)),
    contentType: "image/bmp",
    fileName
  });
}

async function makeLegacyOnly(runtime, emoteId) {
  return await makeLegacy(runtime, emoteId, false);
}

async function makeLegacyFallback(runtime, emoteId) {
  return await makeLegacy(runtime, emoteId, true);
}

async function makeLegacy(runtime, emoteId, preserveObjectReference) {
  const row = readEmoteRow(runtime.db, emoteId);
  assert.ok(row?.storageObjectId, `uploaded emote ${emoteId} has no canonical reference`);
  const object = await runtime.storageObjects.loadObjectById(row.storageObjectId);
  const actualCanonicalPath = resolveWorkspaceStoragePath(runtime.dataDir, object.objectKey);
  const bytes = await readFile(actualCanonicalPath);
  assert.equal(bytes.byteLength, Number(row.byteSize));
  assert.equal(sha256(bytes), row.sha256);
  const storageKey = `custom-emotes/${row.userId}/${row.id}/content.webp`;
  await writeLegacy(runtime.dataDir, storageKey, bytes);
  if (preserveObjectReference) {
    await runtime.db.prepare("UPDATE workspace_custom_emotes SET storage_key = ? WHERE id = ?").run(storageKey, row.id);
  } else {
    await runtime.db.prepare("UPDATE workspace_custom_emotes SET storage_key = ?, storage_object_id = NULL WHERE id = ?")
      .run(storageKey, row.id);
  }
  // Delete only the synthetic canonical file. Keep the registry row for the
  // fallback case so Node must observe a missing canonical object.
  await runtime.objectStore.deleteObject(object);
  const updated = readEmoteRow(runtime.db, row.id);
  return {
    row: updated,
    bytes,
    byteSize: bytes.byteLength,
    sha256: sha256(bytes),
    canonicalObjectKey: object.objectKey,
    legacyStorageKey: storageKey,
    preserveObjectReference
  };
}

async function makeTombstone(runtime, emoteId) {
  const row = readEmoteRow(runtime.db, emoteId);
  assert.ok(row?.storageObjectId, `tombstone emote ${emoteId} has no canonical reference`);
  const object = await runtime.storageObjects.loadObjectById(row.storageObjectId);
  await runtime.objectStore.deleteObject(object);
  await runtime.db.prepare(`
    UPDATE workspace_custom_emotes
    SET removed_at = ?, storage_key = NULL, storage_object_id = NULL
    WHERE id = ?
  `).run(TOMBSTONE_AT, row.id);
  return { row: readEmoteRow(runtime.db, row.id), byteSize: row.byteSize, sha256: row.sha256 };
}

async function insertLegacyClone(db, id, sourceCustomEmoteId, sortOrder) {
  await db.prepare(`
    INSERT INTO workspace_custom_emotes (
      id, user_id, source_type, source_attachment_id, source_custom_emote_id, source_emote_key,
      original_file_name, original_mime_type, label, normalized_mime_type, byte_size,
      width, height, frame_count, duration_ms, sha256, storage_key, storage_object_id,
      sort_order, created_at, removed_at
    ) VALUES (?, ?, 'custom', NULL, ?, NULL, NULL, NULL, ?, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)
  `).run(id, OWNER_ID, sourceCustomEmoteId, `Legacy clone ${sortOrder}`, sortOrder, NOW);
  return readEmoteRow(db, id);
}

async function insertMalformed(db) {
  const id = "legacy-malformed-emote";
  await db.prepare(`
    INSERT INTO workspace_custom_emotes (
      id, user_id, source_type, source_attachment_id, source_custom_emote_id, source_emote_key,
      original_file_name, original_mime_type, label, normalized_mime_type, byte_size,
      width, height, frame_count, duration_ms, sha256, storage_key, storage_object_id,
      sort_order, created_at, removed_at
    ) VALUES (?, ?, 'upload', NULL, NULL, NULL, NULL, NULL, ?, 'image/webp', 1,
      NULL, NULL, NULL, NULL, ?, ?, NULL, 99, ?, NULL)
  `).run(id, OWNER_ID, "Malformed legacy emote", "0".repeat(64), "../escape.webp", NOW);
  return readEmoteRow(db, id);
}

function readEmoteRow(db, id) {
  return db.prepare(`
    SELECT id, user_id AS userId, source_type AS sourceType,
      source_custom_emote_id AS sourceCustomEmoteId,
      original_file_name AS originalFileName, original_mime_type AS originalMimeType,
      label, normalized_mime_type AS normalizedMimeType, byte_size AS byteSize,
      width, height, frame_count AS frameCount, duration_ms AS durationMs,
      sha256, storage_key AS storageKey, storage_object_id AS storageObjectId,
      removed_at AS removedAt
    FROM workspace_custom_emotes WHERE id = ?
  `).get(id);
}

function manifestRecord(row, canonicalObjectKey) {
  const record = {
    id: row.id,
    ownerId: row.userId,
    sourceType: row.sourceType,
    sourceCustomEmoteId: row.sourceCustomEmoteId ?? null,
    storageKey: row.storageKey ?? null,
    storageObjectId: row.storageObjectId ?? null,
    byteSize: numberOrNull(row.byteSize),
    sha256: row.sha256 ?? null,
    metadata: {
      originalFileName: row.originalFileName ?? null,
      originalMimeType: row.originalMimeType ?? null,
      normalizedMimeType: row.normalizedMimeType ?? null,
      width: numberOrNull(row.width),
      height: numberOrNull(row.height),
      frameCount: numberOrNull(row.frameCount),
      durationMs: numberOrNull(row.durationMs)
    },
    removed: Boolean(row.removedAt)
  };
  if (canonicalObjectKey) record.canonicalObjectKey = canonicalObjectKey;
  return record;
}

function withoutCanonicalObjectKey(record) {
  const { canonicalObjectKey: _canonicalObjectKey, ...withoutKey } = record;
  return withoutKey;
}

async function readNodeContent(service, actorId, emoteId) {
  const delivery = await service.getDelivery(actorId, emoteId);
  if (delivery.kind === "buffer") return Buffer.from(delivery.buffer);
  if (delivery.kind === "stream") return await readFile(delivery.path);
  throw new Error(`unsupported Node custom-emote delivery kind ${delivery.kind}`);
}

async function assertNodeRejection(service, scenario, description) {
  const [emoteId] = scenario.recordIds;
  const { outcome: _outcome, ...expectedError } = scenario.expected;
  let observed;
  try {
    await service.getDelivery(scenario.actorId, emoteId);
  } catch (error) {
    observed = { code: error?.code, statusCode: error?.statusCode };
  }
  assert.deepEqual(observed, expectedError, `${description} did not preserve Node rejection`);
}

function assertContent(bytes, expected, description) {
  assert.equal(expected.outcome, "read");
  assert.equal(bytes.byteLength, expected.byteSize, `${description} size changed`);
  assert.equal(sha256(bytes), expected.sha256, `${description} digest changed`);
}

async function assertMissing(dataDir, storageKey) {
  await assert.rejects(
    stat(resolveWorkspaceStoragePath(dataDir, storageKey)),
    (error) => error?.code === "ENOENT"
  );
}

function requireCase(manifest, name) {
  const scenario = manifest.cases.find((candidate) => candidate.name === name);
  assert.ok(scenario, `missing manifest case ${name}`);
  return scenario;
}

function summarize(manifest, dataDir, manifestPath, mode) {
  return {
    status: "completed",
    mode,
    source: manifest.source,
    contractVersion: manifest.contractVersion,
    recordCount: manifest.records.length,
    caseCount: manifest.cases.length,
    fixtureDir: dataDir,
    manifestPath,
    manifest
  };
}

async function writeLegacy(dataDir, storageKey, bytes) {
  const target = resolveWorkspaceStoragePath(dataDir, storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
}

function seedHuman(db, id, login) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, github_id, github_login, email, display_name, nickname, avatar_url, kind, created_at, last_login_at)
    VALUES (?, NULL, ?, NULL, ?, ?, NULL, 'human', ?, NULL)
  `).run(id, login, login, login, now);
  db.prepare(`
    INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
    VALUES ('spc_default', ?, 'member', ?, NULL)
  `).run(id, now);
}

function createOnePixelBmp([red, green, blue]) {
  const buffer = Buffer.alloc(58);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(1, 18);
  buffer.writeInt32LE(1, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(4, 34);
  buffer.set([blue, green, red, 0], 54);
  return buffer;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

async function prepareFixtureDirectory(value, check) {
  const resolved = path.resolve(value);
  assert.ok(path.basename(resolved).startsWith(FIXTURE_PREFIX), `fixture directory must start with ${FIXTURE_PREFIX}`);
  await mkdir(resolved, { recursive: true });
  if (!check && (await readdir(resolved)).length !== 0) {
    throw new Error("fixture directory must be empty when creating a Node emote legacy fixture");
  }
  return resolved;
}

async function removeOwnedFixture(value) {
  const resolved = await realpath(value);
  const parent = await realpath(path.dirname(resolved));
  const tempRoot = await realpath(tmpdir());
  assert.equal(parent, tempRoot);
  assert.ok(path.basename(resolved).startsWith(FIXTURE_PREFIX));
  await rm(resolved, { recursive: true, force: false });
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
      process.stdout.write("node scripts/backend/workspace-emotes-legacy-contract.mjs [--check --fixture-dir <synthetic-dir>]\n");
      process.exit(0);
    }
    throw new Error(`unknown option: ${argument}`);
  }
  if (result.check && !result.fixtureDir) throw new Error("--check requires --fixture-dir <synthetic-dir>");
  return result;
}
