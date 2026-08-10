import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import {
  createWorkspaceChunkUploadService,
  WORKSPACE_UPLOAD_PART_SIZE,
  workspaceUploadContract
} from "./workspace-upload-chunks.mjs";

describe("workspace chunk uploads", () => {
  const cleanups = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async ({ db, directory }) => {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it("plans bounded chunks and assembles verified parts in order", async () => {
    const { db, directory } = await fixture();
    const expected = WORKSPACE_UPLOAD_PART_SIZE + 3;
    insertUpload(db, "upl_chunks", expected);
    const service = createWorkspaceChunkUploadService({ db, dataDir: directory });
    const first = Buffer.alloc(WORKSPACE_UPLOAD_PART_SIZE, 0x61);
    const second = Buffer.from("end");

    await service.savePart(partInput("upl_chunks", 1, expected, first));
    await service.savePart(partInput("upl_chunks", 2, expected, second));
    const status = await service.getStatus("upl_chunks", expected);
    expect(status).toMatchObject({ mode: "chunked", partCount: 2, partSize: WORKSPACE_UPLOAD_PART_SIZE });
    expect(status.parts.map((part) => part.partNumber)).toEqual([1, 2]);

    let assembled = Buffer.alloc(0);
    const stored = await service.assemble({
      upload: {
        transfer: { id: "upl_chunks", byte_size: expected },
        attachment: { id: "att_chunks", byteSize: expected }
      },
      objectStore: {
        async saveAttachment({ stream }) {
          const chunks = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          assembled = Buffer.concat(chunks);
          return { byteSize: assembled.byteLength, sha256: sha256(assembled) };
        }
      }
    });
    expect(stored.byteSize).toBe(expected);
    expect(assembled.subarray(-3).toString()).toBe("end");
    expect((await service.getStatus("upl_chunks", expected)).parts).toEqual([]);
  });

  it("accepts an identical part retry and rejects conflicting content", async () => {
    const { db, directory } = await fixture();
    const body = Buffer.from("part");
    insertUpload(db, "upl_retry", body.byteLength);
    const service = createWorkspaceChunkUploadService({ db, dataDir: directory });
    const first = await service.savePart(partInput("upl_retry", 1, body.byteLength, body));
    const retry = await service.savePart(partInput("upl_retry", 1, body.byteLength, body));
    expect(first.reused).toBe(false);
    expect(retry.reused).toBe(true);

    await expect(service.savePart({
      ...partInput("upl_retry", 1, body.byteLength, Buffer.from("diff")),
      sha256: sha256(Buffer.from("diff"))
    })).rejects.toMatchObject({ code: "upload.part_conflict", statusCode: 409 });
  });

  it("rejects a part whose declared hash does not match its bytes", async () => {
    const { db, directory } = await fixture();
    const body = Buffer.from("hash-me");
    insertUpload(db, "upl_hash", body.byteLength);
    const service = createWorkspaceChunkUploadService({ db, dataDir: directory });
    await expect(service.savePart({
      ...partInput("upl_hash", 1, body.byteLength, body),
      sha256: "0".repeat(64)
    })).rejects.toMatchObject({ code: "upload.part_hash_mismatch" });
  });

  it("serializes duplicate completion attempts so the stored object is not removed or rewritten", async () => {
    const { db, directory } = await fixture();
    const body = Buffer.from("complete-once");
    insertUpload(db, "upl_complete_once", body.byteLength);
    const service = createWorkspaceChunkUploadService({ db, dataDir: directory });
    await service.savePart(partInput("upl_complete_once", 1, body.byteLength, body));
    let saves = 0;
    const input = {
      upload: {
        transfer: { id: "upl_complete_once", byte_size: body.byteLength },
        attachment: { id: "att_complete_once", byteSize: body.byteLength }
      },
      objectStore: {
        async saveAttachment({ stream }) {
          saves += 1;
          for await (const _chunk of stream) {
            // Drain the assembled object.
          }
          return { byteSize: body.byteLength, sha256: sha256(body) };
        }
      }
    };

    const results = await Promise.allSettled([
      service.assemble(input),
      service.assemble(input)
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "upload.parts_incomplete" }) })
    ]);
    expect(saves).toBe(1);
  });

  it("uses the single request path only up to one application part", () => {
    expect(workspaceUploadContract(WORKSPACE_UPLOAD_PART_SIZE)).toMatchObject({ mode: "single", partCount: 1 });
    expect(workspaceUploadContract(WORKSPACE_UPLOAD_PART_SIZE + 1)).toMatchObject({ mode: "chunked", partCount: 2 });
  });

  async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-chunks-"));
    const db = openTestDatabase(directory);
    cleanups.push({ db, directory });
    return { db, directory };
  }
});

function insertUpload(db, uploadId, byteSize) {
  db.prepare(`
    INSERT INTO transfer_ledger (
      id, space_id, user_id, direction, byte_size, status, attachment_id,
      created_at, completed_at, released_at, last_activity_at
    ) VALUES (?, 'spc_default', 'usr_owner', 'upload', ?, 'reserved', NULL, ?, NULL, NULL, ?)
  `).run(uploadId, byteSize, new Date().toISOString(), new Date().toISOString());
}

function partInput(uploadId, partNumber, expectedByteSize, body) {
  return {
    uploadId,
    partNumber,
    expectedByteSize,
    stream: Readable.from(body),
    contentLength: body.byteLength,
    sha256: sha256(body)
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
