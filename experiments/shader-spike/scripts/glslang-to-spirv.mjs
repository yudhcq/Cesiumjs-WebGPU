/**
 * Spike S2 — Path A, stage 1: GLSL ES 3.00 -> SPIR-V with @webgpu/glslang (wasm, npm-only toolchain).
 * Feeds the REAL assembled Cesium globe shaders from ../glsl/.
 * Usage: node glslang-to-spirv.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLSL_DIR = path.resolve(HERE, "..", "glsl");
const OUT = path.resolve(HERE, "..", "logs");
fs.mkdirSync(OUT, { recursive: true });

// package "main" is dist/node-devel/glslang (wasm, Vulkan SPIR-V target).
// The spike toolchain deliberately lives OUTSIDE the repo (see REPORT.md §0):
// nothing is installed at the repository root.
const TOOLCHAIN =
  process.env.SPIKE_TOOLCHAIN ?? path.join(os.tmpdir(), "shader-spike");
const glslangModule = require(
  path.join(TOOLCHAIN, "node_modules", "@webgpu", "glslang"),
);
const glslang = await glslangModule();

const cases = process.argv.slice(2);
const targets = cases.length
  ? cases
  : ["default-3d", "minimal-3d", "kitchen-sink"];

const report = [];
for (const name of targets) {
  for (const stage of ["vert", "frag"]) {
    const file = path.join(GLSL_DIR, `${name}.${stage}.glsl`);
    const src = fs.readFileSync(file, "utf8");
    const t0 = performance.now();
    let spirv = null;
    let error = null;
    try {
      spirv = glslang.compileGLSL(src, stage === "vert" ? "vertex" : "fragment");
    } catch (e) {
      error = String(e && e.message ? e.message : e);
    }
    const ms = +(performance.now() - t0).toFixed(1);
    if (spirv) {
      fs.writeFileSync(path.join(OUT, `${name}.${stage}.spv`), Buffer.from(spirv));
    }
    const entry = {
      name,
      stage,
      glslLines: src.split("\n").length,
      ok: !!spirv,
      spirvBytes: spirv ? spirv.length : 0,
      spirvWords: spirv ? spirv.length / 4 : 0,
      ms,
      error,
    };
    report.push(entry);
    console.log(
      `${name}.${stage}: ${spirv ? `OK ${spirv.length} bytes (${spirv.length / 4} words) in ${ms} ms` : `FAIL`}`,
    );
    if (error) console.log("  error:\n" + error.split("\n").map((l) => "    " + l).join("\n"));
  }
}
fs.writeFileSync(path.join(OUT, "glslang-report.json"), JSON.stringify(report, null, 2));
