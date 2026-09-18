/**
 * Package entry — the one and only public surface of `cesium-webgpu`.
 *
 * Invariants enforced by `tools/scripts/check-arch-boundaries.mjs` (rule A1) and by
 * `tests/unit/public-api-surface.test.mjs`:
 *   - no concrete rendering-backend type, device handle or patch-layer path may appear here
 *     or in the emitted `dist/index.d.ts`;
 *   - the exported symbol set is exactly the one listed in contract render-path-api.md §1;
 *   - the optional `./escape-hatch` sub-entry is NOT re-exported from here (contract C-6).
 *
 * PHASE 1 SKELETON: `createTerrainScene` only validates nothing and fails loudly. The real
 * composition (capability probe → backend choice → terrain adapters → whole-backend switch)
 * lands in the user-story phases; until then the entry raises a `not-implemented` diagnostic
 * instead of handing back a handle that would silently never render (FR-033).
 */
import type { DiagnosticError, TerrainSceneHandle, TerrainSceneOptions } from "./api/types.js";

export type {
  BackendKind,
  DiagnosticError,
  FrameCapture,
  FrameStatistics,
  RenderPathStatus,
  TerrainSceneHandle,
  TerrainSceneOptions,
} from "./api/types.js";

/**
 * Create the terrain scene on the selected backend.
 *
 * @throws an `Error` carrying the `DiagnosticError` fields while the implementation is not
 *   in place (category `not-implemented`).
 */
export function createTerrainScene(options: TerrainSceneOptions): TerrainSceneHandle {
  const diagnostic: DiagnosticError = {
    category: "not-implemented",
    message:
      "createTerrainScene is not implemented yet: this build only contains the Phase 1 skeleton " +
      "(package entry, public types, tooling). The render path, terrain adapters and handle land in the " +
      "user-story phases of specs/001-webgpu-terrain-mvp.",
  };
  void options;
  throw Object.assign(new Error(diagnostic.message), diagnostic);
}
