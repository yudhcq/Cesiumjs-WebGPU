/**
 * W5 root-cause probe: **where do the terrain vertices go, and did anything rasterise?**
 *
 * Run: `node tests/support/backend-runner.mjs --backend=webgpu --suite=terrain:raster-probe`
 *
 * Evidence gathering, not an acceptance suite (the same status `terrain-probe.spec.mjs` has): it
 * publishes the vertex rows, both uniform slots decoded through the program's own layout table, the
 * clip-space verdict of the drawn vertices and the depth-presence measurement, and asserts only that
 * the page itself ran. Writing assertions about "non-black pixels" here would be writing T091's
 * acceptance criteria ahead of the fix, which is exactly what Phase 7 forbids.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "playwright/test";

import { ARTIFACT_ROOT, runContractSuite } from "../support/contract-harness.mjs";

test.setTimeout(600_000);

/**
 * Variant query of this run (`PROBE_QUERY="cull=none"`), so the same probe can bisect one pipeline
 * state at a time. It only ever narrows one run's conditions; nothing here can enable a second backend.
 */
const extraQuery = Object.fromEntries(new URLSearchParams(process.env.PROBE_QUERY ?? ""));

test("the terrain raster probe publishes the geometry, the uniform block and the depth-presence verdict", async () => {
  const run = await runContractSuite("terrain:raster-probe", { viewport: { width: 384, height: 288 }, timeoutMs: 420000, ...(Object.keys(extraQuery).length === 0 ? {} : { query: extraQuery }) });
  const report = run.report;
  assert.ok(report !== null, "the page MUST publish a report");

  const result = report.result["terrain-raster-probe"];
  const out = path.join(ARTIFACT_ROOT, "terrain-raster-probe");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, `observation.${run.backend}.json`),
    `${JSON.stringify({ run: { backend: run.backend, url: run.url, browserVersion: run.browserVersion, error: run.error }, result, canvasScreenshot: run.canvasScreenshot ?? null, pageErrors: run.pageErrors, pageReportedErrors: report.errors, consoleMessages: run.consoleMessages }, null, 2)}\n`,
    "utf8",
  );
  if (typeof result?.vertexModule === "string") {
    fs.writeFileSync(path.join(out, `vertex-module.${run.backend}.wgsl`), result.vertexModule, "utf8");
  }
  if (typeof result?.fragmentModule === "string") {
    fs.writeFileSync(path.join(out, `fragment-module.${run.backend}.wgsl`), result.fragmentModule, "utf8");
  }
  console.log(
    `terrain-raster-probe[${run.backend}]: ${JSON.stringify({
      pageErrors: report.errors.length,
      counts: result?.counts ?? null,
      gpuFrame: result?.gpuFrame === null || result?.gpuFrame === undefined ? null : { nonBlackPixels: result.gpuFrame.nonBlackPixels, uniqueColours: result.gpuFrame.uniqueColours, centre: result.gpuFrame.centre },
      canvasScreenshot: run.canvasScreenshot === undefined ? null : { nonBackground: run.canvasScreenshot.nonBackground, uniqueColours: run.canvasScreenshot.uniqueColours, centre: run.canvasScreenshot.centre },
      firstVertices: result?.geometry?.firstVertices ?? null,
      uniformStructSize: result?.uniforms?.structSize ?? null,
      automaticZeroMembers: result?.uniforms?.automaticZeroMembers ?? null,
      emittedDefineMarkers: result?.emittedDefineMarkers ?? null,
      clip: result?.clipVerdict === undefined ? null : { evaluated: result.clipVerdict.vertexRowsEvaluated ?? null, inside: result.clipVerdict.insideClipVolume ?? null },
      depthPresence: result?.depthPresence === undefined ? null : {
        indicatorAlways: result.depthPresence.indicatorAlways?.nonBlackPixels ?? null,
        terrainFrameGreater: result.depthPresence.terrainFrameGreater?.nonBlackPixels ?? null,
        clearOnlyThenGreater: result.depthPresence.clearOnlyThenGreater?.nonBlackPixels ?? null,
        difference: result.depthPresence.differenceFromControl ?? null,
        verdict: result.depthPresence.verdict ?? null,
      },
      geometryProbeVerdict: result?.geometryProbe?.verdict ?? null,
    })}`,
  );

  assert.deepEqual(run.pageErrors, [], `uncaught page error(s): ${JSON.stringify(run.pageErrors)}`);
  assert.ok(result !== undefined, "the probe MUST publish its result");
});
