/**
 * G-7 precursor runner — the depth-texture × MSAA design space, measured on a real device.
 *
 * Run: `node experiments/gates/g7-slice-b/run-gpu.mjs`
 *
 * Writes `experiments/gates/out/g7-depth-msaa.json` (an **evidence** file: `check-gate.mjs` discovers
 * gate verdicts by `<id>.json`, so a slug keeps this from being mistaken for the G-7 verdict, which
 * belongs to T127 once slice B has landed).
 *
 * Why a device measurement instead of a spec reading: the two facts slice B depends on are
 * implementation-defined in practice —
 *   - whether a pass may mix attachment sample counts (the patch layer cites this as the blocker), and
 *   - whether any depth-resolve mechanism exists (without one, a samplable depth texture and MSAA are
 *     mutually exclusive, and slice B stops being "wire GlobeDepth up" and becomes a design trade-off).
 * Both are answered with the browser's own message here, each with the control arm that makes the
 * message attributable.
 *
 * Node-only, cross-platform; no browser flags (same environment shape as every other gate).
 */
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT, repoRelative, runGatePage } from "../shared/page-runner.mjs";

const PAGE = path.join(REPO_ROOT, "experiments", "gates", "g7-slice-b", "depth-msaa.html");
const INPUT_FILE = path.join(REPO_ROOT, "experiments", "gates", "out", "g7-depth-msaa.input.json");
const OUT_FILE = path.join(REPO_ROOT, "experiments", "gates", "out", "g7-depth-msaa.json");

/** The rule the patch layer cites: mixing sample counts in one pass. The control must stay legal. */
const REQUIRED_MEASUREMENTS = [
  "mixed-sample-attachments",
  "matched-sample-attachments",
  "create-samplable-4x-depth",
  "sample-4x-depth-with-2d-binding",
  "sample-4x-depth-with-multisampled-binding",
  "depth-resolve-target",
  "depth-resolve-readback-values",
  "copy-texture-4x-to-1x-depth",
  "shader-writes-depth-into-4x-pass",
];

const COPY_FORMATS = ["depth32float", "depth24plus", "depth16unorm", "depth24plus-stencil8"];

function byName(measurements, name) {
  return measurements.find((measurement) => measurement.name === name) ?? null;
}

/**
 * Turn the measurements into the verdict slice B needs: which mechanisms are available, and therefore
 * whether the MSAA trade-off is real.
 */
function judge(measurements) {
  const rejected = (name) => byName(measurements, name)?.error != null;
  const legal = (name) => byName(measurements, name)?.error == null;

  const mixingRejected = rejected("mixed-sample-attachments");
  const controlLegal = legal("matched-sample-attachments");
  const resolveRejected = rejected("depth-resolve-target");
  const multisampleCopyRejected = rejected("copy-texture-4x-to-1x-depth");
  const shaderDepthLegal = legal("shader-writes-depth-into-4x-pass");

  const copyableFormats = COPY_FORMATS.filter((format) => legal(`copy-${format}-depth-to-buffer`));

  const findings = [];
  findings.push({
    id: "F1",
    statement: "a render pass MUST use one sample count for all its attachments",
    established: mixingRejected && controlLegal,
    evidence: {
      rejected: byName(measurements, "mixed-sample-attachments")?.scoped ?? byName(measurements, "mixed-sample-attachments")?.thrown ?? null,
      control: byName(measurements, "matched-sample-attachments")?.error ?? null,
    },
    consequence: "the WebGL idiom (multisampled depth attachment + single-sampled depth texture) cannot be built as-is",
  });
  findings.push({
    id: "F2",
    statement: "this Chrome has no usable depth resolve: neither a pass `resolveTarget` that actually writes, nor a manual multisample depth copy",
    established: resolveRejected && multisampleCopyRejected,
    evidence: {
      resolveTargetReadback: byName(measurements, "depth-resolve-readback-values")?.error ?? `resolved (values ${JSON.stringify(byName(measurements, "depth-resolve-readback-values")?.samples ?? null)})`,
      copyTextureToTexture: byName(measurements, "copy-texture-4x-to-1x-depth")?.error ?? null,
    },
    consequence: resolveRejected
      ? "a samplable depth texture cannot be produced from a multisampled pass on this platform"
      : "a depth resolve IS available, so a samplable depth texture can coexist with MSAA — the WebGL idiom maps onto WebGPU after all",
  });
  findings.push({
    id: "F3",
    statement: "a fragment shader can write depth inside a multisampled pass",
    established: shaderDepthLegal,
    evidence: { error: byName(measurements, "shader-writes-depth-into-4x-pass")?.error ?? null },
    consequence: "a resolve-free depth copy (full-screen quad writing sampled depth) remains a legal design, so MSAA is not automatically lost",
  });
  // F5 is the one that decides whether slice B costs MSAA: if a multisampled depth texture can be read
  // at all, a manual resolve exists in software even though the hardware offers none (F2).
  const multisampledBindingLegal = legal("sample-4x-depth-with-multisampled-binding");
  const plainBindingLegal = legal("sample-4x-depth-with-2d-binding");
  findings.push({
    id: "F5",
    statement: "a multisampled depth texture is readable through `texture_depth_multisampled_2d` + textureLoad, so a depth resolve can be written in a shader",
    established: multisampledBindingLegal && !plainBindingLegal,
    evidence: {
      plainDepth2dBinding: byName(measurements, "sample-4x-depth-with-2d-binding")?.error ?? null,
      multisampledDepthBinding: byName(measurements, "sample-4x-depth-with-multisampled-binding")?.error ?? null,
    },
    consequence: multisampledBindingLegal
      ? "MSAA can be kept: resolve depth in a full-screen pass into a single-sampled depth32float texture"
      : "a samplable depth texture cannot be produced from a multisampled pass by any measured route, so slice B MUST drop MSAA for the depth-texture path",
  });
  findings.push({
    id: "F4",
    statement: "the copyability of a depth aspect is a property of the **format**, not of the canvas texture",
    established: copyableFormats.length > 0,
    evidence: Object.fromEntries(COPY_FORMATS.map((format) => [format, byName(measurements, `copy-${format}-depth-to-buffer`)?.error ?? null])),
    consequence:
      copyableFormats.length > 0
        ? `depth readback/copy is possible for ${copyableFormats.join(", ")}; slice B MUST use one of those formats for any depth texture that has to leave the pass`
        : "no depth format is copyable on this Chrome, so depth evidence MUST be gathered through the depth test (the marker-layer probe this repository already uses)",
  });

  const msaaTradeOffIsReal = resolveRejected && multisampleCopyRejected && !shaderDepthLegal && !multisampledBindingLegal;
  return {
    findings,
    copyableDepthFormats: copyableFormats,
    msaaTradeOffIsReal,
    recommendation: msaaTradeOffIsReal
      ? "slice B MUST choose between (a) single-sampled rendering with a samplable depth texture and (b) MSAA without a depth texture — an explicit, user-visible trade-off"
      : multisampledBindingLegal || shaderDepthLegal
        ? "slice B can keep MSAA: produce the single-sampled depth texture with a full-screen depth pass (shader-written depth and/or an in-shader resolve of the multisampled depth), then let GlobeDepth consume it"
        : "slice B can keep MSAA: build the samplable depth texture from a single-sampled offscreen pass, whichever the T097 prototype measures as correct",
  };
}

async function main() {
  const run = await runGatePage({
    page: PAGE,
    globalName: "g7DepthMsaa",
    input: { gate: "g7-depth-msaa", ranAt: new Date().toISOString() },
    inputFile: INPUT_FILE,
    timeoutMs: 300000,
  });

  const collected = run.collected;
  const measurements = collected?.measurements ?? [];
  const missing = REQUIRED_MEASUREMENTS.filter((name) => byName(measurements, name) === null);
  const judgement = judge(measurements);

  const document = {
    gate: "g7-depth-msaa",
    kind: "evidence",
    title: "切片 B 设计空间实测：离屏深度纹理 × MSAA 的合法性（Chrome 153）",
    ranAt: new Date().toISOString(),
    runner: repoRelative(import.meta.filename),
    page: repoRelative(PAGE),
    browserVersion: run.browserVersion,
    environment: collected?.environment ?? null,
    measurements,
    findings: judgement.findings,
    copyableDepthFormats: judgement.copyableDepthFormats,
    msaaTradeOffIsReal: judgement.msaaTradeOffIsReal,
    recommendation: judgement.recommendation,
    missingMeasurements: missing,
    runtimeError: run.runtimeError,
    pageErrors: run.pageErrors,
    reportedErrors: collected?.errors ?? [],
    passed:
      run.runtimeError === null &&
      run.pageErrors.length === 0 &&
      (collected?.errors ?? []).length === 0 &&
      missing.length === 0 &&
      judgement.findings.every((finding) => finding.established),
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  console.log(`g7-depth-msaa: browser ${run.browserVersion}, ${measurements.length} measurement(s) -> ${repoRelative(OUT_FILE)}`);
  for (const measurement of measurements) {
    console.log(`  ${measurement.error === null ? "LEGAL   " : "rejected"} ${measurement.name}${measurement.error === null ? "" : ` :: ${measurement.error}`}`);
  }
  for (const finding of judgement.findings) {
    console.log(`  [${finding.established ? "established" : "NOT established"}] ${finding.id} ${finding.statement}`);
  }
  console.log(`  msaaTradeOffIsReal: ${judgement.msaaTradeOffIsReal}`);
  console.log(`  copyableDepthFormats: ${judgement.copyableDepthFormats.join(", ") || "(none)"}`);
  console.log(`  recommendation: ${judgement.recommendation}`);
  if (missing.length > 0) console.log(`  MISSING measurements: ${missing.join(", ")}`);
  if (run.runtimeError !== null) console.log(`  runtime error: ${run.runtimeError}`);
  console.log(`g7-depth-msaa: ${document.passed ? "pass" : "FAIL"}`);

  process.exitCode = document.passed ? 0 : 1;
}

await main();
