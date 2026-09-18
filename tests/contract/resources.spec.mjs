/**
 * T064 — resource-layer contract test (`层=契约`, tasks.md T064; FR-008/FR-011, principle II).
 *
 * Run (one backend per process, one page load, **two independent runs**):
 *   node tests/support/backend-runner.mjs --backend=webgpu --suite=contract:resources
 *   node tests/support/backend-runner.mjs --backend=webgl2 --suite=contract:resources
 *
 * The page drives the **production specifiers** (`@cesium/engine/Source/Renderer/Buffer.js`, …), so
 * under the real manifest the W3 replacements run and under the empty manifest the upstream classes
 * do. Both runs publish the same report shape, which is what makes the cross-path comparison an
 * offline activity (`tests/support/compare-offline.mjs`) rather than a same-session one.
 *
 * The two pixel assertions are the ones no descriptor can make:
 *   - **buffer upload ordering**: the vertex buffer is written twice (a superseded red, then the
 *     expected blue) and the drawn pixel MUST show the *second* write;
 *   - **MSAA resolve result**: a triangle rendered into the multisampled renderbuffer MUST appear in
 *     the resolved texture — without the resolve the right half would stay black.
 */
import assert from "node:assert/strict";
import { test } from "playwright/test";

import { assertCleanRun, assertOtherBackendUntouched, runContractSuite } from "../support/contract-harness.mjs";

// One run builds the bundle (rollup + TypeScript over the whole upstream graph), launches Chrome and
// loads the page. A cold build alone exceeds Playwright's 30 s default, so the budget is stated here.
test.setTimeout(300_000);

/** The colours the page's workload uses (`probe.js` → `W3_*_COLOUR`). */
const ORDERED_COLOUR = [0.15, 0.55, 0.85, 1.0];
const SUPERSEDED_COLOUR = [1.0, 0.0, 0.0, 1.0];
const MSAA_COLOUR = [0.2, 0.8, 0.3, 1.0];

/** Normalised sample points: the centre of each half-viewport. */
const SAMPLE_POINTS = [
  { name: "left-centre", x: 0.25, y: 0.5 },
  { name: "right-centre", x: 0.75, y: 0.5 },
];

const to255 = (value) => Math.round(value * 255);

/** Assert a sampled pixel is `expected` within `tolerance` (the swap chain is an 8-bit unorm format). */
function assertColour(sample, expected, tolerance, label) {
  assert.ok(sample !== undefined, `the harness MUST have sampled "${label}"`);
  const [r, g, b] = sample.rgba;
  const target = expected.slice(0, 3).map(to255);
  const deltas = [r - target[0], g - target[1], b - target[2]];
  assert.ok(
    deltas.every((delta) => Math.abs(delta) <= tolerance),
    `${label} MUST be rgb(${target.join(", ")}) ± ${tolerance}, got rgb(${[r, g, b].join(", ")}) at (${sample.x}, ${sample.y})`,
  );
}

test("contract:resources — the W3 resource layer, one backend per run", async () => {
  const run = await runContractSuite("contract:resources", { captureCanvas: true, samplePoints: SAMPLE_POINTS });
  assertCleanRun(run, assert);
  assertOtherBackendUntouched(run, assert);
  assert.equal(run.isolation, "separate-process", "one run = one process + one page load (principle II)");
  // Upstream Cesium has known internal cycles (`Scene/**`, `DataSources/**`), so the code list is not
  // asserted empty; what MUST hold is that the **patch layer** adds no warning of its own.
  assert.deepEqual(
    run.build.patchLayerWarnings ?? [],
    [],
    `the W3 modules MUST NOT add bundle warnings (all: ${JSON.stringify(run.build.warnings)})`,
  );

  const resources = run.report.result.resources;
  assert.ok(resources !== undefined, "the page MUST publish the resource report");
  assert.equal(resources.backend, run.backend, "the report MUST describe the backend the runner enabled");

  // ---- buffers: three factories, usage mapping, index extras ----------------------------------
  const buffer = resources.buffer;
  assert.equal(buffer.vertexSizeInBytes, 3 * 7 * 4, "three vertices of seven float32 components");
  assert.equal(buffer.indexSizeInBytes, 4 * 2, "four Uint16 indices");
  assert.equal(buffer.bytesPerIndex, 2);
  assert.equal(buffer.numberOfIndices, 4);
  assert.equal(buffer.indexDatatype, 0x1403, "IndexDatatype.UNSIGNED_SHORT");
  assert.equal(buffer.numberOfVertices, 3, "sizeInBytes / stride");

  // ---- texture + sampler ----------------------------------------------------------------------
  assert.deepEqual(
    { width: resources.texture.width, height: resources.texture.height, pixelFormat: resources.texture.pixelFormat, pixelDatatype: resources.texture.pixelDatatype },
    { width: 2, height: 2, pixelFormat: 0x1908, pixelDatatype: 0x1401 },
    "the texture keeps upstream's option bag (2x2, RGBA, UNSIGNED_BYTE)",
  );
  assert.equal(resources.texture.flipY, true, "upstream's default is flipY: true");
  assert.equal(resources.texture.sizeInBytes, 16, "2x2x4 bytes, upstream's arithmetic");
  assert.equal(resources.sampler.wrapS, 0x2901, "TextureWrap.REPEAT");
  assert.equal(resources.sampler.wrapT, 0x8370, "TextureWrap.MIRRORED_REPEAT");
  assert.equal(resources.sampler.minificationFilter, 0x2601, "TextureMinificationFilter.LINEAR");
  assert.equal(resources.sampler.maximumAnisotropy, 1);
  assert.equal(resources.sampler.gpuDescriptor === null, run.backend !== "webgpu", "the GPU descriptor exists on the WebGPU path only");

  // ---- MSAA pairing and resolve ---------------------------------------------------------------
  assert.equal(resources.msaa.requestSamples, 4);
  assert.equal(resources.msaa.attachmentSamples, 4, "the multisampled attachment really is 4x");
  assert.equal(resources.msaa.renderColorAttachments, 1);
  assert.equal(resources.msaa.colorColorAttachments, 1, "the resolve destination is the colour framebuffer's texture");
  assert.equal(resources.msaa.resolveSampleCount, 4);
  if (run.backend === "webgpu") {
    assert.equal(resources.msaa.resolveTargetPresent, true, "the multisampled attachment carries its resolveTarget (T061)");
    assert.equal(resources.msaa.resolveMechanism, "resolveTarget", "WebGPU resolves at pass end, not by a blit command");
    assert.equal(buffer.gpuLayout.length, 1, "both attributes share one interleaved buffer");
    assert.equal(buffer.gpuLayout[0].arrayStride, 28);
    assert.equal(buffer.gpuLayout[0].attributes, 2);
    assert.equal(resources.texture.gpuFormat, "rgba8unorm", "the format table maps RGBA8 to rgba8unorm");
    // The FR-017 ledger MUST have seen the resources this run created, and MUST be consistent.
    assert.ok(resources.counts.registry.live > 0, "the GPU resource ledger MUST be non-empty while resources are alive");
    assert.ok(resources.counts.registry.totalBytes > 0, "the FR-017 byte total MUST be real");
    assert.equal(resources.counts.registry.released, 0, "nothing is released before the page tears the backend down");
    assert.deepEqual(resources.counts.frameErrors, [], `the WebGPU frame MUST produce no GPU error (got ${JSON.stringify(resources.counts.frameErrors)})`);
    assert.ok(resources.counts.draws >= 3, `every scripted draw MUST reach the encoder (got ${resources.counts.draws})`);
    assert.ok(resources.counts.drawIndexedCalls >= 3, "all three draws use the index buffer");
  } else {
    assert.equal(resources.msaa.resolveTargetPresent, false, "GL resolves through blitFramebuffer instead");
    assert.equal(resources.msaa.resolveMechanism, "blitFramebuffer");
  }

  // ---- the pixels -----------------------------------------------------------------------------
  const shot = run.canvasScreenshot;
  assert.ok(shot !== undefined && shot.captured === true, `the harness MUST capture the canvas (${shot?.reason ?? "no capture"})`);
  const samples = new Map((shot.samples ?? []).map((sample) => [sample.name, sample]));
  assert.deepEqual([...samples.keys()].sort(), SAMPLE_POINTS.map((point) => point.name).sort());

  // The left half proves the upload ORDER: the second write (blue) is drawn, not the first (red).
  assertColour(samples.get("left-centre"), ORDERED_COLOUR, 12, "the ordered-buffer half");
  const [leftRed] = samples.get("left-centre").rgba;
  assert.ok(leftRed < to255(SUPERSEDED_COLOUR[0]) / 2, "the superseded first upload MUST NOT be what was drawn (buffer upload ordering)");

  // The right half proves the MSAA RESOLVE produced the drawn pixels.
  assertColour(samples.get("right-centre"), MSAA_COLOUR, 12, "the MSAA-resolved half");
});
