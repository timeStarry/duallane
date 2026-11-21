import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";
import { archiveFiles, MAX_OTA_BYTES, sha256 as digest } from "./operator/ota-archive.mjs";

const MAX_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 400;
const EXTENSIONS = new Set([
  ".html", ".js", ".mjs", ".css", ".json", ".png", ".jpg", ".jpeg", ".svg",
  ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".txt",
]);

function fail(code) {
  return Object.assign(new Error(code), { code });
}

function pathIdentity(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

async function listAssets(directory) {
  if (pathIdentity(await realpath(directory)) !== pathIdentity(resolve(directory))) {
    throw fail("development.ota_invalid_build_path");
  }
  const files = [];
  let size = 0;
  const names = new Set();
  async function walk(parent, prefix) {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (path.length > 240 || !/^[a-z0-9_-][a-z0-9._-]*$/iu.test(entry.name) || path.includes("..")) {
        throw fail("development.ota_invalid_entry");
      }
      const target = join(parent, entry.name);
      if (entry.isDirectory()) {
        await walk(target, `${path}/`);
        continue;
      }
      if (names.has(path.toLowerCase()) || !entry.isFile() || !EXTENSIONS.has(extname(path).toLowerCase()) ||
          /^(?:assets\/)?www\//.test(path)) {
        throw fail("development.ota_invalid_entry");
      }
      const metadata = await lstat(target);
      size += metadata.size;
      if (!metadata.isFile() || metadata.nlink !== 1 || files.length >= MAX_ENTRIES || size > MAX_EXPANDED_BYTES) {
        throw fail("development.ota_limit_exceeded");
      }
      const bytes = await readFile(target, { flag: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) });
      if (bytes.length !== metadata.size) throw fail("development.ota_entry_changed");
      names.add(path.toLowerCase());
      files.push({ path, bytes, sha256: digest(bytes) });
    }
  }
  await walk(directory, "");
  if (!files.some(({ path, bytes }) => path === "index.html" && bytes.length > 0)) {
    throw fail("development.ota_missing_index");
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function buildZip(files) {
  const locals = [];
  const centralDirectory = [];
  let offset = 0;
  let centralSize = 0;
  for (const { path, bytes } of files) {
    const name = Buffer.from(path, "utf8");
    const compressed = deflateRawSync(bytes, { level: 9 });
    const checksum = crc32(bytes);
    const metadata = Buffer.alloc(22);
    metadata.writeUInt16LE(20, 0); // ZIP version needed
    metadata.writeUInt16LE(0x0800, 2); // UTF-8 file name
    metadata.writeUInt16LE(8, 4); // Deflate
    metadata.writeUInt16LE(0x5c21, 8); // 2026-01-01
    metadata.writeUInt32LE(checksum, 10);
    metadata.writeUInt32LE(compressed.length, 14);
    metadata.writeUInt32LE(bytes.length, 18);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    metadata.copy(local, 4);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    metadata.copy(central, 6);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centralDirectory.push(central, name);
    offset += local.length + name.length + compressed.length;
    centralSize += central.length + name.length;
    if (offset + centralSize + 22 > MAX_OTA_BYTES) throw fail("development.ota_limit_exceeded");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centralDirectory, end]);
}

export async function prepareOtaArtifact(directory, artifactDirectory) {
  const assets = await listAssets(directory);
  const zip = buildZip(assets);
  const files = assets.map(({ path, sha256 }) => ({ path, sha256 }));
  if (!isDeepStrictEqual(files, archiveFiles(zip))) throw fail("development.ota_verify_failed");
  const sha256 = digest(zip);
  const temporary = join(artifactDirectory, `.ota-${randomUUID()}.tmp`);
  const destination = join(artifactDirectory, `${sha256}.zip`);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, zip, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, destination);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await lstat(destination);
    if (!existing.isFile() || existing.size !== zip.length || digest(await readFile(destination)) !== sha256) {
      throw fail("development.ota_artifact_conflict");
    }
  } finally {
    await unlink(temporary);
  }
  return { sha256, files };
}
