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
 * T089: the body is now the real composition. The scene is built in `./compose/scene-runtime.js`
 * (canvas → upstream `Scene` → `Globe` + the T086 terrain adapter → fixed camera → frame loop),
 * whose only engine references are **production specifiers**; the build-time alias plugin
 * (`tools/rollup-plugin-engine-patch.mjs`) maps them onto the patch layer per manifest, exactly as
 * `src/terrain/source.ts` already does. That indirection is what keeps this file free of any
 * backend symbol while still composing a real scene (architecture rules A1/A2).
 */
import { createTerrainSceneComposition } from "./compose/scene-runtime.js";
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
 * Never throws for a runtime failure and never rejects: the returned handle's `ready` resolves once the
 * scene and its terrain are in place, and every failure is reported through
 * `handle.diagnostics.onError` — terrain data problems as `data-unavailable`, rendering and
 * construction problems as `render-failed`, so the two stay distinguishable (FR-004).
 */
export function createTerrainScene(options: TerrainSceneOptions): TerrainSceneHandle {
  return createTerrainSceneComposition(options, entryDiagnostics(options));
}

/**
 * The capabilities this increment knowingly cannot honour, reported by the entry itself.
 *
 * `preference` is a configuration value the caller passes through without inspecting it (FR-007), but
 * honouring it needs the one-shot capability probe and the whole-backend switch, which land in W6
 * (T099–T101). Until then the scene is composed on whatever path the host provides, and saying so with
 * a `not-implemented` diagnostic is the honest answer instead of silently ignoring the request
 * (FR-033: a capability outside the slice fails loudly).
 */
function entryDiagnostics(options: TerrainSceneOptions): DiagnosticError[] {
  if (options.preference === undefined || options.preference === "auto") return [];
  return [
    {
      category: "not-implemented",
      message:
        `preference "${options.preference}" cannot be enforced yet: the capability probe and the whole-backend ` +
        "switch are W6 (T099–T101), so this session runs on the path the host provides rather than on the " +
        "preferred one. The request is reported instead of being silently ignored.",
    },
  ];
}
