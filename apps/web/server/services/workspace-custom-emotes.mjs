import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { getReactionEmote, listVisibleEmotePacks } from "./emote-catalog.mjs";
import { DEFAULT_SPACE_ID } from "./db.mjs";
import { WorkspaceError, WorkspacePermissionError, WorkspaceValidationError } from "./workspace.mjs";

export const CUSTOM_EMOTE_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const CUSTOM_EMOTE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const CUSTOM_EMOTE_MAX_ITEMS = 100;
export const CUSTOM_EMOTE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const CUSTOM_EMOTE_MAX_DIMENSION = 4096;
const CUSTOM_EMOTE_MAX_PIXELS = 40 * 1024 * 1024;
const CUSTOM_EMOTE_MAX_FRAMES = 60;
const CUSTOM_EMOTE_MAX_DURATION_MS = 15000;
const SUPPORTED_FORMATS = new Set(["jpeg", "png", "webp", "gif", "bmp"]);
const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"]);

export function createWorkspaceCustomEmoteService({ db, objectStore, dataDir, now = () => new Date() }) {
  const userLocks = new Map();
  const stagingRoot = path.resolve(dataDir, "workspace-custom-emote-staging");

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

  const storeProcessed = async ({ actorId, input, source }) => {
    const actor = await requireHumanActor(db, actorId);
    const normalizedSource = { ...source, fileName: normalizeFileName(source.fileName) };
    const processed = await normalizeCustomEmote(input, normalizedSource);
    return await withUserLock(actor.id, async () => {
      const duplicate = await db.prepare(`
        SELECT * FROM workspace_custom_emotes WHERE user_id = ? AND sha256 = ?
      `).get(actor.id, processed.sha256);
      if (duplicate) return publicCustomEmote(duplicate);
      await assertCollectionCapacity(db, actor.id, processed.byteSize);
      const id = randomUUID();
      const storageKey = `custom-emotes/${actor.id}/${id}/content.webp`;
      const stagingPath = path.join(stagingRoot, `${id}.webp`);
      await mkdir(stagingRoot, { recursive: true });
      await writeFile(stagingPath, processed.buffer, { flag: "wx" });
      const stored = {
        id,
        userId: actor.id,
        path: stagingPath,
        storageKey,
        byteSize: processed.byteSize,
        sha256: processed.sha256
      };
      let persisted = false;
      try {
        await objectStore.persistCustomEmote(stored);
        persisted = true;
        const orderRow = await db.prepare(`
          SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder
          FROM workspace_custom_emotes WHERE user_id = ?
        `).get(actor.id);
        await db.prepare(`
          INSERT INTO workspace_custom_emotes (
            id, user_id, source_type, source_attachment_id, source_custom_emote_id,
            source_emote_key, original_file_name, original_mime_type, label,
            normalized_mime_type, byte_size, width, height, frame_count, duration_ms,
            sha256, storage_key, sort_order, created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'image/webp', ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          storageKey,
          orderRow.nextOrder,
          now().toISOString()
        );
        return publicCustomEmote(await getOwnEmoteRow(db, actor.id, id));
      } catch (error) {
        if (persisted) await objectStore.removeCustomEmote(stored).catch(() => {});
        throw error;
      } finally {
        await rm(stagingPath, { force: true });
      }
    });
  };

  return {
    async getSettings(actorId) {
      await requireHumanActor(db, actorId);
      const availablePacks = listVisibleEmotePacks();
      const row = await db.prepare(`
        SELECT enabled_pack_ids_json AS enabledPackIdsJson
        FROM workspace_emote_preferences WHERE user_id = ?
      `).get(actorId);
      return {
        availablePacks,
        enabledPackIds: normalizeEnabledPackIds(row?.enabledPackIdsJson, availablePacks),
        minimumEnabled: 1
      };
    },

    async updateSettings(actorId, enabledPackIds) {
      await requireHumanActor(db, actorId);
      const availablePacks = listVisibleEmotePacks();
      const allowed = new Set(availablePacks.map((pack) => pack.id));
      const normalized = [...new Set(Array.isArray(enabledPackIds) ? enabledPackIds.map(String) : [])]
        .filter((id) => allowed.has(id));
      if (normalized.length < 1 || normalized.length !== new Set(Array.isArray(enabledPackIds) ? enabledPackIds.map(String) : []).size) {
        throw new WorkspaceValidationError("emote.pack_required", "至少保留一个表情包");
      }
      const updatedAt = now().toISOString();
      await db.prepare(`
        INSERT INTO workspace_emote_preferences (user_id, enabled_pack_ids_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET
          enabled_pack_ids_json = excluded.enabled_pack_ids_json,
          updated_at = excluded.updated_at
      `).run(actorId, JSON.stringify(normalized), updatedAt);
      return { availablePacks, enabledPackIds: normalized, minimumEnabled: 1 };
    },

    async list(actorId) {
      await requireHumanActor(db, actorId);
      const rows = await db.prepare(`
        SELECT * FROM workspace_custom_emotes
        WHERE user_id = ?
        ORDER BY sort_order ASC, created_at ASC
      `).all(actorId);
      return {
        items: rows.map(publicCustomEmote).filter(Boolean),
        limits: {
          maxItems: CUSTOM_EMOTE_MAX_ITEMS,
          maxTotalBytes: CUSTOM_EMOTE_MAX_TOTAL_BYTES,
          maxInputBytes: CUSTOM_EMOTE_MAX_INPUT_BYTES
        }
      };
    },

    async upload({ actorId, stream, contentType, fileName }) {
      if (!SUPPORTED_MIME_TYPES.has(String(contentType ?? "").toLowerCase())) {
        throw new WorkspaceValidationError("emote.invalid_format", "仅支持 JPEG、PNG、WebP、GIF 或 BMP 图片");
      }
      const input = await readLimitedStream(stream, CUSTOM_EMOTE_MAX_INPUT_BYTES);
      return await storeProcessed({
        actorId,
        input,
        source: { type: "upload", fileName: normalizeFileName(fileName), mimeType: contentType }
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
        return await addBuiltinFavorite(db, actorId, emote, now());
      }
      const normalizedCustomId = String(customEmoteId ?? "").trim();
      if (!messageContainsCustomEmote(content, normalizedCustomId)) {
        throw new WorkspaceValidationError("emote.invalid_source", "该消息没有可收藏的表情");
      }
      const source = await db.prepare("SELECT * FROM workspace_custom_emotes WHERE id = ?").get(normalizedCustomId);
      if (!source || !source.storage_key) {
        throw new WorkspaceValidationError("emote.invalid_source", "收藏表情已不可用");
      }
      const bytes = await objectStore.readCustomEmoteBytes(toObjectStoreEmote(source), CUSTOM_EMOTE_MAX_INPUT_BYTES);
      return await storeProcessed({
        actorId,
        input: bytes,
        source: {
          type: "custom",
          customEmoteId: source.id,
          fileName: source.original_file_name || `${source.label}.webp`,
          mimeType: source.original_mime_type || "image/webp"
        }
      });
    },

    async remove(actorId, emoteId) {
      await requireHumanActor(db, actorId);
      const row = await getOwnEmoteRow(db, actorId, emoteId);
      if (!row) throw new WorkspaceError("emote.not_found", "收藏表情不存在", 404);
      if (row.storage_key) await objectStore.removeCustomEmote(toObjectStoreEmote(row));
      await db.prepare("DELETE FROM workspace_custom_emotes WHERE id = ? AND user_id = ?").run(row.id, actorId);
      return { ok: true, emoteId: row.id };
    },

    async reorder(actorId, emoteIds) {
      await requireHumanActor(db, actorId);
      const existing = await db.prepare(`
        SELECT id FROM workspace_custom_emotes WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC
      `).all(actorId);
      const currentIds = existing.map((row) => row.id);
      const normalized = Array.isArray(emoteIds) ? [...new Set(emoteIds.map(String))] : [];
      if (normalized.length !== currentIds.length || normalized.some((id) => !currentIds.includes(id))) {
        throw new WorkspaceValidationError("emote.invalid_order", "收藏表情顺序无效");
      }
      await db.transaction(async () => {
        for (let index = 0; index < normalized.length; index += 1) {
          await db.prepare("UPDATE workspace_custom_emotes SET sort_order = ? WHERE id = ? AND user_id = ?")
            .run(index, normalized[index], actorId);
        }
      });
      return await this.list(actorId);
    },

    async getDelivery(actorId, emoteId) {
      await requireHumanActor(db, actorId);
      const row = await db.prepare("SELECT * FROM workspace_custom_emotes WHERE id = ?").get(emoteId);
      if (!row?.storage_key) throw new WorkspaceError("emote.not_found", "收藏表情不存在", 404);
      if (row.user_id !== actorId && !await isCustomEmoteVisibleTo(db, actorId, row.id)) {
        throw new WorkspacePermissionError("permission.denied", "你没有访问该表情的权限");
      }
      return await objectStore.getCustomEmoteDelivery(toObjectStoreEmote(row), {
        contentDisposition: "inline"
      });
    },

    async validateMessageCustomEmote(actorId, customEmoteId) {
      const row = await getOwnEmoteRow(db, actorId, customEmoteId);
      if (!row?.storage_key) throw new WorkspaceValidationError("message.invalid_emoji", "收藏表情不可用");
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
    label: normalizeLabel(source.fileName)
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

async function addBuiltinFavorite(db, actorId, emote, date) {
  const emoteKey = `${emote.packId}:${emote.id}`;
  const existing = await db.prepare(`
    SELECT * FROM workspace_custom_emotes WHERE user_id = ? AND source_emote_key = ?
  `).get(actorId, emoteKey);
  if (existing) return publicCustomEmote(existing);
  await assertCollectionCapacity(db, actorId, 0);
  const orderRow = await db.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder FROM workspace_custom_emotes WHERE user_id = ?
  `).get(actorId);
  const id = randomUUID();
  await db.prepare(`
    INSERT INTO workspace_custom_emotes (
      id, user_id, source_type, source_emote_key, label, sort_order, created_at
    ) VALUES (?, ?, 'builtin', ?, ?, ?, ?)
  `).run(id, actorId, emoteKey, emote.label, orderRow.nextOrder, date.toISOString());
  return publicCustomEmote(await getOwnEmoteRow(db, actorId, id));
}

async function assertCollectionCapacity(db, userId, nextBytes) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS totalBytes
    FROM workspace_custom_emotes WHERE user_id = ?
  `).get(userId);
  if (row.count >= CUSTOM_EMOTE_MAX_ITEMS) {
    throw new WorkspaceError("emote.limit_reached", "收藏表情已达到 100 个上限", 409);
  }
  if (row.totalBytes + nextBytes > CUSTOM_EMOTE_MAX_TOTAL_BYTES) {
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
  return Boolean(await db.prepare(`
    SELECT 1
    FROM message_custom_emotes mce
    INNER JOIN messages m ON m.id = mce.message_id
    INNER JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
    WHERE mce.custom_emote_id = ? AND cm.user_id = ?
      AND cm.removed_at IS NULL AND m.deleted_at IS NULL
    LIMIT 1
  `).get(emoteId, actorId));
}

async function getOwnEmoteRow(db, actorId, emoteId) {
  return await db.prepare("SELECT * FROM workspace_custom_emotes WHERE id = ? AND user_id = ?")
    .get(String(emoteId ?? "").trim(), actorId);
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

function toObjectStoreEmote(row) {
  return {
    id: row.id,
    userId: row.user_id,
    storageKey: row.storage_key,
    byteSize: row.byte_size
  };
}

function normalizeEnabledPackIds(value, availablePacks) {
  const fallback = availablePacks.map((pack) => pack.id);
  try {
    const parsed = JSON.parse(value ?? "null");
    const allowed = new Set(fallback);
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

function normalizeLabel(fileName) {
  const base = path.basename(normalizeFileName(fileName)).replace(/\.[^.]+$/, "").trim();
  return Array.from(base || "收藏表情").slice(0, 40).join("");
}

function formatMimeType(format) {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}
