#!/usr/bin/env node
/**
 * G-6 gate runner, part 2 — **H-7: 精度差异与纹理 Y 翻转** (tasks.md T026).
 *
 *   node experiments/gates/g6-precision/run.mjs --backend=webgpu
 *   node experiments/gates/g6-precision/run.mjs --backend=webgl2
 *
 * **One backend per run** — the two runs are separate processes with separate pages (principle II /
 * arch rule A7); they never share a session and never render in the same frame. The offline
 * comparison is `compare.mjs --offscreen`.
 *
 * What each run renders (same fixed scene, `experiments/gates/shared/terrain-scene.mjs`):
 *   - `color`       the shaded frame: emitted WGSL (webgpu) vs the **real upstream assembled GLSL**
 *                   (webgl2) for the same define set + same uniforms + same imagery;
 *   - `elevation`   the *same vertex stage* with an elevation-encoding fragment stage, so the
 *                   terrain-elevation numbers travel through the same transform in both backends;
 *   - `texel-probe` a full-screen quad sampling the imagery texture, which makes each backend's
 *                   texture-origin convention directly observable.
 *
 * Artefacts: `experiments/gates/out/g6-precision-<backend>.json` (+ PNGs, + the pass sources).
 * Exit codes: 0 → the run rendered every pass; 1 → a pass failed; 2 → the runner could not run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runGatePage } from "../shared/page-runner.mjs";
import { encodePng } from "../shared/png.mjs";
import { OUT_DIR, REPO_ROOT, buildUnionLayout } from "../g5-shader/model.mjs";
import { assembleGlslForVariant } from "../g5-shader/define-matrix.mjs";
import { deriveVaryingPairs } from "../g5-shader/varying-pairing.mjs";
import { emitTerrainWgsl } from "../g5-shader/wgsl-emitter.mjs";
import { referencedUniforms } from "../g5-shader/model.mjs";
import { buildScene, ELLIPSOID_RADII } from "../shared/terrain-scene.mjs";
import { selectVariant } from "../../../tools/shader-verify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "page.html");
const PASS_DIR = path.join(OUT_DIR, "g6-precision-passes");

/** The define set both backends are run with (the MVP golden configuration of T022). */
export const PRECISION_SELECTION = { textureUnits: 1, quantization: "float", lighting: "daynight", groundAtmosphere: "none", fog: "none", ocean: "none", imageryOps: "none", tileLimitRectangle: "none", geodetic: "none" };

/**
 * Radius range the elevation pass encodes. Derived from the fixture (not from any measurement):
 * the patch's ECEF radius spans the ellipsoid radius plus the heightmap range.
 */
export function radiusRange(scene) {
  const min = Math.min(ELLIPSOID_RADII.x, ELLIPSOID_RADII.z) + scene.heightRange[0] - 50;
  const max = Math.max(ELLIPSOID_RADII.x, ELLIPSOID_RADII.z) + scene.heightRange[1] + 50;
  return [min, max];
}

function elevationWgsl(fragmentWgsl, range) {
  const start = fragmentWgsl.indexOf("struct FSIn {");
  const end = fragmentWgsl.indexOf("}", start);
  const struct = fragmentWgsl.slice(start, end + 1);
  return [
    `// G-6 elevation pass (T026): the emitted vertex stage is reused unchanged; only the fragment`,
    `// stage is replaced, so both backends run the SAME vertex transform.`,
    `const G6_RADIUS_MIN: f32 = ${range[0].toFixed(6)};`,
    `const G6_RADIUS_MAX: f32 = ${range[1].toFixed(6)};`,
    struct,
    `@fragment fn fs_main(input: FSIn) -> @location(0) vec4<f32> {`,
    `  let r = length(input.v_positionMC);`,
    `  return vec4<f32>(clamp((r - G6_RADIUS_MIN) / (G6_RADIUS_MAX - G6_RADIUS_MIN), 0.0, 1.0), 0.0, 0.0, 1.0);`,
    `}`,
    ``,
  ].join("\n");
}

function elevationGlsl(range) {
  return [
    `#version 300 es`,
    `precision highp float;`,
    `in vec3 v_positionMC;`,
    `layout(location = 0) out vec4 out_FragColor;`,
    `const float G6_RADIUS_MIN = ${range[0].toFixed(6)};`,
    `const float G6_RADIUS_MAX = ${range[1].toFixed(6)};`,
    `void main() {`,
    `  float r = length(v_positionMC);`,
    `  out_FragColor = vec4(clamp((r - G6_RADIUS_MIN) / (G6_RADIUS_MAX - G6_RADIUS_MIN), 0.0, 1.0), 0.0, 0.0, 1.0);`,
    `}`,
    ``,
  ].join("\n");
}

function texelProbeWgsl(layout, viewport, textureUnits) {
  const sampler = layout.samplers.find((entry) => entry.glslName === "u_dayTextures" && entry.element === 0);
  if (sampler === undefined) throw new Error("g6: the layout has no u_dayTextures[0] binding");
  return [
    `// G-6 texture-origin probe (T026): samples the imagery texture with the fragment coordinate,`,
    `// so the rendered corners expose each backend's texture-origin convention directly.`,
    `@group(0) @binding(${sampler.textureBinding}) var probeTexture : ${sampler.textureType};`,
    `@group(0) @binding(${sampler.samplerBinding}) var probeSampler : sampler;`,
    `@vertex fn vs_main(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {`,
    `  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));`,
    `  return vec4<f32>(positions[index], 0.0, 1.0);`,
    `}`,
    `@fragment fn fs_main(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {`,
    `  let uv = position.xy / vec2<f32>(${viewport.width}.0, ${viewport.height}.0);`,
    `  return textureSampleLevel(probeTexture, probeSampler, uv, 0.0);`,
    `}`,
    ``,
  ].join("\n");
}

function probeVertexGlsl() {
  return [
    `#version 300 es`,
    `const vec2 G6_POSITIONS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));`,
    `void main() { gl_Position = vec4(G6_POSITIONS[gl_VertexID], 0.0, 1.0); }`,
    ``,
  ].join("\n");
}

function texelProbeGlsl(viewport) {
  return [
    `#version 300 es`,
    `precision highp float;`,
    `uniform sampler2D u_dayTextures[1];`,
    `layout(location = 0) out vec4 out_FragColor;`,
    `void main() {`,
    // `gl_FragCoord.y` is bottom-up while WGSL's `@builtin(position).y` is top-down: flip it so both
    // probes compare the same SCREEN position (otherwise the probe would compare different pixels and
    // the flip policy would appear inverted).
    `  vec2 uv = vec2(gl_FragCoord.x, ${viewport.height}.0 - gl_FragCoord.y) / vec2(${viewport.width}.0, ${viewport.height}.0);`,
    `  out_FragColor = texture(u_dayTextures[0], uv);`,
    `}`,
    ``,
  ].join("\n");
}

function serialiseScene(scene, layout) {
  const bytes = Math.max(16, Math.ceil(layout.structSize / 16) * 16);
  const raw = new Uint8Array(bytes);
  const view = new DataView(raw.buffer);
  const write = (byteOffset, type, value) => {
    const scalars = { float: 1, vec2: 2, vec3: 3, vec4: 4 }[type];
    if (scalars !== undefined) {
      for (let component = 0; component < scalars; component += 1) {
        const offset = byteOffset + component * 4;
        if (offset + 4 > raw.length) return;
        view.setFloat32(offset, Number(value[component] ?? value) || 0, true);
      }
      return;
    }
    if (type === "bool") return view.setUint32(byteOffset, value ? 1 : 0, true);
    if (type === "int") return view.setInt32(byteOffset, Number(value) | 0, true);
    if (type === "mat3" || type === "mat4") {
      const columns = type === "mat3" ? 3 : 4;
      const rows = type === "mat3" ? 3 : 4;
      for (let column = 0; column < columns; column += 1) {
        for (let row = 0; row < rows; row += 1) {
          const offset = byteOffset + column * 16 + row * 4;
          if (offset + 4 <= raw.length) view.setFloat32(offset, value[column * rows + row] ?? 0, true);
        }
      }
      return;
    }
    throw new Error(`g6: cannot serialise uniform type "${type}"`);
  };
  for (const member of layout.members) {
    const entry = scene.uniforms[member.name];
    if (entry === undefined) continue;
    const elementValues = member.length > 1 ? (Array.isArray(entry.elements) ? entry.elements : new Array(member.length).fill(entry.value)) : [entry.value];
    for (let element = 0; element < member.length; element += 1) write(member.byteOffset + element * (member.arrayStride ?? 0), entry.type, elementValues[element]);
  }
  const vertices = new Uint8Array(scene.interleaved.buffer.slice(0));
  const indices = new Uint8Array(scene.indices.buffer.slice(0));
  return {
    viewport: scene.config.viewport,
    vertexBytes: vertices.byteLength,
    vertexBytesArray: [...vertices],
    indexBytes: indices.byteLength,
    indexBytesArray: [...indices],
    indexCount: scene.indexCount,
    uniformBytes: bytes,
    uniformBytesArray: [...raw],
    imagery: {
      width: scene.imagery.width,
      height: scene.imagery.height,
      rgba: [...scene.imagery.rgba],
      corners: {
        topLeft: texelAt(scene, 0, 0),
        topRight: texelAt(scene, scene.imagery.width - 1, 0),
        bottomLeft: texelAt(scene, 0, scene.imagery.height - 1),
        bottomRight: texelAt(scene, scene.imagery.width - 1, scene.imagery.height - 1),
      },
    },
    samplers: layout.samplers,
  };
}

function texelAt(scene, x, y) {
  const index = (y * scene.imagery.width + x) * 4;
  return [scene.imagery.rgba[index], scene.imagery.rgba[index + 1], scene.imagery.rgba[index + 2], scene.imagery.rgba[index + 3]];
}

async function main() {
  const argv = process.argv.slice(2);
  let backend = null;
  let quiet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(0, eq) : token;
    const value = eq >= 0 ? token.slice(eq + 1) : argv[index + 1];
    if (key === "--backend") backend = value;
    else if (key === "--quiet") quiet = true;
  }
  if (backend !== "webgpu" && backend !== "webgl2") throw new Error("--backend=webgpu|webgl2 is required (and exactly one of them: the two paths MUST NOT run in one session)");

  const startedAt = new Date().toISOString();
  const log = (line) => {
    if (!quiet) process.stdout.write(`[g6-precision:${backend}] ${line}\n`);
  };
  log(`start ${startedAt} (node ${process.version})`);

  fs.rmSync(PASS_DIR, { recursive: true, force: true });
  fs.mkdirSync(PASS_DIR, { recursive: true });

  const variant = selectVariant(PRECISION_SELECTION);
  const glsl = assembleGlslForVariant(variant);
  const derivation = deriveVaryingPairs({ vertexSource: glsl.vertexSource, fragmentSource: glsl.fragmentSource, defines: variant.defines });
  const layout = buildUnionLayout();
  const emission = emitTerrainWgsl({ variant, glsl, derivation, layout });
  if (!emission.ok) throw new Error(`g6: the precision define set was not emitted: ${JSON.stringify(emission.unsupported)}`);

  const scene = buildScene({ quantized: false });
  const range = radiusRange(scene);
  const viewport = scene.config.viewport;
  const serialisedScene = serialiseScene(scene, layout);
  const uniforms = referencedUniforms(glsl, variant.defines);

  const write = (name, text) => {
    const target = path.join(PASS_DIR, `${name}.${backend === "webgpu" ? "wgsl" : "glsl"}`);
    fs.writeFileSync(target, text, "utf8");
    return `/${path.relative(REPO_ROOT, target).split(path.sep).join("/")}`;
  };

  const passes = [];
  if (backend === "webgpu") {
    const attributes = [
      { ...derivation.attributes[0], stride: 32, format: "float32x4", offset: 0 },
      { ...derivation.attributes[1], stride: 32, format: "float32x4", offset: 16 },
    ];
    // The texel probe is split so the binding declarations live in the fragment module only (the
    // vertex module of a full-screen triangle declares no resources).
    const probe = texelProbeWgsl(layout, viewport, 1);
    const vertexPart = probe.slice(probe.indexOf("@vertex fn vs_main"), probe.indexOf("@fragment fn fs_main"));
    const fragmentPart = `${probe.slice(0, probe.indexOf("@vertex fn vs_main"))}${probe.slice(probe.indexOf("@fragment fn fs_main"))}`;
    passes.push(
      // The variant's pipeline-overridable constants: `color` uses both emitted stages, `elevation`
      // keeps the emitted vertex stage but replaces the fragment stage (which declares none of the
      // overrides, so it MUST be given none), and the texel probe is a standalone pair.
      { id: "color", vertexUrl: write("color-vs", emission.vertexWgsl), fragmentUrl: write("color-fs", emission.fragmentWgsl), attributes, vertexConstants: emission.structure.overrides, fragmentConstants: emission.structure.overrides },
      { id: "elevation", vertexUrl: write("elevation-vs", emission.vertexWgsl), fragmentUrl: write("elevation-fs", elevationWgsl(emission.fragmentWgsl, range)), attributes, vertexConstants: emission.structure.overrides, fragmentConstants: null },
      { id: "texel-probe", vertexUrl: write("probe-vs", vertexPart), fragmentUrl: write("probe-fs", fragmentPart), attributes: [] },
    );
  } else {
    const attributes = [
      { name: derivation.attributes[0].name, location: 0, offset: 0, format: "float32x4", stride: 32 },
      { name: derivation.attributes[1].name, location: 1, offset: 16, format: "float32x4", stride: 32 },
    ];
    passes.push(
      { id: "color", vertexUrl: write("color-vs", glsl.vertexSource), fragmentUrl: write("color-fs", glsl.fragmentSource), attributes },
      { id: "elevation", vertexUrl: write("elevation-vs", glsl.vertexSource), fragmentUrl: write("elevation-fs", elevationGlsl(range)), attributes },
      { id: "texel-probe", vertexUrl: write("probe-vs", probeVertexGlsl()), fragmentUrl: write("probe-fs", texelProbeGlsl(viewport)), attributes: [] },
    );
  }

  const input = {
    backend,
    sceneId: scene.id,
    variant: variant.id,
    defines: variant.defines,
    passes,
    attributes: passes[0].attributes,
    // Typed arrays do not survive JSON as arrays (`JSON.stringify(Float64Array)` yields an object),
    // and `new Float32Array(object)` is length 0 → `uniformMatrix*fv` raises GL_INVALID_VALUE and the
    // matrix stays zero (the first version of this runner rendered a black frame for exactly this
    // reason). Normalise every value to a plain array here.
    uniforms: uniforms.map((entry) => {
      const source = scene.uniforms[entry.name];
      const normalise = (value) => (ArrayBuffer.isView(value) ? Array.from(value) : Array.isArray(value) ? value.map(normalise) : value);
      return { name: entry.name, glslType: entry.glslType, size: entry.size, value: normalise(source?.value ?? 0), elements: source?.elements === undefined ? undefined : normalise(source.elements) };
    }),
    scene: serialisedScene,
    layout: { structName: layout.structName, structSize: layout.structSize, members: layout.members.map((member) => ({ name: member.name, byteOffset: member.byteOffset, byteSize: member.byteSize, arrayStride: member.arrayStride, length: member.length })) },
  };

  const run = await runGatePage({ page: PAGE, globalName: "__g6p", input, inputFile: path.join(OUT_DIR, `g6-precision-input-${backend}.json`), quiet });
  const collected = run.collected;
  if (collected === null) throw new Error(`the device page produced no report: ${run.runtimeError ?? "unknown reason"}`);

  // Frames to PNG + a JSON summary without the (huge) base64 payload.
  const frames = {};
  const summary = {};
  for (const [id, pass] of Object.entries(collected.passes ?? {})) {
    if (pass.rgbaBase64 === undefined) {
      summary[id] = pass;
      continue;
    }
    const pixels = Buffer.from(pass.rgbaBase64, "base64");
    const png = path.join(OUT_DIR, `g6-precision-${backend}-${id}.png`);
    fs.writeFileSync(png, encodePng(new Uint8Array(pixels), pass.width, pass.height));
    const { rgbaBase64: _drop, ...rest } = pass;
    summary[id] = { ...rest, png: path.relative(REPO_ROOT, png).split(path.sep).join("/") };
    frames[id] = { bytesPerRow: pass.bytesPerRow, width: pass.width, height: pass.height, rgbaBase64: pass.rgbaBase64 };
  }

  const document = {
    gate: "g6-precision",
    task: "T026",
    backend,
    verdict: collected.errors.length === 0 && Object.values(summary).every((pass) => pass.validationError === null) ? "pass" : "fail",
    recordedAt: new Date().toISOString(),
    notes:
      `T026 ${backend} 半程：以**同一个固定场景**渲染三个 pass —— color（${backend === "webgpu" ? "本仓库发射的 WGSL" : "上游拼装出的真实 GLSL"}）、elevation（同一顶点阶段 + 高程编码片元阶段）、` +
      `texel-probe（全屏四边形直接采样影像纹理，暴露纹理原点约定）。两次运行**互不重叠**（不同进程、不同页面、不同 backend）。离线比较见 compare.mjs --offscreen。`,
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      browser: { channel: process.env.GATE_BROWSER_CHANNEL ?? "chrome", version: run.browserVersion, headless: true, launchArgs: [] },
      adapter: collected.adapter ?? null,
      preferredFormat: collected.preferredFormat ?? null,
      textureFlipPolicy: backend === "webgpu" ? "row order reversed on upload (WebGPU has no UNPACK_FLIP_Y_WEBGL) — the Texture mapping layer policy" : "UNPACK_FLIP_Y_WEBGL = true (Cesium Texture.flipY default, Renderer/Texture.js:27)",
    },
    variant: { id: variant.id, defines: variant.defines },
    radiusRange: range,
    checks: [
      { id: "device-page-produced-report", ok: collected.errors.length === 0 && run.pageErrors.length === 0, detail: `page errors=${JSON.stringify(collected.errors.slice(0, 3))} pageerror=${JSON.stringify(run.pageErrors)}` },
      ...Object.entries(summary).map(([id, pass]) => ({ id: `pass-${id}-rendered`, ok: pass.validationError === null && (pass.nonBlackPixels ?? 0) > 0, detail: `${id}: ${pass.nonBlackPixels ?? "?"}/${pass.totalPixels ?? "?"} non-black, unique colours=${pass.uniqueColors ?? "?"}, validationError=${JSON.stringify(pass.validationError)}${pass.unsetUniforms !== undefined ? `, uniforms with no location=${JSON.stringify(pass.unsetUniforms)}` : ""}` })),
    ],
    evidence: [
      { path: `experiments/gates/out/g6-precision-${backend}.json`, what: "this artefact" },
      { path: `experiments/gates/out/g6-precision-input-${backend}.json`, what: "the exact input document handed to the device page" },
      ...Object.values(summary).filter((pass) => pass.png !== undefined).map((pass) => ({ path: pass.png, what: "rendered frame" })),
      { path: `experiments/gates/out/g6-precision-passes`, what: "the shader sources actually compiled in this run" },
    ].filter((entry) => fs.existsSync(path.join(REPO_ROOT, entry.path))),
    passes: summary,
    frames,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `g6-precision-${backend}.json`), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, `g6-precision-${backend}-run.log`), `${(collected.pages ?? []).join("\n")}\n`, "utf8");
  for (const entry of document.checks) process.stdout.write(`  [${entry.ok ? "ok" : "FAIL"}] ${entry.id}: ${entry.detail}\n`);
  log(`verdict=${document.verdict} -> experiments/gates/out/g6-precision-${backend}.json`);
  return document.verdict === "pass" ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`g6-precision: unexpected failure: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    });
}
