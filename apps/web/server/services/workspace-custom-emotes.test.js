import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import { listWorkspaceEvents } from "./workspace.mjs";
import { createWorkspaceCustomEmoteService } from "./workspace-custom-emotes.mjs";
import { createWorkspaceStorageObjectRegistry } from "./workspace-storage-objects.mjs";

describe("workspace custom emotes", () => {
  const cleanups = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async ({ db, directory }) => {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it("keeps at least one visible built-in pack", async () => {
    const { service } = await fixture();
    const defaults = await service.getSettings("usr_owner");
    expect(defaults.availablePacks.map((pack) => pack.id)).toEqual(expect.arrayContaining([
      "xiaohongshu",
      "heybox",
      "tieba"
    ]));
    expect(defaults.enabledPackIds).toEqual(["emoji", "bili", "wechat", "feishu"]);
    expect(defaults.clickImageEmoteToSend).toBe(false);
    await expect(service.updateSettings("usr_owner", [])).rejects.toMatchObject({ code: "emote.pack_required" });

    const updated = await service.updateSettings("usr_owner", ["emoji", "xiaohongshu"]);
    expect(updated.enabledPackIds).toEqual(["emoji", "xiaohongshu"]);
    const directSend = await service.updateSettings("usr_owner", { clickImageEmoteToSend: true });
    expect(directSend).toMatchObject({
      enabledPackIds: ["emoji", "xiaohongshu"],
      clickImageEmoteToSend: true
    });
    expect(await service.getSettings("usr_owner")).toMatchObject({
      enabledPackIds: ["emoji", "xiaohongshu"],
      clickImageEmoteToSend: true
    });
    await expect(service.updateSettings("usr_owner", { clickImageEmoteToSend: "yes" }))
      .rejects.toMatchObject({ code: "emote.invalid_settings" });
  });

  it("normalizes uploaded images to WebP, deduplicates them, and removes the owned copy", async () => {
    const { service, db, stored, removed, storedBytesFor, storageObjectIdFor } = await fixture();
    const png = await sharp({
      create: { width: 48, height: 32, channels: 4, background: { r: 20, g: 150, b: 130, alpha: 0.7 } }
    }).png().toBuffer();
    const first = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(png),
      contentType: "image/png",
      fileName: "wave.png"
    });
    const canonicalStorageObjectId = storageObjectIdFor(first.id);
    db.prepare("UPDATE workspace_custom_emotes SET storage_key = 'legacy/custom.webp', storage_object_id = NULL WHERE id = ?")
      .run(first.id);
    const duplicate = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(png),
      contentType: "image/png",
      fileName: "wave-copy.png"
    });

    expect(first).toMatchObject({ kind: "custom", label: "wave", animated: false });
    expect(first.src).toContain(`/api/workspace/emotes/${first.id}/content`);
    expect(duplicate.id).toBe(first.id);
    expect(storageObjectIdFor(first.id)).toBe(canonicalStorageObjectId);
    expect(stored.size).toBe(1);
    const normalized = storedBytesFor(first.id);
    expect((await sharp(normalized).metadata()).format).toBe("webp");
    expect((await service.list("usr_owner")).items).toHaveLength(1);

    const storageObjectId = storageObjectIdFor(first.id);
    await service.remove("usr_owner", first.id);
    expect(removed).toContain(storageObjectId);
    expect((await service.list("usr_owner")).items).toEqual([]);
  });

  it("accepts BMP uploads and normalizes them to WebP", async () => {
    const { service, storedBytesFor } = await fixture();
    const bmp = createOnePixelBmp();
    const emote = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(bmp),
      contentType: "image/bmp",
      fileName: "pixel.bmp"
    });

    expect(emote).toMatchObject({ kind: "custom", label: "pixel", animated: false });
    expect((await sharp(storedBytesFor(emote.id)).metadata()).format).toBe("webp");
  });

  it("uses short readable labels and lets owners rename an emote", async () => {
    const { service } = await fixture();
    const png = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 90, g: 120, b: 210, alpha: 1 } }
    }).png().toBuffer();
    const uploaded = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(png),
      contentType: "image/png",
      fileName: "Screenshot_20260812_183433.png"
    });

    expect(uploaded.label).toBe("自定义表情");
    await expect(service.update("usr_owner", uploaded.id, { label: "  开心蓝脸  " }))
      .resolves.toMatchObject({ id: uploaded.id, label: "开心蓝脸" });
    await expect(service.update("usr_owner", uploaded.id, { label: "" }))
      .rejects.toMatchObject({ code: "emote.invalid_label" });
  });

  it("accepts practical animated GIFs above the previous 60-frame limit", async () => {
    const { service, db, storedBytesFor } = await fixture();
    const gif = await createAnimatedGif({ frameCount: 75, delayMs: 100 });
    const emote = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(gif),
      contentType: "image/gif",
      fileName: "animated-cat.gif"
    });

    expect(emote).toMatchObject({
      kind: "custom",
      label: "animated cat",
      animated: true
    });
    expect(db.prepare(`
      SELECT frame_count AS frameCount, duration_ms AS durationMs
      FROM workspace_custom_emotes WHERE id = ?
    `).get(emote.id)).toEqual({ frameCount: 75, durationMs: 7500 });
    expect(await sharp(storedBytesFor(emote.id), { animated: true }).metadata()).toMatchObject({
      format: "webp",
      pages: 75
    });
  });

  it("rejects unsupported input types before image processing", async () => {
    const { service } = await fixture();
    await expect(service.upload({
      actorId: "usr_owner",
      stream: Readable.from(Buffer.from("not an image")),
      contentType: "image/svg+xml",
      fileName: "unsafe.svg"
    })).rejects.toMatchObject({ code: "emote.invalid_format" });
  });

  it("rejects control characters in source file names", async () => {
    const { service } = await fixture();
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 20, g: 150, b: 130, alpha: 1 } }
    }).png().toBuffer();
    await expect(service.upload({
      actorId: "usr_owner",
      stream: Readable.from(png),
      contentType: "image/png",
      fileName: "unsafe\rname.png"
    })).rejects.toMatchObject({ code: "emote.invalid_file_name" });
  });

  it("places newly added emotes and collections at the front of the library", async () => {
    const { service } = await fixture();
    const first = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "first.bmp"
    });
    const secondPng = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 40, g: 120, b: 200, alpha: 1 } }
    }).png().toBuffer();
    const second = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(secondPng),
      contentType: "image/png",
      fileName: "second.png"
    });

    expect((await service.getLibrary("usr_owner")).entries.map((entry) => entry.emote?.id))
      .toEqual([second.id, first.id]);

    const collection = await service.createCollection("usr_owner", { name: "置顶合集", emoteIds: [first.id] });
    let library = await service.getLibrary("usr_owner");
    expect(library.entries[0]).toMatchObject({ type: "collection", collection: { id: collection.id } });

    const preservedEntryIds = [library.entries[2].id, library.entries[1].id, library.entries[0].id];
    await service.reorderLibrary("usr_owner", preservedEntryIds);
    const thirdPng = await sharp({
      create: { width: 5, height: 5, channels: 4, background: { r: 190, g: 70, b: 90, alpha: 1 } }
    }).png().toBuffer();
    const third = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(thirdPng),
      contentType: "image/png",
      fileName: "third.png"
    });
    library = await service.getLibrary("usr_owner");
    expect(library.entries[0]).toMatchObject({ type: "emote", emote: { id: third.id } });
    expect(library.entries.slice(1).map((entry) => entry.id)).toEqual(preservedEntryIds);
    expect((await service.list("usr_owner")).items[0].id).toBe(third.id);
  });

  it("reuses normalized custom-emote resources when another member favorites them", async () => {
    const { service, db, stored, removed, storageObjectIdFor } = await fixture({ member: true });
    const now = new Date().toISOString();
    seedVisibleEmoteMessage(db, now);
    const source = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "source.bmp"
    });
    const content = {
      format: "duallane.message+json;v=1",
      plainText: "[表情]",
      blocks: [{ type: "emoji", shortcode: `custom:${source.id}` }]
    };
    db.prepare(`
      INSERT INTO messages (
        id, space_id, conversation_id, author_id, author_kind, kind, client_message_id,
        content_format, content_json, plain_text, reply_to_message_id, created_at, edited_at, deleted_at
      ) VALUES ('msg_emote', 'spc_default', 'con_emote', 'usr_owner', 'human', 'user', 'client-emote',
        'duallane.message+json;v=1', ?, '[表情]', NULL, ?, NULL, NULL)
    `).run(JSON.stringify(content), now);
    db.prepare("INSERT INTO message_custom_emotes (message_id, custom_emote_id) VALUES ('msg_emote', ?)").run(source.id);

    const favorite = await service.favoriteFromMessage({
      actorId: "usr_member",
      messageId: "msg_emote",
      customEmoteId: source.id
    });
    expect(favorite.id).not.toBe(source.id);
    const sharedStorageObjectId = storageObjectIdFor(source.id);
    expect(storageObjectIdFor(favorite.id)).toBe(sharedStorageObjectId);
    expect(favorite.originalMimeType).toBe("image/webp");
    expect(stored.size).toBe(1);
    expect(db.prepare(`
      SELECT source_custom_emote_id AS sourceCustomEmoteId, storage_key AS storageKey
      FROM workspace_custom_emotes WHERE id = ?
    `).get(favorite.id)).toEqual({ sourceCustomEmoteId: source.id, storageKey: null });

    db.prepare("DELETE FROM message_custom_emotes WHERE message_id = 'msg_emote'").run();
    await service.remove("usr_owner", source.id);
    expect(removed).not.toContain(sharedStorageObjectId);
    expect(db.prepare("SELECT removed_at AS removedAt FROM workspace_custom_emotes WHERE id = ?")
      .get(source.id).removedAt).toBeTruthy();
    await expect(service.validateMessageCustomEmote("usr_member", favorite.id)).resolves.toMatchObject({ id: favorite.id });
    expect(await service.getDelivery("usr_member", favorite.id)).toMatchObject({ kind: "buffer" });

    await service.remove("usr_member", favorite.id);
    expect(removed).toContain(sharedStorageObjectId);
    expect(stored.size).toBe(0);
  });

  it("releases subscribed aliases and deletes canonical bytes only after the last reference", async () => {
    const { service, db, stored, removed, storageObjects, storageObjectIdFor } = await fixture({ member: true });
    const sourceEmote = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "shared-cas.bmp"
    });
    const storageObjectId = storageObjectIdFor(sourceEmote.id);
    const source = await service.createCollection("usr_owner", { name: "Shared CAS", emoteIds: [sourceEmote.id] });
    const share = await service.createCollectionShare("usr_owner", source.id);
    const subscribed = await service.importCollectionShare("usr_member", share.id, { subscribeToSourceChanges: true });
    const targetId = subscribed.collection.items[0].id;

    expect(storageObjectIdFor(targetId)).toBe(storageObjectId);
    expect(stored.size).toBe(1);
    await expect(storageObjects.countReferences(storageObjectId)).resolves.toBe(2);

    await service.remove("usr_owner", sourceEmote.id);
    expect(db.prepare("SELECT 1 FROM workspace_custom_emotes WHERE id = ?").get(targetId)).toBeUndefined();
    expect(stored.size).toBe(1);
    expect(removed).not.toContain(storageObjectId);
    await expect(storageObjects.countReferences(storageObjectId)).resolves.toBe(1);

    await service.revokeCollectionShare("usr_owner", share.id);
    expect(stored.size).toBe(0);
    expect(removed).toContain(storageObjectId);
    expect(db.prepare("SELECT 1 FROM workspace_custom_emotes WHERE id = ?").get(sourceEmote.id)).toBeUndefined();
  });

  it("shares immutable collection snapshots and imports them by resource reference", async () => {
    const { service, db, stored, removed, storageObjectIdFor } = await fixture({ member: true });
    const first = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "first.bmp"
    });
    const secondPng = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 10, g: 80, b: 220, alpha: 1 } }
    }).png().toBuffer();
    const second = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(secondPng),
      contentType: "image/png",
      fileName: "second.png"
    });
    const firstStorageObjectId = storageObjectIdFor(first.id);
    const collection = await service.createCollection("usr_owner", { name: "常用", emoteIds: [first.id, second.id] });
    const firstShare = await service.createCollectionShare("usr_owner", collection.id);
    const reusedShare = await service.createCollectionShare("usr_owner", collection.id);
    expect(reusedShare.id).toBe(firstShare.id);

    await service.reorderCollection("usr_owner", collection.id, [second.id, first.id]);
    const changedShare = await service.createCollectionShare("usr_owner", collection.id);
    expect(changedShare.id).not.toBe(firstShare.id);
    expect(changedShare.items.map((item) => item.id)).toEqual([second.id, first.id]);

    const imported = await service.importCollectionShare("usr_member", changedShare.id);
    expect(imported.collection).toMatchObject({ name: "常用", itemCount: 2 });
    expect(imported.items).toHaveLength(2);
    expect(stored.size).toBe(2);
    for (const item of imported.items) {
      expect(db.prepare(`
        SELECT source_custom_emote_id AS sourceCustomEmoteId, storage_key AS storageKey
        FROM workspace_custom_emotes WHERE id = ?
      `).get(item.id)).toMatchObject({ storageKey: null });
      expect(await service.getDelivery("usr_member", item.id)).toMatchObject({ kind: "buffer" });
    }

    await service.remove("usr_owner", first.id);
    expect(removed).not.toContain(firstStorageObjectId);
    await service.revokeCollectionShare("usr_owner", firstShare.id);
    await service.revokeCollectionShare("usr_owner", changedShare.id);
    expect(removed).not.toContain(firstStorageObjectId);
  });

  it("keeps snapshots local while atomically syncing canonical source subscriptions", async () => {
    const { service, db, stored } = await fixture({ member: true });
    const first = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "owner-first.bmp"
    });
    const secondBytes = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 15, g: 90, b: 220, alpha: 1 } }
    }).png().toBuffer();
    const second = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(secondBytes),
      contentType: "image/png",
      fileName: "owner-second.png"
    });
    const sourceStorageObjectId = db.prepare("SELECT storage_object_id AS storageObjectId FROM workspace_custom_emotes WHERE id = ?")
      .get(first.id).storageObjectId;
    const source = await service.createCollection("usr_owner", {
      name: "原作者合集",
      emoteIds: [first.id, second.id]
    });
    const share = await service.createCollectionShare("usr_owner", source.id);
    expect((await service.getCollectionShare("usr_member", share.id)).canSubscribeToSourceChanges).toBe(true);

    const snapshot = await service.importCollectionShare("usr_member", share.id);
    const subscribed = await service.importCollectionShare("usr_member", share.id, {
      subscribeToSourceChanges: true
    });
    expect(snapshot.collection.sourceSubscription).toMatchObject({ eligible: true, enabled: false, status: "off", readOnly: false });
    expect(subscribed.collection.sourceSubscription).toMatchObject({ eligible: true, enabled: true, status: "synced", readOnly: true });
    expect(subscribed.collection.items.map((item) => item.id)).not.toEqual(snapshot.collection.items.map((item) => item.id));
    expect(stored.size).toBe(2);
    expect(db.prepare("SELECT storage_object_id AS storageObjectId FROM workspace_custom_emotes WHERE id = ?")
      .get(subscribed.collection.items[0].id).storageObjectId).toBe(sourceStorageObjectId);

    const initialLibrary = await service.getLibrary("usr_member");
    expect(initialLibrary.limits).toMatchObject({ maxItems: null, maxCollections: null, maxTotalBytes: 1024 ** 3, maxCollectionItems: 100 });
    expect(initialLibrary.usage).toMatchObject({
      itemCount: 2,
      subscribedItemCount: 2,
      subscribedCollectionCount: 1,
      overLimit: false
    });

    const subscribedFirstId = subscribed.collection.items[0].id;
    await expect(service.update("usr_member", subscribedFirstId, { label: "不能修改" }))
      .rejects.toMatchObject({ code: "emote.subscription_read_only" });
    await expect(service.updateCollection("usr_member", subscribed.collection.id, { name: "不能改名" }))
      .rejects.toMatchObject({ code: "emote.subscription_read_only" });

    await service.updateCollection("usr_owner", source.id, { name: "同步后的名称" });
    await service.update("usr_owner", first.id, { label: "源短名称" });
    await service.removeCollectionItem("usr_owner", source.id, second.id);
    const thirdBytes = await sharp({
      create: { width: 5, height: 5, channels: 4, background: { r: 190, g: 40, b: 80, alpha: 1 } }
    }).png().toBuffer();
    const third = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(thirdBytes),
      contentType: "image/png",
      fileName: "owner-third.png",
      collectionId: source.id,
      addToLibrary: false
    });
    await service.reorderCollection("usr_owner", source.id, [third.id, first.id]);
    await service.revokeCollectionShare("usr_owner", share.id);
    await service.updateCollection("usr_owner", source.id, { name: "撤销分享后仍同步" });

    const afterSync = await service.getLibrary("usr_member");
    const syncedCollection = afterSync.collections.find((collection) => collection.id === subscribed.collection.id);
    const snapshotCollection = afterSync.collections.find((collection) => collection.id === snapshot.collection.id);
    expect(syncedCollection).toMatchObject({ name: "撤销分享后仍同步", itemCount: 2 });
    expect(syncedCollection.items.map((item) => item.label)).toEqual(["owner third", "源短名称"]);
    expect(snapshotCollection).toMatchObject({ name: "原作者合集", itemCount: 2 });
    expect(snapshotCollection.items[0]).toMatchObject({ label: "owner first" });

    const switchedOff = await service.updateCollectionSourceSubscription("usr_member", subscribed.collection.id, { enabled: false });
    expect(switchedOff.collection.sourceSubscription)
      .toMatchObject({ eligible: true, enabled: false, status: "off", readOnly: false });
    const switchedOn = await service.updateCollectionSourceSubscription("usr_member", subscribed.collection.id, { enabled: true });
    expect(switchedOn.collection.sourceSubscription)
      .toMatchObject({ eligible: true, enabled: true, status: "synced", readOnly: true });

    const memberEvents = (await listWorkspaceEvents(db, "usr_member", 0))
      .filter((event) => event.type === "emote.library.updated" && event.targetId === "usr_member");
    expect(memberEvents.length).toBeGreaterThan(0);
    expect(memberEvents.at(-1).payload).toEqual({
      userId: "usr_member",
      collectionId: subscribed.collection.id,
      sourceRevision: expect.any(Number),
      status: "synced"
    });
    expect((await listWorkspaceEvents(db, "usr_owner", 0))
      .some((event) => event.type === "emote.library.updated" && event.targetId === "usr_member")).toBe(false);
  });

  it("preflights manual detach but preserves an over-limit snapshot when the source is deleted", async () => {
    const { service, db } = await fixture({ member: true });
    const sourceEmote = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "large-source.bmp"
    });
    const source = await service.createCollection("usr_owner", { name: "会删除", emoteIds: [sourceEmote.id] });
    const share = await service.createCollectionShare("usr_owner", source.id);
    const subscribed = await service.importCollectionShare("usr_member", share.id, { subscribeToSourceChanges: true });
    const local = await service.upload({
      actorId: "usr_member",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "subscriber-local-alias.bmp"
    });
    expect(local.id).not.toBe(subscribed.collection.items[0].id);
    await service.update("usr_owner", sourceEmote.id, { label: "source renamed" });
    expect(await service.validateMessageCustomEmote("usr_member", local.id)).toMatchObject({ label: "subscriber local" });
    db.prepare("UPDATE workspace_custom_emotes SET byte_size = ? WHERE id = ?")
      .run(1024 ** 3, subscribed.collection.items[0].id);

    await expect(service.updateCollectionSourceSubscription("usr_member", subscribed.collection.id, { enabled: false }))
      .rejects.toMatchObject({ code: "emote.storage_limit_reached" });
    await service.deleteCollection("usr_owner", source.id, "keep");
    const detached = await service.getLibrary("usr_member");
    expect(detached.collections.find((collection) => collection.id === subscribed.collection.id)?.sourceSubscription)
      .toMatchObject({ eligible: false, enabled: false, status: "detached", readOnly: false });
    expect(detached.usage).toMatchObject({ overLimit: true, subscribedItemCount: 0 });
    await expect(service.upload({
      actorId: "usr_member",
      stream: Readable.from(await sharp({
        create: { width: 3, height: 3, channels: 4, background: { r: 9, g: 8, b: 7, alpha: 1 } }
      }).png().toBuffer()),
      contentType: "image/png",
      fileName: "blocked.png"
    })).rejects.toMatchObject({ code: "emote.storage_limit_reached" });
    expect(await service.validateMessageCustomEmote("usr_member", subscribed.collection.items[0].id))
      .toMatchObject({ id: subscribed.collection.items[0].id });
    expect(local.id).toBeTruthy();
  });

  it("detaches an off subscription when its canonical source is deleted", async () => {
    const { service } = await fixture({ member: true });
    const sourceEmote = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "off-source.bmp"
    });
    const source = await service.createCollection("usr_owner", { name: "Off source", emoteIds: [sourceEmote.id] });
    const share = await service.createCollectionShare("usr_owner", source.id);
    const imported = await service.importCollectionShare("usr_member", share.id, { subscribeToSourceChanges: true });
    await service.updateCollectionSourceSubscription("usr_member", imported.collection.id, { enabled: false });

    await service.deleteCollection("usr_owner", source.id, "keep");

    const collection = (await service.getLibrary("usr_member")).collections
      .find((item) => item.id === imported.collection.id);
    expect(collection.sourceSubscription)
      .toMatchObject({ eligible: false, enabled: false, status: "detached", readOnly: false });
    expect((await service.getCollectionShare("usr_member", share.id)).canSubscribeToSourceChanges).toBe(false);
  });

  it("resolves a re-shared subscription to the canonical original collection", async () => {
    const { service, db } = await fixture({ member: true });
    seedMember(db, "usr_second", "second");
    const emote = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "canonical.bmp"
    });
    const source = await service.createCollection("usr_owner", { name: "Canonical", emoteIds: [emote.id] });
    const firstShare = await service.createCollectionShare("usr_owner", source.id);
    const firstImport = await service.importCollectionShare("usr_member", firstShare.id, { subscribeToSourceChanges: true });
    const relayShare = await service.createCollectionShare("usr_member", firstImport.collection.id);
    const relayProjection = await service.getCollectionShare("usr_second", relayShare.id);
    expect(relayProjection.canSubscribeToSourceChanges).toBe(true);
    const secondImport = await service.importCollectionShare("usr_second", relayShare.id, { subscribeToSourceChanges: true });
    expect(secondImport.collection).toMatchObject({
      originalCreatorUserId: "usr_owner",
      sourceSubscription: { sourceCollectionId: source.id, enabled: true, status: "synced" }
    });
    await service.updateCollection("usr_owner", source.id, { name: "Canonical updated" });
    expect((await service.getLibrary("usr_second")).collections
      .find((collection) => collection.id === secondImport.collection.id)?.name).toBe("Canonical updated");
  });

  it("rolls back a source mutation when subscriber projection fanout fails", async () => {
    const { service, db } = await fixture({ member: true });
    const emote = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "atomic.bmp"
    });
    const source = await service.createCollection("usr_owner", { name: "Atomic source", emoteIds: [emote.id] });
    const share = await service.createCollectionShare("usr_owner", source.id);
    const subscribed = await service.importCollectionShare("usr_member", share.id, { subscribeToSourceChanges: true });
    const before = db.prepare("SELECT name, revision FROM workspace_emote_collections WHERE id = ?").get(source.id);
    db.exec(`
      CREATE TRIGGER reject_subscription_projection
      BEFORE UPDATE ON workspace_emote_collections
      WHEN OLD.id = '${subscribed.collection.id}'
      BEGIN
        SELECT RAISE(ABORT, 'subscription projection rejected');
      END
    `);

    await expect(service.updateCollection("usr_owner", source.id, { name: "Must roll back" }))
      .rejects.toThrow("subscription projection rejected");
    expect(db.prepare("SELECT name, revision FROM workspace_emote_collections WHERE id = ?").get(source.id))
      .toEqual(before);
  });

  it("serializes source fanout with manual subscription off and enable", async () => {
    const { service, db } = await fixture({ member: true });
    const emote = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "concurrent.bmp"
    });
    const source = await service.createCollection("usr_owner", { name: "Concurrent source", emoteIds: [emote.id] });
    const share = await service.createCollectionShare("usr_owner", source.id);
    const imported = await service.importCollectionShare("usr_member", share.id, { subscribeToSourceChanges: true });
    const subscriptionId = db.prepare(`
      SELECT id FROM workspace_emote_collection_subscriptions WHERE collection_id = ?
    `).get(imported.collection.id).id;
    const subscriptionLock = `duallane:emote-subscription:${subscriptionId}`;
    const acquiredLocks = [];
    const originalLock = db.lock;
    let releaseSourceFanout;
    let sourceFanoutBlocked = false;
    const sourceFanoutGate = new Promise((resolve) => { releaseSourceFanout = resolve; });
    let markSourceFanoutEntered;
    const sourceFanoutEntered = new Promise((resolve) => { markSourceFanoutEntered = resolve; });
    db.lock = async (key) => {
      acquiredLocks.push(key);
      if (key === subscriptionLock && !sourceFanoutBlocked) {
        sourceFanoutBlocked = true;
        markSourceFanoutEntered();
        await sourceFanoutGate;
      }
      return await originalLock(key);
    };

    const sourceMutation = service.updateCollection("usr_owner", source.id, { name: "Concurrent latest" });
    await sourceFanoutEntered;
    const manualOff = service.updateCollectionSourceSubscription("usr_member", imported.collection.id, { enabled: false });
    releaseSourceFanout();
    await Promise.all([sourceMutation, manualOff]);

    let projection = (await service.getLibrary("usr_member")).collections
      .find((collection) => collection.id === imported.collection.id);
    expect(projection).toMatchObject({
      name: "Concurrent latest",
      sourceSubscription: { enabled: false, status: "off", eligible: true, readOnly: false }
    });
    expect(acquiredLocks.filter((key) => key === subscriptionLock).length).toBeGreaterThanOrEqual(2);

    await service.updateCollectionSourceSubscription("usr_member", imported.collection.id, { enabled: true });
    projection = (await service.getLibrary("usr_member")).collections
      .find((collection) => collection.id === imported.collection.id);
    expect(projection.sourceSubscription).toMatchObject({ enabled: true, status: "synced", readOnly: true });
    expect(acquiredLocks.filter((key) => key === subscriptionLock).length).toBeGreaterThanOrEqual(3);
  });

  it("allows more than 20 collections and more than 500 locally metered emotes", async () => {
    const { service, db } = await fixture();
    for (let index = 0; index < 21; index += 1) {
      await service.createCollection("usr_owner", { name: `Collection ${index + 1}` });
    }
    seedSyntheticEmotes(db, { count: 501, addToLibrary: true });

    const uploaded = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "item-502.bmp"
    });
    const library = await service.getLibrary("usr_owner");
    expect(uploaded.id).toBeTruthy();
    expect(library.usage).toMatchObject({ collectionCount: 21, itemCount: 502, overLimit: false });
    expect(library.limits).toMatchObject({ maxCollections: null, maxItems: null });
  });

  it("rejects the 101st item in one collection with a stable conflict", async () => {
    const { service, db } = await fixture();
    const emoteIds = seedSyntheticEmotes(db, { count: 101 });
    const collection = await service.createCollection("usr_owner", {
      name: "Full collection",
      emoteIds: emoteIds.slice(0, 100)
    });

    await expect(service.addCollectionItems("usr_owner", collection.id, [emoteIds[100]]))
      .rejects.toMatchObject({ code: "emote.collection_limit_reached", statusCode: 409 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_emote_collection_items WHERE collection_id = ?")
      .get(collection.id).count).toBe(100);
  });

  it("allows exactly 1 GiB when disabling a subscription and rejects one byte more", async () => {
    const { service, db } = await fixture({ member: true });
    const sourceEmote = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "quota-source.bmp"
    });
    const source = await service.createCollection("usr_owner", { name: "Quota source", emoteIds: [sourceEmote.id] });
    const share = await service.createCollectionShare("usr_owner", source.id);
    const subscribed = await service.importCollectionShare("usr_member", share.id, { subscribeToSourceChanges: true });
    const firstTargetId = subscribed.collection.items[0].id;
    db.prepare("UPDATE workspace_custom_emotes SET byte_size = ? WHERE id = ?")
      .run(1024 ** 3, firstTargetId);

    await expect(service.updateCollectionSourceSubscription("usr_member", subscribed.collection.id, { enabled: false }))
      .resolves.toMatchObject({ collection: { sourceSubscription: { status: "off", eligible: true } } });
    expect((await service.getLibrary("usr_member")).usage).toMatchObject({ totalBytes: 1024 ** 3, overLimit: false });

    const date = new Date().toISOString();
    db.prepare(`
      INSERT INTO workspace_emote_library_entries (
        id, user_id, entry_type, emote_id, collection_id, sort_order, created_at
      ) VALUES ('entry_quota_local', 'usr_member', 'emote', ?, NULL, -1, ?)
    `).run(firstTargetId, date);
    const reenabled = await service.updateCollectionSourceSubscription("usr_member", subscribed.collection.id, { enabled: true });
    const secondTargetId = reenabled.collection.items[0].id;
    expect(secondTargetId).not.toBe(firstTargetId);
    db.prepare("UPDATE workspace_custom_emotes SET byte_size = 1 WHERE id = ?").run(secondTargetId);

    await expect(service.updateCollectionSourceSubscription("usr_member", subscribed.collection.id, { enabled: false }))
      .rejects.toMatchObject({ code: "emote.storage_limit_reached", statusCode: 409 });
    expect((await service.getLibrary("usr_member")).usage).toMatchObject({
      totalBytes: 1024 ** 3,
      subscribedTotalBytes: 1,
      overLimit: false
    });
  });

  it("rolls back collection import when a snapshot item is unavailable", async () => {
    const { service, db } = await fixture({ member: true });
    const source = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(createOnePixelBmp()),
      contentType: "image/bmp",
      fileName: "source.bmp"
    });
    const collection = await service.createCollection("usr_owner", { name: "不完整", emoteIds: [source.id] });
    const share = await service.createCollectionShare("usr_owner", collection.id);
    db.prepare("UPDATE workspace_custom_emotes SET storage_key = NULL, storage_object_id = NULL WHERE id = ?").run(source.id);

    await expect(service.importCollectionShare("usr_member", share.id)).rejects.toMatchObject({ code: "emote.invalid_source" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_emote_collections WHERE user_id = 'usr_member'").get().count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_custom_emotes WHERE user_id = 'usr_member'").get().count).toBe(0);
  });

  async function fixture({ member = false } = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-emotes-"));
    const db = openTestDatabase(directory);
    if (member) seedMember(db);
    const stored = new Map();
    const removed = [];
    const objectStore = {
      async ensureObject(item) {
        if (stored.has(item.sha256)) return { ...item, created: false };
        const chunks = [];
        for await (const chunk of item.stream) chunks.push(Buffer.from(chunk));
        const buffer = Buffer.concat(chunks);
        if (buffer.byteLength !== item.byteSize || createHash("sha256").update(buffer).digest("hex") !== item.sha256) {
          throw new Error("canonical object mismatch");
        }
        stored.set(item.sha256, buffer);
        return { ...item, created: true };
      },
      async deleteObject(item) {
        removed.push(item.id);
        stored.delete(item.sha256);
      },
      async removeCustomEmote(item) {
        removed.push(item.id);
      },
      async getCustomEmoteDelivery(item) {
        const buffer = item.storageObject ? stored.get(item.storageObject.sha256) : null;
        if (!buffer) throw new Error("missing emote resource");
        return { kind: "buffer", buffer, byteSize: buffer.byteLength };
      }
    };
    const storageObjects = createWorkspaceStorageObjectRegistry({ db, objectStore });
    const service = createWorkspaceCustomEmoteService({ db, objectStore, storageObjects });
    const storageObjectIdFor = (emoteId) => db.prepare(`
      SELECT storage_object_id AS storageObjectId FROM workspace_custom_emotes WHERE id = ?
    `).get(emoteId)?.storageObjectId ?? null;
    const storedBytesFor = (emoteId) => {
      const row = db.prepare(`
        SELECT so.sha256
        FROM workspace_custom_emotes e
        INNER JOIN workspace_storage_objects so ON so.id = e.storage_object_id
        WHERE e.id = ?
      `).get(emoteId);
      return row ? stored.get(row.sha256) : null;
    };
    cleanups.push({ db, directory });
    return { db, directory, service, stored, removed, storageObjects, storageObjectIdFor, storedBytesFor };
  }
});

function createOnePixelBmp() {
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
  buffer.set([32, 128, 224, 0], 54);
  return buffer;
}

function seedMember(db, id = "usr_member", login = "member") {
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

function seedSyntheticEmotes(db, { count, addToLibrary = false }) {
  const now = new Date().toISOString();
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const id = `synthetic_emote_${index}`;
    ids.push(id);
    db.prepare(`
      INSERT INTO workspace_custom_emotes (
        id, user_id, source_type, original_file_name, original_mime_type, label,
        normalized_mime_type, byte_size, width, height, frame_count, duration_ms,
        sha256, storage_key, sort_order, created_at, removed_at
      ) VALUES (?, 'usr_owner', 'upload', ?, 'image/webp', ?, 'image/webp', 1, 1, 1, 1, 0, ?, ?, ?, ?, NULL)
    `).run(
      id,
      `${id}.webp`,
      `Synthetic ${index}`,
      index.toString(16).padStart(64, "0"),
      `custom-emotes/usr_owner/${id}/content.webp`,
      index,
      now
    );
    if (addToLibrary) {
      db.prepare(`
        INSERT INTO workspace_emote_library_entries (
          id, user_id, entry_type, emote_id, collection_id, sort_order, created_at
        ) VALUES (?, 'usr_owner', 'emote', ?, NULL, ?, ?)
      `).run(`synthetic_entry_${index}`, id, index, now);
    }
  }
  return ids;
}

function seedVisibleEmoteMessage(db, now) {
  db.prepare(`
    INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
    VALUES ('con_emote', 'spc_default', 'direct', '', 'emote-test', 100, 'usr_owner', ?)
  `).run(now);
  for (const userId of ["usr_owner", "usr_member"]) {
    db.prepare(`
      INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at, notification_level)
      VALUES ('con_emote', ?, ?, NULL, 'all')
    `).run(userId, now);
  }
}

async function createAnimatedGif({ frameCount, delayMs }) {
  const width = 8;
  const height = 8;
  const channels = 4;
  const input = Buffer.alloc(width * height * frameCount * channels);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (((frame * height + y) * width + x) * channels);
        input[offset] = (frame * 17 + x * 13) % 256;
        input[offset + 1] = (frame * 11 + y * 23) % 256;
        input[offset + 2] = (frame * 7 + x * y) % 256;
        input[offset + 3] = 255;
      }
    }
  }
  return await sharp(input, {
    raw: { width, height: height * frameCount, channels, pageHeight: height }
  }).gif({ delay: Array(frameCount).fill(delayMs), pageHeight: height, loop: 0, dither: 0 }).toBuffer();
}
