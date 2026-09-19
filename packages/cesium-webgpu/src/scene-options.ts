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
   *
   * W5 realisation (T089): the composition builds the upstream `Scene` **directly** instead of going
   * through `CesiumWidget`, so these three objects are not merely switched off — they are never
   * constructed at all. `CesiumWidget` would additionally create a `Sun` and a `Moon`, and `Moon`
   * fetches `Assets/Textures/moonSmall.jpg` on construction; that request is an external asset fetch
   * the offline contract (T087, `mode: "fixture"` ⇒ zero external requests) forbids, and its failure
   * surfaces as an uncaught `RequestErrorEvent` (measured, W5 opening probe). The flags stay pinned
   * here and are asserted before composition, so the intent cannot drift even though the mechanism is
   * "do not create them".
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
    /**
     * The logarithmic depth buffer is **pinned off** (W5 measured deviation, see
     * `docs/w5-scene-and-slice-b.md`).
     *
     * `Scene.defaultLogDepthBuffer` is `true` and the capability `fragmentDepth` is `true` on both
     * paths, so an unpinned scene turns log depth ON — and the terrain shaders then carry the
     * `LOG_DEPTH` define. The W4 WGSL emission front-end has no `LOG_DEPTH` region and refuses the
     * define explicitly (`ShaderProgram: the WGSL emission for variant "LOG_DEPTH" was rejected`) —
     * a **loud** failure, never a silent degrade, but it stops the MVP before a single terrain
     * triangle is drawn. Pinning it off is a scene-configuration decision applied to **both** paths
     * identically (principle II/III stay intact: the two runs execute the same configuration), and
     * it is recorded as an out-of-increment shader-closure boundary rather than as a silent downgrade.
     */
    logarithmicDepthBuffer: false,
  },
  /**
   * The globe configuration (T089: `globe.enableLighting = true` is part of the MVP set).
   *
   * `depthTestAgainstTerrain: true` is the second pinned globe value, and it is not cosmetic:
   * `Scene.js:3787-3797` computes `clearGlobeDepth = globe.show && !globe.depthTestAgainstTerrain`
   * and, when it is true, builds and draws the upstream **`DepthPlane`** — a shader pair
   * (`DepthPlaneVS`/`DepthPlaneFS`) that is *not* part of the globe closure. The W4 WGSL emission
   * front-end serves the globe pair only (its family test is "not model/voxel/gaussian-splat", so any
   * other scene program lands in the terrain family and is refused). Pinning the globe to be
   * depth-tested against terrain keeps that program out of the MVP path, and it is the correct
   * setting for a terrain scene in its own right: primitives are tested against the terrain instead of
   * against a hidden depth plane. (Measured in the W5 opening probe: with the upstream default the
   * DepthPlane program was created and refused.)
   */
  globeOptions: {
    enableLighting: true,
    depthTestAgainstTerrain: true,
  },
  /** Camera/terrain determinism inputs shared by both render paths (T116). */
  deterministicConditions: {
    baseLayer: false,
    skyBox: false,
    skyAtmosphere: false,
    postProcess: false,
    logarithmicDepthBuffer: false,
    depthTestAgainstTerrain: true,
    enableLighting: true,
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
  const sceneOptions = (configuration as { sceneOptions?: Record<string, unknown> }).sceneOptions ?? {};
  if (sceneOptions.logarithmicDepthBuffer !== false) {
    drifted.push(
      "sceneOptions.logarithmicDepthBuffer MUST be false: the WGSL closure has no LOG_DEPTH region, so leaving it on " +
        "makes `ShaderProgram` refuse the emission (loud, but no terrain is drawn)",
    );
  }
  const globe = (configuration as { globeOptions?: Record<string, unknown> }).globeOptions ?? {};
  if (globe.enableLighting !== true) drifted.push("globeOptions.enableLighting MUST be true (T089 MVP set)");
  if (globe.depthTestAgainstTerrain !== true) {
    drifted.push(
      "globeOptions.depthTestAgainstTerrain MUST be true: the upstream default builds the `DepthPlane` program, which is " +
        "outside the globe WGSL closure and is therefore refused",
    );
  }
  if (drifted.length > 0) throw new Error(`MVP scene configuration drifted: ${drifted.join("; ")}`);
}

/** The globe values the composition MUST apply, with the reason each one is pinned. */
export const MVP_GLOBE_OPTIONS: { readonly enableLighting: true; readonly depthTestAgainstTerrain: true } = {
  enableLighting: true,
  depthTestAgainstTerrain: true,
};

/** The three flags as a flat record, matching `VerificationRun.fixedConditions` (data-model §7.1). */
export function mvpFixedConditions(): { baseLayer: false; skyBox: false; skyAtmosphere: false } {
  return {
    baseLayer: false,
    skyBox: false,
    skyAtmosphere: false,
  };
}
