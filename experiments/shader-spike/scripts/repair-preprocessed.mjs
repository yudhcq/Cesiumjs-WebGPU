/**
 * Spike S5 — Path A, full mechanical-repair chain, on PREPROCESSED Cesium GLSL.
 *
 * Realistic pipeline shape:
 *   assembled GLSL (ES 3.00, #ifdef-laden)
 *     -> glslang -E                      (preprocess with Cesium's #defines)
 *     -> repair 1..4 (this script)       (the parts naga/glslang cannot ingest)
 *     -> glslang -V                      (SPIR-V)
 *     -> naga                            (WGSL)
 *
 * Repairs applied, each one a *semantic* change, not a syntax tweak:
 *   R1 `#version 300 es`            -> `#version 310 es`   (glslang: ES SPIR-V needs >=310)
 *   R2 loose `uniform T n;`         -> single std140 uniform block + `czmUBO.n` rewriting
 *   R3 `in/out` globals             -> explicit `layout(location = N)`
 *   R4 block inserted after the     (GLSL ES requires a default float precision before
 *      precision statements            any float declaration)
 *
 * Usage: node repair-preprocessed.mjs <in.glsl> <stage:vert|frag> <out.glsl>
 */
import fs from "node:fs";

const [inFile, stage, outFile] = process.argv.slice(2);
if (!inFile || !outFile) {
  console.error("usage: node repair-preprocessed.mjs <in.glsl> <vert|frag> <out.glsl>");
  process.exit(2);
}
let src = fs.readFileSync(inFile, "utf8");
const report = { inFile, stage, repairs: {} };

// ---- R0: drop GLSL `#line` directives ---------------------------------------
// Cesium emits `#line 0` markers for debuggability; glslang rejects them once any
// non-preprocessor token precedes them, and they make every diagnostic line-0.
const lineDirectives = (src.match(/#line\b/g) || []).length;
src = src.replace(/[ \t]*#line\b[^\r\n]*/g, "");
report.repairs.dropLineDirectives = lineDirectives;

// ---- R1: version bump -------------------------------------------------------
src = src.replace(/^#version[^\r\n]*/m, "#version 310 es");
report.repairs.versionBump = "300 es -> 310 es";

// ---- R2: hoist loose uniforms into one std140 block -------------------------
// NOTE: array-typed declarations (`uniform sampler2D u_dayTextures[1];`) must be
// matched too, otherwise the sampler is left without layout(binding=...) and glslang
// fails with "sampler/texture/image requires layout(binding=X)".
const OPAQUE = /^(sampler|isampler|usampler|image|texture)/;
const members = [];
const samplers = [];
src = src.replace(
  /^[ \t]*uniform[ \t]+([A-Za-z0-9_]+)[ \t]+([A-Za-z0-9_]+)(\[[^\]]*\])?[ \t]*;[ \t]*\r?$/gm,
  (m, type, name, array) => {
    if (OPAQUE.test(type)) {
      samplers.push(`${type} ${name}${array ?? ""}`);
      return `layout(binding = ${16 + samplers.length}) uniform ${type} ${name}${array ?? ""};`;
    }
    members.push({ type, name, array: array ?? "" });
    return "";
  },
);
for (const { name } of members) {
  src = src.replace(
    new RegExp(`(?<![.A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, "g"),
    `czmUBO.${name}`,
  );
}
report.repairs.uniformBlock = {
  members: members.length,
  samplers: samplers.length,
  note: "all automatic uniforms merged into ONE std140 block; GL-side per-uniform binding by name is lost",
};

// ---- R3: explicit locations on global in/out --------------------------------
let loc = 0;
const located = [];
src = src
  .split("\n")
  .map((raw) => {
    const line = raw.replace(/\r$/, "");
    const m = line.match(
      /^[ \t]*(in|out)[ \t]+([A-Za-z0-9_]+)[ \t]+([A-Za-z0-9_]+)[ \t]*;[ \t]*$/,
    );
    if (!m) return raw;
    const l = loc++;
    located.push(`${m[1]} ${m[2]} ${m[3]} -> location ${l}`);
    return line.replace(/^([ \t]*)(in|out)/, `$1layout(location = ${l}) $2`);
  })
  .join("\n");
report.repairs.ioLocations = located;

// ---- R4: insert the block AFTER the precision statements --------------------
// GLSL ES requires a default float precision to be declared before any float
// declaration, and Cesium emits its precision block early, so the UBO cannot simply
// be appended after `#version`.
const block =
  `layout(std140, set = 0, binding = 0) uniform CZM_UBO {\n` +
  members.map((m) => `    ${m.type} ${m.name}${m.array};`).join("\n") +
  `\n} czmUBO;\n`;
const lines = src.split("\n");
let insertAt = 1; // just after #version
for (let i = 1; i < lines.length; i++) {
  const l = lines[i].replace(/\r$/, "");
  if (/^\s*(precision|#ifdef\s+GL_FRAGMENT_PRECISION_HIGH|#else|#endif)/.test(l)) {
    insertAt = i + 1;
    continue;
  }
  if (/^\s*$/.test(l) || /^\s*#(define|line|extension)/.test(l)) {
    insertAt = i + 1;
    continue;
  }
  break;
}
lines.splice(insertAt, 0, block);
src = lines.join("\n");
report.repairs.blockInsertLine = insertAt;

fs.writeFileSync(outFile, src, "utf8");
console.log(JSON.stringify(report, null, 2));
