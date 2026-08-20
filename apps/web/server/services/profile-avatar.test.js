import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  AVATAR_MAX_INPUT_BYTES,
  ProfileAvatarError,
  removeProfileAvatar,
  saveProfileAvatar
} from "./profile-avatar.mjs";

describe("profile avatar storage", () => {
  let dataDir;

  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("normalizes supported images to a metadata-free 256px WebP", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "duallane-avatar-"));
    const input = await sharp({
      create: { width: 640, height: 320, channels: 3, background: "#236d78" }
    }).withMetadata({ comment: "private metadata" }).png().toBuffer();

    const stored = await saveProfileAvatar(dataDir, {
      stream: Readable.from(input),
      mimeType: "image/png",
      contentLength: null,
      userId: "usr_test"
    });
    const output = await readFile(stored.path);
    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 256, height: 256 });
    expect(metadata.exif).toBeUndefined();
    expect(stored.storageKey).toMatch(/^profile-avatars\/usr_test\/[a-f0-9-]+\.webp$/);
    expect(stored.sha256).toBe(createHash("sha256").update(output).digest("hex"));

    await removeProfileAvatar(dataDir, stored.storageKey);
    await expect(readFile(stored.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsupported, empty, oversized and malformed images", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "duallane-avatar-"));
    await expect(saveProfileAvatar(dataDir, {
      stream: Readable.from(Buffer.from("not an image")),
      mimeType: "image/gif",
      contentLength: 12,
      userId: "usr_test"
    })).rejects.toMatchObject({ code: "avatar.unsupported_format" });
    await expect(saveProfileAvatar(dataDir, {
      stream: Readable.from([]),
      mimeType: "image/png",
      contentLength: null,
      userId: "usr_test"
    })).rejects.toMatchObject({ code: "avatar.invalid_size" });
    await expect(saveProfileAvatar(dataDir, {
      stream: Readable.from(Buffer.alloc(1)),
      mimeType: "image/png",
      contentLength: AVATAR_MAX_INPUT_BYTES + 1,
      userId: "usr_test"
    })).rejects.toBeInstanceOf(ProfileAvatarError);
    await expect(saveProfileAvatar(dataDir, {
      stream: Readable.from(Buffer.from("not an image")),
      mimeType: "image/png",
      contentLength: null,
      userId: "usr_test"
    })).rejects.toMatchObject({ code: "avatar.invalid_image" });
  });
});
