/**
 * Ordering + integration probe for Phase 7 (tasks.md T084-T098a) — **evidence gathering, not an
 * acceptance suite**.
 *
 * Run: `node tests/support/backend-runner.mjs --backend=webgpu --suite=terrain:probe`
 *
 * Three diagnostic variants of the same scenario run as three separate page loads (one backend each,
 * principle II): the default MVP camera, a far top-down camera (whole globe in view) and lighting off.
 * Together they attribute a black frame to the camera/projection, to the shading, or to the draw path.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "playwright/test";

import { ARTIFACT_ROOT, runContractSuite } from "../support/contract-harness.mjs";

test.setTimeout(600_000);

const VARIANTS = [
  { id: "default", query: {} },
  { id: "far-topdown", query: { camera: "far" } },
  { id: "no-lighting", query: { lighting: "off" } },
  { id: "ellipsoid-provider", query: { provider: "ellipsoid", camera: "far" } },
  { id: "no-cull-no-depth", query: { cull: "none", depth: "always" } },
  { id: "globe-hidden", query: { globe: "hidden", camera: "far" } },
  { id: "single-sample-depth", query: { samples: "1" } },
];

test("the MVP terrain scene renders and every FramebufferManager request is recorded", async () => {
  const observations = {};
  for (const variant of VARIANTS) {
    const run = await runContractSuite("terrain:probe", { viewport: { width: 384, height: 288 }, timeoutMs: 300000, query: variant.query });
    const report = run.report;
    assert.ok(report !== null, `${variant.id}: the page MUST publish a report`);
    const result = report.result["terrain-probe"];
    observations[variant.id] = { backend: run.backend, result, pageErrors: report.errors, canvasScreenshot: run.canvasScreenshot ?? null };

    const out = path.join(ARTIFACT_ROOT, "terrain-probe");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, `observation.${variant.id}.${run.backend}.json`),
      `${JSON.stringify({ variant: variant.id, query: variant.query, run: { backend: run.backend, url: run.url, browserVersion: run.browserVersion, error: run.error }, result, canvasScreenshot: run.canvasScreenshot ?? null, pageErrors: run.pageErrors, pageReportedErrors: report.errors, requestFailures: run.requestFailures, requests: run.requests, badResponses: run.badResponses, consoleMessages: run.consoleMessages }, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `terrain-probe[${variant.id}/${run.backend}]: ${JSON.stringify({
        pageErrors: report.errors.length,
        draws: result?.counts?.draws ?? null,
        passes: result?.counts?.passes ?? null,
        tiles: result?.globeDiagnostics?.tilesToRenderLength ?? null,
        gpuFrame: result?.gpuFrame === undefined || result.gpuFrame === null ? null : { nonBlack: result.gpuFrame.nonBlackPixels, centre: result.gpuFrame.centre },
        screenshot: run.canvasScreenshot === undefined ? null : { nonBackground: run.canvasScreenshot.nonBackground, uniqueColours: run.canvasScreenshot.uniqueColours, centre: run.canvasScreenshot.centre },
        framebufferUpdateShapes: (result?.framebufferUpdates ?? []).length,
      })}`,
    );
  }
  // The probe's purpose is the observation; the only hard assertion is that the page itself ran.
  for (const [id, observation] of Object.entries(observations)) {
    assert.deepEqual(observation.pageErrors, [], `${id}: the page reported errors`);
    assert.ok(observation.result !== undefined, `${id}: the probe MUST publish its result`);
  }
});
