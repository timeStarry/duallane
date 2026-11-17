import fs from "node:fs";

export const AGENT_DIRECT_FILE_MAX_BYTES = 50 * 1024 * 1024;

function fileInputError(code) {
  return Object.assign(new TypeError("File input is invalid or exceeds the allowed byte limit."), { code });
}

/** Apply the direct-upload budget before allocating a UTF-8 buffer. */
export function normalizeFileBytes(value, { allowText = true } = {}) {
  if (typeof value === "string" && allowText) {
    const byteSize = Buffer.byteLength(value, "utf8");
    if (byteSize > AGENT_DIRECT_FILE_MAX_BYTES) throw fileInputError("artifact.too_large");
    if (!byteSize) throw fileInputError("artifact.invalid_data");
    return Buffer.from(value, "utf8");
  }
  if (!(value instanceof Uint8Array) || !value.byteLength) throw fileInputError("artifact.invalid_data");
  if (value.byteLength > AGENT_DIRECT_FILE_MAX_BYTES) throw fileInputError("artifact.too_large");
  return value;
}

/** Read a regular file with a finite allocation, refusing a changed size. */
export function readBoundedFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0) throw fileInputError("artifact.invalid_data");
    if (stat.size > AGENT_DIRECT_FILE_MAX_BYTES) throw fileInputError("artifact.too_large");
    // One extra byte detects growth without allocating or reading an unbounded body.
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== stat.size || fs.fstatSync(fd).size !== stat.size) throw fileInputError("artifact.input_changed");
    return bytes.subarray(0, offset);
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("artifact.")) throw error;
    throw fileInputError("artifact.file_unavailable");
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Preserve the bounded-input failure. */ } }
  }
}
