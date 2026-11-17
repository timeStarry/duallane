import { deflateSync, inflateSync } from "node:zlib";

const crcTable = new Uint32Array(256);
for (let i = 0; i < crcTable.length; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[i] = value >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, "ascii");
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

/** A complete deterministic RGB PNG, not a signature with arbitrary padding. */
export function largePngFixture() {
  const width = 1024, height = 1165, stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  let value = 0x6d2b79f5;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 1; x < stride; x++) {
      value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
      pixels[row + x] = value & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels, { level: 0 })), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Independently verify CRCs and decompressed rows used by the PNG regression. */
export function verifyLargePngFixture(png) {
  let offset = 8, width, height;
  const compressed = [];
  const chunks = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) throw new Error("Invalid PNG chunk length");
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, end - 4);
    if (crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)) throw new Error("Invalid PNG CRC");
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === "IDAT") compressed.push(data);
    chunks.push(type); offset = end;
  }
  const pixels = inflateSync(Buffer.concat(compressed));
  if (pixels.length !== (width * 3 + 1) * height || chunks.join(",") !== "IHDR,IDAT,IEND") throw new Error("Invalid PNG structure");
  for (let y = 0; y < height; y++) if (pixels[y * (width * 3 + 1)] !== 0) throw new Error("Invalid PNG filter");
  return { width, height, byteSize: png.length };
}
