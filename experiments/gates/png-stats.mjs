#!/usr/bin/env node
/**
 * G-1 gate — minimal PNG reader + pixel statistics (zero dependencies).
 *
 * WHY: the gate's central claim ("the upstream terrain is not visible in the capture") must be
 * checked against the **actual screenshot bytes**, not against a re-rendered copy or a hand-wave.
 * Chrome/Edge screenshots are non-interlaced 8-bit PNGs; this module decodes exactly that subset
 * (colour types 2 and 6) with `node:zlib` and implements the five standard scanline filters.
 *
 * Exports:
 *   readPng(path)                      -> { width, height, data: Uint8Array (RGBA8) }
 *   countColor(snapshot, rgb, tol)     -> { matched, total, ratio }
 *   diffPng(a, b, tol)                 -> { mismatchPixels, total, ratio, maxChannelDelta, bbox }
 */

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readPng(path) {
  const buffer = readFileSync(path);
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${path}: not a PNG file`);
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8) {
    throw new Error(`${path}: unsupported bit depth ${bitDepth} (only 8 is supported)`);
  }
  if (interlace !== 0) {
    throw new Error(`${path}: interlaced PNG is not supported`);
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) {
    throw new Error(`${path}: unsupported colour type ${colorType} (only 2 and 6 are supported)`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);

  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawOffset++];
    for (let x = 0; x < stride; x++) {
      const value = raw[rawOffset + x];
      const a = x >= channels ? current[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let reconstructed;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + a;
          break;
        case 2:
          reconstructed = value + b;
          break;
        case 3:
          reconstructed = value + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          reconstructed = value + predictor;
          break;
        }
        default:
          throw new Error(`${path}: unknown scanline filter ${filter} at row ${y}`);
      }
      current[x] = reconstructed & 0xff;
    }
    rawOffset += stride;
    for (let x = 0; x < width; x++) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      out[dst] = current[src];
      out[dst + 1] = current[src + 1];
      out[dst + 2] = current[src + 2];
      out[dst + 3] = channels === 4 ? current[src + 3] : 255;
    }
    previous.set(current);
  }

  return { width, height, data: out, path, colorType, bytes: buffer.length };
}

export function countColor(snapshot, rgb, tolerance = 16, minAlpha = 200) {
  const { data } = snapshot;
  const total = snapshot.width * snapshot.height;
  let matched = 0;
  let opaque = 0;
  let fullyTransparent = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a >= minAlpha) {
      opaque++;
    }
    if (a === 0) {
      fullyTransparent++;
    }
    if (
      Math.abs(data[i] - rgb[0]) <= tolerance &&
      Math.abs(data[i + 1] - rgb[1]) <= tolerance &&
      Math.abs(data[i + 2] - rgb[2]) <= tolerance &&
      a >= minAlpha
    ) {
      matched++;
    }
  }
  return { matched, total, ratio: matched / total, opaque, fullyTransparent };
}

export function diffPng(a, b, perChannelTolerance = 8) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const total = a.width * a.height;
  let mismatchPixels = 0;
  let maxChannelDelta = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      const delta = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]),
        Math.abs(a.data[i + 3] - b.data[i + 3]),
      );
      if (delta > maxChannelDelta) {
        maxChannelDelta = delta;
      }
      if (delta > perChannelTolerance) {
        mismatchPixels++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    mismatchPixels,
    total,
    ratio: mismatchPixels / total,
    maxChannelDelta,
    bbox:
      mismatchPixels > 0
        ? { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
        : null,
  };
}

export function channelMeans(snapshot) {
  const { data } = snapshot;
  const total = snapshot.width * snapshot.height;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    a += data[i + 3];
  }
  return { r: r / total, g: g / total, b: b / total, a: a / total };
}

/** Bounding box + centre of all pixels matching a colour — used to locate the globe disk. */
export function colorBBox(snapshot, rgb, tolerance = 24, minAlpha = 200) {
  const { data, width, height } = snapshot;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let matched = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (
        Math.abs(data[i] - rgb[0]) <= tolerance &&
        Math.abs(data[i + 1] - rgb[1]) <= tolerance &&
        Math.abs(data[i + 2] - rgb[2]) <= tolerance &&
        data[i + 3] >= minAlpha
      ) {
        matched++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (matched === 0) {
    return { matched: 0, bbox: null, center: null, radii: null };
  }
  return {
    matched,
    bbox: { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 },
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    radii: { rx: (maxX - minX + 1) / 2, ry: (maxY - minY + 1) / 2 },
  };
}

/**
 * Diff restricted to the interior of an ellipse (the globe's projected disk, shrunk by `shrink`).
 * Lets a claim like "the difference is confined to the limb, not the globe surface" be measured
 * instead of asserted.
 */
export function diffPngInEllipse(a, b, center, radii, shrink = 0.85, perChannelTolerance = 8) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const rx = radii.rx * shrink;
  const ry = radii.ry * shrink;
  let inside = 0;
  let insideMismatch = 0;
  let insideMaxDelta = 0;
  let outsideMismatch = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      const delta = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]),
        Math.abs(a.data[i + 3] - b.data[i + 3]),
      );
      const nx = (x - center.x) / rx;
      const ny = (y - center.y) / ry;
      const isInside = nx * nx + ny * ny <= 1;
      if (isInside) {
        inside++;
        if (delta > perChannelTolerance) {
          insideMismatch++;
          if (delta > insideMaxDelta) insideMaxDelta = delta;
        }
      } else if (delta > perChannelTolerance) {
        outsideMismatch++;
      }
    }
  }
  return {
    shrink,
    ellipse: { center, rx, ry },
    insidePixels: inside,
    insideMismatchPixels: insideMismatch,
    insideMismatchRatio: insideMismatch / inside,
    insideMaxChannelDelta: insideMaxDelta,
    outsideMismatchPixels: outsideMismatch,
  };
}
