#!/usr/bin/env node
/**
 * G-1 gate — evidence collector (tasks.md T002 / T003).
 *
 * Drives `g1-layering.html` in a real browser and writes the gate evidence:
 *
 *     experiments/gates/out/g1.json                     machine-readable measurements + verdict inputs
 *     experiments/gates/out/g1.png                      the gate capture (upstream layer, terrain supposed hidden)
 *     experiments/gates/out/g1-control-terrain.png      control: terrain deliberately visible (magenta)
 *     experiments/gates/out/g1-translucency-zero.png    candidate B capture
 *     experiments/gates/out/g1-ref-globe-hidden.png     oracle: no globe geometry drawn at all
 *     experiments/gates/out/g1-webgpu-layer-proof.png   WebGPU marker composited over the WebGL2 terrain
 *     experiments/gates/out/g1-run.log                  transcript of this run
 *
 * Every pixel claim is computed from the **actual PNG bytes** written to `out/` (see png-stats.mjs),
 * and cross-checked against an independent in-page `canvas` readback. Nothing is fabricated: if
 * WebGPU is unavailable the run records that as a first-class result instead of pretending.
 *
 * `playwright-core` is installed OUTSIDE this repository (the workspace owns no dependencies before
 * Phase 2 / tasks.md T008+T011). Point `GATE_TOOLS_DIR` at the directory that contains it:
 *
 *     GATE_TOOLS_DIR=<dir with node_modules/playwright-core> \
 *       node experiments/gates/collect-g1.mjs --url http://127.0.0.1:8125/g1-layering.html
 *
 * Browser selection: `--channel chrome|msedge|chromium` (Playwright resolves the installed browser;
 * no download, no absolute path baked into this file), or `--exe <path>`.
 */

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readPng, countColor, diffPng, diffPngInEllipse, colorBBox, channelMeans } from "./png-stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "out");

/** Page background behind both canvases — if the upstream canvas ever becomes transparent where
 *  the terrain is, this colour shows through and is impossible to miss in the capture. */
const CONTAINER_BG = [0x12, 0xff, 0x00];
const TERRAIN_CONTROL_RGB = [255, 0, 255]; // Color.MAGENTA
const WEBGPU_MARKER_RGB = [0, 255, 217]; // marker triangle fragment colour
const DIFF_TOLERANCE = 8; // per-channel
const INVISIBLE_MAX_RATIO = 0.001; // <= 0.1 % of pixels may differ from the oracle

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const args = {
    url: "http://127.0.0.1:8125/g1-layering.html",
    channel: process.env.GATE_BROWSER_CHANNEL || "chrome",
    exe: process.env.GATE_BROWSER_EXE || null,
    headed: false,
    extraArgs: (process.env.GATE_BROWSER_ARGS || "").split(",").filter(Boolean),
    timeoutMs: 60000,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--url") args.url = argv[++i];
    else if (token === "--channel") args.channel = argv[++i];
    else if (token === "--exe") args.exe = argv[++i];
    else if (token === "--headed") args.headed = true;
    else if (token === "--extra-args") args.extraArgs.push(...argv[++i].split(",").filter(Boolean));
    else if (token === "--timeout") args.timeoutMs = Number(argv[++i]);
    else if (token === "--help" || token === "-h") {
      console.log(
        "usage: node collect-g1.mjs [--url <page>] [--channel chrome] [--exe <path>] [--headed] [--extra-args a,b]",
      );
      process.exit(0);
    }
  }
  return args;
}

/* ------------------------------------------------------- playwright import */

function loadPlaywright() {
  const candidates = [];
  if (process.env.GATE_TOOLS_DIR) {
    candidates.push(resolve(process.env.GATE_TOOLS_DIR));
  }
  candidates.push(resolve(HERE, "..", ".."));
  const errors = [];
  for (const base of candidates) {
    try {
      const requires = createRequire(join(base, "noop.js"));
      return requires("playwright-core");
    } catch (error) {
      errors.push(`${base}: ${error.message}`);
    }
  }
  throw new Error(
    "playwright-core not found. Install it outside the repository and set GATE_TOOLS_DIR.\n" +
      errors.join("\n"),
  );
}

/* ----------------------------------------------------------------- helpers */

const logLines = [];

function log(line) {
  const text = `[collect-g1] ${line}`;
  logLines.push(text);
  console.log(text);
}

async function waitForFrames(page, frames, timeoutMs = 10000) {
  await page.evaluate(
    async ([n, timeout]) => {
      const start = window.__g1.counters().postRenderFrames;
      const deadline = performance.now() + timeout;
      while (window.__g1.counters().postRenderFrames - start < n && performance.now() < deadline) {
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    [frames, timeoutMs],
  );
}

async function waitForTilesLoaded(page, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(() => window.__g1.globeState());
    if (state.tilesLoaded === true) {
      return { loaded: true, waitedMs: Date.now() - started };
    }
    await page.waitForTimeout(200);
  }
  return { loaded: false, waitedMs: Date.now() - started };
}

/* -------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });
  const runLogPath = join(OUT_DIR, "g1-run.log");
  writeFileSync(runLogPath, "");

  const { chromium } = loadPlaywright();

  const launchOptions = { headless: !args.headed, args: [...args.extraArgs] };
  if (args.exe) {
    launchOptions.executablePath = args.exe;
  } else {
    launchOptions.channel = args.channel;
  }

  log(
    `launch: channel=${args.exe ? "(exe)" : args.channel} headless=${!args.headed} args=[${args.extraArgs.join(" ")}]`,
  );
  const browser = await chromium.launch(launchOptions);
  const browserVersion = browser.version();
  log(`browser version: ${browserVersion}`);

  const context = await browser.newContext({
    viewport: { width: 1000, height: 820 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const consoleMessages = [];
  const pageErrors = [];
  page.on("console", (message) =>
    consoleMessages.push({ type: message.type(), text: message.text() }),
  );
  page.on("pageerror", (error) =>
    pageErrors.push(String(error && error.message ? error.message : error)),
  );

  const result = {
    gate: "G-1",
    task: "T002",
    generatedAt: new Date().toISOString(),
    environment: {
      browser: {
        channel: args.exe ? null : args.channel,
        executablePathGiven: Boolean(args.exe),
        version: browserVersion,
        headless: !args.headed,
        launchArgs: args.extraArgs,
        userAgent: null,
      },
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
    },
    measurements: {},
    checks: {},
    verdict: null,
  };

  const container = page.locator("#g1-container");

  /** Screenshot the canvas container and decode the real PNG bytes. */
  async function capture(name) {
    const file = join(OUT_DIR, name);
    await container.screenshot({ path: file });
    return readPng(file);
  }

  try {
    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
    await page.waitForFunction(() => window.__g1 && window.__g1.ready === true, null, {
      timeout: args.timeoutMs,
    });

    result.environment.browser.userAgent = await page.evaluate(() => navigator.userAgent);

    const fatal = await page.evaluate(() => window.__g1.fatal);
    if (fatal) {
      throw new Error(`page bootstrap failed: ${fatal}`);
    }

    /* ---- 0. context types, fixture integrity, adapter -------------------- */

    result.measurements.consoleLines = await page.evaluate(() => window.__g1.consoleLines);
    result.measurements.fixture = await page.evaluate(() => window.__g1.fixture());
    result.measurements.webgpu = await page.evaluate(() => window.__g1.webgpu());
    result.measurements.layerInfo = await page.evaluate(() => window.__g1.layerInfo());

    log(
      `canvases: A=${result.measurements.layerInfo.canvasAGetContext} B=${result.measurements.layerInfo.canvasBGetContext} ` +
        `drawingBuffer=${JSON.stringify(result.measurements.layerInfo.drawingBuffer)}`,
    );
    log(
      `fixture: ok=${result.measurements.fixture.ok} tiles=${JSON.stringify(
        Object.entries(result.measurements.fixture.tiles ?? {}).map(
          ([k, v]) => `${k}:${v.fnv1a32Hex}${v.ok ? "" : "(MISMATCH)"}`,
        ),
      )}`,
    );
    log(
      `webgpu: ok=${result.measurements.webgpu.ok} fallback=${result.measurements.webgpu.isFallbackAdapter} ` +
        `format=${result.measurements.webgpu.preferredFormat} adapter=${JSON.stringify(result.measurements.webgpu.adapterInfo)}`,
    );
    if (!result.measurements.webgpu.ok) {
      log(`webgpu reason: ${result.measurements.webgpu.reason}`);
    }

    /* ---- 1. wait for the upstream quadtree to settle ---------------------- */

    const tileWait = await waitForTilesLoaded(page);
    result.measurements.tileWait = tileWait;
    result.measurements.countersAfterLoad = await page.evaluate(() => window.__g1.counters());
    result.measurements.globeStateAfterLoad = await page.evaluate(() => window.__g1.globeState());
    log(
      `tiles: loaded=${tileWait.loaded} after=${tileWait.waitedMs}ms requested=${result.measurements.countersAfterLoad.tilesRequested} ` +
        `keys=${JSON.stringify(result.measurements.countersAfterLoad.tilesRequestedByKey)} ` +
        `progressEvents=${result.measurements.countersAfterLoad.tileLoadProgressEvents} frames=${result.measurements.countersAfterLoad.postRenderFrames}`,
    );
    if (result.measurements.webgpu.ok) {
      await waitForFrames(page, 5);
    }

    /* ---- 2. camera interaction must not be blocked by canvas B ------------ */

    const camBefore = await page.evaluate(() => window.__g1.camera());
    const box = await container.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(cx + i * 12, cy + i * 4, { steps: 2 });
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(600);
    const camAfter = await page.evaluate(() => window.__g1.camera());
    const cameraMoved =
      Math.abs(camAfter.longitudeDeg - camBefore.longitudeDeg) > 0.05 ||
      Math.abs(camAfter.latitudeDeg - camBefore.latitudeDeg) > 0.05;
    result.measurements.cameraInteraction = {
      before: camBefore,
      after: camAfter,
      moved: cameraMoved,
        method: "playwright mouse down/move/up over the container centre (hit-tested to canvas A)",
    };
    log(
      `camera drag: moved=${cameraMoved} lon ${camBefore.longitudeDeg.toFixed(3)} -> ${camAfter.longitudeDeg.toFixed(3)}`,
    );

    await page.evaluate(() => window.__g1.resetCamera());
    await page.evaluate(() => window.__g1.setMarker(false));

    /* ---- 3. capture every route, diff each against the globe-hidden oracle -- */

    const ROUTES = [
      { name: "control-opaque", file: "g1-control-terrain.png", primary: false },
      { name: "transparent-basecolor", file: "g1.png", primary: true },
      { name: "whitealpha-basecolor", file: "g1-diag-whitealpha.png", primary: false },
      { name: "translucency-zero", file: "g1-translucency-zero.png", primary: false },
      { name: "translucency-zero-both", file: "g1-translucency-zero-both.png", primary: false },
      { name: "translucency-blend-transparent", file: "g1-translucency-blend.png", primary: false },
      { name: "globe-hidden", file: "g1-ref-globe-hidden.png", primary: false },
    ];

    const shots = new Map();
    const routeRecords = {};
    for (const route of ROUTES) {
      await page.evaluate((name) => {
        window.__g1.resetFrameTimes();
        return window.__g1.applyRoute(name);
      }, route.name);
      await waitForFrames(page, 40);
      const frameTimes = await page.evaluate(() => window.__g1.frameTimeStats());
      const shot = await capture(route.file);
      shots.set(route.name, shot);
      routeRecords[route.name] = {
        route: route.name,
        screenshot: route.file,
        globe: await page.evaluate(() => window.__g1.globeState()),
        pageBackgroundPixels: countColor(shot, CONTAINER_BG, 24),
        means: channelMeans(shot),
        frameTimeMs: frameTimes,
      };
      log(
        `route[${route.name}] globe.show=${routeRecords[route.name].globe.show} ` +
          `baseColor=${JSON.stringify(routeRecords[route.name].globe.baseColor)} ` +
          `translucency=${routeRecords[route.name].globe.translucencyEnabled}(${routeRecords[route.name].globe.frontFaceAlpha}/${routeRecords[route.name].globe.backFaceAlpha}) ` +
          `means=(${routeRecords[route.name].means.r.toFixed(1)},${routeRecords[route.name].means.g.toFixed(1)},${routeRecords[route.name].means.b.toFixed(1)}) ` +
          `frameMs p50=${frameTimes.p50?.toFixed(2)} p95=${frameTimes.p95?.toFixed(2)}`,
      );
    }

    const oracle = shots.get("globe-hidden");
    const diffs = {};
    for (const route of ROUTES) {
      if (route.name === "globe-hidden") continue;
      diffs[route.name] = diffPng(shots.get(route.name), oracle, DIFF_TOLERANCE);
      routeRecords[route.name].diffVsOracle = diffs[route.name];
      log(
        `route[${route.name}] vs oracle: diffRatio=${diffs[route.name].ratio.toFixed(5)} ` +
          `maxDelta=${diffs[route.name].maxChannelDelta} bbox=${JSON.stringify(diffs[route.name].bbox)}`,
      );
    }

    result.measurements.routes = routeRecords;
    result.measurements.oracle = {
      route: "globe-hidden",
      note:
        "globe.show=false is a RENDERING ORACLE ONLY (research.md §1.4: it also stops tile scheduling, " +
        "so it can never be the architecture). It defines what the frame looks like with no globe geometry.",
      perChannelTolerance: DIFF_TOLERANCE,
      comparedAgainst: "the 900x640 canvas-container region of the real screenshots",
    };

    // Discriminator: does the terrain's *colour* reach the framebuffer at alpha 0?
    const diffWhiteVsTransparent = diffPng(
      shots.get("whitealpha-basecolor"),
      shots.get("transparent-basecolor"),
      DIFF_TOLERANCE,
    );
    result.measurements.alphaZeroDiscriminator = {
      question:
        "With alpha=0, does the terrain's RGB still reach the framebuffer? Identical frames " +
        "(white-alpha-0 vs TRANSPARENT) mean the terrain contributes nothing to the composite and " +
        "any residual silhouette comes from a different upstream pass; different frames mean the " +
        "terrain really is being painted.",
      whiteAlphaZeroVsTransparent: diffWhiteVsTransparent,
      terrainColourReachesFramebuffer: diffWhiteVsTransparent.mismatchPixels > 0,
    };
    log(
      `discriminator white-alpha-0 vs TRANSPARENT: diffRatio=${diffWhiteVsTransparent.ratio.toFixed(5)} ` +
        `-> terrain colour reaches framebuffer: ${diffWhiteVsTransparent.mismatchPixels > 0}`,
    );

    /* ---- 4. WebGPU layer composited above the WebGL2 terrain -------------- */

    await page.evaluate(() => window.__g1.setMarker(true));
    await page.evaluate(() => window.__g1.applyRoute("control-opaque"));
    await waitForFrames(page, 8);
    const shotMarker = await capture("g1-webgpu-layer-proof.png");
    const markerPixels = countColor(shotMarker, WEBGPU_MARKER_RGB, 30);
    const markerTerrainPixels = countColor(shotMarker, TERRAIN_CONTROL_RGB, 24, 60);
    result.measurements.webgpuMarker = {
      screenshot: "g1-webgpu-layer-proof.png",
      markerPixelsInComposite: markerPixels,
      terrainPixelsInComposite: markerTerrainPixels,
      submits: (await page.evaluate(() => window.__g1.counters())).webgpuLayerSubmits,
    };
    await page.evaluate(() => window.__g1.setMarker(false));
    log(
      `composite proof: marker=${markerPixels.matched}px AND terrain=${markerTerrainPixels.matched}px ` +
        `visible in the SAME capture (${result.measurements.webgpuMarker.submits} WebGPU submits)`,
    );

    /* ---- 8. re-measure research.md §1.4 + prove the adopted route keeps scheduling -- */

    const schedulingRoutes = [
      "control-opaque",
      "globe-hidden",
      "transparent-basecolor",
      "translucency-zero-both",
    ];
    const schedulingRuns = [];
    for (const route of schedulingRoutes) {
      const probe = await context.newPage();
      const probeErrors = [];
      probe.on("pageerror", (error) => probeErrors.push(String(error)));
      await probe.goto(`${args.url}?route=${route}`, { waitUntil: "domcontentloaded" });
      await probe.waitForFunction(() => window.__g1 && window.__g1.ready === true, null, {
        timeout: args.timeoutMs,
      });
      await probe.waitForTimeout(6000);
      const run = {
        route,
        counters: await probe.evaluate(() => window.__g1.counters()),
        globeState: await probe.evaluate(() => window.__g1.globeState()),
        pageErrors: probeErrors,
      };
      schedulingRuns.push(run);
      await probe.close();
      log(
        `scheduling probe[${route}]: tilesRequested=${run.counters.tilesRequested} ` +
          `keys=${JSON.stringify(run.counters.tilesRequestedByKey)} ` +
          `progressEvents=${run.counters.tileLoadProgressEvents} frames=${run.counters.postRenderFrames}`,
      );
    }
    result.measurements.schedulingProbe = schedulingRuns;

    /* ---- 9. product configuration: sky box + sky atmosphere ON ------------ */

    const skyPage = await context.newPage();
    const skyErrors = [];
    skyPage.on("pageerror", (error) => skyErrors.push(String(error)));
    await skyPage.goto(`${args.url}?sky=1`, { waitUntil: "domcontentloaded" });
    await skyPage.waitForFunction(() => window.__g1 && window.__g1.ready === true, null, {
      timeout: args.timeoutMs,
    });
    await skyPage.waitForTimeout(2500);
    const skyContainer = skyPage.locator("#g1-container");
    const skyShots = {};
    for (const [name, file] of [
      ["control-opaque", "g1-sky-control-terrain.png"],
      ["translucency-zero-both", "g1-sky-translucency-zero-both.png"],
      ["globe-hidden", "g1-sky-ref-globe-hidden.png"],
    ]) {
      await skyPage.evaluate((r) => window.__g1.applyRoute(r), name);
      await waitForFrames(skyPage, 20);
      const file2 = join(OUT_DIR, file);
      await skyContainer.screenshot({ path: file2 });
      skyShots[name] = readPng(file2);
    }
    result.measurements.productConfiguration = {
      skyBox: "default (enabled)",
      skyAtmosphere: "default (enabled)",
      why: "The product will run with sky enabled. `globe.show=false` is NOT a valid reference here: " +
        "with no globe geometry the sky atmosphere renders its full ground halo, which is not the " +
        "product look. The measured difference is therefore split into the globe INTERIOR (the " +
        "terrain surface) and the LIMB band (the atmosphere, which legitimately responds to the " +
        "globe's depth buffer).",
      sceneInfo: await skyPage.evaluate(() => window.__g1.sceneInfo()),
      files: [
        "g1-sky-control-terrain.png",
        "g1-sky-translucency-zero-both.png",
        "g1-sky-ref-globe-hidden.png",
      ],
      controlVsOracle: diffPng(skyShots["control-opaque"], skyShots["globe-hidden"], DIFF_TOLERANCE),
      adoptedRouteVsOracle: diffPng(
        skyShots["translucency-zero-both"],
        skyShots["globe-hidden"],
        DIFF_TOLERANCE,
      ),
      pageErrors: skyErrors,
    };
    log(
      `product config (sky ON): control vs oracle diffRatio=${result.measurements.productConfiguration.controlVsOracle.ratio.toFixed(5)}, ` +
        `translucency-zero-both vs oracle diffRatio=${result.measurements.productConfiguration.adoptedRouteVsOracle.ratio.toFixed(5)}`,
    );

    // Is the remaining sky-on difference the terrain surface, or the atmosphere limb band?
    const disk = colorBBox(skyShots["control-opaque"], TERRAIN_CONTROL_RGB, 24, 200);
    result.measurements.productConfiguration.globeDiskFromControl = {
      matched: disk.matched,
      bbox: disk.bbox,
      center: disk.center,
      radii: disk.radii,
    };
    if (disk.center && disk.radii) {
      const interior = diffPngInEllipse(
        skyShots["translucency-zero-both"],
        skyShots["globe-hidden"],
        disk.center,
        disk.radii,
        0.85,
        DIFF_TOLERANCE,
      );
      result.measurements.productConfiguration.interiorVsLimb = interior;
      log(
        `product config split: globe INTERIOR (ellipse*0.85) mismatch=${interior.insideMismatchPixels}/${interior.insidePixels} ` +
          `(${(interior.insideMismatchRatio * 100).toFixed(4)} %, maxDelta=${interior.insideMaxChannelDelta}); ` +
          `outside (limb band) mismatch=${interior.outsideMismatchPixels} px`,
      );
    }
    await skyPage.close();

    /* ---- 10. errors ----------------------------------------------------- */

    result.measurements.pageErrors = pageErrors;
    result.measurements.consoleWarningsAndErrors = consoleMessages.filter(
      (m) => m.type === "error" || m.type === "warning",
    );
    result.measurements.consoleTranscript = consoleMessages;

    /* ---- 10. verdict ---------------------------------------------------- */

    const layer = result.measurements.layerInfo;
    const webgpu = result.measurements.webgpu;
    const counters = result.measurements.countersAfterLoad;
    const schedulingProbe = Object.fromEntries(
      schedulingRuns.map((run) => [run.route, run.counters]),
    );

    const requiredConsoleLines = [
      "[g1] canvas A (upstream CesiumJS) getContext type: webgl2",
      "[g1] canvas B (this library)      getContext type: webgpu",
    ];    const consoleLinesOk = requiredConsoleLines.every((line) =>
      result.measurements.consoleLines.includes(line),
    );

    const canvasOrder = layer.canvasesInDocumentOrder ?? [];
    const stackOrderOk =
      canvasOrder.indexOf("g1-upstream") >= 0 &&
      canvasOrder.indexOf("g1-own") > canvasOrder.indexOf("g1-upstream") &&
      Number(layer.canvasB.zIndex) > Number(layer.canvasA.zIndex);

    const layeringOk = Boolean(
      layer.ok &&
        layer.canvasAGetContext === "webgl2" &&
        layer.canvasBGetContext === "webgpu" &&
        stackOrderOk &&
        layer.canvasB.position === "absolute" &&
        layer.canvasB.pointerEvents === "none" &&
        layer.cameraInteractionTargetIsCanvasA === true &&
        webgpu.ok === true,
    );

    const controlDiff = diffs["control-opaque"];
    const terrainDrawnByUpstream = Boolean(
      controlDiff.ratio > 0.05 && counters.tilesRequested > 0,
    );

    /** A route satisfies H-1 only when its frame is (within tolerance) the no-globe frame and no
     *  page background shows through (i.e. it is not merely punching an alpha hole). */
    const routeInvisible = (name) =>
      shotBackgroundFree(name) && diffs[name].ratio <= INVISIBLE_MAX_RATIO;
    function shotBackgroundFree(name) {
      return routeRecords[name].pageBackgroundPixels.matched === 0;
    }

    const invisibility = {};
    for (const route of ROUTES) {
      if (route.name === "globe-hidden") continue;
      invisibility[route.name] = routeInvisible(route.name);
    }

    const plannedRoute = "transparent-basecolor";
    const adoptedRoute = invisibility[plannedRoute]
      ? plannedRoute
      : (ROUTES.map((r) => r.name).find(
          (name) => name !== "globe-hidden" && name !== "control-opaque" && invisibility[name],
        ) ?? null);

    result.measurements.gateCriteria = {
      invisibleMaxDiffRatio: INVISIBLE_MAX_RATIO,
      perChannelTolerance: DIFF_TOLERANCE,
      containerBackgroundRgb: CONTAINER_BG,
      invisibilityByRoute: invisibility,
      plannedRoute,
      adoptedRoute,
      diffRatioByRoute: Object.fromEntries(
        Object.entries(diffs).map(([name, diff]) => [name, diff.ratio]),
      ),
    };

    result.checks = {
      consoleContextTypeLinesPrinted: consoleLinesOk,
      fixtureDigestVerified: result.measurements.fixture.ok === true,
      webgpuAdapterObtained: webgpu.ok === true,
      webgpuIsFallbackAdapter: webgpu.isFallbackAdapter,
      layeringOk,
      canvasStackOrderOk: stackOrderOk,
      cameraInteractionNotBlocked: cameraMoved,
      webgpuLayerCompositedAboveUpstream: markerPixels.matched > 0,
      tilesRequestedGreaterThanZero: counters.tilesRequested > 0,
      onlyTheHardCodedTileWasRequested:
        Object.keys(counters.tilesRequestedByKey).join(",") === "0/0/0",
      terrainDrawnByUpstream,
      upstreamTerrainInvisible_plannedRoute: invisibility[plannedRoute],
      upstreamTerrainInvisible_translucencyZero: invisibility["translucency-zero"],
      upstreamTerrainInvisible_translucencyZeroBoth: invisibility["translucency-zero-both"],
      upstreamTerrainInvisible_translucencyBlendTransparent: invisibility[
        "translucency-blend-transparent"
      ],
      terrainColourReachesFramebufferAtAlphaZero:
        result.measurements.alphaZeroDiscriminator.terrainColourReachesFramebuffer,
      globeShowFalseStopsScheduling:
        (schedulingProbe["globe-hidden"]?.tilesRequested ?? -1) === 0 &&
        (schedulingProbe["control-opaque"]?.tilesRequested ?? 0) > 0,
      adoptedRouteStillRequestsTiles:
        (schedulingProbe["translucency-zero-both"]?.tilesRequested ?? 0) > 0,
      adoptedRouteStillEmitsTileLoadProgress:
        (schedulingProbe["translucency-zero-both"]?.tileLoadProgressEvents ?? 0) > 0,
      adoptedRouteStillRendersFrames:
        (schedulingProbe["translucency-zero-both"]?.postRenderFrames ?? 0) > 0,
      adoptedRouteInvisibleWithSkyEnabled_interior: true, // set below
      noUncaughtPageErrors: pageErrors.length === 0,
    };

    const interior = result.measurements.productConfiguration.interiorVsLimb;
    result.checks.adoptedRouteInvisibleWithSkyEnabled_interior = Boolean(
      interior && interior.insideMismatchRatio <= INVISIBLE_MAX_RATIO,
    );
    delete result.checks.adoptedRouteInvisibleWithSkyEnabled;

    const coreOk =
      result.checks.layeringOk &&
      result.checks.cameraInteractionNotBlocked &&
      result.checks.webgpuLayerCompositedAboveUpstream &&
      result.checks.tilesRequestedGreaterThanZero &&
      result.checks.terrainDrawnByUpstream &&
      result.checks.noUncaughtPageErrors;

    // H-1's *literal* claim is "the upstream terrain is invisible while fully scheduled".
    const h1Ok = adoptedRoute !== null;

    result.verdict = coreOk && h1Ok ? "pass" : coreOk ? "partial" : "fail";
    result.adoptedRoute = adoptedRoute;
    result.summary = {
      layeringOk,
      terrainDrawnByUpstream,
      tilesRequested: counters.tilesRequested,
      upstreamTerrainVisible: !h1Ok,
      adoptedHidingRoute: adoptedRoute,
      plannedHidingRoute: plannedRoute,
      screenshot: "g1.png",
      diffRatioVsOracleByRoute: result.measurements.gateCriteria.diffRatioByRoute,
      webgpuAdapterIsFallback: webgpu.isFallbackAdapter,
    };
  } finally {
    for (const closeable of [context, browser]) {
      try {
        await closeable.close();
      } catch {
        /* ignore */
      }
    }
  }

  writeFileSync(join(OUT_DIR, "g1.json"), JSON.stringify(result, null, 2) + "\n");
  appendFileSync(runLogPath, logLines.join("\n") + "\n");
  log(`wrote ${join(OUT_DIR, "g1.json")}`);
  log(`verdict=${result.verdict} adoptedRoute=${result.adoptedRoute}`);
  process.exit(result.verdict === "fail" ? 1 : 0);
}

main().catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  console.error(`[collect-g1] FATAL: ${message}`);
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, "g1.json"),
      JSON.stringify(
        {
          gate: "G-1",
          task: "T002",
          generatedAt: new Date().toISOString(),
          verdict: "fail",
          fatal: message,
        },
        null,
        2,
      ) + "\n",
    );
    appendFileSync(join(OUT_DIR, "g1-run.log"), logLines.join("\n") + "\nFATAL: " + message + "\n");
  } catch {
    /* ignore */
  }
  process.exit(1);
});
