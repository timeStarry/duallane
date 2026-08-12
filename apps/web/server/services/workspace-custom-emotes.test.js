import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import { createWorkspaceCustomEmoteService } from "./workspace-custom-emotes.mjs";

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
    expect(defaults.enabledPackIds.length).toBeGreaterThan(0);
    await expect(service.updateSettings("usr_owner", [])).rejects.toMatchObject({ code: "emote.pack_required" });

    const updated = await service.updateSettings("usr_owner", ["emoji"]);
    expect(updated.enabledPackIds).toEqual(["emoji"]);
    expect((await service.getSettings("usr_owner")).enabledPackIds).toEqual(["emoji"]);
  });

  it("normalizes uploaded images to WebP, deduplicates them, and removes the owned copy", async () => {
    const { service, stored, removed } = await fixture();
    const png = await sharp({
      create: { width: 48, height: 32, channels: 4, background: { r: 20, g: 150, b: 130, alpha: 0.7 } }
    }).png().toBuffer();
    const first = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(png),
      contentType: "image/png",
      fileName: "wave.png"
    });
    const duplicate = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(png),
      contentType: "image/png",
      fileName: "wave-copy.png"
    });

    expect(first).toMatchObject({ kind: "custom", label: "wave", animated: false });
    expect(first.src).toContain(`/api/workspace/emotes/${first.id}/content`);
    expect(duplicate.id).toBe(first.id);
    expect(stored.size).toBe(1);
    const normalized = stored.get(first.id);
    expect((await sharp(normalized).metadata()).format).toBe("webp");
    expect((await service.list("usr_owner")).items).toHaveLength(1);

    await service.remove("usr_owner", first.id);
    expect(removed).toContain(first.id);
    expect((await service.list("usr_owner")).items).toEqual([]);
  });

  it("accepts BMP uploads and normalizes them to WebP", async () => {
    const { service, stored } = await fixture();
    const bmp = createOnePixelBmp();
    const emote = await service.upload({
      actorId: "usr_owner",
      stream: Readable.from(bmp),
      contentType: "image/bmp",
      fileName: "pixel.bmp"
    });

    expect(emote).toMatchObject({ kind: "custom", label: "pixel", animated: false });
    expect((await sharp(stored.get(emote.id)).metadata()).format).toBe("webp");
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
    const { service, db, stored } = await fixture();
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
    expect(await sharp(stored.get(emote.id), { animated: true }).metadata()).toMatchObject({
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

  it("reuses normalized custom-emote resources when another member favorites them", async () => {
    const { service, db, stored, removed } = await fixture({ member: true });
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
    expect(favorite.originalMimeType).toBe("image/webp");
    expect(stored.size).toBe(1);
    expect(db.prepare(`
      SELECT source_custom_emote_id AS sourceCustomEmoteId, storage_key AS storageKey
      FROM workspace_custom_emotes WHERE id = ?
    `).get(favorite.id)).toEqual({ sourceCustomEmoteId: source.id, storageKey: null });

    db.prepare("DELETE FROM message_custom_emotes WHERE message_id = 'msg_emote'").run();
    await service.remove("usr_owner", source.id);
    expect(removed).not.toContain(source.id);
    expect(db.prepare("SELECT removed_at AS removedAt FROM workspace_custom_emotes WHERE id = ?")
      .get(source.id).removedAt).toBeTruthy();
    await expect(service.validateMessageCustomEmote("usr_member", favorite.id)).resolves.toMatchObject({ id: favorite.id });
    expect(await service.getDelivery("usr_member", favorite.id)).toMatchObject({ kind: "buffer" });

    await service.remove("usr_member", favorite.id);
    expect(removed).toContain(source.id);
    expect(stored.has(source.id)).toBe(false);
  });

  it("shares immutable collection snapshots and imports them by resource reference", async () => {
    const { service, db, stored, removed } = await fixture({ member: true });
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
    expect(removed).not.toContain(first.id);
    await service.revokeCollectionShare("usr_owner", firstShare.id);
    await service.revokeCollectionShare("usr_owner", changedShare.id);
    expect(removed).not.toContain(first.id);
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
    db.prepare("UPDATE workspace_custom_emotes SET storage_key = NULL WHERE id = ?").run(source.id);

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
      async persistCustomEmote(item) {
        stored.set(item.id, await readFile(item.path));
        return item;
      },
      async removeCustomEmote(item) {
        removed.push(item.id);
        stored.delete(item.id);
      },
      async getCustomEmoteDelivery(item) {
        const buffer = stored.get(item.id);
        if (!buffer) throw new Error("missing emote resource");
        return { kind: "buffer", buffer, byteSize: buffer.byteLength };
      }
    };
    const service = createWorkspaceCustomEmoteService({ db, objectStore, dataDir: directory });
    cleanups.push({ db, directory });
    return { db, directory, service, stored, removed };
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

function seedMember(db) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, github_id, github_login, email, display_name, nickname, avatar_url, kind, created_at, last_login_at)
    VALUES ('usr_member', NULL, 'member', NULL, 'Member', 'Member', NULL, 'human', ?, NULL)
  `).run(now);
  db.prepare(`
    INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
    VALUES ('spc_default', 'usr_member', 'member', ?, NULL)
  `).run(now);
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
