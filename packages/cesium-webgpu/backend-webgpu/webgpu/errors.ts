/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Fail-loud error model of the patch layer (contract render-path-api.md §6, FR-033): a
 * capability outside the current slice MUST raise a diagnosable error. Returning an empty value,
 * a black frame or a silently skipped draw is forbidden — those failure modes are exactly what
 * the constitution's "verifiable rendering" principle (III) cannot catch.
 */

/** Error categories shared by the patch layer and the public diagnostics surface (contract §6). */
export type DiagnosticCategory =
  | "not-implemented"
  | "data-unavailable"
  | "render-failed"
  | "probe-failed"
  | "device-lost"
  | "internal";

/** The backend a diagnostic came from; identical vocabulary to the public `BackendKind`. */
export type DiagnosticBackend = "webgpu" | "webgl2";

/** Structured context attached to a diagnostic (evidence for the failure, never user data). */
export interface DiagnosticDetails {
  /** Upstream module the failure belongs to, e.g. `Renderer/Context.js`. */
  readonly upstreamModule?: string;
  /** Upstream entry point that was reached, e.g. `Context#readPixels`. */
  readonly entryPoint?: string;
  /** Phase of `specs/001-webgpu-terrain-mvp/tasks.md` that delivers the capability. */
  readonly plannedPhase?: string;
  /** Requirement the capability traces to, e.g. `FR-030`. */
  readonly requirementRef?: string;
  /** Extra machine-readable context (counts, ids, …). */
  readonly extra?: Readonly<Record<string, string | number | boolean>>;
}

export interface DiagnosticErrorOptions extends DiagnosticDetails {
  readonly backend?: DiagnosticBackend;
  readonly cause?: unknown;
}

/**
 * The patch layer's diagnostic error.
 *
 * Structurally compatible with the public `DiagnosticError` interface of
 * `src/api/types.ts` (`category` / `message` / `backend?` / `cause?`), so a backend failure can
 * be surfaced through `TerrainSceneHandle.diagnostics.onError` without translation.
 */
export class DiagnosticError extends Error {
  readonly category: DiagnosticCategory;
  readonly backend: DiagnosticBackend | undefined;
  readonly details: DiagnosticDetails;

  constructor(category: DiagnosticCategory, message: string, options: DiagnosticErrorOptions = {}) {
    const { backend, cause, ...details } = options;
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DiagnosticError";
    this.category = category;
    this.backend = backend;
    this.details = details;
  }
}

/** Build (without throwing) a `not-implemented` diagnostic for a capability. */
export function notImplemented(capability: string, options: DiagnosticErrorOptions = {}): DiagnosticError {
  const where = options.entryPoint ?? options.upstreamModule;
  const phase = options.plannedPhase === undefined ? "" : ` It lands in ${options.plannedPhase}.`;
  return new DiagnosticError(
    "not-implemented",
    `${capability} is not implemented in this build${where === undefined ? "" : ` (${where})`}.${phase} ` +
      "The WebGPU backend MUST fail loudly here instead of returning an empty result or a black frame.",
    options,
  );
}

/** Throw a `not-implemented` diagnostic. Every placeholder entry point of this phase uses it. */
export function throwNotImplemented(capability: string, options: DiagnosticErrorOptions = {}): never {
  throw notImplemented(capability, options);
}

/** Narrowing helper — used by the status model and by tests to assert the failure category. */
export function isDiagnosticError(value: unknown): value is DiagnosticError {
  return value instanceof DiagnosticError || (typeof value === "object" && value !== null && typeof (value as { category?: unknown }).category === "string" && (value as { name?: unknown }).name === "DiagnosticError");
}

/** The six categories of the contract, in a stable order (asserted by the unit tests). */
export const DIAGNOSTIC_CATEGORIES: readonly DiagnosticCategory[] = [
  "not-implemented",
  "data-unavailable",
  "render-failed",
  "probe-failed",
  "device-lost",
  "internal",
];
