import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WorkspaceError, WorkspaceValidationError } from "./workspace.mjs";

export const WORKSPACE_UPLOAD_PART_SIZE = 4 * 1024 * 1024;
export const WORKSPACE_UPLOAD_PART_LIMIT = 10000;

export function workspaceUploadContract(byteSize) {
  const normalizedSize = Number(byteSize);
  const partCount = Math.ceil(normalizedSize / WORKSPACE_UPLOAD_PART_SIZE);
  return {
    mode: normalizedSize > WORKSPACE_UPLOAD_PART_SIZE ? "chunked" : "single",
    partSize: WORKSPACE_UPLOAD_PART_SIZE,
    partCount
  };
}

export function createWorkspaceChunkUploadService({ db, dataDir, now = () => new Date() }) {
  const root = path.resolve(dataDir, "workspace-upload-parts");
  const inFlight = new Map();

  const withPartLock = async (key, operation) => {
    const previous = inFlight.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    inFlight.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (inFlight.get(key) === queued) inFlight.delete(key);
    }
  };

  const partPath = (uploadId, partNumber) => {
    assertSafeId(uploadId);
    return path.join(root, uploadId, `${partNumber}.part`);
  };

  return {
    async savePart({ uploadId, partNumber, expectedByteSize, stream, contentLength, sha256 }) {
      const normalizedPart = parsePartNumber(partNumber);
      const contract = workspaceUploadContract(expectedByteSize);
      if (contract.partCount < 1 || contract.partCount > WORKSPACE_UPLOAD_PART_LIMIT || normalizedPart > contract.partCount) {
        throw new WorkspaceValidationError("upload.invalid_part", "上传分片编号无效");
      }
      const expectedPartBytes = normalizedPart === contract.partCount
        ? expectedByteSize - contract.partSize * (contract.partCount - 1)
        : contract.partSize;
      if (Number(contentLength) !== expectedPartBytes) {
        throw new WorkspaceValidationError("upload.part_size_mismatch", "上传分片大小不正确");
      }
      const normalizedHash = String(sha256 ?? "").trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(normalizedHash)) {
        throw new WorkspaceValidationError("upload.invalid_part_hash", "上传分片校验值无效");
      }

      return await withPartLock(`${uploadId}:${normalizedPart}`, async () => {
        const existing = await db.prepare(`
          SELECT byte_size AS byteSize, sha256
          FROM workspace_upload_parts
          WHERE upload_id = ? AND part_number = ?
        `).get(uploadId, normalizedPart);
        if (existing) {
          if (existing.byteSize !== expectedPartBytes || existing.sha256 !== normalizedHash) {
            throw new WorkspaceError("upload.part_conflict", "该分片已上传且内容不同", 409);
          }
          try {
            const existingStat = await stat(partPath(uploadId, normalizedPart));
            if (existingStat.isFile() && existingStat.size === expectedPartBytes) {
              await touchUpload(db, uploadId, now());
              await drainPartStream(stream, expectedPartBytes);
              return { partNumber: normalizedPart, byteSize: expectedPartBytes, sha256: normalizedHash, reused: true };
            }
          } catch {
            // Recreate a missing part below using the retried request body.
          }
        }

        const targetPath = partPath(uploadId, normalizedPart);
        const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
        try {
          await mkdir(path.dirname(targetPath), { recursive: true });
          const written = await writeVerifiedPart(stream, tmpPath, expectedPartBytes, normalizedHash);
          await rm(targetPath, { force: true });
          await rename(tmpPath, targetPath);
          const timestamp = now().toISOString();
          await db.prepare(`
            INSERT INTO workspace_upload_parts (
              upload_id, part_number, byte_size, sha256, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (upload_id, part_number) DO UPDATE SET
              byte_size = excluded.byte_size,
              sha256 = excluded.sha256,
              updated_at = excluded.updated_at
          `).run(uploadId, normalizedPart, written, normalizedHash, timestamp, timestamp);
          await touchUpload(db, uploadId, now());
          return { partNumber: normalizedPart, byteSize: written, sha256: normalizedHash, reused: false };
        } catch (error) {
          await rm(tmpPath, { force: true });
          if (error instanceof WorkspaceError) throw error;
          throw new WorkspaceError("upload.part_failed", "上传分片保存失败", 500);
        }
      });
    },

    async getStatus(uploadId, expectedByteSize) {
      const contract = workspaceUploadContract(expectedByteSize);
      const parts = await db.prepare(`
        SELECT part_number AS partNumber, byte_size AS byteSize, sha256
        FROM workspace_upload_parts
        WHERE upload_id = ?
        ORDER BY part_number ASC
      `).all(uploadId);
      return { ...contract, parts };
    },

    async assemble({ upload, objectStore }) {
      return await withPartLock(`complete:${upload.transfer.id}`, async () => {
        const status = await this.getStatus(upload.transfer.id, upload.transfer.byte_size);
        if (status.parts.length !== status.partCount) {
          throw new WorkspaceValidationError("upload.parts_incomplete", "上传分片不完整");
        }
        for (let index = 0; index < status.parts.length; index += 1) {
          const part = status.parts[index];
          const expectedPartNumber = index + 1;
          const expectedPartBytes = expectedPartNumber === status.partCount
            ? upload.transfer.byte_size - status.partSize * (status.partCount - 1)
            : status.partSize;
          if (part.partNumber !== expectedPartNumber || part.byteSize !== expectedPartBytes) {
            throw new WorkspaceValidationError("upload.parts_incomplete", "上传分片不完整");
          }
          const partStat = await stat(partPath(upload.transfer.id, expectedPartNumber)).catch(() => null);
          if (!partStat?.isFile() || partStat.size !== expectedPartBytes) {
            throw new WorkspaceValidationError("upload.parts_incomplete", "上传分片内容不可用");
          }
        }

        const stream = Readable.from((async function* () {
          for (const part of status.parts) {
            for await (const chunk of createReadStream(partPath(upload.transfer.id, part.partNumber))) {
              yield chunk;
            }
          }
        })());
        const stored = await objectStore.saveAttachment({ attachment: upload.attachment, stream });
        await this.cleanup(upload.transfer.id);
        return stored;
      });
    },

    async cleanup(uploadId) {
      assertSafeId(uploadId);
      await rm(path.join(root, uploadId), { recursive: true, force: true });
      await db.prepare("DELETE FROM workspace_upload_parts WHERE upload_id = ?").run(uploadId);
    },

    async cleanupInactive() {
      const rows = await db.prepare(`
        SELECT DISTINCT p.upload_id AS uploadId
        FROM workspace_upload_parts p
        INNER JOIN transfer_ledger tl ON tl.id = p.upload_id
        WHERE tl.status <> 'reserved'
      `).all();
      for (const row of rows) await this.cleanup(row.uploadId);
      return rows.length;
    }
  };
}

async function writeVerifiedPart(stream, targetPath, expectedByteSize, expectedSha256) {
  if (!stream || typeof stream.pipe !== "function") {
    throw new WorkspaceValidationError("upload.invalid_content", "上传内容不能为空");
  }
  const hash = createHash("sha256");
  let written = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      written += buffer.byteLength;
      if (written > expectedByteSize) {
        callback(new WorkspaceValidationError("upload.part_size_mismatch", "上传分片大小不正确"));
        return;
      }
      hash.update(buffer);
      callback(null, buffer);
    }
  });
  await pipeline(stream, meter, createWriteStream(targetPath));
  if (written !== expectedByteSize) {
    throw new WorkspaceValidationError("upload.part_size_mismatch", "上传分片大小不正确");
  }
  if (hash.digest("hex") !== expectedSha256) {
    throw new WorkspaceValidationError("upload.part_hash_mismatch", "上传分片校验失败");
  }
  return written;
}

async function drainPartStream(stream, expectedByteSize) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return;
  let consumed = 0;
  for await (const chunk of stream) {
    consumed += Buffer.byteLength(chunk);
    if (consumed > expectedByteSize) {
      throw new WorkspaceValidationError("upload.part_size_mismatch", "上传分片大小不正确");
    }
  }
  if (consumed !== expectedByteSize) {
    throw new WorkspaceValidationError("upload.part_size_mismatch", "上传分片大小不正确");
  }
}

async function touchUpload(db, uploadId, date) {
  await db.prepare(`
    UPDATE transfer_ledger
    SET last_activity_at = ?
    WHERE id = ? AND direction = 'upload' AND status = 'reserved'
  `).run(date.toISOString(), uploadId);
}

function parsePartNumber(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > WORKSPACE_UPLOAD_PART_LIMIT) {
    throw new WorkspaceValidationError("upload.invalid_part", "上传分片编号无效");
  }
  return parsed;
}

function assertSafeId(value) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(value ?? ""))) {
    throw new WorkspaceValidationError("upload.invalid", "上传预留无效");
  }
}
