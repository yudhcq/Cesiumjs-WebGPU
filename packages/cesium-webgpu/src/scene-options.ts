/**
 * MVP scene configuration (`packages/cesium-webgpu/src/scene-options.ts`).
 *
 * This module is the **single frozen declaration** of the scene configuration the MVP acceptance path
 * runs with. It exists from W2 on because two things depend on it:
 *
 *   1. architecture rule **A6** (`tools/scripts/check-arch-boundaries.mjs`) requires the
 *      scene-composition module to pin `baseLayer: false`, `skyBox: false` and `skyAtmosphere: false` —
 *      research §1.6 measured that those three flags are what keeps the `ComputeCommand` dispatch count
 *      at **0** (the GPGPU path is slice C and fails loudly, T053);
 *   2. `tests/support/backend-runner.mjs` writes the same three flags into every `VerificationRun`'s
 *      `fixedConditions`, and the contract suites construct the upstream scene from this object, so the
 *      recorded conditions and the executed conditions cannot drift apart.
 *
 * `createTerrainScene` (T089, W5) consumes it; the deterministic-condition freeze (T116, W7) re-asserts
 * every field. Nothing here is backend-specific — the same configuration is used on both render paths,
 * which is what makes a cross-backend comparison meaningful at all.
 *
 * Deliberately NOT exported from `src/index.ts`: the public surface is exactly the contract's symbol set
 * (`tests/unit/public-api-surface.test.mjs`), and this is composition detail, not public API.
 */

/** The pinned terrain-relevant scene configuration (research §1.6, contract render-path-api §1). */
export const MVP_SCENE_CONFIGURATION = {
  /**
   * `baseLayer`, `skyBox` and `skyAtmosphere` are `CesiumWidget` options: the widget creates its own
   * `Scene`, so they MUST be false at composition time.
   */
  widgetOptions: {
    baseLayer: false,
    skyBox: false,
    skyAtmosphere: false,
    /** No post-processing: the post-process stages dispatch compute work the MVP does not implement. */
    postProcessStages: false,
  },
  /** Options handed to the upstream `Scene` itself. */
  sceneOptions: {
    scene3DOnly: true,
    requestRenderMode: false,
    /** `Context` options: alpha-less canvas. `createSceneContext` MUST stay unset so the replacement
     * `Context` is the one constructed (a `createSceneContext` hook would bypass the patch layer). */
    contextOptions: { webgl: { alpha: false } },
  },
  /** Camera/terrain determinism inputs shared by both render paths (T116). */
  deterministicConditions: {
    baseLayer: false,
    skyBox: false,
    skyAtmosphere: false,
    postProcess: false,
  },
} as const;

/**
 * Assert that a configuration object still carries the pinned values.
 *
 * @throws an `Error` naming every field that drifted — a silently relaxed configuration would make the
 *   "zero compute dispatch" argument (research §1.6) unverifiable.
 */
export function assertMvpSceneOptions(configuration = MVP_SCENE_CONFIGURATION): void {
  const widget = (configuration as { widgetOptions?: Record<string, unknown> }).widgetOptions ?? {};
  const drifted: string[] = [];
  for (const flag of ["baseLayer", "skyBox", "skyAtmosphere"] as const) {
    if (widget[flag] !== false) drifted.push(`widgetOptions.${flag} MUST be false (got ${String(widget[flag])})`);
  }
  if (widget.postProcessStages !== false) drifted.push("widgetOptions.postProcessStages MUST be false (no post-processing in the MVP)");
  const contextOptions = (configuration as { sceneOptions?: { contextOptions?: Record<string, unknown> } }).sceneOptions?.contextOptions ?? {};
  if ("createSceneContext" in contextOptions) {
    drifted.push("sceneOptions.contextOptions.createSceneContext MUST stay unset: it would bypass the replacement Context");
  }
  if (drifted.length > 0) throw new Error(`MVP scene configuration drifted: ${drifted.join("; ")}`);
}

/** The three flags as a flat record, matching `VerificationRun.fixedConditions` (data-model §7.1). */
export function mvpFixedConditions(): { baseLayer: false; skyBox: false; skyAtmosphere: false } {
  return {
    baseLayer: false,
    skyBox: false,
    skyAtmosphere: false,
  };
}
