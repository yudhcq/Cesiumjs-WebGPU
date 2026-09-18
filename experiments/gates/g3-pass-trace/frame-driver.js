/**
 * G-3 gate page driver (tasks.md T020) — records ONE complete frame of the upstream globe/terrain path.
 *
 * Sequence:
 *   1. install the platform tracer (wraps `WebGL2RenderingContext.prototype` only);
 *   2. create a real upstream `CesiumWidget` over the **default `EllipsoidTerrainProvider`** (zero
 *      network, deterministic) with the MVP's render-path options (`baseLayer:false`, `skyBox:false`,
 *      `skyAtmosphere:false`, no sun/moon), globe visible, camera looking at a small surface rectangle;
 *   3. drive warm-up frames until the globe reports `tilesLoaded` (shader compilation, tile build);
 *   4. record exactly one further frame: `tracer.start()` → `widget.render()` → `tracer.stop()`;
 *   5. report the trace, the widget/scene facts and the WebGL capability values actually in force.
 *
 * The recorder never touches a Cesium object: it only wraps platform prototypes (T020).
 */

import * as engine from "./entry.js";
import { TRACED_METHODS, installPlatformTracer } from "./platform-trace.js";

const report = {
  startedAt: new Date().toISOString(),
  tracer: null,
  bundle: { upstreamContextIsPresent: engine.upstreamContextIsPresent === true },
  scene: null,
  frame: null,
  trace: null,
  errors: [],
};

function serialiseError(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 5).join("\n") : null };
}

async function nextFrame() {
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function run() {
  const container = document.getElementById("g3-container");
  const tracer = installPlatformTracer();
  report.tracer = { tracedMethods: TRACED_METHODS.length };

  const widget = new engine.CesiumWidget(container, {
    baseLayer: false,
    skyBox: false,
    skyAtmosphere: false,
    scene3DOnly: true,
    useDefaultRenderLoop: false,
    requestRenderMode: false,
    terrainProvider: new engine.EllipsoidTerrainProvider(),
    contextOptions: { webgl: { alpha: false, stencil: true, powerPreference: "high-performance" } },
  });
  const scene = widget.scene;
  const sceneSurfaces = { sun: scene.sun !== undefined, moon: scene.moon !== undefined, globe: scene.globe !== undefined, fog: scene.fog !== undefined, skyBox: scene.skyBox !== undefined, skyAtmosphere: scene.skyAtmosphere !== undefined };
  report.sceneSurfaces = sceneSurfaces;
  if (scene.globe === undefined) throw new Error(`G-3 driver: the scene has no globe (surfaces: ${JSON.stringify(sceneSurfaces)})`);
  if (scene.sun !== undefined) scene.sun.show = false;
  if (scene.moon !== undefined) scene.moon.show = false;
  if (scene.skyBox !== undefined) scene.skyBox.show = false;
  if (scene.skyAtmosphere !== undefined) scene.skyAtmosphere.show = false;
  scene.globe.show = true;
  scene.globe.showGroundAtmosphere = true;
  scene.globe.enableLighting = false;
  scene.globe.depthTestAgainstTerrain = false;
  if (scene.fog !== undefined) scene.fog.enabled = true;

  const gl = scene.context._gl;
  if (gl === null || gl === undefined) throw new Error("G-3 driver: the scene has no WebGL context");

  report.scene = {
    contextConstructor: scene.context.constructor?.name ?? null,
    webgl2: scene.context.webgl2 === true,
    drawingBufferWidth: scene.context.drawingBufferWidth,
    drawingBufferHeight: scene.context.drawingBufferHeight,
    msaaSupported: scene.msaaSupported,
    msaaSamples: scene.msaaSamples,
    logarithmicDepthBuffer: scene.logarithmicDepthBuffer,
    depthTexture: scene.context.depthTexture,
    stencilBuffer: scene.context.stencilBuffer,
    maximumSamples: gl.getParameter(gl.MAX_SAMPLES),
    maximumDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    maximumColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS),
    version: gl.getParameter(gl.VERSION),
    globeTilesLoaded: false,
    terrainProvider: scene.terrainProvider?.constructor?.name ?? null,
  };

  scene.camera.setView({ destination: engine.Rectangle.fromDegrees(-2.0, -2.0, 2.0, 2.0) });

  // ---- warm-up: let the tile tree build and the shaders compile (recording disabled) -------------
  // The globe's tile provider works asynchronously (heightmap decoding runs in a Web Worker), so the
  // warm-up waits for `tilesLoaded` with a bounded budget before the frame that is actually recorded.
  const warmupFrames = [];
  const warmupDeadline = performance.now() + 8000;
  for (let index = 0; index < 90; index += 1) {
    widget.render();
    await nextFrame();
    warmupFrames.push({ index, tilesLoaded: scene.globe.tilesLoaded === true });
    if (scene.globe.tilesLoaded === true && index >= 3) break;
    if (performance.now() > warmupDeadline) break;
  }
  report.scene.globeTilesLoaded = scene.globe.tilesLoaded === true;
  report.frame = { warmupFrames: warmupFrames.length, warmup: warmupFrames.slice(-3) };

  // ---- record exactly one frame ------------------------------------------------------------------
  tracer.ops.length = 0;
  tracer.start();
  const startedAt = performance.now();
  widget.render();
  const finishedAt = performance.now();
  tracer.stop();

  report.frame = {
    ...report.frame,
    durationMs: finishedAt - startedAt,
    operationCount: tracer.ops.length,
    tilesLoadedBeforeFrame: report.scene.globeTilesLoaded,
  };
  report.trace = { ops: tracer.ops.slice(), summary: tracer.summary(), finalState: tracer.state() };
  report.scene.tilesLoadedAfterFrame = scene.globe.tilesLoaded === true;

  tracer.uninstall();
  widget.destroy();
  return report;
}

globalThis.__g3 = { ready: false, report: null, error: null };
try {
  const result = await run();
  report.finishedAt = new Date().toISOString();
  globalThis.__g3 = { ready: true, report: result, error: null };
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.errors.push(serialiseError(error));
  globalThis.__g3 = { ready: true, report, error: serialiseError(error) };
}
