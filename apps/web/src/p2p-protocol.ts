export const P2P_FILE_CHUNK_SIZE = 16 * 1024;
export const P2P_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const P2P_MAX_CHAT_BYTES = 8 * 1024;

const MAX_ID_LENGTH = 128;
const MAX_AUTHOR_LENGTH = 80;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_MIME_TYPE_LENGTH = 255;
const MAX_CHUNK_BASE64_LENGTH = Math.ceil(P2P_FILE_CHUNK_SIZE / 3) * 4;
const SHA256_BASE64_URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type DataEnvelope =
  | { kind: "chat"; id: string; author: string; body: string; at: string }
  | { kind: "chat-ack"; messageId: string }
  | { kind: "file-offer"; transferId: string; author: string; name: string; size: number; mimeType: string; total: number }
  | { kind: "file-accept"; transferId: string }
  | { kind: "file-reject"; transferId: string; reason?: string }
  | { kind: "file-chunk"; transferId: string; index: number; total: number; sha256: string; data: string }
  | { kind: "file-complete"; transferId: string; total: number; size: number }
  | { kind: "file-ack"; transferId: string }
  | { kind: "file-error"; transferId: string; reason: string };

export type IncomingFileState = {
  size: number;
  total: number;
  receivedBytes: number;
  chunks: Array<Uint8Array<ArrayBuffer> | undefined>;
};

export function getP2pFileChunkCount(size: number) {
  return Math.max(1, Math.ceil(size / P2P_FILE_CHUNK_SIZE));
}

export function getExpectedP2pChunkBytes(size: number, index: number, total: number) {
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(index) || !Number.isSafeInteger(total)) {
    return -1;
  }
  if (total !== getP2pFileChunkCount(size) || index < 0 || index >= total) {
    return -1;
  }
  const start = index * P2P_FILE_CHUNK_SIZE;
  return Math.max(0, Math.min(P2P_FILE_CHUNK_SIZE, size - start));
}

export function validateP2pFileChunk(
  state: Pick<IncomingFileState, "size" | "total">,
  envelope: Extract<DataEnvelope, { kind: "file-chunk" }>,
  bytes: Uint8Array<ArrayBuffer>
) {
  if (envelope.total !== state.total) {
    return "文件分片总数不一致";
  }
  const expectedBytes = getExpectedP2pChunkBytes(state.size, envelope.index, state.total);
  if (expectedBytes < 0 || bytes.byteLength !== expectedBytes) {
    return "文件分片大小不一致";
  }
  return null;
}

export function validateP2pFileCompletion(
  state: IncomingFileState,
  envelope: Extract<DataEnvelope, { kind: "file-complete" }>
) {
  if (envelope.total !== state.total || envelope.size !== state.size) {
    return "文件完成信息不一致";
  }
  if (state.receivedBytes !== state.size) {
    return "文件字节数不完整";
  }
  for (let index = 0; index < state.total; index += 1) {
    const chunk = state.chunks[index];
    if (!chunk || chunk.byteLength !== getExpectedP2pChunkBytes(state.size, index, state.total)) {
      return "文件分片不完整";
    }
  }
  return null;
}

export async function sha256Base64Url(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return bytesToBase64Url(new Uint8Array(digest));
}

export function parseDataEnvelope(raw: string): DataEnvelope | null {
  try {
    return parseDataEnvelopeValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseDataEnvelopeValue(value: unknown): DataEnvelope | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.kind !== "string") {
    return null;
  }

  if (
    envelope.kind === "chat" &&
    isBoundedString(envelope.id, MAX_ID_LENGTH) &&
    isBoundedString(envelope.author, MAX_AUTHOR_LENGTH) &&
    isBoundedUtf8String(envelope.body, P2P_MAX_CHAT_BYTES) &&
    isBoundedString(envelope.at, 40)
  ) {
    return envelope as DataEnvelope;
  }

  if (envelope.kind === "chat-ack" && isBoundedString(envelope.messageId, MAX_ID_LENGTH)) {
    return envelope as DataEnvelope;
  }

  if (
    envelope.kind === "file-offer" &&
    isBoundedString(envelope.transferId, MAX_ID_LENGTH) &&
    isBoundedString(envelope.author, MAX_AUTHOR_LENGTH) &&
    isBoundedString(envelope.name, MAX_FILE_NAME_LENGTH) &&
    isBoundedString(envelope.mimeType, MAX_MIME_TYPE_LENGTH) &&
    isFileSize(envelope.size) &&
    isChunkTotal(envelope.total, envelope.size)
  ) {
    return envelope as DataEnvelope;
  }

  if (
    (envelope.kind === "file-accept" || envelope.kind === "file-ack") &&
    isBoundedString(envelope.transferId, MAX_ID_LENGTH)
  ) {
    return envelope as DataEnvelope;
  }

  if (
    envelope.kind === "file-reject" &&
    isBoundedString(envelope.transferId, MAX_ID_LENGTH) &&
    (envelope.reason === undefined || isBoundedString(envelope.reason, 240))
  ) {
    return envelope as DataEnvelope;
  }

  if (
    envelope.kind === "file-error" &&
    isBoundedString(envelope.transferId, MAX_ID_LENGTH) &&
    isBoundedString(envelope.reason, 240)
  ) {
    return envelope as DataEnvelope;
  }

  if (
    envelope.kind === "file-chunk" &&
    isBoundedString(envelope.transferId, MAX_ID_LENGTH) &&
    Number.isSafeInteger(envelope.index) &&
    Number.isSafeInteger(envelope.total) &&
    Number(envelope.index) >= 0 &&
    Number(envelope.total) > 0 &&
    Number(envelope.index) < Number(envelope.total) &&
    Number(envelope.total) <= getP2pFileChunkCount(P2P_MAX_FILE_BYTES) &&
    typeof envelope.sha256 === "string" &&
    SHA256_BASE64_URL_PATTERN.test(envelope.sha256) &&
    typeof envelope.data === "string" &&
    envelope.data.length <= MAX_CHUNK_BASE64_LENGTH &&
    BASE64_PATTERN.test(envelope.data)
  ) {
    return envelope as DataEnvelope;
  }

  if (
    envelope.kind === "file-complete" &&
    isBoundedString(envelope.transferId, MAX_ID_LENGTH) &&
    isFileSize(envelope.size) &&
    isChunkTotal(envelope.total, envelope.size)
  ) {
    return envelope as DataEnvelope;
  }

  return null;
}

function isBoundedString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isBoundedUtf8String(value: unknown, maxBytes: number) {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= maxBytes;
}

function isFileSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= P2P_MAX_FILE_BYTES;
}

function isChunkTotal(value: unknown, size: unknown) {
  return Number.isSafeInteger(value) && isFileSize(size) && Number(value) === getP2pFileChunkCount(Number(size));
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
