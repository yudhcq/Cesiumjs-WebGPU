#!/usr/bin/env node
/**
 * G-1 gate — deterministic local terrain fixture generator (T002).
 *
 * Produces the *only* terrain bytes the G-1 page consumes:
 *
 *   experiments/gates/fixtures/g1-level0-0-0.f32   Float32 little-endian, GRID*GRID heights (metres),
 *                                                  row-major, north -> south, west -> east.
 *   experiments/gates/fixtures/g1-level0-0-0.json  metadata + content digest (FNV-1a 32-bit).
 *
 * Design notes
 * ------------
 * - Zero third-party dependencies, Node built-ins only (`node:fs`, `node:path`).
 * - Fully deterministic: no clock, no RNG, no network. Re-running must reproduce the identical
 *   digest, which is what makes the gate reproducible on another machine.
 * - The fixture stands in for "a small fixed set of local terrain tiles" (tasks.md T002 wording).
 *   It is deliberately synthetic so the gate is hermetic (no external data source, no licence
 *   obligation, no network) — G-1 validates the *injection point* (`TerrainProvider` subclass ->
 *   `HeightmapTerrainData`) and the canvas layering, not the tile byte format. See
 *   `docs/gate-g1-conclusion.md` for why that substitution does not weaken the conclusion.
 * - The height field is a fixed sum of Gaussians + a low-frequency ripple, clamped to
 *   [0, 8800] m so it stays inside the "plausible terrain" range used by the project.
 *
 * Usage:  node experiments/gates/make-fixture.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Heightmap grid edge length. Must match GRID in g1-layering.ts. */
export const GRID = 65;
export const HEIGHT_SCALE = 1.0;
export const HEIGHT_OFFSET = 0.0;

/**
 * The hard-coded tile set. `GeographicTilingScheme` has **two** level-zero tiles
 * (`getNumberOfXTilesAtLevel(0) === 2`, each 180 deg of longitude wide, one row), so covering the
 * whole globe needs both of them. Discovering that the hard way is itself part of the gate record.
 */
export const TILES = [
  { level: 0, x: 0, y: 0, file: "g1-level0-0-0.f32", seed: 0 },
  { level: 0, x: 1, y: 0, file: "g1-level0-1-0.f32", seed: 1 },
];

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "fixtures");

/** FNV-1a 32-bit over a byte sequence — stable, dependency-free content digest. */
export function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic synthetic height field for one level-0 Geographic tile (whole globe, 2 tiles). */
export function buildHeights(grid = GRID, seed = 0) {
  // A different fixed set of Gaussian centres per tile, so the two tiles are visibly different
  // and a seam between them is meaningful.
  const bumps =
    seed === 0
      ? [
          [0.42, 0.38, 4200, 0.02],
          [0.63, 0.56, 2650, 0.012],
          [0.29, 0.69, 1800, 0.03],
          [0.78, 0.24, 1250, 0.018],
        ]
      : [
          [0.34, 0.55, 3600, 0.022],
          [0.58, 0.31, 2900, 0.014],
          [0.72, 0.72, 1500, 0.026],
          [0.2, 0.2, 900, 0.04],
        ];
  const heights = new Float32Array(grid * grid);
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const u = i / (grid - 1);
      const v = j / (grid - 1);
      let h = 0;
      for (const [cu, cv, amp, sigma] of bumps) {
        h += amp * Math.exp(-(((u - cu) ** 2 + (v - cv) ** 2) / sigma));
      }
      h += 700 * Math.sin((u + seed * 0.3) * Math.PI * 6) * Math.cos(v * Math.PI * 5);
      h = Math.min(8800, Math.max(0, h));
      heights[j * grid + i] = Math.round(h * 100) / 100;
    }
  }
  return heights;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  let min = Infinity;
  let max = -Infinity;
  for (const tile of TILES) {
    const heights = buildHeights(GRID, tile.seed);
    const bytes = new Uint8Array(heights.buffer, heights.byteOffset, heights.byteLength);
    const digest = fnv1a(bytes);
    min = Math.min(min, ...heights);
    max = Math.max(max, ...heights);

    const binPath = join(OUT_DIR, tile.file);
    writeFileSync(binPath, bytes);

    const meta = {
      file: tile.file,
      format: "float32-le",
      grid: GRID,
      width: GRID,
      height: GRID,
      tile: { level: tile.level, x: tile.x, y: tile.y, tilingScheme: "GeographicTilingScheme" },
      structure: {
        heightScale: HEIGHT_SCALE,
        heightOffset: HEIGHT_OFFSET,
        elementsPerHeight: 1,
        stride: 1,
        elementMultiplier: 256,
        isBigEndian: false,
        lowestEncodedHeight: 0,
        highestEncodedHeight: 8800,
      },
      bytes: bytes.byteLength,
      fnv1a32: digest,
      fnv1a32Hex: "0x" + digest.toString(16).padStart(8, "0"),
      source: "synthetic-deterministic (make-fixture.mjs); no external data source, no network",
      provenance: "G-1 gate fixture, see docs/gate-g1-conclusion.md",
    };
    writeFileSync(join(OUT_DIR, tile.file.replace(/\.f32$/, ".json")), JSON.stringify(meta, null, 2) + "\n");
    console.log(
      `[make-fixture] ${tile.level}/${tile.x}/${tile.y} -> ${binPath} bytes=${bytes.byteLength} fnv1a32=${meta.fnv1a32Hex}`,
    );
  }
  console.log(`[make-fixture] height range over all tiles: ${min} .. ${max} m`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("make-fixture.mjs")) {
  main();
}
