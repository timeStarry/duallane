import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { resolveWorkspaceStoragePath } from "./workspace-storage.mjs";

export const AVATAR_INPUT_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const AVATAR_MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const AVATAR_MAX_INPUT_PIXELS = 40_000_000;
export const AVATAR_MAX_INPUT_EDGE = 8192;

export class ProfileAvatarError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ProfileAvatarError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function saveProfileAvatar(dataDir, { stream, mimeType, contentLength, userId }) {
  if (!AVATAR_INPUT_MIME_TYPES.has(mimeType)) {
    throw new ProfileAvatarError("avatar.unsupported_format", "头像仅支持 JPEG、PNG 或 WebP");
  }
  const declaredLength = Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : null;
  if (declaredLength !== null && declaredLength > AVATAR_MAX_INPUT_BYTES) {
    throw new ProfileAvatarError("avatar.invalid_size", "头像文件大小应在 5 MiB 以内");
  }

  const chunks = [];
  let received = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.byteLength;
    if (received > AVATAR_MAX_INPUT_BYTES || (declaredLength !== null && received > declaredLength)) {
      throw new ProfileAvatarError("avatar.invalid_size", "头像文件大小应在 5 MiB 以内");
    }
    chunks.push(buffer);
  }
  if (received === 0 || (declaredLength !== null && received !== declaredLength)) {
    throw new ProfileAvatarError("avatar.invalid_size", "头像文件大小与请求不一致");
  }

  const input = Buffer.concat(chunks);
  let image;
  let metadata;
  try {
    image = sharp(input, { failOn: "error", limitInputPixels: AVATAR_MAX_INPUT_PIXELS });
    metadata = await image.metadata();
  } catch {
    throw new ProfileAvatarError("avatar.invalid_image", "头像图片无法解析");
  }
  if (
    !metadata.format ||
    !["jpeg", "png", "webp"].includes(metadata.format) ||
    !metadata.width ||
    !metadata.height ||
    metadata.width > AVATAR_MAX_INPUT_EDGE ||
    metadata.height > AVATAR_MAX_INPUT_EDGE
  ) {
    throw new ProfileAvatarError("avatar.invalid_image", "头像图片尺寸或格式无效");
  }

  let output;
  try {
    output = await image
      .rotate()
      .resize(256, 256, { fit: "cover", position: "centre" })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
  } catch {
    throw new ProfileAvatarError("avatar.processing_failed", "头像处理失败", 500);
  }

  const version = randomUUID();
  const storageKey = `profile-avatars/${userId}/${version}.webp`;
  const targetPath = resolveWorkspaceStoragePath(dataDir, storageKey);
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(temporaryPath, output, { flag: "wx" });
    await rename(temporaryPath, targetPath);
  } catch {
    await rm(temporaryPath, { force: true });
    throw new ProfileAvatarError("avatar.storage_failed", "头像保存失败", 500);
  }
  return { storageKey, version, byteSize: output.byteLength, path: targetPath };
}

export async function removeProfileAvatar(dataDir, storageKey) {
  if (!storageKey) return;
  await rm(resolveWorkspaceStoragePath(dataDir, storageKey), { force: true });
}

export function resolveProfileAvatar(dataDir, storageKey) {
  return resolveWorkspaceStoragePath(dataDir, storageKey);
}
