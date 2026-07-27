import { describe, expect, it } from "vitest";
import {
  P2P_FILE_CHUNK_SIZE,
  getP2pFileChunkCount,
  parseDataEnvelopeValue,
  sha256Base64Url,
  validateP2pFileChunk,
  validateP2pFileCompletion
} from "./p2p-protocol";

describe("p2p protocol", () => {
  it("accepts delivery acknowledgements and rejects malformed file metadata", () => {
    expect(parseDataEnvelopeValue({ kind: "chat-ack", messageId: "p2p-1" })).toEqual({
      kind: "chat-ack",
      messageId: "p2p-1"
    });
    expect(parseDataEnvelopeValue({
      kind: "file-offer",
      transferId: "file-1",
      author: "Alice",
      name: "note.txt",
      size: P2P_FILE_CHUNK_SIZE + 1,
      mimeType: "text/plain",
      total: 1
    })).toBeNull();
  });

  it("validates exact chunk boundaries and complete byte counts", () => {
    const size = P2P_FILE_CHUNK_SIZE + 3;
    const total = getP2pFileChunkCount(size);
    const first = new Uint8Array(P2P_FILE_CHUNK_SIZE);
    const second = new Uint8Array(3);
    const chunkEnvelope = {
      kind: "file-chunk" as const,
      transferId: "file-1",
      index: 1,
      total,
      sha256: "A".repeat(43),
      data: "AAAA"
    };

    expect(validateP2pFileChunk({ size, total }, chunkEnvelope, second)).toBeNull();
    expect(validateP2pFileChunk({ size, total }, chunkEnvelope, new Uint8Array(2))).toBe("文件分片大小不一致");
    expect(validateP2pFileCompletion({ size, total, receivedBytes: size, chunks: [first, second] }, {
      kind: "file-complete",
      transferId: "file-1",
      size,
      total
    })).toBeNull();
    expect(validateP2pFileCompletion({ size, total, receivedBytes: P2P_FILE_CHUNK_SIZE, chunks: [first] }, {
      kind: "file-complete",
      transferId: "file-1",
      size,
      total
    })).toBe("文件字节数不完整");
  });

  it("computes stable SHA-256 digests for file chunks", async () => {
    expect(await sha256Base64Url(new TextEncoder().encode("duallane").buffer)).toBe(
      "8c_gciBCThpfXWzMsuJxJMM1vGjM8oxMW0NOWQwBbQU"
    );
  });
});
