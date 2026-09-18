/**
 * Shared gate helper — a minimal, dependency-free PNG encoder (8-bit RGBA, filter type 0).
 *
 * Gates must publish *lookable* evidence (`experiments/gates/README.md` §1), and a raw RGBA blob is
 * not lookable. Node's `zlib` is enough for a valid PNG; no image library is added to the workspace.
 *
 * Node-only, cross-platform.
 */
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * @param {Uint8Array} rgba row-major, `width * height * 4` bytes
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} a valid PNG file
 */
export function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer ?? rgba, rgba.byteOffset ?? 0, rgba.length).copy(raw, row * (width * 4 + 1) + 1, row * width * 4, (row + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Side-by-side / difference image for the gate's visual evidence. */
export function encodeDiffPng(a, b, width, height) {
  const out = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height * 4; index += 4) {
    const dr = Math.abs(a[index] - b[index]);
    const dg = Math.abs(a[index + 1] - b[index + 1]);
    const db = Math.abs(a[index + 2] - b[index + 2]);
    const max = Math.max(dr, dg, db);
    out[index] = Math.min(255, dr * 4);
    out[index + 1] = Math.min(255, dg * 4);
    out[index + 2] = Math.min(255, db * 4);
    out[index + 3] = max === 0 ? 255 : 255;
  }
  return encodePng(out, width, height);
}
