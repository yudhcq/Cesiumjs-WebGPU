#!/usr/bin/env node
/**
 * Offline comparator for two-independent-run artefacts (tasks.md T047, productised later by T109).
 *
 * HARD INVARIANT (constitution v2.0.0 principle II): this tool NEVER runs a backend. It reads the
 * artefacts of **two separate runs** (`<artifact>/<backend>.json`) and compares them offline. It has no
 * way to launch a browser, so "same session / same frame comparison" is structurally impossible here.
 *
 * Usage:
 *   node tests/support/compare-offline.mjs --artifact=artifacts/pass-sequence
 *   node tests/support/compare-offline.mjs --artifact=artifacts/pass-sequence --json
 *
 * Exit codes: 0 both runs agree and satisfy the recorded rules; 1 a difference or an invariant
 * violation; 2 misconfiguration (missing artefacts / unknown mode).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Parse `--key=value` / `--flag`. */
function parseArgv(argv) {
  const options = { artifact: null, json: false, help: false };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--artifact=")) options.artifact = arg.slice("--artifact=".length);
    else throw new Error(`unknown argument "${arg}"`);
  }
  return options;
}

function readArtifact(artifactDir, backend) {
  const file = path.join(REPO_ROOT, artifactDir, `${backend}.json`);
  if (!fs.existsSync(file)) return { backend, file, present: false, run: null };
  return { backend, file, present: true, run: JSON.parse(fs.readFileSync(file, "utf8")) };
}

/** A pass reduced to the properties both recordings can be held to. */
function normalise(pass, backend) {
  const presentation = backend === "webgpu" ? String(pass.keyText).includes("color=[swapchain]") : String(pass.keyText).includes("colorTargets=[canvas]");
  return { index: pass.index, clearOps: pass.clearOps, drawOps: pass.drawOps, presentation };
}

/**
 * Compare two `contract:pass-sequence` artefacts.
 *
 * @returns {{checks: {id: string, ok: boolean, detail: string}[], measurements: object}}
 */
export function comparePassSequence({ webgpu, webgl2, gate }) {
  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, ok: ok === true, detail });

  check(
    "both-runs-present",
    webgpu.present && webgl2.present,
    `artefacts: webgpu=${webgpu.present ? "present" : "MISSING"} (${path.relative(REPO_ROOT, webgpu.file)}), ` +
      `webgl2=${webgl2.present ? "present" : "MISSING"} (${path.relative(REPO_ROOT, webgl2.file)})`,
  );
  if (!webgpu.present || !webgl2.present) return { checks, measurements: {} };

  const gpuRun = webgpu.run;
  const glRun = webgl2.run;
  check(
    "two-independent-runs",
    gpuRun.runId !== glRun.runId &&
      gpuRun.isolation === "separate-process" &&
      glRun.isolation === "separate-process" &&
      gpuRun.backend === "webgpu" &&
      glRun.backend === "webgl2",
    `run ids ${gpuRun.runId} vs ${glRun.runId}; isolation ${gpuRun.isolation}/${glRun.isolation}; ` +
      `backends ${gpuRun.backend}/${glRun.backend} — no artefact was produced by a shared session`,
  );
  check(
    "each-run-touched-only-its-own-backend",
    (gpuRun.report?.webgl2?.objectsCreated ?? null) === 0 &&
      (gpuRun.report?.webgl2?.contextRequests ?? null) === 0 &&
      (glRun.report?.webgpu?.adapterRequests ?? null) === 0 &&
      (glRun.report?.webgpu?.deviceRequests ?? null) === 0,
    `the WebGPU run created ${gpuRun.report?.webgl2?.objectsCreated} WebGL object(s) and requested ` +
      `${gpuRun.report?.webgl2?.contextRequests} WebGL context(s); the WebGL2 run requested ` +
      `${glRun.report?.webgpu?.adapterRequests} WebGPU adapter(s) and ${glRun.report?.webgpu?.deviceRequests} device(s)`,
  );

  const gpuSequence = gpuRun.report?.result?.["pass-sequence"];
  const glSequence = glRun.report?.result?.["pass-sequence"];
  check("both-runs-recorded-a-sequence", gpuSequence !== undefined && glSequence !== undefined, "both pages published their pass sequence");
  if (gpuSequence === undefined || glSequence === undefined) return { checks, measurements: {} };

  const gpuPasses = gpuSequence.passes.map((pass) => normalise(pass, "webgpu"));
  const glPasses = glSequence.passes.map((pass) => normalise(pass, "webgl2"));

  check(
    "pass-count-agrees",
    gpuPasses.length === glPasses.length,
    `derived passes: WebGPU ${gpuPasses.length} vs WebGL2 ${glPasses.length} for the same scripted workload ` +
      "(clear+draw x2 on the presentation target, clear+draw offscreen, draw back)",
  );
  const mismatches = [];
  for (let index = 0; index < Math.min(gpuPasses.length, glPasses.length); index += 1) {
    const left = gpuPasses[index];
    const right = glPasses[index];
    if (left.clearOps !== right.clearOps || left.drawOps !== right.drawOps || left.presentation !== right.presentation) {
      mismatches.push({ index, webgpu: left, webgl2: right });
    }
  }
  check(
    "clear-draw-sequence-agrees",
    mismatches.length === 0,
    mismatches.length === 0
      ? `all ${gpuPasses.length} passes agree on (clearOps, drawOps, presentation target): ` +
        gpuPasses.map((pass) => `${pass.clearOps}c${pass.drawOps}d${pass.presentation ? "*" : ""}`).join(" | ")
      : `differing pass(es): ${JSON.stringify(mismatches)}`,
  );
  check(
    "g3-derived-rules-hold-in-both-recordings",
    // G-3's rules, re-applied to both recordings: no empty pass, and the frame ends on the presentation target.
    [...gpuPasses, ...glPasses].every((pass) => pass.clearOps + pass.drawOps > 0) &&
      gpuPasses.at(-1)?.presentation === true &&
      glPasses.at(-1)?.presentation === true,
    "every pass contains at least one clear/draw (no empty pass) and both recordings end on the presentation target — " +
      "the two invariants G-3 established (checks `partition-boundaries-match-clear-draw-sequence` and " +
      "`no-unclosed-pass-before-endframe`)",
  );

  const gateChecks = Array.isArray(gate?.checks) ? gate.checks : [];
  const gateById = new Map(gateChecks.map((entry) => [entry.id, entry]));
  const ruleIds = ["partition-boundaries-match-clear-draw-sequence", "no-unclosed-pass-before-endframe", "clears-are-first-in-their-pass"];
  check(
    "g3-conclusion-is-the-reference",
    ruleIds.every((id) => gateById.get(id)?.ok === true),
    `G-3's conclusion (experiments/gates/out/g3.json) passes the rules this comparison re-applies: ` +
      ruleIds.map((id) => `${id}=${gateById.get(id)?.ok ?? "absent"}`).join(", "),
  );

  return {
    checks,
    measurements: {
      webgpu: { runId: gpuRun.runId, source: gpuSequence.source, operationCount: gpuSequence.operationCount, passes: gpuPasses },
      webgl2: { runId: glRun.runId, source: glSequence.source, operationCount: glSequence.operationCount, passes: glPasses },
    },
  };
}

/**
 * Compare two `contract:resources` artefacts (tasks.md T064, W3).
 *
 * Both runs perform the same resource workload through the production specifiers, so the *observable*
 * resource behaviour MUST agree. The two paths legitimately describe the resolve differently — WebGPU
 * pairs a multisampled attachment with its `resolveTarget`, GL blits between two framebuffers — and
 * that difference is **declared** here rather than smoothed over (the same discipline T106 asks for).
 */
export function compareResources({ webgpu, webgl2 }) {
  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, ok: ok === true, detail });

  check(
    "both-runs-present",
    webgpu.present && webgl2.present,
    `artefacts: webgpu=${webgpu.present ? "present" : "MISSING"}, webgl2=${webgl2.present ? "present" : "MISSING"}`,
  );
  if (!webgpu.present || !webgl2.present) return { checks, measurements: {}, declaredDifferences: [] };

  const gpuRun = webgpu.run;
  const glRun = webgl2.run;
  check(
    "two-independent-runs",
    gpuRun.runId !== glRun.runId &&
      gpuRun.isolation === "separate-process" &&
      glRun.isolation === "separate-process" &&
      gpuRun.backend === "webgpu" &&
      glRun.backend === "webgl2",
    `run ids ${gpuRun.runId} vs ${glRun.runId}; isolation ${gpuRun.isolation}/${glRun.isolation} — no artefact came from a shared session`,
  );
  check(
    "each-run-touched-only-its-own-backend",
    (gpuRun.report?.webgl2?.objectsCreated ?? null) === 0 &&
      (gpuRun.report?.webgl2?.contextRequests ?? null) === 0 &&
      (glRun.report?.webgpu?.adapterRequests ?? null) === 0 &&
      (glRun.report?.webgpu?.deviceRequests ?? null) === 0,
    `the WebGPU run created ${gpuRun.report?.webgl2?.objectsCreated} WebGL object(s); the WebGL2 run requested ` +
      `${glRun.report?.webgpu?.adapterRequests} WebGPU adapter(s)`,
  );

  const gpu = gpuRun.report?.result?.resources;
  const gl = glRun.report?.result?.resources;
  check("both-runs-published-the-report", gpu !== undefined && gl !== undefined, "both pages published their resource report");
  if (gpu === undefined || gl === undefined) return { checks, measurements: {}, declaredDifferences: [] };

  const equalFact = (id, path, label) => {
    const left = path(gpu);
    const right = path(gl);
    check(id, left === right, `${label}: WebGPU ${JSON.stringify(left)} vs WebGL2 ${JSON.stringify(right)}`);
  };

  equalFact("buffer-sizes-agree", (r) => `${r.buffer.vertexSizeInBytes}/${r.buffer.indexSizeInBytes}`, "vertex/index buffer sizes");
  equalFact("buffer-usage-agree", (r) => `${r.buffer.vertexUsage}/${r.buffer.indexUsage}`, "BufferUsage values");
  equalFact("index-extras-agree", (r) => `${r.buffer.indexDatatype}/${r.buffer.bytesPerIndex}/${r.buffer.numberOfIndices}`, "index datatype/bytes/count");
  equalFact("vertex-count-agrees", (r) => r.buffer.numberOfVertices, "numberOfVertices");
  equalFact(
    "texture-facts-agree",
    (r) => `${r.texture.width}x${r.texture.height}/${r.texture.pixelFormat}/${r.texture.pixelDatatype}/${r.texture.flipY}/${r.texture.sizeInBytes}`,
    "texture size/format/type/flipY/sizeInBytes",
  );
  equalFact(
    "sampler-values-agree",
    (r) => `${r.sampler.wrapS}/${r.sampler.wrapT}/${r.sampler.wrapR}/${r.sampler.minificationFilter}/${r.sampler.magnificationFilter}/${r.sampler.maximumAnisotropy}`,
    "the six Sampler values",
  );
  equalFact("msaa-sample-count-agrees", (r) => r.msaa.attachmentSamples, "the multisampled attachment's sample count");
  equalFact("msaa-attachment-count-agrees", (r) => `${r.msaa.renderColorAttachments}/${r.msaa.colorColorAttachments}`, "colour attachment counts");

  // The pixels: the same two probes on both runs, within a small tolerance (8-bit unorm storage).
  const sampleOf = (run, name) => (run.canvasScreenshot?.samples ?? []).find((sample) => sample.name === name)?.rgba ?? null;
  for (const [name, expectation] of [
    ["left-centre", "the ordered-buffer colour"],
    ["right-centre", "the MSAA-resolved colour"],
  ]) {
    const left = sampleOf(gpuRun, name);
    const right = sampleOf(glRun, name);
    const within = (a, b) => a !== null && b !== null && a.slice(0, 3).every((value, index) => Math.abs(value - b[index]) <= 12);
    check(`pixel-${name}-agrees`, within(left, right), `${expectation}: WebGPU rgb(${left?.slice(0, 3)}) vs WebGL2 rgb(${right?.slice(0, 3)})`);
  }

  const declaredDifferences = [
    {
      metric: "msaa.resolveMechanism",
      webgpu: gpu.msaa.resolveMechanism,
      webgl2: gl.msaa.resolveMechanism,
      reason:
        "WebGPU resolves through `colorAttachments[i].resolveTarget` at pass end; GL copies with `blitFramebuffer`. " +
        "The *result* is compared (the resolved pixels), not the mechanism.",
    },
    {
      metric: "texture.gpuFormat / buffer.gpuLayout / counts",
      webgpu: "present",
      webgl2: "absent (no GPU descriptor to report)",
      reason: "WebGPU-only descriptors; the GL side reports the upstream-visible values instead.",
    },
  ];
  check(
    "the-resolve-difference-is-declared",
    gpu.msaa.resolveMechanism === "resolveTarget" && gl.msaa.resolveMechanism === "blitFramebuffer",
    `WebGPU=${gpu.msaa.resolveMechanism}, WebGL2=${gl.msaa.resolveMechanism} — a declared difference, not a silent one`,
  );

  return {
    checks,
    declaredDifferences,
    measurements: {
      webgpu: { runId: gpuRun.runId, buffer: gpu.buffer, texture: gpu.texture, sampler: gpu.sampler, msaa: gpu.msaa },
      webgl2: { runId: glRun.runId, buffer: gl.buffer, texture: gl.texture, sampler: gl.sampler, msaa: gl.msaa },
    },
  };
}

function main(argv) {
  const options = parseArgv(argv);
  if (options.help || options.artifact === null) {
    process.stdout.write("usage: node tests/support/compare-offline.mjs --artifact=<dir> [--json]\n");
    return options.help ? 0 : 2;
  }
  const webgpu = readArtifact(options.artifact, "webgpu");
  const webgl2 = readArtifact(options.artifact, "webgl2");
  const gatePath = path.join(REPO_ROOT, "experiments", "gates", "out", "g3.json");
  const gate = fs.existsSync(gatePath) ? JSON.parse(fs.readFileSync(gatePath, "utf8")) : null;

  // Which comparison applies is decided by the artefact directory, so a new suite cannot be compared
  // with the wrong rules by accident.
  const isResources = /(^|[\\/])resources$/.test(options.artifact);
  const { checks, measurements, declaredDifferences = [] } = isResources
    ? compareResources({ webgpu, webgl2 })
    : comparePassSequence({ webgpu, webgl2, gate });
  const failed = checks.filter((entry) => entry.ok !== true);
  const verdict = failed.length === 0 ? "pass" : "fail";

  const report = {
    tool: "compare-offline",
    artifact: options.artifact,
    recordedAt: new Date().toISOString(),
    isolation: "offline-only: this tool never launches a browser or a backend (principle II)",
    comparison: isResources ? "resources" : "pass-sequence",
    verdict,
    checks,
    declaredDifferences,
    measurements,
  };
  const outDir = path.join(REPO_ROOT, options.artifact);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const entry of checks) process.stdout.write(`[${entry.ok ? "ok" : "FAIL"}] ${entry.id}: ${entry.detail}\n`);
    process.stdout.write(`compare-offline: ${verdict} (${checks.length - failed.length}/${checks.length}) -> ${options.artifact}/comparison.json\n`);
  }
  return verdict === "pass" ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`compare-offline: ${error?.message ?? error}\n`);
    process.exitCode = 2;
  }
}
