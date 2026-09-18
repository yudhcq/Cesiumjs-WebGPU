/**
 * Public error vocabulary (contract render-path-api.md §6, data-model §2.5).
 *
 * The runtime counterpart of the `DiagnosticError` interface declared in `./types.js`: callers
 * receive errors through `TerrainSceneHandle.diagnostics.onError`, and every one of them MUST be
 * diagnosable — an error that is swallowed or reduced to an empty result violates FR-033.
 *
 * This module is part of the package's public API surface: it MUST stay backend-agnostic
 * (rule A1) and MUST NOT import the patch layer (rule A2).
 */
import type { BackendKind } from "./types.js";

/**
 * The six error categories of the contract. `not-implemented` is the one that carries the
 * "fail loudly" discipline: a capability outside the current slice MUST raise it rather than
 * return an empty value or a black frame.
 */
export type DiagnosticCategory =
  | "not-implemented"
  | "data-unavailable"
  | "render-failed"
  | "probe-failed"
  | "device-lost"
  | "internal";

/** Stable ordering used by the docs, the status filter and the unit tests. */
export const DIAGNOSTIC_CATEGORIES: readonly DiagnosticCategory[] = [
  "not-implemented",
  "data-unavailable",
  "render-failed",
  "probe-failed",
  "device-lost",
  "internal",
];

/** Fields accepted when constructing a diagnostic. */
export interface DiagnosticInit {
  readonly category: DiagnosticCategory;
  readonly message: string;
  readonly backend?: BackendKind;
  readonly cause?: unknown;
}

/**
 * A diagnosable failure.
 *
 * Structurally identical to the public `DiagnosticError` interface (`category` / `message` /
 * `backend?` / `cause?`) and a real `Error`, so it can be thrown, logged and asserted on.
 */
export class DiagnosticError extends Error {
  readonly category: DiagnosticCategory;
  readonly backend: BackendKind | undefined;
  readonly cause: unknown;

  constructor(init: DiagnosticInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "DiagnosticError";
    this.category = init.category;
    this.backend = init.backend;
    this.cause = init.cause;
  }
}

/** Build a `not-implemented` diagnostic (the fail-loud path of FR-033). */
export function notImplemented(message: string, options: { backend?: BackendKind; cause?: unknown } = {}): DiagnosticError {
  return new DiagnosticError({ category: "not-implemented", message, ...options });
}

/** Build a `data-unavailable` diagnostic (terrain data missing, kept distinct from render failures). */
export function dataUnavailable(message: string, options: { backend?: BackendKind; cause?: unknown } = {}): DiagnosticError {
  return new DiagnosticError({ category: "data-unavailable", message, ...options });
}

/** Narrowing helper for consumers that receive `unknown` (event handlers, promise rejections). */
export function isDiagnosticError(value: unknown): value is DiagnosticError {
  if (value instanceof DiagnosticError) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { name?: unknown; category?: unknown; message?: unknown };
  return candidate.name === "DiagnosticError" && typeof candidate.category === "string" && typeof candidate.message === "string";
}

/**
 * Normalise any thrown value into a diagnostic.
 *
 * Nothing is dropped: an unknown thrown value becomes an `internal` diagnostic that keeps the
 * original value as `cause` — "never silently swallowed" (T038, FR-033).
 */
export function toDiagnosticError(error: unknown, options: { backend?: BackendKind; message?: string } = {}): DiagnosticError {
  if (isDiagnosticError(error)) return error;
  const cause = error;
  const message = options.message ?? (error instanceof Error ? error.message : `non-error value thrown: ${String(error)}`);
  return new DiagnosticError({ category: "internal", message, ...options, cause });
}
