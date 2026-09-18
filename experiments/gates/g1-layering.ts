/**
 * G-1 gate experiment — source of record (tasks.md T001 + T002).
 * ============================================================================
 *
 * QUESTION THIS FILE ANSWERS (the project's single largest architectural risk, research.md §2 / H-1)
 * -------------------------------------------------------------------------------------------------
 *   Can we run two canvases in one container — upstream CesiumJS on WebGL2 underneath, our own
 *   canvas on WebGPU on top — while the upstream terrain stays *fully scheduled* but stays
 *   *invisible*, and while our own `TerrainProvider` subclass feeds upstream real heightmap tiles?
 *
 * HOW THE ANSWER IS MEASURED (all numbers are produced by a real browser run, see collect-g1.mjs)
 * ------------------------------------------------------------------------------------------------
 *   route                      globe.show  baseColor      translucency   expectation
 *   -------------------------  ----------  -------------  -------------  ----------------------------
 *   control-opaque             true        MAGENTA        off            terrain silhouette visible
 *   transparent-basecolor      true        TRANSPARENT    off            candidate A (planned route)
 *   translucency-zero          true        MAGENTA        enabled, a=0   candidate B (research §2 fallback)
 *   globe-hidden               false       (untouched)    off            rendering oracle: no globe at all
 *
 *   `globe-hidden` is the oracle: it is what the frame looks like when *no* globe geometry is drawn.
 *   A hiding technique is only "the upstream terrain is invisible" if the resulting upstream canvas
 *   is pixel-equal to that oracle; a technique that merely paints the terrain in another colour
 *   (or punches an alpha hole) does *not* satisfy H-1 and must be reported as a failure.
 *
 *   `globe-hidden` is used **only as a rendering oracle** — it is never a candidate architecture,
 *   because research.md §1.4 proves `globe.show = false` also stops tile scheduling (and the gate
 *   re-measures that claim: `tilesRequestedWhenGlobeHidden` must be 0).
 *
 * HARD CONSTRAINTS OBSERVED HERE
 * ------------------------------
 *   - No import of anything under this repository's `src/**` (tasks.md T001). The only upstream
 *     dependency is the published `cesium@1.145.0` artifact, resolved by the page's import map.
 *   - Only public CesiumJS API (constitution principle I / research.md §1.1). The `@private`
 *     blacklist of research.md §1.2 is never touched; `experiments/gates/scan-api-usage.mjs`
 *     enforces that mechanically (T003).
 *   - No monkey-patching, no `requestAnimationFrame` loop of our own: our WebGPU submit happens
 *     inside the public `scene.postRender` event (decision D2, research.md §3).
 *
 * The file is TypeScript; `g1-layering.js` next to it is the compiled, served artifact.
 */

import {
  CesiumWidget,
  Color,
  Credit,
  Event,
  GeographicTilingScheme,
  HeightmapTerrainData,
  Rectangle,
  TerrainProvider,
  TileAvailability,
  TileProviderError,
} from "cesium";

/* -------------------------------------------------------------------------- */
/* Fixture contract (must match make-fixture.mjs output)                       */
/* -------------------------------------------------------------------------- */

const FIXTURE_BASE = "./fixtures/g1-level0";

/** Grid edge of the hard-coded terrain tiles (65x65 regular heightmap). */
const GRID = 65;

/**
 * The hard-coded tile set. `GeographicTilingScheme` has TWO level-zero tiles
 * (`getNumberOfXTilesAtLevel(0) === 2`, one row), so covering the visible globe needs both —
 * a fact the gate discovered the hard way (with only x=0 the globe renders as a half disk).
 */
const TILES = [
  { level: 0, x: 0, y: 0, fnv1a32: 0x34e2da31 },
  { level: 0, x: 1, y: 0, fnv1a32: 0x67c65f0e },
] as const;
const FIXTURE_BYTES = GRID * GRID * 4;

function tileKey(level: number, x: number, y: number): string {
  return `${level}/${x}/${y}`;
}

function findTile(level: number, x: number, y: number): (typeof TILES)[number] | undefined {
  return TILES.find((tile) => tile.level === level && tile.x === x && tile.y === y);
}

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

type RouteName =
  | "control-opaque"
  | "transparent-basecolor"
  | "whitealpha-basecolor"
  | "translucency-zero"
  | "translucency-zero-both"
  | "translucency-blend-transparent"
  | "globe-hidden";

const ROUTE_NAMES: RouteName[] = [
  "control-opaque",
  "transparent-basecolor",
  "whitealpha-basecolor",
  "translucency-zero",
  "translucency-zero-both",
  "translucency-blend-transparent",
  "globe-hidden",
];

interface Counters {
  tilesRequested: number;
  tilesRequestedByKey: Record<string, number>;
  tileLoadProgressEvents: number;
  tileLoadProgressSamples: number[];
  tileLoadProgressMin: number | null;
  tileErrors: number;
  postRenderFrames: number;
  webgpuLayerSubmits: number;
}

interface CameraReadout {
  longitudeDeg: number;
  latitudeDeg: number;
  heightM: number;
}

/* -------------------------------------------------------------------------- */
/* Module state                                                                */
/* -------------------------------------------------------------------------- */

const counters: Counters = {
  tilesRequested: 0,
  tilesRequestedByKey: {},
  tileLoadProgressEvents: 0,
  tileLoadProgressSamples: [],
  tileLoadProgressMin: null,
  tileErrors: 0,
  postRenderFrames: 0,
  webgpuLayerSubmits: 0,
};

const uncaught: string[] = [];
const consoleLines: string[] = [];

/** Canvas A snapshots (unpremultiplied RGBA8, top-left origin), filled inside `postRender`. */
const snapshots = new Map<string, { width: number; height: number; data: Uint8ClampedArray }>();

/** Inter-frame intervals observed in `postRender` — coarse cost signal for the route comparison. */
const frameTimesMs: number[] = [];

let fixtureHeights = new Map<string, Float32Array>();
let fixtureVerified: Record<string, unknown> | null = null;

/* -------------------------------------------------------------------------- */
/* T002(b): the custom TerrainProvider — the ONLY legal injection point (D3)   */
/* -------------------------------------------------------------------------- */

/**
 * Feeds upstream CesiumJS a real `HeightmapTerrainData` for exactly one hard-coded tile, from a
 * fixed local fixture. Upstream keeps doing the quadtree scheduling / LOD selection / mesh building
 * / drawing; that is precisely what H-1 needs to stay alive while being made invisible.
 *
 * ⚠ GATE FINDING #1 (see docs/gate-g1-conclusion.md)
 * --------------------------------------------------------------------------
 * `class G1TerrainProvider extends TerrainProvider { constructor() { super(); } }` is IMPOSSIBLE.
 * The published JSDoc for `TerrainProvider` states: *"This type describes an interface and is not
 * intended to be instantiated directly."* — and the constructor really does throw:
 *
 *     DeveloperError: This function defines an interface and should not be called directly.
 *         at new TerrainProvider (cesium/index.js)
 *         at new G1TerrainProvider (g1-layering.js)
 *
 * The injection point is still public and still works; only the *inheritance technique* changes.
 * Cesium's own providers chain through the prototype instead of calling the base constructor, so
 * this file does the same: `Object.create(TerrainProvider.prototype)` plus own properties that
 * shadow the base getters. This touches **no** `@private` member (no `_tilingScheme`,
 * `_availability`, …); it only uses the exported class's public `prototype` object.
 */
interface G1TerrainProvider extends TerrainProvider {
  readonly availability: TileAvailability;
  readonly tilingScheme: GeographicTilingScheme;
  readonly hasWaterMask: boolean;
  readonly hasVertexNormals: boolean;
  readonly ready: boolean;
  readonly credit: Credit;
  readonly errorEvent: Event;
}

interface G1TerrainProviderConstructor {
  new (): G1TerrainProvider;
  readonly prototype: G1TerrainProvider;
}

const G1TerrainProvider = function (this: G1TerrainProvider): void {
  const tilingScheme = new GeographicTilingScheme();
  const availability = new TileAvailability(tilingScheme, 0);
  // One range per tile, in order of increasing level (both tiles are level 0 here).
  for (const tile of TILES) {
    availability.addAvailableTileRange(tile.level, tile.x, tile.y, tile.x, tile.y);
  }
  Object.defineProperties(this, {
    tilingScheme: { value: tilingScheme, enumerable: true },
    availability: { value: availability, enumerable: true },
    hasWaterMask: { value: false, enumerable: true },
    hasVertexNormals: { value: false, enumerable: true },
    ready: { value: true, enumerable: true },
    credit: {
      value: new Credit("G-1 gate: synthetic fixed heightmap (no external data source)"),
      enumerable: true,
    },
    errorEvent: { value: new Event(), enumerable: true },
  });
} as unknown as G1TerrainProviderConstructor;

(G1TerrainProvider as unknown as { prototype: G1TerrainProvider }).prototype = Object.create(
  TerrainProvider.prototype,
) as unknown as G1TerrainProvider;
(G1TerrainProvider.prototype as { constructor: unknown }).constructor = G1TerrainProvider;

G1TerrainProvider.prototype.getLevelMaximumGeometricError = function (level: number): number {
  const radius = (this.tilingScheme as GeographicTilingScheme).ellipsoid.maximumRadius;
  // Level-0 Geographic tile spans pi/2 radians of latitude; one sample step is that over GRID-1.
  return ((Math.PI / 2) * radius) / (GRID - 1) / Math.pow(2, level);
};

G1TerrainProvider.prototype.getTileDataAvailable = function (
  x: number,
  y: number,
  level: number,
): boolean {
  return findTile(level, x, y) !== undefined;
};

G1TerrainProvider.prototype.loadTileDataAvailability = function (): Promise<void> {
  return Promise.resolve();
};

G1TerrainProvider.prototype.requestTileGeometry = function (
  x: number,
  y: number,
  level: number,
): Promise<HeightmapTerrainData | undefined> | undefined {
  // T002(c): the scheduling signal. Every call is the upstream quadtree asking us for a tile.
  counters.tilesRequested += 1;
  const key = tileKey(level, x, y);
  counters.tilesRequestedByKey[key] = (counters.tilesRequestedByKey[key] ?? 0) + 1;

  const heights = fixtureHeights.get(key);
  if (!heights) {
    if (findTile(level, x, y)) {
      counters.tileErrors += 1;
      this.errorEvent.raiseEvent(
        new TileProviderError(
          this,
          `G-1 local heightmap fixture for tile ${key} is not loaded`,
          new Error("fixture-missing"),
        ),
      );
    }
    return undefined;
  }

  // Hand upstream the SAME `HeightmapTerrainData` shape the product will hand it in T031.
  return Promise.resolve(
    new HeightmapTerrainData({
      buffer: heights,
      width: GRID,
      height: GRID,
      childTileMask: 0,
      structure: {
        heightScale: 1.0,
        heightOffset: 0.0,
        elementsPerHeight: 1,
        stride: 1,
        elementMultiplier: 256,
        isBigEndian: false,
        lowestEncodedHeight: 0,
        highestEncodedHeight: 8800,
      },
    }),
  );
};

/* -------------------------------------------------------------------------- */
/* Fixture loading                                                             */
/* -------------------------------------------------------------------------- */

function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] as number;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

async function loadFixture(): Promise<void> {
  const tiles: Record<string, unknown> = {};
  let allOk = true;
  for (const tile of TILES) {
    const key = tileKey(tile.level, tile.x, tile.y);
    const base = `${FIXTURE_BASE}-${tile.x}-${tile.y}`;
    const response = await fetch(`${base}.f32`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`fixture fetch failed for ${key}: ${response.status} ${response.statusText}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = fnv1a(bytes);
    const meta = (await (await fetch(`${base}.json`, { cache: "no-store" })).json()) as {
      fnv1a32Hex?: string;
      bytes?: number;
    };
    const ok =
      bytes.byteLength === FIXTURE_BYTES && digest === tile.fnv1a32 && meta.fnv1a32Hex === toHex(tile.fnv1a32);
    allOk = allOk && ok;
    tiles[key] = {
      bytes: bytes.byteLength,
      fnv1a32Hex: "0x" + digest.toString(16).padStart(8, "0"),
      expectedFnv1a32Hex: toHex(tile.fnv1a32),
      metaFnv1a32Hex: meta.fnv1a32Hex ?? null,
      ok,
    };
    // Copy into an aligned Float32Array (fetched buffers are 4-byte aligned already; be explicit).
    const heights = new Float32Array(bytes.byteLength / 4);
    new Uint8Array(heights.buffer).set(bytes);
    fixtureHeights.set(key, heights);
  }
  fixtureVerified = {
    expectedBytesPerTile: FIXTURE_BYTES,
    tiles,
    ok: allOk,
  };
  if (!allOk) {
    throw new Error(`fixture digest mismatch: ${JSON.stringify(tiles)}`);
  }
}

function toHex(value: number): string {
  return "0x" + (value >>> 0).toString(16).padStart(8, "0");
}

/* -------------------------------------------------------------------------- */
/* T001: dual-canvas layering                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Reports the context type a canvas has ALREADY been initialised with.
 *
 * ⚠ Must only be called once both canvases own a context. `getContext(kind)` CREATES a context of
 * that kind on a canvas that owns none, so probing a still-virgin canvas is destructive: doing that
 * on canvas B before `getContext("webgpu")` permanently denies it a WebGPU context. (This gate hit
 * exactly that trap and it cost a full re-run — hence both the ordering rule and the sanity probe
 * on a throwaway canvas, which is allowed to be destroyed by the query.)
 */
function probeContextType(canvas: HTMLCanvasElement): string | null {
  const asWebgpu = canvas.getContext("webgpu");
  const asWebgl2 = canvas.getContext("webgl2");
  if (asWebgpu && !asWebgl2) {
    return "webgpu";
  }
  if (asWebgl2 && !asWebgpu) {
    return "webgl2";
  }
  if (asWebgl2 && asWebgpu) {
    // Only reachable when the canvas owned nothing and both queries created a context.
    return "webgl2+webgpu(virgin-canvas)";
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* WebGPU layer (canvas B)                                                     */
/* -------------------------------------------------------------------------- */

const MARKER_WGSL = /* wgsl */ `
@vertex
fn vs_main(@location(0) position: vec2f) -> @builtin(position) vec4f {
  return vec4f(position, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(0.0, 1.0, 0.85, 1.0);
}
`;

interface WebgpuLayer {
  ok: boolean;
  reason: string | null;
  adapterInfo: GPUAdapterInfo | null;
  isFallbackAdapter: boolean | null;
  preferredFormat: string | null;
  context: GPUCanvasContext | null;
  device: GPUDevice | null;
}

async function initWebgpuLayer(canvas: HTMLCanvasElement): Promise<WebgpuLayer> {
  const layer: WebgpuLayer = {
    ok: false,
    reason: null,
    adapterInfo: null,
    isFallbackAdapter: null,
    preferredFormat: null,
    context: null,
    device: null,
  };

  if (!navigator.gpu) {
    layer.reason = "navigator.gpu is undefined (WebGPU not exposed in this browser/context)";
    return layer;
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    layer.reason = "navigator.gpu.requestAdapter() returned null (no WebGPU adapter)";
    return layer;
  }
  layer.adapterInfo = adapter.info;
  layer.isFallbackAdapter = adapter.isFallbackAdapter ?? null;

  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) {
    layer.reason = 'canvas.getContext("webgpu") returned null on our own canvas';
    return layer;
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  // Marker triangle: proves the WebGPU layer is composited ABOVE the WebGL2 canvas. It lives in
  // the lower-left corner, outside the measured region used for the terrain-visibility analysis.
  const module = device.createShaderModule({ code: MARKER_WGSL, label: "g1-marker" });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: 8,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        },
      ],
    },
    fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const vertices = device.createBuffer({
    size: 3 * 2 * 4,
    usage: 0x20 | 0x08, // VERTEX | COPY_DST
    mappedAtCreation: true,
  });
  new Float32Array(
    (vertices as unknown as { getMappedRange(): ArrayBuffer }).getMappedRange(),
  ).set([-0.96, -0.96, -0.62, -0.96, -0.96, -0.62]);
  (vertices as unknown as { unmap(): void }).unmap();

  layer.ok = true;
  layer.context = context;
  layer.device = device;
  layer.preferredFormat = format;
  webgpuPipeline = pipeline;
  webgpuVertices = vertices;
  return layer;
}

let webgpuPipeline: unknown = null;
let webgpuVertices: unknown = null;
let markerEnabled = false;

function renderWebgpuLayer(layer: WebgpuLayer): void {
  if (!layer.ok || !layer.context || !layer.device) {
    return;
  }
  const view = layer.context.getCurrentTexture().createView();
  const encoder = layer.device.createCommandEncoder({ label: "g1-frame" });
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view,
        // Fully transparent: everything the WebGPU layer does not draw must reveal canvas A.
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  if (markerEnabled && webgpuPipeline && webgpuVertices) {
    pass.setPipeline(webgpuPipeline);
    pass.setVertexBuffer(0, webgpuVertices);
    pass.draw(3);
  }
  pass.end();
  layer.device.queue.submit([encoder.finish()]);
  counters.webgpuLayerSubmits += 1;
}

/* -------------------------------------------------------------------------- */
/* Pixel readback helpers (measure canvas A only — the upstream layer)         */
/* -------------------------------------------------------------------------- */

function readCanvas(canvas: HTMLCanvasElement): {
  width: number;
  height: number;
  data: Uint8ClampedArray;
} {
  const off = document.createElement("canvas");
  off.width = canvas.width;
  off.height = canvas.height;
  const ctx = off.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("2d readback context unavailable");
  }
  ctx.globalCompositeOperation = "copy";
  ctx.drawImage(canvas, 0, 0);
  return { width: off.width, height: off.height, data: ctx.getImageData(0, 0, off.width, off.height).data };
}

function colorStats(
  snap: { width: number; height: number; data: Uint8ClampedArray },
  rgb: [number, number, number],
  tolerance: number,
  minAlpha: number,
): { matched: number; total: number; ratio: number; opaque: number; transparent: number; meanRgb: [number, number, number] } {
  const { data } = snap;
  let matched = 0;
  let opaque = 0;
  let transparent = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const total = snap.width * snap.height;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] as number;
    const g = data[i + 1] as number;
    const b = data[i + 2] as number;
    const a = data[i + 3] as number;
    sumR += r;
    sumG += g;
    sumB += b;
    if (a >= minAlpha) {
      opaque += 1;
    }
    if (a === 0) {
      transparent += 1;
    }
    if (
      Math.abs(r - rgb[0]) <= tolerance &&
      Math.abs(g - rgb[1]) <= tolerance &&
      Math.abs(b - rgb[2]) <= tolerance &&
      a >= minAlpha
    ) {
      matched += 1;
    }
  }
  return {
    matched,
    total,
    ratio: matched / total,
    opaque,
    transparent,
    meanRgb: [sumR / total, sumG / total, sumB / total],
  };
}

function diffSnapshots(
  a: { width: number; height: number; data: Uint8ClampedArray },
  b: { width: number; height: number; data: Uint8ClampedArray },
  perChannelTolerance = 8,
): { mismatchPixels: number; total: number; ratio: number; maxChannelDelta: number } {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("snapshot size mismatch");
  }
  const total = a.width * a.height;
  let mismatch = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs((a.data[i] as number) - (b.data[i] as number)),
      Math.abs((a.data[i + 1] as number) - (b.data[i + 1] as number)),
      Math.abs((a.data[i + 2] as number) - (b.data[i + 2] as number)),
      Math.abs((a.data[i + 3] as number) - (b.data[i + 3] as number)),
    );
    if (d > maxDelta) {
      maxDelta = d;
    }
    if (d > perChannelTolerance) {
      mismatch += 1;
    }
  }
  return { mismatchPixels: mismatch, total, ratio: mismatch / total, maxChannelDelta: maxDelta };
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                   */
/* -------------------------------------------------------------------------- */

const state = {
  route: "control-opaque" as RouteName,
  canvasAContext: null as string | null,
  canvasBContext: null as string | null,
  webgpu: null as WebgpuLayer | null,
  htmlCanvasContext: null as string | null,
  skyEnabled: false,
  ready: false,
  fatal: null as string | null,
};

let widget: CesiumWidget | null = null;
let canvasA: HTMLCanvasElement | null = null;
let canvasB: HTMLCanvasElement | null = null;

function applyRoute(name: RouteName): void {
  if (!widget) {
    throw new Error("widget not created");
  }
  const { scene } = widget;
  const globe = scene.globe;
  // Reset to the documented defaults first so routes never leak state into each other.
  globe.translucency.enabled = false;
  globe.translucency.frontFaceAlpha = 1.0;
  globe.translucency.backFaceAlpha = 1.0;
  switch (name) {
    case "control-opaque":
      // Reference: what the upstream terrain looks like when it IS meant to be visible.
      globe.show = true;
      globe.baseColor = Color.MAGENTA;
      break;
    case "transparent-basecolor":
      // Candidate A — the route research.md §2 planned on ("terrain fragments output alpha = 0").
      globe.show = true;
      globe.baseColor = Color.TRANSPARENT;
      break;
    case "whitealpha-basecolor":
      // DIAGNOSTIC. Same alpha as TRANSPARENT but a different RGB. If this frame is identical to
      // `transparent-basecolor`, the terrain's colour never reaches the framebuffer (the terrain is
      // genuinely invisible and whatever is left over comes from a different upstream pass);
      // if the frames differ, the terrain really is being painted.
      globe.show = true;
      globe.baseColor = new Color(1.0, 1.0, 1.0, 0.0);
      break;
    case "translucency-zero":
      // Candidate B (research.md §2 / §8 H-1 fallback), front faces only.
      globe.show = true;
      globe.baseColor = Color.MAGENTA;
      globe.translucency.frontFaceAlpha = 0.0;
      globe.translucency.enabled = true;
      break;
    case "translucency-zero-both":
      // Candidate B': both faces at 0 (probes whether the reverse faces are what stays painted).
      globe.show = true;
      globe.baseColor = Color.MAGENTA;
      globe.translucency.frontFaceAlpha = 0.0;
      globe.translucency.backFaceAlpha = 0.0;
      globe.translucency.enabled = true;
      break;
    case "translucency-blend-transparent":
      // Candidate C: keep the terrain's own alpha at 0 AND force the globe into the translucent
      // (alpha-blended) pass, so a zero-alpha fragment must leave the destination untouched.
      globe.show = true;
      globe.baseColor = Color.TRANSPARENT;
      globe.translucency.frontFaceAlpha = 1.0;
      globe.translucency.backFaceAlpha = 1.0;
      globe.translucency.enabled = true;
      break;
    case "globe-hidden":
      // Oracle only — never a candidate architecture (research.md §1.4: this also stops scheduling).
      globe.show = false;
      break;
  }
  state.route = name;
  if (scene.requestRenderMode) {
    scene.requestRender();
  }
}

async function bootstrap(): Promise<void> {
  window.addEventListener("error", (event) => {
    uncaught.push(`error: ${event.message} @${event.filename}:${event.lineno}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    uncaught.push(`unhandledrejection: ${String((event as PromiseRejectionEvent).reason)}`);
  });

  await loadFixture();

  const container = document.getElementById("g1-container");
  if (!container) {
    throw new Error("#g1-container missing");
  }
  const creditHost = document.createElement("div");
  creditHost.style.display = "none";
  container.appendChild(creditHost);

  const provider = new G1TerrainProvider();

  // `?sky=1` restores the product configuration (default sky box + sky atmosphere). The default
  // for the gate is sky-off, so "is the upstream terrain visible?" becomes an exact pixel question
  // instead of an atmospheric-haze judgement call; the collector measures both.
  const skyEnabled = new URLSearchParams(window.location.search).get("sky") === "1";

  // T001: published cesium@1.145.0, alpha-enabled WebGL context, no imagery layer.
  widget = new CesiumWidget(container, {
    baseLayer: false,
    terrainProvider: provider,
    skyBox: skyEnabled ? undefined : false,
    skyAtmosphere: skyEnabled ? undefined : false,
    contextOptions: { webgl: { alpha: true } },
    useBrowserRecommendedResolution: false,
    resolutionScale: 1,
    requestRenderMode: false,
    creditContainer: creditHost,
  });
  state.skyEnabled = skyEnabled;

  const { scene } = widget;
  scene.backgroundColor = new Color(0.07, 0.1, 0.18, 1.0);
  scene.globe.enableLighting = false;

  // Deterministic framing: a fixed geographic rectangle, so both the terrain silhouette and the
  // limb stay in a stable place across every route capture.
  scene.camera.setView({ destination: Rectangle.fromDegrees(-45, -30, 45, 30) });

  // Optional `?route=` lets the collector measure scheduling under different globe states from
  // frame 0 (used to re-measure research.md §1.4: `globe.show = false` stops tile scheduling).
  const requestedRoute = new URLSearchParams(window.location.search).get("route");
  applyRoute(
    requestedRoute && ROUTE_NAMES.includes(requestedRoute as RouteName)
      ? (requestedRoute as RouteName)
      : "control-opaque",
  );

  canvasA = widget.canvas;
  canvasA.classList.add("g1-upstream");

  // T001: our own canvas, same container, layered above, non-blocking for camera interaction.
  canvasB = document.createElement("canvas");
  canvasB.className = "g1-own";
  canvasB.width = scene.drawingBufferWidth;
  canvasB.height = scene.drawingBufferHeight;
  container.appendChild(canvasB);

  state.webgpu = await initWebgpuLayer(canvasB);

  // Both canvases now own a context, so the (non-destructive) type probe is meaningful.
  state.canvasAContext = probeContextType(canvasA);
  state.canvasBContext = probeContextType(canvasB);
  // Sanity probe on a throwaway canvas: WebGL2 must still be available in this browser/context.
  const probe = document.createElement("canvas");
  state.htmlCanvasContext = probe.getContext("webgl2") ? "webgl2" : "none";

  consoleLines.push(`[g1] canvas A (upstream CesiumJS) getContext type: ${state.canvasAContext}`);
  consoleLines.push(`[g1] canvas B (this library)      getContext type: ${state.canvasBContext}`);
  consoleLines.push(`[g1] sanity probe (throwaway canvas) webgl2 available: ${state.htmlCanvasContext}`);
  for (const line of consoleLines) {
    console.log(line);
  }

  if (state.webgpu.ok) {
    console.log(
      `[g1] WebGPU adapter: ${JSON.stringify({
        vendor: state.webgpu.adapterInfo?.vendor,
        architecture: state.webgpu.adapterInfo?.architecture,
        device: state.webgpu.adapterInfo?.device,
        description: state.webgpu.adapterInfo?.description,
      })} isFallbackAdapter=${state.webgpu.isFallbackAdapter} format=${state.webgpu.preferredFormat}`,
    );
  } else {
    console.warn(`[g1] WebGPU layer unavailable: ${state.webgpu.reason}`);
  }

  // D2: our per-frame submit lives inside the public `postRender` event.
  let lastFrameAt = 0;
  scene.postRender.addEventListener(() => {
    counters.postRenderFrames += 1;
    const now = performance.now();
    if (lastFrameAt > 0) {
      frameTimesMs.push(now - lastFrameAt);
      if (frameTimesMs.length > 4000) {
        frameTimesMs.shift();
      }
    }
    lastFrameAt = now;
    if (state.webgpu) {
      renderWebgpuLayer(state.webgpu);
    }
  });

  // T002(c): upstream's own scheduling signal.
  scene.globe.tileLoadProgressEvent.addEventListener((remaining: unknown) => {
    const value = typeof remaining === "number" ? remaining : Number(remaining);
    counters.tileLoadProgressEvents += 1;
    counters.tileLoadProgressSamples.push(value);
    counters.tileLoadProgressMin =
      counters.tileLoadProgressMin === null ? value : Math.min(counters.tileLoadProgressMin, value);
  });

  applyRoute(state.route);
  state.ready = true;
  console.log(`[g1] ready (route=${state.route})`);
}

/* -------------------------------------------------------------------------- */
/* Control surface used by collect-g1.mjs                                      */
/* -------------------------------------------------------------------------- */

function snapshotCanvasA(tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!widget || !canvasA) {
      reject(new Error("widget not created"));
      return;
    }
    let remove: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      if (remove) {
        remove();
      }
      reject(new Error(`snapshot timeout for ${tag}`));
    }, 5000);
    remove = widget.scene.postRender.addEventListener(() => {
      // Same frame as the upstream draw: the WebGL2 drawing buffer is still readable here.
      window.clearTimeout(timer);
      if (remove) {
        remove();
      }
      try {
        snapshots.set(tag, readCanvas(canvasA as HTMLCanvasElement));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

const g1 = {
  get ready(): boolean {
    return state.ready;
  },
  get fatal(): string | null {
    return state.fatal;
  },
  get uncaught(): string[] {
    return uncaught;
  },
  get consoleLines(): string[] {
    return consoleLines;
  },
  get routes(): RouteName[] {
    return ROUTE_NAMES.slice();
  },
  applyRoute,
  resetCamera(): void {
    if (!widget) {
      throw new Error("widget not created");
    }
    widget.scene.camera.setView({ destination: Rectangle.fromDegrees(-45, -30, 45, 30) });
  },
  setMarker(enabled: boolean): void {
    markerEnabled = enabled;
  },
  counters(): Counters {
    return JSON.parse(JSON.stringify(counters)) as Counters;
  },
  resetCounters(): void {
    counters.tilesRequested = 0;
    counters.tilesRequestedByKey = {};
    counters.tileLoadProgressEvents = 0;
    counters.tileLoadProgressSamples = [];
    counters.tileLoadProgressMin = null;
    counters.tileErrors = 0;
  },
  layerInfo(): Record<string, unknown> {
    if (!widget || !canvasA || !canvasB) {
      return { ok: false };
    }
    const container = document.getElementById("g1-container") as HTMLElement;
    const rectA = canvasA.getBoundingClientRect();
    const rectB = canvasB.getBoundingClientRect();
    const styleB = window.getComputedStyle(canvasB);
    const styleA = window.getComputedStyle(canvasA);
    const probeX = Math.round(rectA.left + rectA.width * 0.5);
    const probeY = Math.round(rectA.top + rectA.height * 0.5);
    const hit = document.elementFromPoint(probeX, probeY);
    // CesiumWidget wraps its canvas in a `div.cesium-widget`, so canvas A is not a direct child of
    // the container. Order the canvases in *document order* instead, and rely on the computed
    // z-index plus the empirical marker capture for the stacking claim.
    const canvasesInDocumentOrder = Array.from(container.querySelectorAll("canvas")).map(
      (element) => element.className,
    );
    const children = Array.from(container.children).map((element) => ({
      tag: element.tagName,
      className: element.className,
    }));
    return {
      ok: true,
      canvasAGetContext: state.canvasAContext,
      canvasBGetContext: state.canvasBContext,
      htmlCanvasGetContext: state.htmlCanvasContext,
      drawingBuffer: [widget.scene.drawingBufferWidth, widget.scene.drawingBufferHeight],
      canvasesInDocumentOrder,
      canvasA: {
        width: canvasA.width,
        height: canvasA.height,
        clientWidth: canvasA.clientWidth,
        clientHeight: canvasA.clientHeight,
        rect: [rectA.left, rectA.top, rectA.width, rectA.height],
        position: styleA.position,
        zIndex: styleA.zIndex,
        pointerEvents: styleA.pointerEvents,
        parentClassName: canvasA.parentElement?.className ?? null,
      },
      canvasB: {
        width: canvasB.width,
        height: canvasB.height,
        clientWidth: canvasB.clientWidth,
        clientHeight: canvasB.clientHeight,
        rect: [rectB.left, rectB.top, rectB.width, rectB.height],
        position: styleB.position,
        zIndex: styleB.zIndex,
        pointerEvents: styleB.pointerEvents,
        parentClassName: canvasB.parentElement?.className ?? null,
      },
      containerChildren: children,
      topmostElementAtCenter: hit ? `${hit.tagName}.${hit.className}` : null,
      cameraInteractionTargetIsCanvasA: hit === canvasA,
      skyEnabled: state.skyEnabled,
    };
  },
  webgpu(): Record<string, unknown> {
    const info = state.webgpu?.adapterInfo ?? null;
    return {
      available: Boolean(navigator.gpu),
      ok: state.webgpu?.ok ?? false,
      reason: state.webgpu?.reason ?? null,
      // `GPUAdapterInfo` exposes its fields as prototype getters, so copy them explicitly —
      // JSON.stringify(adapter.info) would silently produce `{}`.
      adapterInfo: info
        ? {
            vendor: info.vendor,
            architecture: info.architecture,
            device: info.device,
            description: info.description,
            subgroupMinSize: info.subgroupMinSize ?? null,
            subgroupMaxSize: info.subgroupMaxSize ?? null,
          }
        : null,
      isFallbackAdapter: state.webgpu?.isFallbackAdapter ?? null,
      preferredFormat: state.webgpu?.preferredFormat ?? null,
      submits: counters.webgpuLayerSubmits,
    };
  },
  fixture(): Record<string, unknown> {
    return { ...(fixtureVerified ?? { ok: false }), expectedBytesPerTile: FIXTURE_BYTES };
  },
  camera(): CameraReadout {
    if (!widget) {
      throw new Error("widget not created");
    }
    const carto = widget.scene.camera.positionCartographic;
    return {
      longitudeDeg: (carto.longitude * 180) / Math.PI,
      latitudeDeg: (carto.latitude * 180) / Math.PI,
      heightM: carto.height,
    };
  },
  globeState(): Record<string, unknown> {
    if (!widget) {
      return { ok: false };
    }
    const globe = widget.scene.globe;
    return {
      show: globe.show,
      tilesLoaded: globe.tilesLoaded,
      translucencyEnabled: globe.translucency.enabled,
      frontFaceAlpha: globe.translucency.frontFaceAlpha,
      backFaceAlpha: globe.translucency.backFaceAlpha,
      baseColor: [globe.baseColor.red, globe.baseColor.green, globe.baseColor.blue, globe.baseColor.alpha],
      terrainProviderIsOurs: globe.terrainProvider instanceof G1TerrainProvider,
      terrainProviderName: globe.terrainProvider?.constructor?.name ?? null,
    };
  },
  async snapshot(tag: string): Promise<void> {
    await snapshotCanvasA(tag);
  },
  colorStats(
    tag: string,
    rgb: [number, number, number],
    tolerance: number,
    minAlpha: number,
  ): Record<string, number> {
    const snap = snapshots.get(tag);
    if (!snap) {
      throw new Error(`no snapshot ${tag}`);
    }
    return colorStats(snap, rgb, tolerance, minAlpha) as unknown as Record<string, number>;
  },
  diffSnapshots(tagA: string, tagB: string, tolerance: number): Record<string, number> {
    const a = snapshots.get(tagA);
    const b = snapshots.get(tagB);
    if (!a || !b) {
      throw new Error(`missing snapshot ${!a ? tagA : tagB}`);
    }
    return diffSnapshots(a, b, tolerance) as unknown as Record<string, number>;
  },
  dropSnapshot(tag: string): void {
    snapshots.delete(tag);
  },
  /** Coarse per-route cost signal: p50/p95 of the interval between consecutive `postRender` events. */
  frameTimeStats(): Record<string, number> {
    if (frameTimesMs.length === 0) {
      return { samples: 0, p50: 0, p95: 0, min: 0, max: 0, mean: 0 };
    }
    const sorted = frameTimesMs.slice().sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
    return {
      samples: sorted.length,
      p50: at(0.5),
      p95: at(0.95),
      min: sorted[0] as number,
      max: sorted[sorted.length - 1] as number,
      mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    };
  },
  resetFrameTimes(): void {
    frameTimesMs.length = 0;
  },
  sceneInfo(): Record<string, unknown> {
    return {
      skyEnabled: state.skyEnabled,
      skyBoxOption: state.skyEnabled ? "default" : false,
      skyAtmosphereOption: state.skyEnabled ? "default" : false,
      canvasSize: [canvasA?.width ?? 0, canvasA?.height ?? 0],
      drawingBuffer: widget ? [widget.scene.drawingBufferWidth, widget.scene.drawingBufferHeight] : null,
      resolutionScale: widget?.resolutionScale ?? null,
      useBrowserRecommendedResolution: widget?.useBrowserRecommendedResolution ?? null,
    };
  },
};

declare global {
  interface Window {
    CESIUM_BASE_URL: string;
    __g1: typeof g1;
  }
}

window.__g1 = g1;

bootstrap().catch((error: unknown) => {
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? "(no stack)"}`
      : String(error);
  state.fatal = detail;
  state.ready = true;
  console.error("[g1] bootstrap failed", detail);
});
