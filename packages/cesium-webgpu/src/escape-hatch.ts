/**
 * Optional `./escape-hatch` sub-entry (contract render-path-api.md §4).
 *
 * Purpose: let verification code reach the upstream objects behind a handle for diagnostics.
 * Referencing this entry **exits the isomorphism guarantee** — it is a test-only escape door —
 * therefore the main entry MUST NOT re-export it (contract C-6, asserted by
 * `tools/scripts/check-arch-boundaries.mjs` rule A1 and `tests/unit/public-api-surface.test.mjs`).
 *
 * PHASE 1 SKELETON: the accessor below only fails loudly; it is wired to the real backend in
 * the user-story phases, once `createTerrainScene` produces a live handle.
 */
import type { DiagnosticError, TerrainSceneHandle } from "./api/types.js";

/** Upstream objects needed for diagnostics; typed loosely on purpose (test-only surface). */
export interface UpstreamDiagnostics {
  /** The upstream scene object, or `undefined` when the active backend has none. */
  readonly scene: unknown;
  /** The upstream render backend/context object used by the active path. */
  readonly context: unknown;
}

/**
 * Read the upstream objects behind a handle.
 *
 * @throws an `Error` carrying a `not-implemented` diagnostic until the compose layer lands.
 */
export function getUpstreamDiagnostics(handle: TerrainSceneHandle): UpstreamDiagnostics {
  const diagnostic: DiagnosticError = {
    category: "not-implemented",
    message:
      "getUpstreamDiagnostics is not implemented yet: the escape hatch is wired in the user-story phases " +
      "of specs/001-webgpu-terrain-mvp.",
  };
  void handle;
  throw Object.assign(new Error(diagnostic.message), diagnostic);
}
