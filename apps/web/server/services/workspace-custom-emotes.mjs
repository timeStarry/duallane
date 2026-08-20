import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { getReactionEmote, listVisibleEmotePacks } from "./emote-catalog.mjs";
import { DEFAULT_SPACE_ID } from "./db.mjs";
import {
  WorkspaceError,
  WorkspacePermissionError,
  WorkspaceValidationError,
  writeWorkspaceEvent
} from "./workspace.mjs";

export const CUSTOM_EMOTE_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const CUSTOM_EMOTE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const CUSTOM_EMOTE_MAX_ITEMS = null;
export const CUSTOM_EMOTE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const CUSTOM_EMOTE_MAX_COLLECTIONS = null;
export const CUSTOM_EMOTE_MAX_COLLECTION_ITEMS = 100;
export const CUSTOM_EMOTE_MAX_BATCH_ITEMS = 50;
const CUSTOM_EMOTE_MAX_DIMENSION = 4096;
const CUSTOM_EMOTE_MAX_PIXELS = 40 * 1024 * 1024;
const CUSTOM_EMOTE_MAX_FRAMES = 180;
const CUSTOM_EMOTE_MAX_DURATION_MS = 30000;
const SUPPORTED_FORMATS = new Set(["jpeg", "png", "webp", "gif", "bmp"]);
const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"]);

export function createWorkspaceCustomEmoteService({ db, objectStore, storageObjects, now = () => new Date() }) {
  if (!storageObjects) throw new TypeError("Workspace custom emotes require a storage object registry");
  const userLocks = new Map();

  const withUserLock = async (userId, operation) => {
    const previous = userLocks.get(userId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    userLocks.set(userId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (userLocks.get(userId) === queued) userLocks.delete(userId);
    }
  };

  const cleanupRetiredEmotes = async (rows) => {
    const unique = new Map(rows.filter(Boolean).map((row) => [row.id, row]));
    for (const row of unique.values()) {
      await cleanupUnreferencedEmote(db, objectStore, storageObjects, row);
    }
  };

  const storeProcessed = async ({ actorId, input, source, collectionId = "", addToLibrary = true }) => {
    const actor = await requireHumanActor(db, actorId);
    const normalizedSource = { ...source, fileName: normalizeFileName(source.fileName) };
    const processed = await normalizeCustomEmote(input, normalizedSource);
    const result = await withUserLock(actor.id, async () => {
      const id = randomUUID();
      const canonical = {
        sha256: processed.sha256,
        byteSize: processed.byteSize,
        contentType: "image/webp"
      };
      const staged = await storageObjects.acquireObject({
        ...canonical,
        stream: Readable.from(processed.buffer)
      });
      try {
        return await db.transaction(async () => {
          await db.lock(`duallane:emote-library:${actor.id}`);
          const duplicate = await findReusableLocalEmote(db, actor.id, "sha256", processed.sha256);
          if (duplicate) {
            await db.prepare("UPDATE workspace_custom_emotes SET removed_at = NULL WHERE id = ?").run(duplicate.id);
            await ensureEmotePlacement(db, actor.id, duplicate.id, { collectionId, addToLibrary, now: now() });
            await storageObjects.acquireAndBind({
              kind: "customEmote",
              resourceId: duplicate.id,
              ...canonical,
              stream: Readable.from(processed.buffer),
              cleanupPrevious: false
            });
            await syncSubscribersForSourceInTransaction(db, collectionId, now);
            return publicCustomEmote(await getOwnEmoteRow(db, actor.id, duplicate.id));
          }
          await assertLocalCapacity(db, actor.id, processed.byteSize);
          const orderRow = await db.prepare(`
            SELECT COALESCE(MIN(sort_order), 0) - 1 AS nextOrder
            FROM workspace_custom_emotes WHERE user_id = ?
          `).get(actor.id);
          await db.prepare(`
            INSERT INTO workspace_custom_emotes (
              id, user_id, source_type, source_attachment_id, source_custom_emote_id,
              source_emote_key, original_file_name, original_mime_type, label,
              normalized_mime_type, byte_size, width, height, frame_count, duration_ms,
              sha256, storage_key, storage_object_id, sort_order, created_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'image/webp', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
          `).run(
            id,
            actor.id,
            normalizedSource.type,
            normalizedSource.attachmentId ?? null,
            normalizedSource.customEmoteId ?? null,
            normalizedSource.fileName,
            processed.detectedMimeType,
            processed.label,
            processed.byteSize,
            processed.width,
            processed.height,
            processed.frameCount,
            processed.durationMs,
            processed.sha256,
            orderRow.nextOrder,
            now().toISOString()
          );
          await ensureEmotePlacement(db, actor.id, id, { collectionId, addToLibrary, now: now() });
          await storageObjects.acquireAndBind({
            kind: "customEmote",
            resourceId: id,
            ...canonical,
            stream: Readable.from(processed.buffer),
            cleanupPrevious: false
          });
          await syncSubscribersForSourceInTransaction(db, collectionId, now);
          return publicCustomEmote(await getOwnEmoteRow(db, actor.id, id));
        });
      } finally {
        await storageObjects.cleanupIfUnreferenced(staged.id).catch(() => {});
      }
    });
    return result;
  };

  const storeReferenceInTransaction = async ({
    actor,
    source,
    collectionId = "",
    addToLibrary = true,
    skipCapacity = false,
    allowSubscribedCollection = false
  }) => {
    const resource = await resolveCustomEmoteResource(db, source);
    if ((!resource?.storage_object_id && !resource?.storage_key) || !resource.sha256) {
      throw new WorkspaceValidationError("emote.invalid_source", "收藏表情已不可用");
    }
    const duplicate = await findReusableLocalEmote(db, actor.id, "sha256", resource.sha256);
    if (duplicate) {
      await db.prepare("UPDATE workspace_custom_emotes SET removed_at = NULL WHERE id = ?").run(duplicate.id);
      await ensureEmotePlacement(db, actor.id, duplicate.id, {
        collectionId,
        addToLibrary,
        now: now(),
        allowSubscribedCollection
      });
      return publicCustomEmote({ ...duplicate, removed_at: null });
    }
    if (!skipCapacity) await assertLocalCapacity(db, actor.id, Number(resource.byte_size) || 0);
    const id = randomUUID();
    const date = now().toISOString();
    const order = await db.prepare(`
      SELECT COALESCE(MIN(sort_order), 0) - 1 AS nextOrder
      FROM workspace_custom_emotes WHERE user_id = ?
    `).get(actor.id);
    await db.prepare(`
      INSERT INTO workspace_custom_emotes (
        id, user_id, source_type, source_attachment_id, source_custom_emote_id,
        source_emote_key, original_file_name, original_mime_type, label,
        normalized_mime_type, byte_size, width, height, frame_count, duration_ms,
        sha256, storage_key, storage_object_id, sort_order, created_at, removed_at
      ) VALUES (?, ?, 'custom', NULL, ?, NULL, ?, 'image/webp', ?,
        'image/webp', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
    `).run(
      id,
      actor.id,
      resource.id,
      resource.original_file_name || `${resource.label}.webp`,
      source.label || resource.label,
      resource.byte_size,
      resource.width,
      resource.height,
      resource.frame_count,
      resource.duration_ms,
      resource.sha256,
      resource.storage_object_id ?? null,
      order.nextOrder,
      date
    );
    await ensureEmotePlacement(db, actor.id, id, {
      collectionId,
      addToLibrary,
      now: new Date(date),
      allowSubscribedCollection
    });
    return publicCustomEmote(await getOwnEmoteRow(db, actor.id, id));
  };

  const storeReference = async ({ actorId, source, collectionId = "", addToLibrary = true }) => {
    const actor = await requireHumanActor(db, actorId);
    return await withUserLock(actor.id, async () => await db.transaction(async () => {
      await db.lock(`duallane:emote-library:${actor.id}`);
      return await storeReferenceInTransaction({ actor, source, collectionId, addToLibrary });
    }));
  };

  const readSettings = async (actorId) => {
    const availablePacks = listVisibleEmotePacks();
    const row = await db.prepare(`
      SELECT
        enabled_pack_ids_json AS enabledPackIdsJson,
        click_image_emote_to_send AS clickImageEmoteToSend
      FROM workspace_emote_preferences WHERE user_id = ?
    `).get(actorId);
    return {
      availablePacks,
      enabledPackIds: normalizeEnabledPackIds(row?.enabledPackIdsJson, availablePacks),
      clickImageEmoteToSend: Boolean(row?.clickImageEmoteToSend),
      minimumEnabled: 1
    };
  };

  return {
    async getSettings(actorId) {
      await requireHumanActor(db, actorId);
      return await readSettings(actorId);
    },

    async updateSettings(actorId, input) {
      await requireHumanActor(db, actorId);
      const availablePacks = listVisibleEmotePacks();
      const current = await readSettings(actorId);
      const settings = Array.isArray(input) ? { enabledPackIds: input } : input ?? {};
      const updatesEnabledPacks = Object.prototype.hasOwnProperty.call(settings, "enabledPackIds");
      const updatesDirectSend = Object.prototype.hasOwnProperty.call(settings, "clickImageEmoteToSend");
      const allowed = new Set(availablePacks.map((pack) => pack.id));
      let normalized = current.enabledPackIds;
      if (updatesEnabledPacks) {
        const requestedPackIds = Array.isArray(settings.enabledPackIds) ? settings.enabledPackIds.map(String) : [];
        normalized = [...new Set(requestedPackIds)].filter((id) => allowed.has(id));
        if (normalized.length < 1 || normalized.length !== new Set(requestedPackIds).size) {
          throw new WorkspaceValidationError("emote.pack_required", "至少保留一个表情包");
        }
      }
      if (updatesDirectSend && typeof settings.clickImageEmoteToSend !== "boolean") {
        throw new WorkspaceValidationError("emote.invalid_settings", "图片表情发送设置无效");
      }
      const clickImageEmoteToSend = updatesDirectSend
        ? settings.clickImageEmoteToSend
        : current.clickImageEmoteToSend;
      const updatedAt = now().toISOString();
      await db.prepare(`
        INSERT INTO workspace_emote_preferences (
          user_id, enabled_pack_ids_json, click_image_emote_to_send, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET
          enabled_pack_ids_json = excluded.enabled_pack_ids_json,
          click_image_emote_to_send = excluded.click_image_emote_to_send,
          updated_at = excluded.updated_at
      `).run(actorId, JSON.stringify(normalized), clickImageEmoteToSend ? 1 : 0, updatedAt);
      return { availablePacks, enabledPackIds: normalized, clickImageEmoteToSend, minimumEnabled: 1 };
    },

    async list(actorId) {
      await requireHumanActor(db, actorId);
      const retired = [];
      await syncActorSubscriptions(db, actorId, now, retired);
      await cleanupRetiredEmotes(retired);
      const rows = await db.prepare(`
        SELECT * FROM workspace_custom_emotes
        WHERE user_id = ? AND removed_at IS NULL
        ORDER BY sort_order ASC, created_at ASC
      `).all(actorId);
      const usage = await getEmoteUsage(db, actorId);
      return {
        items: rows.map(publicCustomEmote).filter(Boolean),
        usage,
        limits: publicEmoteLimits()
      };
    },

    async getLibrary(actorId) {
      await requireHumanActor(db, actorId);
      const retired = [];
      await syncActorSubscriptions(db, actorId, now, retired);
      await cleanupRetiredEmotes(retired);
      return await buildLibrary(db, actorId);
    },

    async reorderLibrary(actorId, entryIds) {
      await requireHumanActor(db, actorId);
      const normalized = uniqueIds(entryIds);
      await db.transaction(async () => {
        await db.lock(`duallane:emote-library:${actorId}`);
        const rows = await db.prepare(`
          SELECT id FROM workspace_emote_library_entries
          WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC
        `).all(actorId);
        const currentIds = rows.map((row) => row.id);
        if (normalized.length !== currentIds.length || normalized.some((id) => !currentIds.includes(id))) {
          throw new WorkspaceValidationError("emote.invalid_order", "表情库顺序无效");
        }
        for (let index = 0; index < normalized.length; index += 1) {
          await db.prepare("UPDATE workspace_emote_library_entries SET sort_order = ? WHERE id = ? AND user_id = ?")
            .run(index, normalized[index], actorId);
        }
      });
      return await buildLibrary(db, actorId);
    },

    async createCollection(actorId, input = {}) {
      await requireHumanActor(db, actorId);
      const name = normalizeCollectionName(input.name);
      const collectionId = randomUUID();
      const date = now().toISOString();
      await db.transaction(async () => {
        await db.lock(`duallane:emote-library:${actorId}`);
        await db.prepare(`
          INSERT INTO workspace_emote_collections (
            id, user_id, name, source_collection_id, original_creator_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, ?, ?, ?)
        `).run(collectionId, actorId, name, actorId, date, date);
        await insertLibraryEntry(db, actorId, "collection", collectionId, date);
        if (Array.isArray(input.emoteIds) && input.emoteIds.length > 0) {
          await addItemsToCollection(db, actorId, collectionId, input.emoteIds, date);
        }
      });
      return await getOwnCollection(db, actorId, collectionId);
    },

    async updateCollection(actorId, collectionId, input = {}) {
      await requireHumanActor(db, actorId);
      const collection = await requireOwnCollection(db, actorId, collectionId);
      assertCollectionWritable(collection);
      const name = normalizeCollectionName(input.name);
      await db.transaction(async () => {
        await db.prepare(`
          UPDATE workspace_emote_collections
          SET name = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND user_id = ?
        `).run(name, now().toISOString(), collection.id, actorId);
        await syncSubscribersForSourceInTransaction(db, collection.id, now);
      });
      return await getOwnCollection(db, actorId, collection.id);
    },

    async deleteCollection(actorId, collectionId, disposition = "keep") {
      await requireHumanActor(db, actorId);
      const collection = await requireOwnCollection(db, actorId, collectionId);
      const emoteRows = await db.prepare(`
        SELECT e.* FROM workspace_emote_collection_items ci
        INNER JOIN workspace_custom_emotes e ON e.id = ci.emote_id
        WHERE ci.collection_id = ?
      `).all(collection.id);
      const date = now().toISOString();
      await db.transaction(async () => {
        await db.lock(`duallane:emote-library:${actorId}`);
        if (collection.sourceSubscription.enabled && disposition !== "remove") {
          await assertCanDetachSubscription(db, actorId, await getCollectionSubscriptionRow(db, collection.id));
        }
        await detachSubscribersForDeletedSourceInTransaction(db, collection.id, date);
        if (disposition !== "remove") {
          for (const row of emoteRows) await ensureEmotePlacement(db, actorId, row.id, { addToLibrary: true, now: new Date(date) });
        }
        await db.prepare("DELETE FROM workspace_emote_collections WHERE id = ? AND user_id = ?").run(collection.id, actorId);
        if (disposition === "remove") {
          for (const row of emoteRows) {
            if (!await isOwnedEmoteInLibrary(db, actorId, row.id)) {
              await db.prepare("UPDATE workspace_custom_emotes SET removed_at = ? WHERE id = ? AND user_id = ?")
                .run(date, row.id, actorId);
            }
          }
        }
      });
      if (disposition === "remove") {
        await Promise.all(emoteRows.map((row) => cleanupUnreferencedEmote(db, objectStore, storageObjects, row)));
      }
      return { ok: true, collectionId: collection.id };
    },

    async addCollectionItems(actorId, collectionId, emoteIds) {
      await requireHumanActor(db, actorId);
      const collection = await requireOwnCollection(db, actorId, collectionId);
      assertCollectionWritable(collection);
      await db.transaction(async () => {
        await db.lock(`duallane:emote-library:${actorId}`);
        await addItemsToCollection(db, actorId, collection.id, emoteIds, now().toISOString());
        await syncSubscribersForSourceInTransaction(db, collection.id, now);
      });
      return await getOwnCollection(db, actorId, collection.id);
    },

    async removeCollectionItem(actorId, collectionId, emoteId) {
      await requireHumanActor(db, actorId);
      const collection = await requireOwnCollection(db, actorId, collectionId);
      assertCollectionWritable(collection);
      const retired = [];
      await db.transaction(async () => {
        const result = await db.prepare(`
          DELETE FROM workspace_emote_collection_items WHERE collection_id = ? AND emote_id = ?
        `).run(collection.id, String(emoteId ?? "").trim());
        if (result.changes === 0) throw new WorkspaceError("emote.not_found", "合集内没有该表情", 404);
        await db.prepare("UPDATE workspace_emote_collections SET revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(now().toISOString(), collection.id);
        await syncSubscribersForSourceInTransaction(db, collection.id, now, retired);
      });
      await cleanupRetiredEmotes(retired);
      return await getOwnCollection(db, actorId, collection.id);
    },

    async reorderCollection(actorId, collectionId, emoteIds) {
      await requireHumanActor(db, actorId);
      const collection = await requireOwnCollection(db, actorId, collectionId);
      assertCollectionWritable(collection);
      const normalized = uniqueIds(emoteIds);
      await db.transaction(async () => {
        await db.lock(`duallane:emote-library:${actorId}`);
        const rows = await db.prepare(`
          SELECT emote_id AS emoteId FROM workspace_emote_collection_items
          WHERE collection_id = ? ORDER BY sort_order ASC, added_at ASC
        `).all(collection.id);
        const current = rows.map((row) => row.emoteId);
        if (normalized.length !== current.length || normalized.some((id) => !current.includes(id))) {
          throw new WorkspaceValidationError("emote.invalid_order", "合集内表情顺序无效");
        }
        for (let index = 0; index < normalized.length; index += 1) {
          await db.prepare("UPDATE workspace_emote_collection_items SET sort_order = ? WHERE collection_id = ? AND emote_id = ?")
            .run(index, collection.id, normalized[index]);
        }
        await db.prepare("UPDATE workspace_emote_collections SET revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(now().toISOString(), collection.id);
        await syncSubscribersForSourceInTransaction(db, collection.id, now);
      });
      return await getOwnCollection(db, actorId, collection.id);
    },

    async createCollectionShare(actorId, collectionId) {
      const actor = await requireHumanActor(db, actorId);
      const collection = await requireOwnCollection(db, actorId, collectionId);
      const items = collection.items;
      if (items.length === 0) throw new WorkspaceValidationError("emote.collection_empty", "空合集不能分享");
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ name: collection.name, emoteIds: items.map((item) => item.id) }))
        .digest("hex");
      const existing = await db.prepare(`
        SELECT id FROM workspace_emote_collection_shares
        WHERE collection_id = ? AND shared_by_user_id = ? AND fingerprint = ? AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `).get(collection.id, actor.id, fingerprint);
      if (existing) return await getShare(db, actor.id, existing.id);
      const shareId = randomUUID();
      const date = now().toISOString();
      await db.transaction(async () => {
        await db.prepare(`
          INSERT INTO workspace_emote_collection_shares (
            id, collection_id, shared_by_user_id, original_creator_user_id,
            snapshot_name, fingerprint, item_count, created_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
          shareId,
          collection.id,
          actor.id,
          collection.originalCreatorUserId || actor.id,
          collection.name,
          fingerprint,
          items.length,
          date
        );
        for (let index = 0; index < items.length; index += 1) {
          await db.prepare(`
            INSERT INTO workspace_emote_collection_share_items (share_id, emote_id, sort_order)
            VALUES (?, ?, ?)
          `).run(shareId, items[index].id, index);
        }
      });
      return await getShare(db, actor.id, shareId);
    },

    async revokeCollectionShare(actorId, shareId) {
      await requireHumanActor(db, actorId);
      const share = await db.prepare(`
        SELECT id, shared_by_user_id AS sharedByUserId
        FROM workspace_emote_collection_shares WHERE id = ?
      `).get(String(shareId ?? "").trim());
      if (!share) throw new WorkspaceError("emote.share_not_found", "分享不存在", 404);
      if (share.sharedByUserId !== actorId) throw new WorkspacePermissionError("permission.denied", "只能撤销自己的分享");
      const shareRows = await db.prepare(`
        SELECT e.* FROM workspace_emote_collection_share_items si
        INNER JOIN workspace_custom_emotes e ON e.id = si.emote_id
        WHERE si.share_id = ?
      `).all(share.id);
      await db.transaction(async () => {
        await db.prepare("UPDATE workspace_emote_collection_shares SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
          .run(now().toISOString(), share.id);
        await db.prepare("DELETE FROM workspace_emote_collection_share_items WHERE share_id = ?").run(share.id);
      });
      for (const row of shareRows) {
        if (row.removed_at) await cleanupUnreferencedEmote(db, objectStore, storageObjects, row);
      }
      return await getShare(db, actorId, share.id);
    },

    async getCollectionShare(actorId, shareId) {
      await requireHumanActor(db, actorId);
      return await getShare(db, actorId, shareId);
    },

    async importCollectionShare(actorId, shareId, input = {}) {
      const actor = await requireHumanActor(db, actorId);
      const share = await getShare(db, actor.id, shareId);
      if (share.revokedAt) throw new WorkspaceError("emote.share_revoked", "该合集已停止分享", 410);
      if (input.subscribeToSourceChanges !== undefined && typeof input.subscribeToSourceChanges !== "boolean") {
        throw new WorkspaceValidationError("emote.invalid_subscription", "订阅设置无效");
      }
      const subscribeToSourceChanges = input.subscribeToSourceChanges === true;
      const requestedIds = Array.isArray(input.emoteIds) && input.emoteIds.length > 0 ? uniqueIds(input.emoteIds) : null;
      let sourceItems = requestedIds
        ? share.items.filter((item) => requestedIds.includes(item.id))
        : share.items;
      let subscriptionSourceRows = null;
      if (requestedIds && sourceItems.length !== requestedIds.length) {
        throw new WorkspaceValidationError("emote.invalid_source", "分享中没有所选表情");
      }
      const importAsCollection = input.asCollection !== false && !requestedIds;
      if (subscribeToSourceChanges && !importAsCollection) {
        throw new WorkspaceValidationError("emote.subscription_requires_collection", "只能订阅完整合集");
      }
      const canonicalSource = importAsCollection
        ? await resolveCanonicalSourceCollection(db, share.sourceCollectionId, share.originalCreator.id)
        : null;
      if (subscribeToSourceChanges) {
        if (!canonicalSource) throw new WorkspaceError("emote.subscription_source_unavailable", "原作者合集已不可用", 409);
        subscriptionSourceRows = await listCollectionItemRows(db, canonicalSource.id);
        sourceItems = subscriptionSourceRows.map(publicCustomEmote).filter(Boolean);
      }
      const { targetCollectionId, imported } = await withUserLock(actor.id, async () => await db.transaction(async () => {
        await db.lock(`duallane:emote-library:${actor.id}`);
        let targetCollectionId = "";
        if (importAsCollection) {
          targetCollectionId = randomUUID();
          const date = now().toISOString();
          await db.prepare(`
            INSERT INTO workspace_emote_collections (
              id, user_id, name, source_collection_id, original_creator_user_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            targetCollectionId,
            actor.id,
            normalizeCollectionName(subscribeToSourceChanges ? canonicalSource.name : share.name),
            canonicalSource?.id ?? share.sourceCollectionId,
            share.originalCreator.id,
            date,
            date
          );
          await insertLibraryEntry(db, actor.id, "collection", targetCollectionId, date);
        }
        const imported = [];
        for (let sourceIndex = 0; sourceIndex < sourceItems.length; sourceIndex += 1) {
          const item = sourceItems[sourceIndex];
          if (subscribeToSourceChanges) {
            const date = now().toISOString();
            const target = await createSubscriptionTargetEmote(db, actor.id, subscriptionSourceRows[sourceIndex], date);
            await db.prepare(`
              INSERT INTO workspace_emote_collection_items (collection_id, emote_id, sort_order, added_at)
              VALUES (?, ?, ?, ?)
            `).run(targetCollectionId, target.id, sourceIndex, date);
            imported.push(publicCustomEmote(target));
            continue;
          }
          if (item.kind === "builtin") {
            const builtin = getReactionEmote(item.emoteKey);
            if (!builtin) throw new WorkspaceValidationError("emote.invalid_source", "分享中的表情已不可用");
            imported.push(await addBuiltinFavorite(db, actor.id, builtin, now(), {
              collectionId: targetCollectionId,
              addToLibrary: !targetCollectionId,
              skipCapacity: subscribeToSourceChanges,
              allowSubscribedCollection: subscribeToSourceChanges
            }));
            continue;
          }
          const source = await db.prepare("SELECT * FROM workspace_custom_emotes WHERE id = ?").get(item.id);
          if (!source) throw new WorkspaceValidationError("emote.invalid_source", "分享中的表情已不可用");
          imported.push(await storeReferenceInTransaction({
            actor,
            source,
            collectionId: targetCollectionId,
            addToLibrary: !targetCollectionId,
            skipCapacity: subscribeToSourceChanges,
            allowSubscribedCollection: subscribeToSourceChanges
          }));
        }
        if (subscribeToSourceChanges) {
          const date = now().toISOString();
          const subscriptionId = randomUUID();
          await db.prepare(`
            INSERT INTO workspace_emote_collection_subscriptions (
              id, collection_id, subscriber_user_id, source_collection_id, source_owner_user_id,
              status, source_revision, last_synced_at, detached_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)
          `).run(
            subscriptionId,
            targetCollectionId,
            actor.id,
            canonicalSource.id,
            canonicalSource.userId,
            canonicalSource.revision,
            date,
            date,
            date
          );
          for (let index = 0; index < sourceItems.length; index += 1) {
            await db.prepare(`
              INSERT INTO workspace_emote_collection_subscription_items (
                subscription_id, source_emote_id, target_emote_id, source_sort_order, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?)
            `).run(subscriptionId, sourceItems[index].id, imported[index].id, index, date, date);
          }
          await writeSubscriptionEvent(db, {
            actorId: canonicalSource.userId,
            subscriberUserId: actor.id,
            collectionId: targetCollectionId,
            status: "synced",
            sourceRevision: canonicalSource.revision
          });
        }
        return { targetCollectionId, imported };
      }));
      return {
        collection: targetCollectionId ? await getOwnCollection(db, actor.id, targetCollectionId) : null,
        items: imported,
        library: await buildLibrary(db, actor.id)
      };
    },

    async updateCollectionSourceSubscription(actorId, collectionId, input = {}) {
      const actor = await requireHumanActor(db, actorId);
      if (typeof input.enabled !== "boolean") {
        throw new WorkspaceValidationError("emote.invalid_subscription", "订阅设置无效");
      }
      await withUserLock(actor.id, async () => await db.transaction(async () => {
        await db.lock(`duallane:emote-library:${actor.id}`);
        if (input.enabled) {
          const candidate = await requireOwnCollection(db, actor.id, collectionId);
          const existing = await getCollectionSubscriptionRow(db, candidate.id);
          const subscriptionId = existing?.id ?? randomUUID();
          await db.lock(`duallane:emote-subscription:${subscriptionId}`);
          const collection = await requireOwnCollection(db, actor.id, candidate.id);
          if (!collection.sourceSubscription.eligible) {
            throw new WorkspaceError("emote.subscription_source_unavailable", "原作者合集已不可用", 409);
          }
          const source = await resolveCanonicalSourceCollection(
            db,
            collection.sourceSubscription.sourceCollectionId,
            collection.originalCreatorUserId
          );
          if (!source || source.id === collection.id) {
            throw new WorkspaceError("emote.subscription_source_unavailable", "原作者合集已不可用", 409);
          }
          const date = now().toISOString();
          const updated = await db.prepare(`
            INSERT INTO workspace_emote_collection_subscriptions (
              id, collection_id, subscriber_user_id, source_collection_id, source_owner_user_id,
              status, source_revision, last_synced_at, detached_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'active', 0, NULL, NULL, ?, ?)
            ON CONFLICT (collection_id) DO UPDATE SET
              source_collection_id = excluded.source_collection_id,
              source_owner_user_id = excluded.source_owner_user_id,
              status = 'active', source_revision = 0, last_synced_at = NULL,
              detached_at = NULL, updated_at = excluded.updated_at
          `).run(subscriptionId, collection.id, actor.id, source.id, source.userId, date, date);
          if (updated.changes !== 1) {
            throw new WorkspaceError("emote.subscription_conflict", "订阅状态已变化，请重试", 409);
          }
          await syncSubscriptionInTransaction(db, subscriptionId, now);
        } else {
          const candidate = await requireOwnCollection(db, actor.id, collectionId);
          const current = await getCollectionSubscriptionRow(db, candidate.id);
          if (!current || current.status !== "active") return;
          await db.lock(`duallane:emote-subscription:${current.id}`);
          const collection = await requireOwnCollection(db, actor.id, candidate.id);
          const subscription = await getCollectionSubscriptionRow(db, collection.id);
          if (!subscription || subscription.status !== "active") return;
          await assertCanDetachSubscription(db, actor.id, subscription);
          const date = now().toISOString();
          const updated = await db.prepare(`
            UPDATE workspace_emote_collection_subscriptions
            SET status = 'off', detached_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'active'
          `).run(date, subscription.id);
          if (updated.changes !== 1) {
            throw new WorkspaceError("emote.subscription_conflict", "订阅状态已变化，请重试", 409);
          }
          await writeSubscriptionEvent(db, {
            actorId: actor.id,
            subscriberUserId: actor.id,
            collectionId: collection.id,
            status: "off",
            sourceRevision: subscription.sourceRevision
          });
        }
      }));
      return {
        collection: await getOwnCollection(db, actor.id, collectionId),
        library: await buildLibrary(db, actor.id)
      };
    },

    async validateMessageCollectionShare(actorId, shareId) {
      await requireHumanActor(db, actorId);
      const share = await db.prepare(`
        SELECT id, revoked_at AS revokedAt FROM workspace_emote_collection_shares WHERE id = ?
      `).get(String(shareId ?? "").trim());
      if (!share) throw new WorkspaceValidationError("message.invalid_emote_collection", "表情合集分享不存在");
      if (share.revokedAt) throw new WorkspaceValidationError("message.invalid_emote_collection", "表情合集分享已撤销");
      return share;
    },

    async upload({ actorId, stream, contentType, fileName, collectionId = "", addToLibrary = true }) {
      if (!SUPPORTED_MIME_TYPES.has(String(contentType ?? "").toLowerCase())) {
        throw new WorkspaceValidationError("emote.invalid_format", "仅支持 JPEG、PNG、WebP、GIF 或 BMP 图片");
      }
      const input = await readLimitedStream(stream, CUSTOM_EMOTE_MAX_INPUT_BYTES);
      return await storeProcessed({
        actorId,
        input,
        source: { type: "upload", fileName: normalizeFileName(fileName), mimeType: contentType },
        collectionId,
        addToLibrary
      });
    },

    async favoriteFromMessage({ actorId, messageId, attachmentId, emoteKey, customEmoteId }) {
      await requireHumanActor(db, actorId);
      const message = await getVisibleMessage(db, actorId, messageId);
      const sourceCount = [attachmentId, emoteKey, customEmoteId].filter(Boolean).length;
      if (sourceCount !== 1) {
        throw new WorkspaceValidationError("emote.invalid_source", "请选择一个可收藏的表情");
      }
      const content = safeContent(message.contentJson);
      if (attachmentId) {
        const used = await db.prepare(`
          SELECT a.*
          FROM message_attachments ma
          INNER JOIN attachments a ON a.id = ma.attachment_id
          WHERE ma.message_id = ? AND ma.attachment_id = ? AND a.status = 'available'
        `).get(message.id, attachmentId);
        if (!used || !SUPPORTED_MIME_TYPES.has(String(used.mime_type ?? "").toLowerCase())) {
          throw new WorkspaceValidationError("emote.invalid_source", "该消息没有可收藏的图片");
        }
        const bytes = await objectStore.readAttachmentBytes({
          id: used.id,
          spaceId: used.space_id,
          storageKey: used.storage_key,
          byteSize: used.byte_size,
          mimeType: used.mime_type
        }, CUSTOM_EMOTE_MAX_INPUT_BYTES);
        return await storeProcessed({
          actorId,
          input: bytes,
          source: {
            type: "attachment",
            attachmentId: used.id,
            fileName: used.file_name,
            mimeType: used.mime_type
          }
        });
      }
      if (emoteKey) {
        const emote = getReactionEmote(emoteKey);
        if (!emote || emote.kind !== "image" || !messageContainsBuiltinEmote(content, emote)) {
          throw new WorkspaceValidationError("emote.invalid_source", "该消息没有可收藏的表情");
        }
        return await withUserLock(actorId, async () => await db.transaction(async () => {
          await db.lock(`duallane:emote-library:${actorId}`);
          return await addBuiltinFavorite(db, actorId, emote, now());
        }));
      }
      const normalizedCustomId = String(customEmoteId ?? "").trim();
      if (!messageContainsCustomEmote(content, normalizedCustomId)) {
        throw new WorkspaceValidationError("emote.invalid_source", "该消息没有可收藏的表情");
      }
      const source = await db.prepare("SELECT * FROM workspace_custom_emotes WHERE id = ?").get(normalizedCustomId);
      if (!source) {
        throw new WorkspaceValidationError("emote.invalid_source", "收藏表情已不可用");
      }
      return await storeReference({
        actorId,
        source
      });
    },

    async update(actorId, emoteId, input = {}) {
      await requireHumanActor(db, actorId);
      const row = await getOwnEmoteRow(db, actorId, emoteId);
      if (!row || row.removed_at) throw new WorkspaceError("emote.not_found", "收藏表情不存在", 404);
      await assertEmoteWritable(db, actorId, row.id);
      const label = normalizeEmoteLabel(input.label);
      const collectionIds = await listMutableCollectionIdsForEmote(db, actorId, row.id);
      const date = now().toISOString();
      await db.transaction(async () => {
        await db.prepare("UPDATE workspace_custom_emotes SET label = ? WHERE id = ? AND user_id = ?")
          .run(label, row.id, actorId);
        for (const id of collectionIds) {
          await db.prepare("UPDATE workspace_emote_collections SET revision = revision + 1, updated_at = ? WHERE id = ?")
            .run(date, id);
          await syncSubscribersForSourceInTransaction(db, id, now);
        }
      });
      return publicCustomEmote({ ...row, label });
    },

    async remove(actorId, emoteId) {
      await requireHumanActor(db, actorId);
      const row = await getOwnEmoteRow(db, actorId, emoteId);
      if (!row) throw new WorkspaceError("emote.not_found", "收藏表情不存在", 404);
      await assertEmoteWritable(db, actorId, row.id);
      const collectionIds = await listMutableCollectionIdsForEmote(db, actorId, row.id);
      const date = now().toISOString();
      const retired = [];
      await db.transaction(async () => {
        await db.lock(`duallane:emote-library:${actorId}`);
        await db.prepare("DELETE FROM workspace_emote_library_entries WHERE user_id = ? AND emote_id = ?").run(actorId, row.id);
        await db.prepare("DELETE FROM workspace_emote_collection_items WHERE emote_id = ? AND collection_id IN (SELECT id FROM workspace_emote_collections WHERE user_id = ?)").run(row.id, actorId);
        await db.prepare("UPDATE workspace_custom_emotes SET removed_at = ? WHERE id = ? AND user_id = ?").run(date, row.id, actorId);
        for (const id of collectionIds) {
          await db.prepare("UPDATE workspace_emote_collections SET revision = revision + 1, updated_at = ? WHERE id = ?")
            .run(date, id);
          await syncSubscribersForSourceInTransaction(db, id, now, retired);
        }
      });
      await cleanupRetiredEmotes(retired);
      const resource = await resolveCustomEmoteResource(db, row);
      await cleanupUnreferencedEmote(db, objectStore, storageObjects, row);
      if (resource && resource.id !== row.id && resource.removed_at) {
        await cleanupUnreferencedEmote(db, objectStore, storageObjects, resource);
      }
      return { ok: true, emoteId: row.id };
    },

    async reorder(actorId, emoteIds) {
      await requireHumanActor(db, actorId);
      const existing = await db.prepare(`
        SELECT id AS entryId, entry_type AS entryType, emote_id AS emoteId
        FROM workspace_emote_library_entries
        WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC
      `).all(actorId);
      const currentIds = existing.filter((row) => row.entryType === "emote").map((row) => row.emoteId);
      const normalized = Array.isArray(emoteIds) ? [...new Set(emoteIds.map(String))] : [];
      if (normalized.length !== currentIds.length || normalized.some((id) => !currentIds.includes(id))) {
        throw new WorkspaceValidationError("emote.invalid_order", "收藏表情顺序无效");
      }
      const entryIdByEmote = new Map(existing.map((row) => [row.emoteId, row.entryId]));
      let emoteIndex = 0;
      const entryIds = existing.map((row) => row.entryType === "emote"
        ? entryIdByEmote.get(normalized[emoteIndex++])
        : row.entryId);
      await this.reorderLibrary(actorId, entryIds);
      return await this.list(actorId);
    },

    async getDelivery(actorId, emoteId) {
      await requireHumanActor(db, actorId);
      const row = await db.prepare("SELECT * FROM workspace_custom_emotes WHERE id = ?").get(emoteId);
      if (!row) throw new WorkspaceError("emote.not_found", "收藏表情不存在", 404);
      if (row.user_id !== actorId && !await isCustomEmoteVisibleTo(db, actorId, row.id)) {
        throw new WorkspacePermissionError("permission.denied", "你没有访问该表情的权限");
      }
      const resource = await resolveCustomEmoteResource(db, row);
      if (!resource?.storage_object_id && !resource?.storage_key) {
        throw new WorkspaceError("emote.not_found", "收藏表情不存在", 404);
      }
      return await objectStore.getCustomEmoteDelivery(
        await toObjectStoreEmote(storageObjects, resource), {
        contentDisposition: "inline"
        }
      );
    },

    async validateMessageCustomEmote(actorId, customEmoteId) {
      const row = await getOwnEmoteRow(db, actorId, customEmoteId);
      const resource = row && !row.removed_at ? await resolveCustomEmoteResource(db, row) : null;
      if (!resource?.storage_object_id && !resource?.storage_key) {
        throw new WorkspaceValidationError("message.invalid_emoji", "收藏表情不可用");
      }
      return row;
    }
  };
}

async function normalizeCustomEmote(input, source) {
  let metadata;
  let sharpInput = input;
  let sharpInputOptions = { animated: true, limitInputPixels: CUSTOM_EMOTE_MAX_PIXELS, failOn: "warning" };
  try {
    if (String(source.mimeType).toLowerCase() === "image/bmp" || input.subarray(0, 2).toString("ascii") === "BM") {
      const decoded = decodeBmp(input);
      metadata = { format: "bmp", width: decoded.width, height: decoded.height, pages: 1 };
      sharpInput = decoded.data;
      sharpInputOptions = { raw: { width: decoded.width, height: decoded.height, channels: 4 } };
    } else {
      metadata = await sharp(input, sharpInputOptions).metadata();
    }
  } catch {
    throw new WorkspaceValidationError("emote.decode_failed", "图片无法解析");
  }
  if (!SUPPORTED_FORMATS.has(metadata.format)) {
    throw new WorkspaceValidationError("emote.invalid_format", "仅支持 JPEG、PNG、WebP、GIF 或 BMP 图片");
  }
  const frameCount = Math.max(1, Number(metadata.pages) || 1);
  const width = Number(metadata.width) || 0;
  const height = Number(metadata.pageHeight || metadata.height) || 0;
  const durationMs = Array.isArray(metadata.delay)
    ? metadata.delay.reduce((total, delay) => total + Math.max(0, Number(delay) || 0), 0)
    : 0;
  if (!width || !height || width > CUSTOM_EMOTE_MAX_DIMENSION || height > CUSTOM_EMOTE_MAX_DIMENSION) {
    throw new WorkspaceValidationError("emote.dimensions_exceeded", "图片尺寸过大");
  }
  if (frameCount > CUSTOM_EMOTE_MAX_FRAMES || durationMs > CUSTOM_EMOTE_MAX_DURATION_MS) {
    throw new WorkspaceValidationError("emote.animation_too_complex", "动图帧数或时长超出限制");
  }

  const makeOutput = async (size, quality) => await sharp(sharpInput, frameCount > 1
    ? { animated: true, limitInputPixels: CUSTOM_EMOTE_MAX_PIXELS, failOn: "warning" }
    : sharpInputOptions)
    .rotate()
    .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
    .webp({ quality, effort: 4, loop: 0 })
    .toBuffer({ resolveWithObject: true });
  let output;
  try {
    output = await makeOutput(256, frameCount > 1 ? 76 : 82);
    if (output.data.byteLength > CUSTOM_EMOTE_MAX_OUTPUT_BYTES) output = await makeOutput(192, 62);
  } catch {
    throw new WorkspaceValidationError("emote.process_failed", "表情图片处理失败");
  }
  if (output.data.byteLength > CUSTOM_EMOTE_MAX_OUTPUT_BYTES) {
    throw new WorkspaceValidationError("emote.output_too_large", "压缩后的表情仍然过大");
  }
  return {
    buffer: output.data,
    byteSize: output.data.byteLength,
    sha256: createHash("sha256").update(output.data).digest("hex"),
    width: output.info.width,
    height: output.info.height,
    frameCount,
    durationMs,
    detectedMimeType: formatMimeType(metadata.format),
    label: normalizeLabel(source.fileName, frameCount > 1)
  };
}

function decodeBmp(input) {
  if (input.length < 54 || input.subarray(0, 2).toString("ascii") !== "BM") {
    throw new Error("invalid bmp header");
  }
  const pixelOffset = input.readUInt32LE(10);
  const dibSize = input.readUInt32LE(14);
  const width = input.readInt32LE(18);
  const signedHeight = input.readInt32LE(22);
  const planes = input.readUInt16LE(26);
  const bitsPerPixel = input.readUInt16LE(28);
  const compression = input.readUInt32LE(30);
  const height = Math.abs(signedHeight);
  if (
    dibSize < 40 || width < 1 || height < 1 || planes !== 1 ||
    ![24, 32].includes(bitsPerPixel) || compression !== 0 ||
    width > CUSTOM_EMOTE_MAX_DIMENSION || height > CUSTOM_EMOTE_MAX_DIMENSION ||
    width * height > CUSTOM_EMOTE_MAX_PIXELS
  ) {
    throw new Error("unsupported bmp layout");
  }
  const bytesPerPixel = bitsPerPixel / 8;
  const rowStride = Math.ceil((width * bytesPerPixel) / 4) * 4;
  if (pixelOffset < 14 + dibSize || pixelOffset + rowStride * height > input.length) {
    throw new Error("truncated bmp data");
  }
  const output = Buffer.allocUnsafe(width * height * 4);
  for (let outputY = 0; outputY < height; outputY += 1) {
    const sourceY = signedHeight > 0 ? height - 1 - outputY : outputY;
    const sourceRow = pixelOffset + sourceY * rowStride;
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = sourceRow + x * bytesPerPixel;
      const outputIndex = (outputY * width + x) * 4;
      output[outputIndex] = input[sourceIndex + 2];
      output[outputIndex + 1] = input[sourceIndex + 1];
      output[outputIndex + 2] = input[sourceIndex];
      output[outputIndex + 3] = bitsPerPixel === 32 && input[sourceIndex + 3] > 0
        ? input[sourceIndex + 3]
        : 255;
    }
  }
  return { data: output, width, height };
}

async function addBuiltinFavorite(db, actorId, emote, date, placement = {}) {
  const emoteKey = `${emote.packId}:${emote.id}`;
  const existing = await findReusableLocalEmote(db, actorId, "source_emote_key", emoteKey);
  if (existing) {
    await db.prepare("UPDATE workspace_custom_emotes SET removed_at = NULL WHERE id = ?").run(existing.id);
    await ensureEmotePlacement(db, actorId, existing.id, { ...placement, now: date });
    return publicCustomEmote({ ...existing, removed_at: null });
  }
  if (!placement.skipCapacity) await assertLocalCapacity(db, actorId, 0);
  const orderRow = await db.prepare(`
    SELECT COALESCE(MIN(sort_order), 0) - 1 AS nextOrder FROM workspace_custom_emotes WHERE user_id = ?
  `).get(actorId);
  const id = randomUUID();
  await db.prepare(`
    INSERT INTO workspace_custom_emotes (
      id, user_id, source_type, source_emote_key, label, sort_order, created_at
    ) VALUES (?, ?, 'builtin', ?, ?, ?, ?)
  `).run(id, actorId, emoteKey, emote.label, orderRow.nextOrder, date.toISOString());
  await ensureEmotePlacement(db, actorId, id, { ...placement, now: date });
  return publicCustomEmote(await getOwnEmoteRow(db, actorId, id));
}

async function assertLocalCapacity(db, userId, nextBytes) {
  const usage = await getEmoteUsage(db, userId);
  if (usage.totalBytes + nextBytes > CUSTOM_EMOTE_MAX_TOTAL_BYTES) {
    throw new WorkspaceError("emote.storage_limit_reached", "收藏表情空间已满", 409);
  }
}

async function requireHumanActor(db, actorId) {
  const actor = await db.prepare(`
    SELECT u.id, u.kind
    FROM users u
    INNER JOIN space_members sm ON sm.user_id = u.id
    WHERE u.id = ? AND sm.space_id = ? AND sm.removed_at IS NULL
  `).get(actorId, DEFAULT_SPACE_ID);
  if (!actor || actor.kind !== "human") throw new WorkspacePermissionError("permission.denied", "当前账号不能使用收藏表情");
  return actor;
}

async function getVisibleMessage(db, actorId, messageId) {
  const row = await db.prepare(`
    SELECT m.id, m.content_json AS contentJson
    FROM messages m
    INNER JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
    WHERE m.id = ? AND m.deleted_at IS NULL AND cm.user_id = ? AND cm.removed_at IS NULL
  `).get(String(messageId ?? "").trim(), actorId);
  if (!row) throw new WorkspaceError("message.not_found", "消息不存在", 404);
  return row;
}

async function isCustomEmoteVisibleTo(db, actorId, emoteId) {
  const messageVisible = await db.prepare(`
    SELECT 1
    FROM message_custom_emotes mce
    INNER JOIN messages m ON m.id = mce.message_id
    INNER JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
    WHERE mce.custom_emote_id = ? AND cm.user_id = ?
      AND cm.removed_at IS NULL AND m.deleted_at IS NULL
    LIMIT 1
  `).get(emoteId, actorId);
  if (messageVisible) return true;
  return Boolean(await db.prepare(`
    SELECT 1 FROM workspace_emote_collection_share_items si
    INNER JOIN workspace_emote_collection_shares s ON s.id = si.share_id
    WHERE si.emote_id = ? AND s.revoked_at IS NULL
    LIMIT 1
  `).get(emoteId));
}

async function getOwnEmoteRow(db, actorId, emoteId) {
  return await db.prepare("SELECT * FROM workspace_custom_emotes WHERE id = ? AND user_id = ?")
    .get(String(emoteId ?? "").trim(), actorId);
}

async function findReusableLocalEmote(db, actorId, column, value) {
  const safeColumn = column === "source_emote_key" ? "source_emote_key" : "sha256";
  const rows = await db.prepare(`
    SELECT * FROM workspace_custom_emotes
    WHERE user_id = ? AND ${safeColumn} = ?
    ORDER BY CASE WHEN removed_at IS NULL THEN 0 ELSE 1 END, created_at ASC
  `).all(actorId, value);
  for (const row of rows) {
    if (!await isExclusiveActiveSubscriptionEmote(db, actorId, row.id)) return row;
  }
  return null;
}

async function isExclusiveActiveSubscriptionEmote(db, actorId, emoteId) {
  const mapped = await db.prepare(`
    SELECT 1
    FROM workspace_emote_collection_subscription_items si
    INNER JOIN workspace_emote_collection_subscriptions s ON s.id = si.subscription_id
    WHERE si.target_emote_id = ? AND s.subscriber_user_id = ? AND s.status = 'active'
    LIMIT 1
  `).get(emoteId, actorId);
  return Boolean(mapped) && !await isEmoteLocallyPlaced(db, actorId, emoteId);
}

async function isEmoteLocallyPlaced(db, actorId, emoteId) {
  return Boolean(await db.prepare(`
    SELECT 1 FROM workspace_emote_library_entries
      WHERE user_id = ? AND emote_id = ?
    UNION ALL
    SELECT 1 FROM workspace_emote_collection_items ci
      INNER JOIN workspace_emote_collections c ON c.id = ci.collection_id
      LEFT JOIN workspace_emote_collection_subscriptions s
        ON s.collection_id = c.id AND s.status = 'active'
      WHERE c.user_id = ? AND ci.emote_id = ? AND s.id IS NULL
    LIMIT 1
  `).get(actorId, emoteId, actorId, emoteId));
}

function publicCustomEmote(row) {
  if (!row) return null;
  if (row.source_type === "builtin") {
    const emote = getReactionEmote(row.source_emote_key);
    if (!emote || emote.kind !== "image") return null;
    return {
      id: row.id,
      kind: "builtin",
      label: row.label,
      token: emote.token,
      src: emote.src,
      emoteKey: row.source_emote_key,
      animated: false,
      createdAt: row.created_at
    };
  }
  return {
    id: row.id,
    kind: "custom",
    label: row.label,
    token: `[custom:${row.id}]`,
    src: `/api/workspace/emotes/${encodeURIComponent(row.id)}/content`,
    animated: Number(row.frame_count) > 1,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    sourceType: row.source_type,
    originalFileName: row.original_file_name || undefined,
    originalMimeType: row.original_mime_type || undefined,
    createdAt: row.created_at
  };
}

async function ensureEmotePlacement(db, actorId, emoteId, {
  collectionId = "",
  addToLibrary = true,
  now,
  allowSubscribedCollection = false
}) {
  const date = now instanceof Date ? now.toISOString() : new Date(now ?? Date.now()).toISOString();
  if (collectionId) {
    const collection = await requireOwnCollection(db, actorId, collectionId);
    if (!allowSubscribedCollection) assertCollectionWritable(collection);
    const count = await db.prepare(`
      SELECT COUNT(*) AS count FROM workspace_emote_collection_items WHERE collection_id = ?
    `).get(collectionId);
    const existing = await db.prepare(`
      SELECT 1 FROM workspace_emote_collection_items WHERE collection_id = ? AND emote_id = ?
    `).get(collectionId, emoteId);
    if (!existing && Number(count.count) >= CUSTOM_EMOTE_MAX_COLLECTION_ITEMS) {
      throw new WorkspaceError("emote.collection_limit_reached", "合集已达到 100 张上限", 409);
    }
    const order = await db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder
      FROM workspace_emote_collection_items WHERE collection_id = ?
    `).get(collectionId);
    await db.prepare(`
      INSERT INTO workspace_emote_collection_items (collection_id, emote_id, sort_order, added_at)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
    `).run(collectionId, emoteId, order.nextOrder, date);
    await db.prepare("UPDATE workspace_emote_collections SET revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(date, collectionId);
  }
  if (addToLibrary) await insertLibraryEntry(db, actorId, "emote", emoteId, date);
}

async function insertLibraryEntry(db, actorId, entryType, targetId, date) {
  const existing = await db.prepare(`
    SELECT id FROM workspace_emote_library_entries
    WHERE user_id = ? AND ${entryType === "emote" ? "emote_id" : "collection_id"} = ?
  `).get(actorId, targetId);
  if (existing) return existing.id;
  const order = await db.prepare(`
    SELECT COALESCE(MIN(sort_order), 0) - 1 AS nextOrder
    FROM workspace_emote_library_entries WHERE user_id = ?
  `).get(actorId);
  const id = randomUUID();
  await db.prepare(`
    INSERT INTO workspace_emote_library_entries (
      id, user_id, entry_type, emote_id, collection_id, sort_order, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    actorId,
    entryType,
    entryType === "emote" ? targetId : null,
    entryType === "collection" ? targetId : null,
    order.nextOrder,
    date
  );
  return id;
}

async function buildLibrary(db, actorId) {
  const [entries, collections, emotes, usage] = await Promise.all([
    db.prepare(`
      SELECT id, entry_type AS entryType, emote_id AS emoteId, collection_id AS collectionId, sort_order AS sortOrder
      FROM workspace_emote_library_entries WHERE user_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `).all(actorId),
    db.prepare(`
      SELECT id FROM workspace_emote_collections WHERE user_id = ? ORDER BY updated_at DESC
    `).all(actorId),
    db.prepare(`
      SELECT * FROM workspace_custom_emotes WHERE user_id = ? AND removed_at IS NULL
    `).all(actorId),
    getEmoteUsage(db, actorId)
  ]);
  const emoteById = new Map(emotes.map((row) => [row.id, publicCustomEmote(row)]));
  const collectionList = await Promise.all(collections.map((row) => getOwnCollection(db, actorId, row.id)));
  const collectionById = new Map(collectionList.map((collection) => [collection.id, collection]));
  return {
    entries: entries.map((entry) => entry.entryType === "emote"
      ? { id: entry.id, type: "emote", emote: emoteById.get(entry.emoteId) }
      : { id: entry.id, type: "collection", collection: collectionById.get(entry.collectionId) }
    ).filter((entry) => entry.emote || entry.collection),
    emotes: [...emoteById.values()].filter(Boolean),
    collections: collectionList,
    usage: { ...usage, collectionCount: collectionList.length },
    limits: publicEmoteLimits()
  };
}

async function getOwnCollection(db, actorId, collectionId) {
  const collection = await db.prepare(`
    SELECT c.id, c.name, c.source_collection_id AS sourceCollectionId,
      c.original_creator_user_id AS originalCreatorUserId,
      COALESCE(u.nickname, u.github_login, u.display_name) AS originalCreatorName,
      c.revision, c.created_at AS createdAt, c.updated_at AS updatedAt
    FROM workspace_emote_collections c
    INNER JOIN users u ON u.id = c.original_creator_user_id
    WHERE c.id = ? AND c.user_id = ?
  `).get(String(collectionId ?? "").trim(), actorId);
  if (!collection) return null;
  const subscription = await getCollectionSubscriptionRow(db, collection.id);
  const rows = await db.prepare(`
    SELECT e.* FROM workspace_emote_collection_items ci
    INNER JOIN workspace_custom_emotes e ON e.id = ci.emote_id
    WHERE ci.collection_id = ? AND e.removed_at IS NULL
    ORDER BY ci.sort_order ASC, ci.added_at ASC
  `).all(collection.id);
  return {
    ...collection,
    originalCreator: {
      id: collection.originalCreatorUserId,
      displayName: collection.originalCreatorName
    },
    sourceSubscription: publicSourceSubscription(collection, subscription),
    items: rows.map(publicCustomEmote).filter(Boolean),
    itemCount: rows.length
  };
}

async function requireOwnCollection(db, actorId, collectionId) {
  const collection = await getOwnCollection(db, actorId, collectionId);
  if (!collection) throw new WorkspaceError("emote.collection_not_found", "表情合集不存在", 404);
  return collection;
}

async function addItemsToCollection(db, actorId, collectionId, emoteIds, date) {
  const normalized = uniqueIds(emoteIds);
  if (normalized.length === 0) return;
  const owned = await db.prepare(`
    SELECT id FROM workspace_custom_emotes WHERE user_id = ? AND removed_at IS NULL
  `).all(actorId);
  const allowed = new Set(owned.map((row) => row.id));
  if (normalized.some((id) => !allowed.has(id))) {
    throw new WorkspaceValidationError("emote.invalid_source", "只能添加自己的可用表情");
  }
  const count = await db.prepare("SELECT COUNT(*) AS count FROM workspace_emote_collection_items WHERE collection_id = ?")
    .get(collectionId);
  const existing = await db.prepare("SELECT emote_id AS emoteId FROM workspace_emote_collection_items WHERE collection_id = ?")
    .all(collectionId);
  const existingIds = new Set(existing.map((row) => row.emoteId));
  const additions = normalized.filter((id) => !existingIds.has(id));
  if (Number(count.count) + additions.length > CUSTOM_EMOTE_MAX_COLLECTION_ITEMS) {
    throw new WorkspaceError("emote.collection_limit_reached", "合集已达到 100 张上限", 409);
  }
  let nextOrder = Number(count.count);
  for (const id of additions) {
    await db.prepare(`
      INSERT INTO workspace_emote_collection_items (collection_id, emote_id, sort_order, added_at)
      VALUES (?, ?, ?, ?)
    `).run(collectionId, id, nextOrder++, date);
  }
  if (additions.length > 0) {
    await db.prepare("UPDATE workspace_emote_collections SET revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(date, collectionId);
  }
}

function publicEmoteLimits() {
  return {
    maxItems: null,
    maxTotalBytes: CUSTOM_EMOTE_MAX_TOTAL_BYTES,
    maxInputBytes: CUSTOM_EMOTE_MAX_INPUT_BYTES,
    maxCollections: null,
    maxCollectionItems: CUSTOM_EMOTE_MAX_COLLECTION_ITEMS,
    maxBatchItems: CUSTOM_EMOTE_MAX_BATCH_ITEMS
  };
}

async function getEmoteUsage(db, actorId, { ignoredActiveSubscriptionId = "" } = {}) {
  const [emotes, mappedRows, localRows, collectionCounts] = await Promise.all([
    db.prepare(`
      SELECT id, COALESCE(byte_size, 0) AS byteSize
      FROM workspace_custom_emotes WHERE user_id = ? AND removed_at IS NULL
    `).all(actorId),
    db.prepare(`
      SELECT DISTINCT si.target_emote_id AS emoteId
      FROM workspace_emote_collection_subscription_items si
      INNER JOIN workspace_emote_collection_subscriptions s ON s.id = si.subscription_id
      WHERE s.subscriber_user_id = ? AND s.status = 'active' AND s.id <> ?
    `).all(actorId, ignoredActiveSubscriptionId),
    db.prepare(`
      SELECT emote_id AS emoteId FROM workspace_emote_library_entries
      WHERE user_id = ? AND emote_id IS NOT NULL
      UNION
      SELECT ci.emote_id AS emoteId
      FROM workspace_emote_collection_items ci
      INNER JOIN workspace_emote_collections c ON c.id = ci.collection_id
      LEFT JOIN workspace_emote_collection_subscriptions s
        ON s.collection_id = c.id AND s.status = 'active' AND s.id <> ?
      WHERE c.user_id = ? AND s.id IS NULL
    `).all(actorId, ignoredActiveSubscriptionId, actorId),
    db.prepare(`
      SELECT COUNT(*) AS collectionCount,
        COALESCE(SUM(CASE WHEN s.status = 'active' THEN 1 ELSE 0 END), 0) AS subscribedCollectionCount
      FROM workspace_emote_collections c
      LEFT JOIN workspace_emote_collection_subscriptions s ON s.collection_id = c.id
      WHERE c.user_id = ?
    `).get(actorId)
  ]);
  const activeMapped = new Set(mappedRows.map((row) => row.emoteId));
  const localPlacement = new Set(localRows.map((row) => row.emoteId));
  let itemCount = 0;
  let totalBytes = 0;
  let subscribedItemCount = 0;
  let subscribedTotalBytes = 0;
  let allTotalBytes = 0;
  for (const emote of emotes) {
    const bytes = Number(emote.byteSize) || 0;
    allTotalBytes += bytes;
    if (activeMapped.has(emote.id) && !localPlacement.has(emote.id)) {
      subscribedItemCount += 1;
      subscribedTotalBytes += bytes;
    } else {
      itemCount += 1;
      totalBytes += bytes;
    }
  }
  return {
    itemCount,
    totalBytes,
    subscribedItemCount,
    subscribedTotalBytes,
    totalItemCount: itemCount + subscribedItemCount,
    allTotalBytes,
    collectionCount: Number(collectionCounts?.collectionCount) || 0,
    subscribedCollectionCount: Number(collectionCounts?.subscribedCollectionCount) || 0,
    overLimit: totalBytes > CUSTOM_EMOTE_MAX_TOTAL_BYTES
  };
}

async function getCollectionSubscriptionRow(db, collectionId) {
  return await db.prepare(`
    SELECT s.id, s.collection_id AS collectionId, s.subscriber_user_id AS subscriberUserId,
      s.source_collection_id AS sourceCollectionId, s.source_owner_user_id AS sourceOwnerUserId,
      s.status, s.source_revision AS lastSourceRevision,
      COALESCE(source.revision, s.source_revision) AS sourceRevision,
      s.last_synced_at AS lastSyncedAt, s.detached_at AS detachedAt,
      s.created_at AS createdAt, s.updated_at AS updatedAt
    FROM workspace_emote_collection_subscriptions s
    LEFT JOIN workspace_emote_collections source ON source.id = s.source_collection_id
    WHERE s.collection_id = ?
  `).get(collectionId);
}

function publicSourceSubscription(collection, subscription) {
  const sourceCollectionId = subscription?.sourceCollectionId ?? collection?.sourceCollectionId ?? null;
  const enabled = subscription?.status === "active";
  const detached = subscription?.status === "detached";
  return {
    eligible: !detached && Boolean(sourceCollectionId),
    enabled,
    status: enabled ? "synced" : detached ? "detached" : "off",
    sourceCollectionId,
    sourceRevision: Number(subscription?.sourceRevision) || null,
    lastSyncedAt: subscription?.lastSyncedAt ?? null,
    readOnly: enabled
  };
}

function assertCollectionWritable(collection) {
  if (collection?.sourceSubscription?.enabled) {
    throw new WorkspaceError("emote.subscription_read_only", "订阅中的合集为只读", 409);
  }
}

async function assertEmoteWritable(db, actorId, emoteId) {
  const subscribed = await db.prepare(`
    SELECT 1
    FROM workspace_emote_collection_subscription_items si
    INNER JOIN workspace_emote_collection_subscriptions s ON s.id = si.subscription_id
    WHERE si.target_emote_id = ? AND s.subscriber_user_id = ? AND s.status = 'active'
    LIMIT 1
  `).get(emoteId, actorId);
  if (subscribed) throw new WorkspaceError("emote.subscription_read_only", "订阅中的表情为只读", 409);
}

async function listMutableCollectionIdsForEmote(db, actorId, emoteId) {
  const rows = await db.prepare(`
    SELECT c.id
    FROM workspace_emote_collection_items ci
    INNER JOIN workspace_emote_collections c ON c.id = ci.collection_id
    LEFT JOIN workspace_emote_collection_subscriptions s ON s.collection_id = c.id AND s.status = 'active'
    WHERE c.user_id = ? AND ci.emote_id = ? AND s.id IS NULL
  `).all(actorId, emoteId);
  return rows.map((row) => row.id);
}

async function assertCanDetachSubscription(db, actorId, sourceSubscription) {
  const subscriptionId = sourceSubscription?.id ?? "";
  if (!subscriptionId) return;
  const usage = await getEmoteUsage(db, actorId, { ignoredActiveSubscriptionId: subscriptionId });
  if (usage.totalBytes > CUSTOM_EMOTE_MAX_TOTAL_BYTES) {
    throw new WorkspaceError("emote.storage_limit_reached", "关闭订阅后将超出收藏表情空间", 409);
  }
}

async function resolveCanonicalSourceCollection(db, collectionId, expectedOwnerId = "") {
  let currentId = String(collectionId ?? "").trim();
  const seen = new Set();
  let current = null;
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    current = await db.prepare(`
      SELECT id, user_id AS userId, name, source_collection_id AS sourceCollectionId,
        original_creator_user_id AS originalCreatorUserId, revision
      FROM workspace_emote_collections WHERE id = ?
    `).get(currentId);
    if (!current) return null;
    if (!current.sourceCollectionId) break;
    currentId = current.sourceCollectionId;
  }
  if (!current || (expectedOwnerId && current.userId !== expectedOwnerId)) return null;
  return { ...current, revision: Number(current.revision) || 1 };
}

async function listCollectionItemRows(db, collectionId) {
  return await db.prepare(`
    SELECT e.*, ci.sort_order AS source_sort_order
    FROM workspace_emote_collection_items ci
    INNER JOIN workspace_custom_emotes e ON e.id = ci.emote_id
    WHERE ci.collection_id = ? AND e.removed_at IS NULL
    ORDER BY ci.sort_order ASC, ci.added_at ASC
  `).all(collectionId);
}

async function syncActorSubscriptions(db, actorId, now, retired = []) {
  const rows = await db.prepare(`
    SELECT id FROM workspace_emote_collection_subscriptions
    WHERE subscriber_user_id = ? AND status = 'active'
    ORDER BY created_at ASC
  `).all(actorId);
  for (const row of rows) {
    await db.transaction(async () => {
      await db.lock(`duallane:emote-subscription:${row.id}`);
      await syncSubscriptionInTransaction(db, row.id, now, retired);
    });
  }
}

async function syncSubscribersForSourceInTransaction(db, sourceCollectionId, now, retired = []) {
  if (!sourceCollectionId) return;
  const rows = await db.prepare(`
    SELECT id FROM workspace_emote_collection_subscriptions
    WHERE source_collection_id = ? AND status = 'active'
    ORDER BY created_at ASC
  `).all(sourceCollectionId);
  for (const row of rows) {
    await db.lock(`duallane:emote-subscription:${row.id}`);
    await syncSubscriptionInTransaction(db, row.id, now, retired);
  }
}

async function syncSubscriptionInTransaction(db, subscriptionId, now, retired = []) {
  const subscription = await db.prepare(`
    SELECT id, collection_id AS collectionId, subscriber_user_id AS subscriberUserId,
      source_collection_id AS sourceCollectionId, status, source_revision AS sourceRevision
    FROM workspace_emote_collection_subscriptions WHERE id = ?
  `).get(subscriptionId);
  if (!subscription || subscription.status !== "active") return;
  const source = await db.prepare(`
    SELECT id, user_id AS userId, name, original_creator_user_id AS originalCreatorUserId, revision
    FROM workspace_emote_collections WHERE id = ?
  `).get(subscription.sourceCollectionId);
  const date = now().toISOString();
  if (!source) {
    await db.prepare(`
      UPDATE workspace_emote_collection_subscriptions
      SET status = 'detached', detached_at = ?, updated_at = ? WHERE id = ?
    `).run(date, date, subscription.id);
    return;
  }
  if (Number(subscription.sourceRevision) === Number(source.revision)) return;
  const sourceItems = await listCollectionItemRows(db, source.id);
  if (sourceItems.length > CUSTOM_EMOTE_MAX_COLLECTION_ITEMS) {
    throw new WorkspaceError("emote.collection_limit_reached", "合集已达到 100 张上限", 409);
  }
  const mappings = await db.prepare(`
    SELECT source_emote_id AS sourceEmoteId, target_emote_id AS targetEmoteId
    FROM workspace_emote_collection_subscription_items WHERE subscription_id = ?
  `).all(subscription.id);
  const previousCollectionItems = await db.prepare(`
    SELECT emote_id AS emoteId FROM workspace_emote_collection_items WHERE collection_id = ?
  `).all(subscription.collectionId);
  const targetBySource = new Map(mappings.map((row) => [row.sourceEmoteId, row.targetEmoteId]));
  const desired = [];
  for (let index = 0; index < sourceItems.length; index += 1) {
    const sourceItem = sourceItems[index];
    let targetId = targetBySource.get(sourceItem.id);
    let target = targetId
      ? await db.prepare("SELECT * FROM workspace_custom_emotes WHERE id = ? AND user_id = ?").get(targetId, subscription.subscriberUserId)
      : null;
    if (target && await isEmoteLocallyPlaced(db, subscription.subscriberUserId, target.id)) {
      target = null;
    }
    if (!target) {
      target = await createSubscriptionTargetEmote(db, subscription.subscriberUserId, sourceItem, date);
      targetId = target.id;
    } else {
      await db.prepare("UPDATE workspace_custom_emotes SET label = ?, removed_at = NULL WHERE id = ?")
        .run(sourceItem.label, target.id);
    }
    desired.push({ sourceEmoteId: sourceItem.id, targetEmoteId: targetId, sortOrder: index });
  }
  const desiredTargets = new Set(desired.map((item) => item.targetEmoteId));
  await db.prepare("DELETE FROM workspace_emote_collection_items WHERE collection_id = ?").run(subscription.collectionId);
  await db.prepare("DELETE FROM workspace_emote_collection_subscription_items WHERE subscription_id = ?").run(subscription.id);
  for (const item of desired) {
    await db.prepare(`
      INSERT INTO workspace_emote_collection_items (collection_id, emote_id, sort_order, added_at)
      VALUES (?, ?, ?, ?)
    `).run(subscription.collectionId, item.targetEmoteId, item.sortOrder, date);
    await db.prepare(`
      INSERT INTO workspace_emote_collection_subscription_items (
        subscription_id, source_emote_id, target_emote_id, source_sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(subscription.id, item.sourceEmoteId, item.targetEmoteId, item.sortOrder, date, date);
  }
  const obsoleteTargetIds = new Set([
    ...mappings.map((mapping) => mapping.targetEmoteId),
    ...previousCollectionItems.map((item) => item.emoteId)
  ]);
  for (const targetId of obsoleteTargetIds) {
    if (desiredTargets.has(targetId)) continue;
    if (!await hasLocalOrActiveSubscriptionPlacement(db, subscription.subscriberUserId, targetId)) {
      await db.prepare("UPDATE workspace_custom_emotes SET removed_at = ? WHERE id = ? AND user_id = ?")
        .run(date, targetId, subscription.subscriberUserId);
      retired.push(await db.prepare("SELECT * FROM workspace_custom_emotes WHERE id = ?").get(targetId));
    }
  }
  await db.prepare(`
    UPDATE workspace_emote_collections
    SET name = ?, source_collection_id = ?, original_creator_user_id = ?,
      revision = revision + 1, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    source.name,
    source.id,
    source.originalCreatorUserId,
    date,
    subscription.collectionId,
    subscription.subscriberUserId
  );
  await db.prepare(`
    UPDATE workspace_emote_collection_subscriptions
    SET source_revision = ?, last_synced_at = ?, updated_at = ? WHERE id = ?
  `).run(Number(source.revision) || 1, date, date, subscription.id);
  await writeSubscriptionEvent(db, {
    actorId: source.userId,
    subscriberUserId: subscription.subscriberUserId,
    collectionId: subscription.collectionId,
    status: "synced",
    sourceRevision: Number(source.revision) || 1
  });
}

async function createSubscriptionTargetEmote(db, actorId, source, date) {
  if (source.source_type === "builtin") {
    const id = randomUUID();
    await db.prepare(`
      INSERT INTO workspace_custom_emotes (
        id, user_id, source_type, source_emote_key, label, sort_order, created_at
      ) VALUES (?, ?, 'builtin', ?, ?, 0, ?)
    `).run(id, actorId, source.source_emote_key, source.label, date);
    return await getOwnEmoteRow(db, actorId, id);
  }
  const resource = await resolveCustomEmoteResource(db, source);
  if ((!resource?.storage_object_id && !resource?.storage_key) || !source.sha256) {
    throw new WorkspaceValidationError("emote.invalid_source", "订阅表情已不可用");
  }
  const id = randomUUID();
  await db.prepare(`
    INSERT INTO workspace_custom_emotes (
      id, user_id, source_type, source_custom_emote_id, original_file_name,
      original_mime_type, label, normalized_mime_type, byte_size, width, height,
      frame_count, duration_ms, sha256, storage_key, storage_object_id,
      sort_order, created_at, removed_at
    ) VALUES (?, ?, 'custom', ?, ?, 'image/webp', ?, 'image/webp', ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, NULL)
  `).run(
    id,
    actorId,
    source.id,
    source.original_file_name || `${source.label}.webp`,
    source.label,
    source.byte_size,
    source.width,
    source.height,
    source.frame_count,
    source.duration_ms,
    source.sha256,
    resource.storage_object_id ?? null,
    date
  );
  return await getOwnEmoteRow(db, actorId, id);
}

async function hasLocalOrActiveSubscriptionPlacement(db, actorId, emoteId) {
  return Boolean(await db.prepare(`
    SELECT 1 FROM workspace_emote_library_entries WHERE user_id = ? AND emote_id = ?
    UNION ALL
    SELECT 1 FROM workspace_emote_collection_items ci
      INNER JOIN workspace_emote_collections c ON c.id = ci.collection_id
      WHERE c.user_id = ? AND ci.emote_id = ?
    UNION ALL
    SELECT 1 FROM workspace_emote_collection_subscription_items si
      INNER JOIN workspace_emote_collection_subscriptions s ON s.id = si.subscription_id
      WHERE s.subscriber_user_id = ? AND s.status = 'active' AND si.target_emote_id = ?
    LIMIT 1
  `).get(actorId, emoteId, actorId, emoteId, actorId, emoteId));
}

async function detachSubscribersForDeletedSourceInTransaction(db, sourceCollectionId, date) {
  const rows = await db.prepare(`
    SELECT id, collection_id AS collectionId, subscriber_user_id AS subscriberUserId,
      source_owner_user_id AS sourceOwnerUserId, source_revision AS sourceRevision
    FROM workspace_emote_collection_subscriptions
    WHERE source_collection_id = ? AND status IN ('active', 'off')
  `).all(sourceCollectionId);
  for (const row of rows) {
    await db.lock(`duallane:emote-subscription:${row.id}`);
    const updated = await db.prepare(`
      UPDATE workspace_emote_collection_subscriptions
      SET status = 'detached', detached_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('active', 'off')
    `).run(date, date, row.id);
    if (updated.changes !== 1) continue;
    await writeSubscriptionEvent(db, {
      actorId: row.sourceOwnerUserId,
      subscriberUserId: row.subscriberUserId,
      collectionId: row.collectionId,
      status: "detached",
      sourceRevision: Number(row.sourceRevision) || 1
    });
  }
}

async function writeSubscriptionEvent(db, {
  actorId,
  subscriberUserId,
  collectionId,
  sourceRevision,
  status
}) {
  await writeWorkspaceEvent(db, {
    type: "emote.library.updated",
    actorId,
    targetType: "user",
    targetId: subscriberUserId,
    payload: {
      userId: subscriberUserId,
      collectionId,
      sourceRevision: Number(sourceRevision) || 0,
      status
    }
  });
}

async function getShare(db, actorId, shareId) {
  const share = await db.prepare(`
    SELECT s.id, s.collection_id AS sourceCollectionId, s.snapshot_name AS name,
      s.shared_by_user_id AS sharedByUserId,
      COALESCE(sr.remark, su.nickname, su.github_login, su.display_name) AS sharedByName,
      s.original_creator_user_id AS originalCreatorUserId,
      COALESCE(orr.remark, ou.nickname, ou.github_login, ou.display_name) AS originalCreatorName,
      s.item_count AS itemCount, s.created_at AS createdAt, s.revoked_at AS revokedAt
    FROM workspace_emote_collection_shares s
    INNER JOIN users su ON su.id = s.shared_by_user_id
    INNER JOIN users ou ON ou.id = s.original_creator_user_id
    LEFT JOIN user_remarks sr ON sr.owner_user_id = ? AND sr.target_user_id = su.id
    LEFT JOIN user_remarks orr ON orr.owner_user_id = ? AND orr.target_user_id = ou.id
    WHERE s.id = ?
  `).get(actorId, actorId, String(shareId ?? "").trim());
  if (!share) throw new WorkspaceError("emote.share_not_found", "分享不存在", 404);
  const rows = await db.prepare(`
    SELECT e.* FROM workspace_emote_collection_share_items si
    INNER JOIN workspace_custom_emotes e ON e.id = si.emote_id
    WHERE si.share_id = ? ORDER BY si.sort_order ASC
  `).all(share.id);
  const canonicalSource = await resolveCanonicalSourceCollection(
    db,
    share.sourceCollectionId,
    share.originalCreatorUserId
  );
  return {
    id: share.id,
    sourceCollectionId: share.sourceCollectionId,
    name: share.name,
    itemCount: Number(share.itemCount) || rows.length,
    createdAt: share.createdAt,
    revokedAt: share.revokedAt || null,
    sharedBy: { id: share.sharedByUserId, displayName: share.sharedByName },
    originalCreator: { id: share.originalCreatorUserId, displayName: share.originalCreatorName },
    canSubscribeToSourceChanges: Boolean(canonicalSource && share.originalCreatorUserId !== actorId),
    canRevoke: share.sharedByUserId === actorId,
    items: rows.map(publicCustomEmote).filter(Boolean),
    sharePath: `/workspace/emotes/shared/${encodeURIComponent(share.id)}`
  };
}

async function isOwnedEmoteInLibrary(db, actorId, emoteId) {
  return Boolean(await db.prepare(`
    SELECT 1 FROM workspace_emote_library_entries le
    WHERE le.user_id = ? AND le.emote_id = ?
    UNION ALL
    SELECT 1 FROM workspace_emote_collection_items ci
    INNER JOIN workspace_emote_collections c ON c.id = ci.collection_id
    WHERE c.user_id = ? AND ci.emote_id = ? LIMIT 1
  `).get(actorId, emoteId, actorId, emoteId));
}

async function cleanupUnreferencedEmote(db, objectStore, storageObjects, row) {
  const cleanup = await db.transaction(async () => {
    const current = await db.prepare("SELECT * FROM workspace_custom_emotes WHERE id = ?").get(row.id);
    if (!current) return null;
    const referenced = await db.prepare(`
      SELECT 1 FROM workspace_emote_library_entries WHERE emote_id = ?
      UNION ALL SELECT 1 FROM workspace_emote_collection_items WHERE emote_id = ?
      UNION ALL SELECT 1 FROM message_custom_emotes WHERE custom_emote_id = ?
      UNION ALL SELECT 1 FROM workspace_custom_emotes WHERE source_custom_emote_id = ?
      UNION ALL SELECT 1 FROM workspace_emote_collection_share_items si
        INNER JOIN workspace_emote_collection_shares s ON s.id = si.share_id
        WHERE si.emote_id = ? AND s.revoked_at IS NULL
      LIMIT 1
    `).get(current.id, current.id, current.id, current.id, current.id);
    if (referenced) return null;
    const source = current.source_custom_emote_id
      ? await db.prepare("SELECT * FROM workspace_custom_emotes WHERE id = ?").get(current.source_custom_emote_id)
      : null;
    await db.prepare("DELETE FROM workspace_custom_emotes WHERE id = ?").run(current.id);
    return { current, source };
  });
  if (!cleanup) return false;
  if (cleanup.current.storage_key) {
    await objectStore.removeCustomEmote(toLegacyObjectStoreEmote(cleanup.current));
  }
  if (cleanup.current.storage_object_id) {
    await storageObjects.cleanupIfUnreferenced(cleanup.current.storage_object_id);
  }
  if (cleanup.source?.removed_at) {
    await cleanupUnreferencedEmote(db, objectStore, storageObjects, cleanup.source);
  }
  return true;
}

async function resolveCustomEmoteResource(db, row) {
  let current = row;
  const seen = new Set();
  while (current && !current.storage_object_id && !current.storage_key && current.source_custom_emote_id) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    current = await db.prepare("SELECT * FROM workspace_custom_emotes WHERE id = ?")
      .get(current.source_custom_emote_id);
  }
  return current?.storage_object_id || current?.storage_key ? current : null;
}

function normalizeCollectionName(value) {
  const normalized = String(value ?? "").toWellFormed().trim();
  if (!normalized || Array.from(normalized).length > 32 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new WorkspaceValidationError("emote.invalid_collection_name", "合集名称需为 1 至 32 个字符");
  }
  return normalized;
}

function uniqueIds(values) {
  return [...new Set(Array.isArray(values) ? values.map((value) => String(value ?? "").trim()).filter(Boolean) : [])];
}

async function toObjectStoreEmote(storageObjects, row) {
  let storageObject;
  if (row.storage_object_id) {
    try {
      storageObject = await storageObjects.loadObjectById(row.storage_object_id);
    } catch (error) {
      if (!row.storage_key || error?.code !== "storage.object_not_found") throw error;
    }
  }
  return { ...toLegacyObjectStoreEmote(row), storageObject };
}

function toLegacyObjectStoreEmote(row) {
  return {
    id: row.id,
    userId: row.user_id,
    storageKey: row.storage_key,
    byteSize: row.byte_size
  };
}

function normalizeEnabledPackIds(value, availablePacks) {
  const fallback = availablePacks.filter((pack) => pack.defaultEnabled !== false).map((pack) => pack.id);
  try {
    const parsed = JSON.parse(value ?? "null");
    const allowed = new Set(availablePacks.map((pack) => pack.id));
    const normalized = [...new Set(Array.isArray(parsed) ? parsed.map(String) : [])].filter((id) => allowed.has(id));
    return normalized.length > 0 ? normalized : fallback;
  } catch {
    return fallback;
  }
}

function safeContent(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && Array.isArray(parsed.blocks) ? parsed : { blocks: [] };
  } catch {
    return { blocks: [] };
  }
}

function messageContainsBuiltinEmote(content, emote) {
  const tokens = new Set([emote.token, `[${emote.packId}:${emote.id}]`]);
  return content.blocks.some((block) => block?.type === "text" && [...tokens].some((token) => String(block.text).includes(token)));
}

function messageContainsCustomEmote(content, customEmoteId) {
  return /^[a-f0-9-]{36}$/i.test(customEmoteId) && content.blocks.some((block) =>
    block?.type === "emoji" && block.shortcode === `custom:${customEmoteId}`
  );
}

async function readLimitedStream(stream, maxBytes) {
  if (!stream || typeof stream.pipe !== "function") throw new WorkspaceValidationError("emote.invalid_content", "表情图片不能为空");
  const chunks = [];
  let byteSize = 0;
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += buffer.byteLength;
      if (byteSize > maxBytes) {
        callback(new WorkspaceError("emote.input_too_large", "表情原图不能超过 10 MiB", 413));
        return;
      }
      chunks.push(buffer);
      callback();
    }
  });
  await pipeline(stream, collector);
  if (byteSize < 1) throw new WorkspaceValidationError("emote.invalid_content", "表情图片不能为空");
  return Buffer.concat(chunks, byteSize);
}

function normalizeFileName(value) {
  const decoded = String(value ?? "").toWellFormed().trim();
  if (/[\u0000-\u001f\u007f]/.test(decoded)) {
    throw new WorkspaceValidationError("emote.invalid_file_name", "表情文件名无效");
  }
  const baseName = path.basename(decoded.replace(/\\/g, "/")) || "收藏表情";
  return Array.from(baseName).slice(0, 255).join("");
}

function normalizeLabel(fileName, animated = false) {
  const base = path.basename(normalizeFileName(fileName)).replace(/\.[^.]+$/, "").trim();
  const compact = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const generic = /^(?:img|image|photo|screenshot|screen shot|wx camera|mmexport|pxl|dsc|download|file)(?:\s*[a-z0-9]+)*$/i.test(compact)
    || /^[a-f0-9-]{20,}$/i.test(compact)
    || /^\d{8,}$/.test(compact);
  return Array.from(!compact || generic ? (animated ? "动态表情" : "自定义表情") : compact).slice(0, 16).join("");
}

function normalizeEmoteLabel(value) {
  const normalized = String(value ?? "").toWellFormed().trim();
  if (!normalized || Array.from(normalized).length > 16 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new WorkspaceValidationError("emote.invalid_label", "表情名称应为 1 至 16 个有效字符");
  }
  return normalized;
}

function formatMimeType(format) {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}
