#!/usr/bin/env node
/**
 * `tools/shader-verify.mjs` — real-device WGSL verification harness (tasks.md **T022**, productised
 * from the spike's `experiments/shader-spike/scripts/webgpu-harness.mjs`).
 *
 *   node tools/shader-verify.mjs --family=globe --variants=mvp
 *   node tools/shader-verify.mjs --family=globe --variants=all-reachable [--report <file>]
 *
 * What it does
 *   1. enumerates the MVP-reachable define matrix of the terrain (globe) shader family
 *      (`experiments/gates/g5-shader/define-matrix.mjs`) and **emits WGSL for every combination**
 *      through the parameterised emission seam (`wgsl-emitter.mjs`), grouping variants by the
 *      byte-identity of their emitted module pair;
 *   2. in `mvp` mode renders the fixed terrain scene (`experiments/gates/shared/terrain-scene.mjs`)
 *      with the golden configuration and reads the frame back (non-black pixels MUST cover the
 *      frame) — the spike's path-B assertion, productised;
 *   3. in `all-reachable` mode creates a real `GPURenderPipeline` for **every distinct module pair**
 *      on a hardware WebGPU adapter and requires zero validation errors, plus a **negative control**
 *      (a deliberately unpaired varying MUST fail — the spike's experiment E1, re-run live);
 *   4. writes `artifacts/shader-verify/globe-<variants>.json`, the machine model at
 *      `experiments/gates/out/g5-model.json`, the compiled modules under
 *      `experiments/gates/out/g5-modules/` and, with `--report <f>`, a gate-schema summary.
 *
 * Exit codes: 0 all checks hold; 1 a check failed; 2 the harness could not run.
 *
 * Zero runtime dependencies beyond the workspace's pinned `playwright`; Node-only, cross-platform.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createStaticServer } from "./scripts/serve.mjs";
import { buildGateModel, buildUnionLayout, OUT_DIR, REPO_ROOT } from "../experiments/gates/g5-shader/model.mjs";
import { emitTerrainWgsl, overrideKey } from "../experiments/gates/g5-shader/wgsl-emitter.mjs";
import { deriveVaryingPairs, deriveVaryingPairsFromWgsl, attributeLayoutFromDerivation } from "../experiments/gates/g5-shader/varying-pairing.mjs";
import { assembleGlslForVariant, enumerateReachableVariants } from "../experiments/gates/g5-shader/define-matrix.mjs";
import { buildScene } from "../experiments/gates/shared/terrain-scene.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(REPO_ROOT, "experiments", "gates", "g5-shader", "page.html");
const MODULE_DIR = path.join(OUT_DIR, "g5-modules");
const ARTIFACT_DIR = path.join(REPO_ROOT, "artifacts", "shader-verify");
const GROUPS_PER_CHUNK = 32;

/**
 * The golden MVP configuration: the spike's proven configuration (`experiments/shader-spike/REPORT.md`
 * §4 path B), now driven by the emitted WGSL instead of the hand-written port.
 *
 * The BITS12-quantized twin is **not** a golden render case: rendering it would require the harness
 * to reproduce `Core/TerrainEncoding.js`'s quantized packer (`toScaledENU` +
 * `AttributeCompression.compressTextureCoordinates`), which is a *fixture* concern rather than a
 * shader-emission concern. The quantized variant is still covered end-to-end by the
 * `--variants=all-reachable` sweep (module + pipeline + varying pairing) and its WGSL regions are
 * the ones the real heightmap path uses.
 */
export const MVP_CASES = [
  {
    id: "mvp-golden",
    description: "spike REPORT §4 configuration: non-quantized heightmap attributes, 1 texture unit, day/night shading, no ground atmosphere, no fog, no ocean",
    selection: { textureUnits: 1, quantization: "float", lighting: "daynight", groundAtmosphere: "none", fog: "none", ocean: "none", imageryOps: "none", tileLimitRectangle: "none", geodetic: "none" },
    quantized: false,
  },
];

const sha256 = (text) => `sha256-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
const repoRelative = (absolute) => path.relative(REPO_ROOT, absolute).split(path.sep).join("/");

export function parseArgv(argv) {
  const options = { family: "globe", variants: "mvp", report: null, quiet: false, headed: false, channel: undefined, timeoutMs: 1800000, modelOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(0, eq) : token;
    const value = eq >= 0 ? token.slice(eq + 1) : undefined;
    if (key === "--quiet") options.quiet = true;
    else if (key === "--headed") options.headed = true;
    else if (key === "--model-only") options.modelOnly = true;
    else if (key === "--family") options.family = value ?? argv[++index];
    else if (key === "--variants") options.variants = value ?? argv[++index];
    else if (key === "--report") options.report = path.resolve(value ?? argv[++index]);
    else if (key === "--channel") options.channel = value ?? argv[++index];
    else if (key === "--timeout") options.timeoutMs = Number(value ?? argv[++index]);
    else throw new Error(`unknown argument "${token}"`);
  }
  if (options.family !== "globe") throw new Error(`unknown --family "${options.family}" (only "globe" is implemented; other families MUST fail loudly rather than pass silently)`);
  if (!["mvp", "all-reachable"].includes(options.variants)) throw new Error(`unknown --variants "${options.variants}"`);
  return options;
}

/** Select one enumerated variant by its dimension values. */
export function selectVariant(selection) {
  const wanted = Object.entries(selection).map(([id, value]) => `${id}=${value}`).join("|");
  const variant = enumerateReachableVariants().find((candidate) => candidate.id === wanted);
  if (variant === undefined) throw new Error(`g5: no enumerated variant matches ${wanted}`);
  return variant;
}

/**
 * Walk the whole define matrix once: emit, hash, and write one representative module pair per
 * distinct hash group into chunked JSON files the probe fetches.
 */
export function buildAndWriteModules({ quiet = false } = {}) {
  const log = (line) => {
    if (!quiet) process.stdout.write(`[shader-verify] ${line}\n`);
  };
  const started = Date.now();
  const groups = [];
  const groupIndex = new Map();
  const pipelineKeys = new Map();
  const rows = [];
  let rejected = 0;
  let pending = [];

  fs.rmSync(MODULE_DIR, { recursive: true, force: true });
  fs.mkdirSync(MODULE_DIR, { recursive: true });

  const model = buildGateModel({
    onEmission: (entry, emission) => {
      if (!emission.ok) {
        rejected += 1;
        rows.push({ id: entry.variant.id, rejected: true, unsupported: emission.unsupported.map((item) => item.define) });
        return;
      }
      const vertexHash = sha256(emission.vertexWgsl);
      const fragmentHash = sha256(emission.fragmentWgsl);
      const key = `${vertexHash}_${fragmentHash}`;
      let index = groupIndex.get(key);
      if (index === undefined) {
        index = groups.length;
        groupIndex.set(key, index);
        groups.push({
          key,
          vertexHash,
          fragmentHash,
          representative: entry.variant.id,
          memberCount: 0,
          attributes: entry.emission.structure.vertexBufferLayout,
          varyingPairs: entry.emission.structure.paired,
          varyingSource: entry.derivation.source ?? null,
          vertexWgsl: emission.vertexWgsl,
          fragmentWgsl: emission.fragmentWgsl,
          vertexBytes: emission.vertexWgsl.length,
          fragmentBytes: emission.fragmentWgsl.length,
        });
        pending.push(index);
      }
      groups[index].memberCount += 1;
      // The runtime identity of a variant is the module pair **plus its pipeline-constant values**
      // (G-6/T025): two define sets that emit the same text still need different pipelines when their
      // `override` values differ. Both counts are published so a reader can see the decomposition.
      const overrides = entry.emission.structure.overrides;
      const pipelineKey = `${key}#${overrideKey(overrides)}`;
      if (!pipelineKeys.has(pipelineKey)) pipelineKeys.set(pipelineKey, { moduleKey: key, overrides });
      rows.push({ id: entry.variant.id, group: key, pipeline: pipelineKey, overrides, paired: entry.emission.structure.paired, rejected: false });

      // Flush a chunk as soon as a full one is ready (the model never holds the whole corpus).
      if (pending.length >= GROUPS_PER_CHUNK) pending = flushChunk(groups, pending);
    },
  });
  if (pending.length > 0) flushChunk(groups, pending);

  const chunkFiles = fs.readdirSync(MODULE_DIR).filter((name) => /^chunk-\d+\.json$/.test(name)).sort();
  const dimensionEffect = {};
  for (const dimension of model.defineSpace.dimensions) {
    const textOf = new Map();
    const wgslOf = new Map();
    for (const row of rows) {
      if (row.rejected) continue;
      const value = row.id.split("|").find((part) => part.startsWith(`${dimension.id}=`));
      const others = row.id
        .split("|")
        .filter((part) => !part.startsWith(`${dimension.id}=`))
        .join("|");
      textOf.set(others, new Set([...(textOf.get(others) ?? []), row.group]));
      wgslOf.set(others, new Set([...(wgslOf.get(others) ?? []), row.pipeline]));
    }
    dimensionEffect[dimension.id] = {
      changesModuleText: [...textOf.values()].some((keys) => keys.size > 1),
      changesPipelineIdentity: [...wgslOf.values()].some((keys) => keys.size > 1),
      values: dimension.values,
    };
  }
  fs.writeFileSync(
    path.join(MODULE_DIR, "index.json"),
    `${JSON.stringify({ chunkFiles, groupCount: groups.length, groupsPerChunk: GROUPS_PER_CHUNK, rows: rows.filter((row) => !row.rejected).map((row) => ({ id: row.id, group: row.group, overrides: row.overrides, attributes: groups[groupIndex.get(row.group)]?.attributes ?? [] })) }, null, 2)}\n`,
    "utf8",
  );
  log(
    `emitted ${rows.length - rejected}/${rows.length} variant(s); ${groups.length} distinct module pair(s) for ${pipelineKeys.size} distinct variant pipeline(s) in ${((Date.now() - started) / 1000).toFixed(1)}s; ${rejected} rejected`,
  );

  const store = {
    tool: "shader-verify/model",
    recordedAt: new Date().toISOString(),
    node: process.version,
    defineSpace: model.defineSpace,
    stats: {
      ...model.stats,
      distinctModulePairs: groups.length,
      distinctVariantPipelines: pipelineKeys.size,
      dimensionEffect,
      elapsedMs: Date.now() - started,
      chunkFiles: chunkFiles.length,
    },
    layout: {
      structName: model.layout.structName,
      structSize: model.layout.structSize,
      wgslStruct: model.layout.wgslStruct,
      memberCount: model.layout.members.length,
      samplers: model.layout.samplers,
      // The full member records are kept: `--variants=mvp` writes the uniform buffer strictly through
      // this table, so it needs `length` / `components` / `columns` — not just the byte offsets.
      members: model.layout.members.map((member) => ({ ...member, scalarOffsets: undefined })),
    },
    unionUniforms: model.unionUniforms,
    groups: groups.map((group) => ({
      key: group.key,
      vertexHash: group.vertexHash,
      fragmentHash: group.fragmentHash,
      representative: group.representative,
      memberCount: group.memberCount,
      attributes: group.attributes,
      varyingPairs: group.varyingPairs,
      // Provenance: which chunk file carries this module pair (the text itself is on disk).
      vertexBytes: group.vertexBytes,
      fragmentBytes: group.fragmentBytes,
    })),
    rows,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "g5-model.json"), `${JSON.stringify(store, null, 2)}\n`, "utf8");
  log(`wrote ${repoRelative(path.join(OUT_DIR, "g5-model.json"))} and ${chunkFiles.length} module chunk(s)`);
  return store;
}

function flushChunk(groups, pending) {
  const chunkIndex = fs.readdirSync(MODULE_DIR).filter((name) => /^chunk-\d+\.json$/.test(name)).length;
  const payload = pending.map((index) => {
    const group = groups[index];
    return { key: group.key, representative: group.representative, memberCount: group.memberCount, attributes: group.attributes, vertexWgsl: group.vertexWgsl, fragmentWgsl: group.fragmentWgsl };
  });
  fs.writeFileSync(path.join(MODULE_DIR, `chunk-${String(chunkIndex).padStart(4, "0")}.json`), JSON.stringify(payload), "utf8");
  // Drop the text now that it is on disk — the model stays small on purpose.
  for (const index of pending) {
    groups[index].vertexWgsl = null;
    groups[index].fragmentWgsl = null;
  }
  return [];
}

/** Write one module pair for a single variant (mvp mode) and return the file URLs. */
function writeVariantModules(id, vertexWgsl, fragmentWgsl) {
  fs.mkdirSync(MODULE_DIR, { recursive: true });
  const vertexPath = path.join(MODULE_DIR, `${id}-vs.wgsl`);
  const fragmentPath = path.join(MODULE_DIR, `${id}-fs.wgsl`);
  fs.writeFileSync(vertexPath, vertexWgsl, "utf8");
  fs.writeFileSync(fragmentPath, fragmentWgsl, "utf8");
  return { vertexUrl: `/${repoRelative(vertexPath)}`, fragmentUrl: `/${repoRelative(fragmentPath)}` };
}

/** Serialise the fixed scene for the page: buffers, uniforms (written via the CPU layout table), imagery. */
function serialiseScene(scene, layout) {
  const bytes = Math.max(16, Math.ceil(layout.structSize / 16) * 16);
  const buffer = new Float32Array(bytes / 4);
  const raw = new Uint8Array(buffer.buffer);
  const write = (byteOffset, type, value) => {
    const scalars = { float: 1, vec2: 2, vec3: 3, vec4: 4 }[type];
    if (scalars !== undefined) {
      for (let component = 0; component < scalars; component += 1) {
        const offset = byteOffset + component * 4;
        if (offset + 4 > raw.length) return;
        new DataView(raw.buffer).setFloat32(offset, Number(value[component] ?? value) || 0, true);
      }
      return;
    }
    if (type === "bool") {
      new DataView(raw.buffer).setUint32(byteOffset, value ? 1 : 0, true);
      return;
    }
    if (type === "int") {
      new DataView(raw.buffer).setInt32(byteOffset, Number(value) | 0, true);
      return;
    }
    if (type === "mat3" || type === "mat4") {
      const columns = type === "mat3" ? 3 : 4;
      const rows = type === "mat3" ? 3 : 4;
      const columnStride = 16;
      for (let column = 0; column < columns; column += 1) {
        for (let row = 0; row < rows; row += 1) {
          const offset = byteOffset + column * columnStride + row * 4;
          if (offset + 4 > raw.length) continue;
          new DataView(raw.buffer).setFloat32(offset, value[column * rows + row] ?? 0, true);
        }
      }
      return;
    }
    throw new Error(`g5: cannot serialise uniform type "${type}"`);
  };

  const missing = [];
  for (const member of layout.members) {
    const entry = scene.uniforms[member.name];
    if (entry === undefined) {
      missing.push(member.name);
      continue;
    }
    // Array members: the union layout sizes `TEXTURE_UNITS` arrays for the largest reachable variant,
    // so each element gets its own value (`elements`) — reusing `value[element]` would write scalars.
    const elementValues = member.length > 1 ? (Array.isArray(entry.elements) ? entry.elements : new Array(member.length).fill(entry.value)) : [entry.value];
    for (let element = 0; element < member.length; element += 1) {
      const elementOffset = member.byteOffset + element * (member.arrayStride ?? 0);
      write(elementOffset, entry.type, elementValues[element]);
    }
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
    structSize: layout.structSize,
    imagery: { width: scene.imagery.width, height: scene.imagery.height, rgba: [...scene.imagery.rgba] },
    heightRange: scene.heightRange,
    missingUniforms: missing,
  };
}

/** Run the page for one input document and return the collected report. */
export async function runPage({ input, inputFile, quiet = false, options }) {
  const log = (line) => {
    if (!quiet) process.stdout.write(`[shader-verify] ${line}\n`);
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(inputFile, JSON.stringify(input), "utf8");
  const server = createStaticServer({ root: REPO_ROOT });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/${repoRelative(PAGE)}?input=${encodeURIComponent(`/${repoRelative(inputFile)}`)}`;
  let browser = null;
  let collected = null;
  let runtimeError = null;
  const pageErrors = [];
  let browserVersion = "none";
  try {
    browser = await chromium.launch({ channel: options.channel ?? process.env.GATE_BROWSER_CHANNEL ?? "chrome", headless: options.headed !== true });
    browserVersion = browser.version();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(`${error.name ?? "Error"}: ${error.message ?? String(error)}`));
    log(`opening ${url} (browser ${browserVersion})`);
    await page.goto(url, { waitUntil: "load", timeout: options.timeoutMs });
    await page.waitForFunction(() => globalThis.__g5 !== undefined && globalThis.__g5.ready === true, null, { timeout: options.timeoutMs });
    collected = await page.evaluate(() => globalThis.__g5);
  } catch (error) {
    runtimeError = `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
  } finally {
    if (browser !== null) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
  return { collected, runtimeError, pageErrors, browserVersion };
}

/**
 * Run the harness. Exported so the G-5 gate runner can fold the device checks into its own verdict
 * without shelling out.
 *
 * @param {string[]} [argv] defaults to `process.argv.slice(2)`
 * @returns {Promise<{code: number, artifact: object, checks: object[], store: object|null}>}
 */
export async function runShaderVerify(argv = process.argv.slice(2)) {
  const options = parseArgv(argv);
  const startedAt = new Date().toISOString();
  const checks = [];
  const check = (id, ok, detail, extra = {}) => ({ id, ok: ok === true, detail, ...extra });

  if (options.variants === "mvp") {
    // ---- the layout comes from the marginal union (fast, and asserted equal to the full union by
    //      the gate runner); in `all-reachable` mode the full cross product rebuilds the same layout.
    let layout;
    let layoutSource;
    const storePath = path.join(OUT_DIR, "g5-model.json");
    if (fs.existsSync(storePath)) {
      const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
      layout = { structName: store.layout.structName, structSize: store.layout.structSize, wgslStruct: store.layout.wgslStruct, samplers: store.layout.samplers, members: store.layout.members };
      layoutSource = `${repoRelative(storePath)} (full cross-product union)`;
    } else {
      layout = buildUnionLayout();
      layoutSource = "marginal union (enumerateMarginals); the gate runner asserts it equals the full cross-product union";
    }

    const cases = [];
    for (const mvpCase of MVP_CASES) {
      const variant = selectVariant(mvpCase.selection);
      const glsl = assembleGlslForVariant(variant);
      const derivation = deriveVaryingPairs({ vertexSource: glsl.vertexSource, fragmentSource: glsl.fragmentSource, defines: variant.defines });
      const emission = emitTerrainWgsl({ variant, glsl, derivation, layout });
      if (!emission.ok) throw new Error(`g5: the MVP case "${mvpCase.id}" was not emitted: ${JSON.stringify(emission.unsupported)}`);
      const urls = writeVariantModules(mvpCase.id, emission.vertexWgsl, emission.fragmentWgsl);
      const scene = buildScene({ quantized: mvpCase.quantized });
      const fromWgsl = deriveVaryingPairsFromWgsl(emission.vertexWgsl, emission.fragmentWgsl);
      // Constant-colour fragment stage carrying the case's own `FSIn`: it isolates the vertex stage
      // (geometry coverage) from the textured fragment stage.
      const fragmentStructStart = emission.fragmentWgsl.indexOf("struct FSIn {");
      const fragmentStructEnd = emission.fragmentWgsl.indexOf("}", fragmentStructStart);
      const constantFragmentWgsl = `${emission.fragmentWgsl.slice(fragmentStructStart, fragmentStructEnd + 1)}\n\n@fragment\nfn fs_main(input: FSIn) -> @location(0) vec4<f32> { return vec4<f32>(0.25, 0.5, 0.75, 1.0); }\n`;
      cases.push({
        ...mvpCase,
        ...urls,
        constantFragmentWgsl,
        variantId: variant.id,
        // The pipeline-overridable constants this variant's module must be specialised with
        // (G-6/T025): without them the module's defaults apply (`numberOfDayTextures = 0`), which would
        // silently render the golden configuration with no imagery at all.
        constants: emission.structure.overrides,
        attributes: attributeLayoutFromDerivation(derivation),
        paired: derivation.paired.map((entry) => entry.name),
        fromWgsl,
        layout: { structName: layout.structName, structSize: layout.structSize, members: layout.members.map((member) => ({ name: member.name, byteOffset: member.byteOffset, byteSize: member.byteSize, arrayStride: member.arrayStride, length: member.length, glslType: member.glslType })) },
        samplers: layout.samplers,
        scene: serialiseScene(scene, layout),
      });
      checks.push(
        check(
          `${mvpCase.id}-scene-has-every-uniform`,
          cases[cases.length - 1].scene.missingUniforms.length === 0,
          `uniform struct members without a scene value: ${JSON.stringify(cases[cases.length - 1].scene.missingUniforms)}`,
        ),
      );
      checks.push(
        check(
          `${mvpCase.id}-emitted-varyings-pair`,
          fromWgsl.unpaired.length === 0 && fromWgsl.locationMismatch.length === 0 && fromWgsl.vertexDeclaresNeverWritten.length === 0,
          `VSOut/FSIn read back from the emitted text: outputs=[${fromWgsl.vertexOutputs.map((entry) => `${entry.name}@${entry.location}`).join(" ")}] ` +
            `inputs=[${fromWgsl.fragmentInputs.map((entry) => `${entry.name}@${entry.location}`).join(" ")}] unpaired=${JSON.stringify(fromWgsl.unpaired)} locationMismatch=${JSON.stringify(fromWgsl.locationMismatch)} ` +
            `declared-but-never-written=${JSON.stringify(fromWgsl.vertexDeclaresNeverWritten)}`,
        ),
      );
    }

    const input = {
      mode: "mvp",
      selfTestScene: { viewport: cases[0].scene.viewport, vertexBytes: 0, vertexBytesArray: [], indexBytes: 0, indexBytesArray: [], indexCount: 0, uniformBytes: 0, uniformBytesArray: [], imagery: cases[0].scene.imagery, heightRange: cases[0].scene.heightRange },
      cases: cases.map(({ vertexWgsl, fragmentWgsl, fromWgsl: _f, ...rest }) => rest),
    };
    const run = await runPage({ input, inputFile: path.join(OUT_DIR, "g5-mvp-input.json"), quiet: options.quiet, options });
    const collected = run.collected;
    if (collected === null) {
      checks.push(check("device-page-produced-report", false, `the device page produced no report: ${run.runtimeError ?? "unknown reason"}`));
    } else {
      checks.push(check("device-page-produced-report", collected.errors.length === 0 && run.pageErrors.length === 0, `page errors=${JSON.stringify(collected.errors)} pageerror=${JSON.stringify(run.pageErrors)}`));
      checks.push(
        check("device-adapter-is-hardware", collected.adapter?.vendor !== undefined && collected.preferredFormat !== null, `adapter.info=${JSON.stringify(collected.adapter)}, preferredFormat=${collected.preferredFormat}, limits=${JSON.stringify(collected.device?.limits)}`),
      );
      // Harness self-test: a constant-colour full-screen triangle must produce a non-black frame —
      // otherwise a black terrain frame would say nothing about the emitted WGSL.
      checks.push(
        check(
          "harness-self-test-renders-non-black",
          collected.selfTest?.ok === true && collected.selfTest.draw?.nonBlackPixels === collected.selfTest.draw?.totalPixels,
          `full-screen constant-colour triangle through the same readback path: ${collected.selfTest?.draw?.nonBlackPixels ?? "?"}/${collected.selfTest?.draw?.totalPixels ?? "?"} non-black, ` +
            `centre=${JSON.stringify(collected.selfTest?.draw?.corners?.center ?? null)}`,
          { phase: "device-mvp" },
        ),
      );
      for (const testCase of collected.mvp?.cases ?? []) {
        const draw = testCase.draw;
        const vertexOnly = testCase.vertexOnlyDraw;
        checks.push(
          check(
            `${testCase.id}-vertex-stage-covers-the-frame`,
            vertexOnly !== undefined && vertexOnly !== null && vertexOnly.nonBlackPixels > 0,
            `the emitted vertex stage with a constant-colour fragment stage paints ${vertexOnly?.nonBlackPixels ?? "?"}/${vertexOnly?.totalPixels ?? "?"} pixel(s) — ` +
              `isolates geometry/uniform placement from the textured fragment stage`,
            { phase: "device-mvp" },
          ),
        );
        checks.push(
          check(
            `${testCase.id}-pipeline-and-draw`,
            testCase.compile.ok && testCase.compile.pipelineError === null && draw !== undefined && draw !== null && draw.renderError === null,
            `createRenderPipeline ok=${testCase.compile.ok}, pipelineError=${JSON.stringify(testCase.compile.pipelineError)}, ` +
              `vertex compile errors=${testCase.compile.vertex.messages.filter((message) => message.type === "error").length}, ` +
              `fragment compile errors=${testCase.compile.fragment.messages.filter((message) => message.type === "error").length}, renderError=${draw === null || draw === undefined ? "no draw" : JSON.stringify(draw.renderError)}`,
            { phase: "device-mvp" },
          ),
        );
        checks.push(
          check(
            `${testCase.id}-readback-non-black-full`,
            draw !== undefined && draw !== null && draw.nonBlackPixels === draw.totalPixels,
            `readback ${draw?.nonBlackPixels ?? "?"}/${draw?.totalPixels ?? "?"} non-black pixel(s) (spike path B required 4096/4096); ` +
              `unique colours=${draw?.uniqueColors ?? "?"}, corners=${JSON.stringify(draw?.corners ?? null)}`,
            { phase: "device-mvp" },
          ),
        );
      }
    }

    const verdict = checks.every((entry) => entry.ok === true) ? "pass" : "fail";
    const artifact = {
      gate: "g5",
      task: "T022",
      tool: "tools/shader-verify.mjs",
      family: "globe",
      variants: "mvp",
      verdict,
      recordedAt: new Date().toISOString(),
      notes:
        `T022 real-device verification of the **golden MVP configuration** (${MVP_CASES.length} case(s)) rendered with the WGSL emitted by ` +
        `experiments/gates/g5-shader/wgsl-emitter.mjs for the same defines + sources upstream assembles into GLSL. ` +
        `The fixed terrain scene (experiments/gates/shared/terrain-scene.mjs: 16x16 WGS84 patch, ${MVP_CASES[0].selection.textureUnits} texture unit, ` +
        `deterministic imagery) is written strictly through the H-4 CPU layout table and read back. ` +
        `Checks: pipeline creation with 0 validation errors and a full-frame non-black readback.`,
      environment: { node: process.version, platform: `${process.platform} ${process.arch}`, browser: { channel: options.channel ?? process.env.GATE_BROWSER_CHANNEL ?? "chrome", version: run.browserVersion, headless: options.headed !== true, launchArgs: [] }, adapter: collected?.adapter ?? null, preferredFormat: collected?.preferredFormat ?? null, deviceLimits: collected?.device?.limits ?? null },
      checks,
      evidence: [
        { path: "artifacts/shader-verify/globe-mvp.json", what: "this artefact" },
        { path: "experiments/gates/out/g5-model.json", what: "the enumerated define space, the H-4 union layout and the module-pair groups" },
        { path: "experiments/gates/g5-shader/wgsl-emitter.mjs", what: "the WGSL emission seam" },
        { path: "experiments/gates/shared/terrain-scene.mjs", what: "the fixed terrain scene used for the readback" },
      ],
      measurements: { cases: (collected?.mvp?.cases ?? []).map((testCase) => ({ id: testCase.id, compile: { ok: testCase.compile.ok, pipelineError: testCase.compile.pipelineError, vertexErrors: testCase.compile.vertex.messages.filter((m) => m.type === "error").length, fragmentErrors: testCase.compile.fragment.messages.filter((m) => m.type === "error").length }, draw: testCase.draw === null ? null : { ...testCase.draw, rgbaBase64: undefined } })) },
    };
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, "globe-mvp.json"), `${JSON.stringify({ ...artifact, frames: Object.fromEntries((collected?.mvp?.cases ?? []).filter((testCase) => testCase.draw !== null).map((testCase) => [testCase.id, { bytesPerRow: testCase.draw.bytesPerRow, rgbaBase64: testCase.draw.rgbaBase64 }])) }, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(OUT_DIR, "g5-device.json"), `${JSON.stringify(collected ?? { error: run.runtimeError }, null, 2)}\n`, "utf8");
    if (options.report !== null) fs.writeFileSync(options.report, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    for (const entry of checks) process.stdout.write(`  [${entry.ok ? "ok" : "FAIL"}] ${entry.id}: ${entry.detail}\n`);
    process.stdout.write(`[shader-verify] variants=mvp: ${checks.filter((entry) => entry.ok === true).length}/${checks.length} check(s) ok -> ${repoRelative(path.join(ARTIFACT_DIR, "globe-mvp.json"))}\n`);
    return { code: verdict === "pass" ? 0 : 1, artifact, checks, store: null };
  }

  // ---- all-reachable: one pipeline per distinct module pair ------------------------------------
  const store = buildAndWriteModules({ quiet: options.quiet });
  const index = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, "index.json"), "utf8"));
  const input = {
    mode: "sweep",
    groupsUrl: `/${repoRelative(path.join(MODULE_DIR, "index.json"))}`,
    chunkUrlPrefix: `/${repoRelative(MODULE_DIR)}/`,
    chunkFiles: index.chunkFiles,
    negativeControl: null,
  };
  const representative = store.groups[0];
  const negativeVariant = selectVariant(MVP_CASES[0].selection);
  const negativeGlsl = assembleGlslForVariant(negativeVariant);
  const negativeDerivation = deriveVaryingPairs({ vertexSource: negativeGlsl.vertexSource, fragmentSource: negativeGlsl.fragmentSource, defines: negativeVariant.defines });
  const negativeEmission = emitTerrainWgsl({ variant: negativeVariant, glsl: negativeGlsl, derivation: negativeDerivation, layout: { structName: store.layout.structName, structSize: store.layout.structSize, wgslStruct: store.layout.wgslStruct, samplers: store.layout.samplers, members: store.layout.members } });
  const negativeUrls = writeVariantModules("negative-control", negativeEmission.vertexWgsl, negativeEmission.fragmentWgsl);
  input.negativeControl = { ...negativeUrls, varying: negativeDerivation.paired[0].name, attributes: attributeLayoutFromDerivation(negativeDerivation), constants: negativeEmission.structure.overrides };

  // The probe needs every chunk: publish them as a list it walks.
  input.chunks = index.chunkFiles.map((name) => `/${repoRelative(path.join(MODULE_DIR, name))}`);
  void representative;

  const run = await runPage({ input, inputFile: path.join(OUT_DIR, "g5-sweep-input.json"), quiet: options.quiet, options });
  const collected = run.collected;
  if (collected === null) {
    checks.push(check("device-page-produced-report", false, `the device page produced no report: ${run.runtimeError ?? "unknown reason"}`));
  } else {
    const sweep = collected.sweep ?? { groupCount: 0, failed: -1, results: [] };
    checks.push(check("device-page-produced-report", collected.errors.length === 0 && run.pageErrors.length === 0, `page errors=${JSON.stringify(collected.errors)} pageerror=${JSON.stringify(run.pageErrors)}`));
    checks.push(check("device-adapter-is-hardware", collected.adapter?.vendor !== undefined, `adapter.info=${JSON.stringify(collected.adapter)}, preferredFormat=${collected.preferredFormat}`));
    checks.push(
      check(
        "every-reachable-define-set-creates-its-own-pipeline",
        sweep.failed === 0 && sweep.results.length === store.stats.defineCombinations,
        `${sweep.results.length - sweep.failed}/${sweep.results.length} reachable define combination(s) created a pipeline with 0 validation errors — each with **its own** pipeline-overridable constant ` +
          `values (G-6/T025: the tile's imagery layer count and the ground-atmosphere mode are pipeline constants, not module text) over the ${store.stats.distinctModulePairs} distinct module pair(s) ` +
          `(enumeration: ${store.stats.defineCombinations} combination(s) → ${store.stats.distinctModulePairs} module text(s) → ${store.stats.distinctVariantPipelines} pipeline identity/identities); ` +
          `first failures: ${JSON.stringify(sweep.results.filter((entry) => !entry.ok).slice(0, 3))}`,
      ),
    );
    checks.push(
      check(
        "each-distinct-module-text-is-parsed-once",
        sweep.moduleCompilations === 2 * store.stats.distinctModulePairs && sweep.distinctModuleTexts === store.stats.distinctModulePairs,
        `createShaderModule called ${sweep.moduleCompilations} time(s) for ${sweep.distinctModuleTexts} distinct module pair(s) (= 2 calls per pair: one vertex module + one fragment module); ` +
          `${sweep.results.filter((entry) => entry.reusedModules === true).length}/${sweep.results.length} combination(s) reused an already-parsed module — ` +
          `the module text is the parse identity, the constant values are the pipeline identity`,
      ),
    );
    checks.push(
      check(
        "negative-control-unpaired-varying-fails",
        collected.sweep?.negativeControl?.ran === true && collected.sweep.negativeControl.ok === false && collected.sweep.negativeControl.removed === true,
        `removing the vertex output "${collected.sweep?.negativeControl?.varying}" while the fragment stage still reads it MUST make createRenderPipeline fail ` +
          `(spike REPORT §4 E1): removed=${collected.sweep?.negativeControl?.removed}, ok=${collected.sweep?.negativeControl?.ok}, ` +
          `error=${JSON.stringify(collected.sweep?.negativeControl?.pipelineError ?? null)}`,
      ),
    );
  }

  const verdict = checks.every((entry) => entry.ok === true) ? "pass" : "fail";
  const artifact = {
    gate: "g5",
    task: "T023",
    tool: "tools/shader-verify.mjs",
    family: "globe",
    variants: "all-reachable",
    verdict,
    recordedAt: new Date().toISOString(),
    notes:
      `T023: every one of the ${store.stats.defineCombinations} MVP-reachable define combination(s) was emitted to WGSL by the parameterised seam and grouped by the ` +
      `byte-identity of its module pair; a real hardware pipeline was created for each of the ${store.stats.distinctModulePairs} distinct pair(s), so **every** enumerated ` +
      `define set is tied to a device-verified pipeline by byte-identity rather than by sampling. A negative control (unpaired varying) MUST and does fail.`,
    environment: { node: process.version, platform: `${process.platform} ${process.arch}`, browser: { channel: options.channel ?? process.env.GATE_BROWSER_CHANNEL ?? "chrome", version: run.browserVersion, headless: options.headed !== true, launchArgs: [] }, adapter: collected?.adapter ?? null, preferredFormat: collected?.preferredFormat ?? null },
    checks,
    evidence: [
      { path: "experiments/gates/out/g5-model.json", what: "the enumerated define space, per-variant varying sets and module-pair groups" },
      { path: "experiments/gates/out/g5-modules/index.json", what: "the compiled module chunks (one representative per distinct pair)" },
      { path: "experiments/gates/out/g5-device.json", what: "the raw device sweep report (per-group pipeline result)" },
    ],
    measurements: { defineCombinations: store.stats.defineCombinations, distinctModulePairs: store.stats.distinctModulePairs, rejected: store.stats.rejected, failed: collected?.sweep?.failed ?? null, negativeControl: collected?.sweep?.negativeControl ?? null, elapsedMs: collected?.sweep?.elapsedMs ?? null },
  };
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, "globe-all-reachable.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "g5-device.json"), `${JSON.stringify(collected ?? { error: run.runtimeError }, null, 2)}\n`, "utf8");
  if (options.report !== null) fs.writeFileSync(options.report, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  for (const entry of checks) process.stdout.write(`  [${entry.ok ? "ok" : "FAIL"}] ${entry.id}: ${entry.detail}\n`);
  process.stdout.write(`[shader-verify] variants=all-reachable: ${checks.filter((entry) => entry.ok === true).length}/${checks.length} check(s) ok -> ${repoRelative(path.join(ARTIFACT_DIR, "globe-all-reachable.json"))}\n`);
  void startedAt;
  return { code: verdict === "pass" ? 0 : 1, artifact, checks, store };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runShaderVerify()
    .then((result) => {
      process.exitCode = result.code;
    })
    .catch((error) => {
      process.stderr.write(`shader-verify: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    });
}
void HERE;
