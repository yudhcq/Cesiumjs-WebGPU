/**
 * Spike S4 — Path A mechanical-repair experiment.
 *
 * Cesium's assembled GLSL is GLSL ES 3.00 with ~25 loose `uniform` declarations per
 * stage. glslang refuses both (see logs/A1..A4). This script applies the MINIMAL
 * mechanical repairs needed to get past glslang, then measures how far the pipeline gets:
 *
 *   repair 1 : `#version 300 es` -> `#version 310 es`
 *   repair 2 : hoist every non-opaque `uniform T name;` into one std140 uniform block
 *              and rewrite all uses `name` -> `czmUBO.name`
 *   repair 3 : give opaque uniforms (samplers) explicit layout(binding=N)
 *
 * Usage: node prepare-spirv-able.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLSL = path.resolve(HERE, "..", "glsl");
const OUT = path.resolve(HERE, "..", "glsl-patched");
fs.mkdirSync(OUT, { recursive: true });

const OPAQUE = /^(sampler|isampler|usampler|image|texture)/;

function repair(src, { blockName = "czmUBO", set = 0, binding = 0 } = {}) {
  const stats = { uniforms: [], samplers: [], renames: 0, blocks: 0 };
  let out = src.replace(/^#version[^\r\n]*/m, "#version 310 es\n");

  // Pass 1: pull out loose uniform declarations (line-anchored, one per line).
  const re = /^[ \t]*uniform[ \t]+([A-Za-z0-9_]+)[ \t]+([A-Za-z0-9_]+)[ \t]*;[ \t]*$/gm;
  const members = [];
  out = out.replace(re, (m, type, name) => {
    if (OPAQUE.test(type)) {
      stats.samplers.push(`${type} ${name}`);
      return `layout(binding = ${binding + stats.samplers.length + 8}) uniform ${type} ${name};`;
    }
    members.push({ type, name });
    return ``;
  });
  stats.uniforms = members.map((m) => `${m.type} ${m.name}`);

  // Pass 2: rewrite identifier uses of each hoisted uniform.
  for (const { name } of members) {
    const useRe = new RegExp(`(?<![.A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, "g");
    const before = out;
    out = out.replace(useRe, `${blockName}.${name}`);
    if (before !== out) stats.renames++;
  }

  // Pass 3: insert the block right after the #version line.
  const block =
    `layout(std140, set = ${set}, binding = ${binding}) uniform CZM_UBO {\n` +
    members.map((m) => `    ${m.type} ${m.name};`).join("\n") +
    `\n} ${blockName};\n`;
  out = out.replace(/^#version 310 es\n/m, `#version 310 es\n${block}`);
  stats.blocks = 1;
  return { out, stats };
}

for (const name of ["default-3d", "minimal-3d", "kitchen-sink"]) {
  for (const stage of ["vert", "frag"]) {
    const src = fs.readFileSync(path.join(GLSL, `${name}.${stage}.glsl`), "utf8");
    const { out, stats } = repair(src);
    fs.writeFileSync(path.join(OUT, `${name}.${stage}.glsl`), out, "utf8");
    console.log(
      `${name}.${stage}: hoisted ${stats.uniforms.length} uniforms into 1 block, ${stats.samplers.length} samplers rebound, ${stats.renames} identifiers rewritten`,
    );
  }
}
console.log(`\nwrote ${OUT}`);
