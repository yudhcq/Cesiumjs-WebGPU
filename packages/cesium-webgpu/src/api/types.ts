/**
 * Public, backend-agnostic API types (contract render-path-api.md §1).
 *
 * This module is part of the package entry surface: it MUST stay free of any concrete
 * rendering-backend symbol (data-model §11 A1). The only backend vocabulary allowed here is
 * the `BackendKind` configuration value, which callers pass through without inspecting it.
 */

/** The render backend that is active for a whole session; exactly one value is in effect. */
export type BackendKind = "webgpu" | "webgl2";

/** Camera pose for the fixed MVP scene (all angles in degrees, height in metres). */
export interface TerrainCameraOptions {
  longitude: number;
  latitude: number;
  height: number;
  heading?: number;
  pitch?: number;
  roll?: number;
}

/** Fixed viewport, pinned so that captures are reproducible. */
export interface TerrainViewportOptions {
  width: number;
  height: number;
  devicePixelRatio: number;
}

/** Observable render-path state (FR-009). Observation only — business code MUST NOT branch on it. */
export interface RenderPathStatus {
  /** The path that is actually rendering right now. */
  readonly active: BackendKind;
  /** Why this path was chosen (or why the preferred one was abandoned). */
  readonly reason:
    | "ok"
    | "no-navigator-gpu"
    | "no-adapter"
    | "device-request-failed"
    | "missing-feature"
    | "below-limit"
    | "timeout";
  /** True when running in a degraded mode; then `notes` MUST be non-empty (FR-023). */
  readonly degraded: boolean;
  /** Degradation and blind-spot notes, e.g. a software adapter in CI or a temporary capability switch-off. */
  readonly notes: string[];
}

/** Error categories surfaced through `TerrainSceneHandle.diagnostics.onError` (contract §6). */
export interface DiagnosticError {
  /**
   * `not-implemented` — a capability outside the current slice was reached (MUST fail loudly,
   * never return an empty result or a black frame);
   * `data-unavailable` — terrain data missing or unreachable (kept distinct from render failures, FR-004);
   * `render-failed` / `probe-failed` / `device-lost` / `internal` — the remaining lifecycle failures.
   */
  readonly category:
    | "not-implemented"
    | "data-unavailable"
    | "render-failed"
    | "probe-failed"
    | "device-lost"
    | "internal";
  readonly message: string;
  readonly backend?: BackendKind;
  readonly cause?: unknown;
}

/** A single captured frame: RGBA8, top-left origin, not premultiplied (contract §1). */
export interface FrameCapture {
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: "rgba8";
  readonly origin: "top-left";
  readonly premultiplied: false;
  readonly pixels: Uint8Array;
}

/** Numeric frame statistics used by every visual/statistical assertion (data-model §7.1). */
export interface FrameStatistics {
  /** Share of pixels that differ from the background colour, in [0, 1]. */
  nonBackgroundRatio: number;
  /** Number of distinct RGBA values in the frame. */
  uniqueColorCount: number;
  /** Share of neighbouring depth samples that differ by more than the fixed threshold. */
  depthDiscontinuityRatio: number;
  triangleCount: number;
  drawCallCount: number;
  tileCount: number;
  frameTimeMs: { p50: number; p95: number };
}

/** Options accepted by `createTerrainScene` (contract §1). */
export interface TerrainSceneOptions {
  /** Element the scene canvas is mounted into. */
  container: HTMLElement;
  /** Identifier of the pinned, offline terrain dataset. */
  datasetId: string;
  /**
   * Backend preference; defaults to `"auto"`. It is a configuration value only — caller code
   * MUST NOT branch on it (FR-007, contract C-5).
   */
  preference?: BackendKind | "auto";
  camera?: TerrainCameraOptions;
  viewport?: TerrainViewportOptions;
  /** Status observer (FR-009). */
  onStatus?: (status: RenderPathStatus) => void;
}

/** The single handle returned by `createTerrainScene`; behaves identically on every backend. */
export interface TerrainSceneHandle {
  /** Resolves once the scene and terrain are ready; MUST NOT reject (failures go to `diagnostics`). */
  readonly ready: Promise<void>;
  whenTilesLoaded(options?: { timeoutMs?: number }): Promise<{ loaded: boolean; pendingTiles: number }>;
  captureFrame(): Promise<FrameCapture>;
  stats(): FrameStatistics;
  resetStats(): void;
  setView(camera: TerrainSceneOptions["camera"]): void;
  requestRender(): void;
  /** Destroys the active backend and every resource it owns. */
  dispose(): void;
  readonly diagnostics: { onError(callback: (error: DiagnosticError) => void): () => void };
}
