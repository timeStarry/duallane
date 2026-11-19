import { createHash } from "node:crypto";
import { inflateRawSync, crc32 } from "node:zlib";

export const MAX_OTA_BYTES = 15 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 500;
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const ALLOWED_FLAGS = 0x080e;
const EXTENSIONS = /\.(html|js|mjs|css|json|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|txt)$/i;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireArchive(condition) {
  if (!condition) throw new Error("invalid_ota_archive");
}

function directoryEnd(bytes) {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) !== EOCD) continue;
    if (offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) return offset;
  }
  throw new Error("invalid_ota_archive");
}

function canonicalName(bytes) {
  const name = bytes.toString("utf8");
  const components = name.split("/");
  requireArchive(name.length <= 512 && !name.includes("..") && !/^(?:assets\/)?www\//.test(name) &&
    components.every(component => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(component)) && EXTENSIONS.test(name));
  return name;
}

// Only inspect canonical static assets in memory. Use central-directory sizes so
// Go's normalized ZIPs with data descriptors and the SDK ZIPs are both accepted.
export function archiveFiles(bytes) {
  requireArchive(Buffer.isBuffer(bytes) && bytes.length >= 64 && bytes.length <= MAX_OTA_BYTES);
  const end = directoryEnd(bytes);
  const count = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  requireArchive(bytes.readUInt32LE(end + 4) === 0 && bytes.readUInt16LE(end + 8) === count &&
    count > 0 && count <= MAX_FILES && start + bytes.readUInt32LE(end + 12) === end);

  const files = new Map();
  const ranges = [];
  let expanded = 0;
  let offset = start;
  for (let i = 0; i < count; i++) {
    requireArchive(offset + 46 <= end && bytes.readUInt32LE(offset) === CENTRAL);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const next = nameStart + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    const fileType = (bytes.readUInt32LE(offset + 38) >>> 16) & 0o170000;
    requireArchive(next <= end && bytes.readUInt16LE(offset + 34) === 0 &&
      (fileType === 0 || fileType === 0o100000) && !(flags & ~ALLOWED_FLAGS) && (method === 0 || method === 8));
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    const path = canonicalName(nameBytes);
    expanded += size;
    requireArchive(!files.has(path) && expanded <= MAX_EXPANDED_BYTES && local + 30 <= start &&
      bytes.readUInt32LE(local) === LOCAL && bytes.readUInt16LE(local + 6) === flags &&
      bytes.readUInt16LE(local + 8) === method && bytes.readUInt16LE(local + 26) === nameLength);
    const data = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
    requireArchive(data + compressed <= start && nameBytes.equals(bytes.subarray(local + 30, local + 30 + nameLength)));
    let recordEnd = data + compressed;
    if (flags & 8) {
      requireArchive(recordEnd + 12 <= start);
      if (bytes.readUInt32LE(recordEnd) === DESCRIPTOR) recordEnd += 4;
      requireArchive(recordEnd + 12 <= start && bytes.readUInt32LE(recordEnd) === crc &&
        bytes.readUInt32LE(recordEnd + 4) === compressed && bytes.readUInt32LE(recordEnd + 8) === size);
      recordEnd += 12;
    } else {
      requireArchive(bytes.readUInt32LE(local + 14) === crc && bytes.readUInt32LE(local + 18) === compressed &&
        bytes.readUInt32LE(local + 22) === size);
    }
    ranges.push([local, recordEnd]);
    const payload = bytes.subarray(data, data + compressed);
    const content = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: Math.max(1, size) });
    requireArchive(content.length === size && crc32(content) === crc && (path !== "index.html" || size > 0));
    files.set(path, sha256(content));
    offset = next;
  }
  requireArchive(offset === end && files.has("index.html"));
  let previousEnd = 0;
  for (const [local, recordEnd] of ranges.sort((a, b) => a[0] - b[0])) {
    requireArchive(local === previousEnd);
    previousEnd = recordEnd;
  }
  requireArchive(previousEnd === start);
  return [...files].map(([path, digest]) => ({ path, sha256: digest })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
