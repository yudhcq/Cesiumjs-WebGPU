/**
 * W5 sanity probe: the **canvas pass** with a depth-tested draw, read back on the GPU.
 *
 * Run: `node tests/support/backend-runner.mjs --backend=webgpu --suite=terrain:canvas-depth-probe`
 *
 * Evidence gathering, not an acceptance suite: it answers "can the canvas pass present a depth-tested
 * draw at all", which is the precondition for the terrain scene.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "playwright/test";

import { ARTIFACT_ROOT, runContractSuite } from "../support/contract-harness.mjs";

test.setTimeout(300_000);

test("the canvas pass presents a depth-tested triangle and the GPU read-back sees it", async () => {
  const run = await runContractSuite("terrain:canvas-depth-probe", { viewport: { width: 384, height: 288 }, timeoutMs: 300000 });
  const report = run.report;
  assert.ok(report !== null, "the page MUST publish a report");

  const result = report.result["canvas-depth-probe"];
  const out = path.join(ARTIFACT_ROOT, "canvas-depth-probe");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, `observation.${run.backend}.json`),
    `${JSON.stringify({ run: { backend: run.backend, url: run.url, browserVersion: run.browserVersion, error: run.error }, result, canvasScreenshot: run.canvasScreenshot ?? null, pageErrors: run.pageErrors, consoleMessages: run.consoleMessages }, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `canvas-depth-probe[${run.backend}]: ${JSON.stringify({ frame: result?.frame ?? null, frameErrors: result?.frameErrors ?? null, sampleCount: result?.sampleCount ?? null, screenshot: run.canvasScreenshot === undefined ? null : { nonBackground: run.canvasScreenshot.nonBackground, centre: run.canvasScreenshot.centre } })}`,
  );

  assert.deepEqual(report.errors, [], `the page reported errors: ${JSON.stringify(report.errors)}`);
  assert.ok(result !== undefined, "the probe MUST publish its result");
});
