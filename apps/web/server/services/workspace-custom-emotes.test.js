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

  async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-emotes-"));
    const db = openTestDatabase(directory);
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
      }
    };
    const service = createWorkspaceCustomEmoteService({ db, objectStore, dataDir: directory });
    cleanups.push({ db, directory });
    return { db, directory, service, stored, removed };
  }
});
