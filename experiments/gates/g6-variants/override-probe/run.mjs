#!/usr/bin/env node
/**
 * Feasibility probe runner for the G-6 fix (T025 over the pre-registered compile budget).
 *
 *   node experiments/gates/g6-variants/override-probe/run.mjs [--samples 16] [--quiet]
 *
 * This is **not** a gate and it does not judge anything: it produces the device numbers that decide
 * whether the plan's chosen route (move the two frame-varying dimensions into WGSL `override`
 * constants) is supported by measurement, or whether the documented fallback (pool/warm the variants
 * and shrink the per-variant module) has to be taken instead.
 *
 * It runs the same timing discipline as `../driver.js` (total cost including the `popErrorScope`
 * validation round trip) against three workloads plus a control:
 *
 *   trivial (platform floor) | fresh module text | cached module + new override | cached module + same override
 *
 * Artefact: `experiments/gates/out/g6-override-probe.json`.
 * Exit codes: 0 → the report was produced; 2 → the probe could not run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { histogram, runGatePage } from "../../shared/page-runner.mjs";
import { OUT_DIR, REPO_ROOT } from "../../g5-shader/model.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "page.html");

async function main() {
  const argv = process.argv.slice(2);
  const quiet = argv.includes("--quiet");
  let samples = 16;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--samples") samples = Number(argv[index + 1]);
    else if (token.startsWith("--samples=")) samples = Number(token.slice("--samples=".length));
  }
  if (!Number.isInteger(samples) || samples < 4) throw new Error(`--samples MUST be an integer >= 4 (got ${samples})`);

  const modelPath = path.join(OUT_DIR, "g5-model.json");
  if (!fs.existsSync(modelPath)) throw new Error(`missing ${path.relative(REPO_ROOT, modelPath)} — run \`node tools/shader-verify.mjs --family=globe --variants=all-reachable\` first`);
  const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));

  // Representatives: the largest emitted pair (worst case for compile cost) and one per distinct
  // varying set, so the probe is not tuned to a single lucky module.
  const bySize = [...model.groups].sort((a, b) => b.fragmentBytes + b.vertexBytes - (a.fragmentBytes + a.vertexBytes));
  const wantedKeys = [];
  const seenVarying = new Set();
  for (const group of bySize) {
    const shape = (group.varyingPairs ?? []).join(",");
    if (wantedKeys.length === 0 || (!seenVarying.has(shape) && wantedKeys.length < 3)) {
      wantedKeys.push(group.key);
      seenVarying.add(shape);
    }
  }

  const chunkFiles = fs
    .readdirSync(path.join(OUT_DIR, "g5-modules"))
    .filter((name) => /^chunk-\d+\.json$/.test(name))
    .sort();
  // The *explicit* pipeline layout the product will use (same shape as `g6-variants/driver.js`):
  // binding 0 = the H-4 uniform buffer, then one (texture, sampler) pair per sampler binding.
  // `GPUShaderStage` is a browser global, so the stage bits are spelled out (VERTEX=1, FRAGMENT=2).
  const STAGE_VERTEX = 1;
  const STAGE_FRAGMENT = 2;
  const layoutEntries = [{ binding: 0, visibility: STAGE_VERTEX | STAGE_FRAGMENT, buffer: { type: "uniform", minBindingSize: model.layout.structSize } }];
  for (const sampler of model.layout.samplers) {
    layoutEntries.push({ binding: sampler.textureBinding, visibility: STAGE_FRAGMENT, texture: { sampleType: "float" } });
    layoutEntries.push({ binding: sampler.samplerBinding, visibility: STAGE_FRAGMENT, sampler: { type: "filtering" } });
  }

  const input = {
    chunks: chunkFiles.map((name) => `/${path.relative(REPO_ROOT, path.join(OUT_DIR, "g5-modules", name)).split(path.sep).join("/")}`),
    wantedKeys,
    samples,
    layoutEntries,
  };

  const run = await runGatePage({ page: PAGE, globalName: "__probe", input, inputFile: path.join(OUT_DIR, "g6-override-probe-input.json"), quiet });
  const collected = run.collected;
  if (collected === null) throw new Error(`the probe page produced no report: ${run.runtimeError ?? "unknown reason"}`);

  const measurements = collected.measurements ?? null;
  const document = {
    tool: "g6-override-probe",
    purpose:
      "G-6 fix route selection: is a new WGSL pipeline-overridable-constant VALUE on an already-parsed module cheaper than a new module text? Not a gate — this report decides the route and is archived as evidence.",
    recordedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      browser: { channel: process.env.GATE_BROWSER_CHANNEL ?? "chrome", version: run.browserVersion, headless: true, launchArgs: [] },
      adapter: collected.adapter ?? null,
      preferredFormat: collected.preferredFormat ?? null,
    },
    samples,
    requestedKeys: wantedKeys,
    measurements,
    histograms: measurements === null
      ? null
      : {
          trivial: measurements.trivial,
          freshModuleNewText: measurements.freshModuleNewText,
          cachedModuleNewOverride: measurements.cachedModuleNewOverride,
          cachedModuleSameOverride: measurements.cachedModuleSameOverride,
        },
    pageNotes: collected.pages ?? [],
    errors: collected.errors ?? [],
    evidence: [
      { path: "experiments/gates/g6-variants/override-probe/probe.js", what: "the in-page probe (four workloads, same timing discipline as the gate driver)" },
      { path: "experiments/gates/out/g6-override-probe-input.json", what: "the exact representative module pairs handed to the page" },
      { path: "experiments/gates/out/g5-model.json", what: "the emission model the representatives are taken from" },
    ].filter((entry) => fs.existsSync(path.join(REPO_ROOT, entry.path))),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "g6-override-probe.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");

  if (!quiet && measurements !== null) {
    const line = (name) => {
      const value = measurements[name];
      return `${name}: n=${value.count} p50=${value.p50.toFixed(2)}ms p95=${value.p95.toFixed(2)}ms max=${value.max.toFixed(2)}ms`;
    };
    for (const name of ["trivial", "freshModuleNewText", "cachedModuleNewOverride", "cachedModuleSameOverride"]) process.stdout.write(`[g6-override-probe] ${line(name)}\n`);
    process.stdout.write(`[g6-override-probe] createShaderModule calls: ${measurements.moduleIdentity.shaderModuleCallsTotal}\n`);
  }
  for (const error of document.errors) process.stderr.write(`[g6-override-probe] page error: ${JSON.stringify(error)}\n`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`g6-override-probe: ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  });
