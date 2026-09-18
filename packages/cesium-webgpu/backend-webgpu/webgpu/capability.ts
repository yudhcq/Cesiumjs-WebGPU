/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Capability composition (research §4, data-model §3.1/§3.2, gate G-2, tasks.md T045): the
 * replacement `Context` publishes the flags the upstream logic layer gates on and synthesises
 * `ContextLimits` from the adapter limits. The measured facts this module MUST honour:
 *
 *   - `webgl2: true` means "modern rendering capabilities are available". The name is **historical**:
 *     upstream reads it in 15 logic-layer files (`Core/FeatureDetection.js:392`,
 *     `Core/PixelFormat.js:518`, `Scene/Picking.js:386`, …) to decide whether the modern pipeline
 *     features (integer textures, instancing, MRT, sRGB render targets) may be used. WebGPU provides
 *     the equivalent semantics, so the honest answer is `true`. It is a **capability, not a path
 *     switch**: `MUST NOT` be used to choose between the WebGPU and the WebGL2 backend (that
 *     decision belongs to `src/render-path/**`; research §4 C-1).
 *   - a `false` capability MUST carry non-empty `notes` **and** the upstream branch it triggers
 *     (FR-023 — never a silent downgrade);
 *   - every value MUST record where it came from (adapter limit / adapter feature / fixed choice);
 *   - `depthTexture` is `false` in slice A and `true` in slice B, and
 *     `sliceBComplete === true` implies `depthTexture === true` (data-model §11 A8).
 */
import { DiagnosticError } from "./errors.js";

/** The MVP slice this build composes for (research §7/§8: slice A = WebGPU terrain path, no depth copy). */
export const MVP_SLICE = "A" as const;
export type MvpSlice = "A" | "B";

/** The capability flags the upstream logic layer gates on (research §4, first table). */
export interface BackendCapabilities {
  readonly webgl2: boolean;
  readonly msaa: boolean;
  readonly depthTexture: boolean;
  readonly fragmentDepth: boolean;
  readonly instancedArrays: boolean;
  readonly drawBuffers: boolean;
  readonly elementIndexUint: boolean;
  readonly stencilBuffer: boolean;
  readonly stencilBits: number;
  readonly textureFilterAnisotropic: boolean;
  readonly supportsBasis: boolean;
  readonly colorBufferFloat: boolean;
  readonly colorBufferHalfFloat: boolean;
  readonly floatingPointTexture: boolean;
  readonly halfFloatingPointTexture: boolean;
  readonly textureFloatLinear: boolean;
  readonly textureHalfFloatLinear: boolean;
  readonly standardDerivatives: boolean;
  readonly blendMinmax: boolean;
  readonly vertexArrayObject: boolean;
  readonly antialias: boolean;
  readonly s3tc: boolean;
  readonly pvrtc: boolean;
  readonly astc: boolean;
  readonly etc: boolean;
  readonly etc1: boolean;
  readonly bc7: boolean;
}

/** `ContextLimits` values the backend synthesises for the logic layer (all 23 upstream members). */
export interface ContextLimitsSnapshot {
  readonly maximumTextureSize: number;
  readonly maximumCubeMapSize: number;
  readonly maximum3DTextureSize: number;
  readonly maximumTextureImageUnits: number;
  readonly maximumVertexTextureImageUnits: number;
  readonly maximumCombinedTextureImageUnits: number;
  readonly maximumTextureFilterAnisotropy: number;
  readonly maximumRenderbufferSize: number;
  readonly maximumVertexAttributes: number;
  readonly maximumVaryingVectors: number;
  readonly maximumVertexUniformVectors: number;
  readonly maximumFragmentUniformVectors: number;
  readonly maximumColorAttachments: number;
  readonly maximumDrawBuffers: number;
  readonly maximumSamples: number;
  readonly minimumAliasedLineWidth: number;
  readonly maximumAliasedLineWidth: number;
  readonly minimumAliasedPointSize: number;
  readonly maximumAliasedPointSize: number;
  readonly maximumViewportWidth: number;
  readonly maximumViewportHeight: number;
  readonly highpFloatSupported: boolean;
  readonly highpIntSupported: boolean;
}

/** One composed value together with its provenance and (for `false`) its degradation note. */
export interface CapabilityValue {
  readonly value: boolean | number;
  /** Where the value came from, e.g. `adapter.limits.maxTextureDimension2D` or `fixed:<reason>`. */
  readonly source: string;
  /** What the logic layer does when the value is `false` (mandatory for every `false`). */
  readonly falseBranch: string | null;
}

export interface ComposeOptions {
  readonly slice?: MvpSlice;
  readonly device?: GPUDevice | null;
  readonly limits?: Readonly<Record<string, number>> | null;
  readonly features?: Iterable<string> | null;
  /** `antialias` comes from the canvas context configuration, not from the adapter. */
  readonly antialias?: boolean;
}

export interface ComposedCapabilities {
  readonly slice: MvpSlice;
  readonly sliceBComplete: boolean;
  readonly capabilities: BackendCapabilities;
  readonly limits: ContextLimitsSnapshot;
  readonly provenance: Readonly<Record<string, CapabilityValue>>;
  readonly falseFlags: readonly string[];
  /** Every flag answered `false`, with the upstream branch it selects (FR-023). */
  readonly notes: Readonly<Record<string, string>>;
}

/** Capability flags whose value is a boolean the logic layer gates on (drives `falseFlags`). */
const BOOLEAN_FLAGS: readonly (keyof BackendCapabilities)[] = [
  "webgl2",
  "msaa",
  "depthTexture",
  "fragmentDepth",
  "instancedArrays",
  "drawBuffers",
  "elementIndexUint",
  "stencilBuffer",
  "textureFilterAnisotropic",
  "supportsBasis",
  "colorBufferFloat",
  "colorBufferHalfFloat",
  "floatingPointTexture",
  "halfFloatingPointTexture",
  "textureFloatLinear",
  "textureHalfFloatLinear",
  "standardDerivatives",
  "blendMinmax",
  "vertexArrayObject",
  "antialias",
  "s3tc",
  "pvrtc",
  "astc",
  "etc",
  "etc1",
  "bc7",
];

function featureSet(features: Iterable<string> | null | undefined): ReadonlySet<string> {
  if (features === undefined || features === null) return new Set<string>();
  return new Set<string>([...features]);
}

function limitOf(limits: Readonly<Record<string, number>> | null | undefined, name: string, fallback: number): number {
  const value = limits?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Compose the capability snapshot and the `ContextLimits` values from a real adapter/device.
 *
 * Every entry of the returned `provenance` names the exact WebGPU fact it was derived from; the
 * table is the executable form of research §4 (research's `webgl2` consumer line numbers are
 * corrected by G-2 finding F-2 / research §4 C-1 and are not re-derived here).
 */
export function composeCapabilities(adapter: GPUAdapter | null, options: ComposeOptions = {}): ComposedCapabilities {
  if (adapter === null || adapter === undefined) {
    throw new DiagnosticError(
      "probe-failed",
      "capability composition requires a GPUAdapter: without one there is no honest answer for the " +
        "logic layer's feature gates, and guessing would make the logic layer take the wrong branch " +
        "(research §3). The construction-time whole delegation (plan.md D2-a) handles the no-adapter case.",
      { backend: "webgpu", requirementRef: "FR-030", entryPoint: "capability.composeCapabilities" },
    );
  }
  const slice = options.slice ?? MVP_SLICE;
  const limits = options.limits ?? (adapter.limits as unknown as Readonly<Record<string, number>>);
  const features = featureSet(options.features ?? adapter.features);
  const antialias = options.antialias ?? true;

  const maxTexture2D = limitOf(limits, "maxTextureDimension2D", 8192);
  const maxTexture3D = limitOf(limits, "maxTextureDimension3D", 2048);
  const maxSampledTextures = limitOf(limits, "maxSampledTexturesPerShaderStage", 16);
  const maxVertexAttributes = limitOf(limits, "maxVertexAttributes", 16);
  const maxInterStage = limitOf(limits, "maxInterStageShaderVariables", 16);
  const maxColorAttachments = limitOf(limits, "maxColorAttachments", 8);
  const maxUniformBufferBindingSize = limitOf(limits, "maxUniformBufferBindingSize", 65536);

  /** `min(floor(maxUniformBufferBindingSize / 16), 4096)` — the conservative one-binding cap. */
  const uniformVectors = Math.min(Math.floor(maxUniformBufferBindingSize / 16), 4096);

  const fixed = (value: boolean | number, reason: string): CapabilityValue => ({ value, source: `fixed:${reason}`, falseBranch: null });
  const fromLimits = (name: string, value: number): CapabilityValue => ({ value, source: `adapter.limits.${name}`, falseBranch: null });
  const fromFeatures = (name: string, value: boolean, falseBranch: string): CapabilityValue => ({
    value,
    source: `adapter.features.has("${name}")`,
    falseBranch,
  });

  const compressedSource = "fixed:no compressed texture upload in the MVP";
  const compressedBranch =
    "Scene/Scene.js:1771-1781 probes the compressed-texture families; all false ⇒ the logic layer keeps its uncompressed texture path.";
  const compressed = (): CapabilityValue => ({ value: false, source: compressedSource, falseBranch: compressedBranch });

  const provenance: Record<string, CapabilityValue> = {
    // --- modern-pipeline capabilities (core WebGPU, no adapter query) ---------------------------
    webgl2: fixed(
      true,
      'historical name meaning "a modern GL-equivalent pipeline is available" (integer textures, ' +
        "instancing, MRT, sRGB targets); it is a capability, NOT a path switch (research §4 C-1)",
    ),
    msaa: fixed(true, "WebGPU core guarantees sampleCount 4 (paired with maximumSamples = 4)"),
    fragmentDepth: fixed(true, "WGSL @builtin(frag_depth)"),
    instancedArrays: fixed(true, "WebGPU core: instance step mode in the vertex layout"),
    drawBuffers: fixed(true, "WebGPU core: multiple color attachments per render pass"),
    elementIndexUint: fixed(true, "WebGPU core: uint32 index format"),
    stencilBuffer: fixed(true, "depth24plus-stencil8 → 8 stencil bits"),
    stencilBits: fixed(8, "depth24plus-stencil8 → 8 stencil bits"),
    standardDerivatives: fixed(true, "WGSL core: dpdx/dpdy/fwidth"),
    blendMinmax: fixed(true, 'WebGPU core blend operations include "min"/"max"'),
    vertexArrayObject: fixed(true, "WebGPU core: the vertex layout lives in the render pipeline (no VAO object)"),
    antialias: fixed(antialias, "canvas context configuration (`alpha`/`antialias`), not an adapter fact"),
    colorBufferHalfFloat: fixed(true, "WebGPU core: rgba16float is renderable and blendable"),
    floatingPointTexture: fixed(true, "WebGPU core texture format table: rgba32float/r32float are sampleable"),
    halfFloatingPointTexture: fixed(true, "WebGPU core texture format table: rgba16float is sampleable and filterable"),
    textureHalfFloatLinear: fixed(true, "WebGPU core: rgba16float is filterable"),
    // --- derived from the adapter's optional features -------------------------------------------
    colorBufferFloat: fromFeatures(
      "float32-blendable",
      features.has("float32-blendable"),
      "without float32-blendable the logic layer keeps its non-float framebuffer path (Scene/Scene.js:1661).",
    ),
    textureFloatLinear: fromFeatures(
      "float32-filterable",
      features.has("float32-filterable"),
      "without float32-filterable the sampler path clamps 32-bit float textures to nearest filtering.",
    ),
    // --- slice A: the one temporary degradation (MUST be flipped by slice B / T098a) ------------
    depthTexture: {
      value: slice === "B",
      source: slice === "B" ? "fixed:slice B (offscreen depth texture + depth copy implemented)" : "fixed:slice A（临时降级）",
      falseBranch:
        "Scene/View.js:46 `if (context.depthTexture)` ⇒ GlobeDepth is NOT created; GlobeTranslucencyState.js:222 and " +
        "GroundPrimitive.js:983 take their no-depth-texture branches. Slice B (T098a) MUST flip this to true and re-run the gates.",
    },
    // --- the MVP does not upload compressed textures -------------------------------------------
    textureFilterAnisotropic: {
      value: false,
      source: "fixed:no anisotropic filtering in WebGPU core",
      falseBranch:
        "ContextLimits.maximumTextureFilterAnisotropy = 1 ⇒ the logic layer clamps anisotropy to 1 (a no-op) in the " +
        "sampler creation path (Scene/ImageryLayer.js:1302 reads the limit).",
    },
    supportsBasis: {
      value: false,
      source: "fixed:Basis transcoding targets compressed formats, all of which are false",
      falseBranch: "GltfLoader.js:586 ⇒ the loader keeps its non-Basis path (no transcoder is created).",
    },
    s3tc: compressed(),
    pvrtc: compressed(),
    astc: compressed(),
    etc: compressed(),
    etc1: compressed(),
    bc7: compressed(),
  };

  const capabilities = {} as Record<string, boolean | number>;
  const notes: Record<string, string> = {};
  const falseFlags: string[] = [];
  for (const flag of BOOLEAN_FLAGS) {
    const entry = provenance[flag];
    if (entry === undefined) {
      throw new DiagnosticError(
        "internal",
        `capability composition is missing a provenance entry for "${flag}": every published flag MUST name ` +
          "the WebGPU fact it came from (research §4, T045).",
        { backend: "webgpu", requirementRef: "FR-030", entryPoint: "capability.composeCapabilities" },
      );
    }
    capabilities[flag] = entry.value;
    if (entry.value === false) {
      if (entry.falseBranch === null || entry.falseBranch.length === 0) {
        throw new DiagnosticError(
          "internal",
          `capability "${flag}" is false but declares no upstream branch: a silent downgrade is forbidden (FR-023).`,
          { backend: "webgpu", requirementRef: "FR-023", entryPoint: "capability.composeCapabilities" },
        );
      }
      falseFlags.push(flag);
      notes[flag] = entry.falseBranch;
    }
  }
  const stencilBits = provenance.stencilBits?.value;
  if (typeof stencilBits !== "number") {
    throw new DiagnosticError(
      "internal",
      "capability composition is missing the `stencilBits` companion value of the stencil-buffer flag (research §4).",
      { backend: "webgpu", requirementRef: "FR-030", entryPoint: "capability.composeCapabilities" },
    );
  }
  capabilities.stencilBits = stencilBits;

  const limitsSnapshot: ContextLimitsSnapshot = {
    maximumTextureSize: maxTexture2D,
    maximumCubeMapSize: maxTexture2D,
    maximum3DTextureSize: maxTexture3D,
    maximumTextureImageUnits: maxSampledTextures,
    maximumVertexTextureImageUnits: maxSampledTextures,
    maximumCombinedTextureImageUnits: maxSampledTextures,
    maximumTextureFilterAnisotropy: 1,
    maximumRenderbufferSize: maxTexture2D,
    maximumVertexAttributes: maxVertexAttributes,
    maximumVaryingVectors: maxInterStage,
    maximumVertexUniformVectors: uniformVectors,
    maximumFragmentUniformVectors: uniformVectors,
    maximumColorAttachments: maxColorAttachments,
    maximumDrawBuffers: maxColorAttachments,
    maximumSamples: 4,
    minimumAliasedLineWidth: 1,
    maximumAliasedLineWidth: 1,
    minimumAliasedPointSize: 1,
    maximumAliasedPointSize: 1,
    maximumViewportWidth: maxTexture2D,
    maximumViewportHeight: maxTexture2D,
    highpFloatSupported: true,
    highpIntSupported: true,
  };

  const limitProvenance: Record<string, CapabilityValue> = {
    maximumTextureSize: fromLimits("maxTextureDimension2D", maxTexture2D),
    maximumCubeMapSize: fromLimits("maxTextureDimension2D", maxTexture2D),
    maximum3DTextureSize: fromLimits("maxTextureDimension3D", maxTexture3D),
    maximumTextureImageUnits: fromLimits("maxSampledTexturesPerShaderStage", maxSampledTextures),
    maximumVertexTextureImageUnits: fromLimits("maxSampledTexturesPerShaderStage", maxSampledTextures),
    maximumCombinedTextureImageUnits: fromLimits("maxSampledTexturesPerShaderStage", maxSampledTextures),
    maximumRenderbufferSize: fromLimits("maxTextureDimension2D", maxTexture2D),
    maximumVertexAttributes: fromLimits("maxVertexAttributes", maxVertexAttributes),
    maximumVaryingVectors: fromLimits("maxInterStageShaderVariables", maxInterStage),
    maximumColorAttachments: fromLimits("maxColorAttachments", maxColorAttachments),
    maximumDrawBuffers: fromLimits("maxColorAttachments", maxColorAttachments),
    maximumViewportWidth: fromLimits("maxTextureDimension2D", maxTexture2D),
    maximumViewportHeight: fromLimits("maxTextureDimension2D", maxTexture2D),
    maximumVertexUniformVectors: fixed(uniformVectors, "min(floor(maxUniformBufferBindingSize / 16), 4096)"),
    maximumFragmentUniformVectors: fixed(uniformVectors, "min(floor(maxUniformBufferBindingSize / 16), 4096)"),
    maximumSamples: fixed(4, "WebGPU guarantees 4× MSAA"),
    minimumAliasedLineWidth: fixed(1, "WebGPU has no wide lines"),
    maximumAliasedLineWidth: fixed(1, "WebGPU has no wide lines; RenderState.lineWidth MUST stay 1 (T049)"),
    minimumAliasedPointSize: fixed(1, "WebGPU point size is 1"),
    maximumAliasedPointSize: fixed(1, "WebGPU point size is 1"),
    maximumTextureFilterAnisotropy: fixed(1, "no anisotropic filtering"),
    highpFloatSupported: fixed(true, "WGSL float32 is highp; there is no reduced-precision fragment path"),
    highpIntSupported: fixed(true, "WGSL i32/u32 are 32-bit in the fragment stage"),
  };

  const composed: ComposedCapabilities = {
    slice,
    sliceBComplete: slice === "B",
    capabilities: capabilities as unknown as BackendCapabilities,
    limits: limitsSnapshot,
    provenance: { ...provenance, ...limitProvenance },
    falseFlags,
    notes,
  };
  assertSliceConsistency(composed.capabilities, composed.sliceBComplete);
  return composed;
}

/**
 * The slice-B consistency invariant (data-model §11 A8): a completed slice B MUST have the depth
 * texture capability. Kept as a real predicate so it can be asserted without the backend. The slice
 * profiles below carry `notes` for every switched-off capability (FR-023) and are read by the
 * static architecture scan (rule A8).
 */
export function assertSliceConsistency(capabilities: Pick<BackendCapabilities, "depthTexture">, sliceBComplete: boolean): void {
  if (sliceBComplete && capabilities.depthTexture !== true) {
    throw new Error("slice-B consistency violated: sliceBComplete === true requires depthTexture === true (data-model §11 A8)");
  }
}

/**
 * The two capability profiles of this increment (data-model §3.1, §11 A8).
 *
 * Slice A ships with the depth-texture capability switched off — a **temporary, declared**
 * degradation whose reason MUST be recorded in `notes` (FR-023); slice B turns it on. The
 * consistency rule "a completed slice B implies `depthTexture`" is expressed here as data — so the
 * architecture scan (A8) can read it — and enforced by `assertSliceConsistency` above.
 */
export const SLICE_PROFILES = {
  sliceA: {
    sliceBComplete: false,
    depthTexture: false,
    notes: ["depthTexture temporarily off (slice A): the offscreen depth attachment lands in slice B (T098a)"],
  },
  sliceB: {
    sliceBComplete: true,
    depthTexture: true,
    notes: [],
  },
} as const;

/** The 23 `ContextLimits` backing-field names, in publication order (the kept upstream module). */
export const CONTEXT_LIMITS_MEMBERS: readonly (keyof ContextLimitsSnapshot)[] = [
  "maximumTextureSize",
  "maximumCubeMapSize",
  "maximum3DTextureSize",
  "maximumTextureImageUnits",
  "maximumVertexTextureImageUnits",
  "maximumCombinedTextureImageUnits",
  "maximumTextureFilterAnisotropy",
  "maximumRenderbufferSize",
  "maximumVertexAttributes",
  "maximumVaryingVectors",
  "maximumVertexUniformVectors",
  "maximumFragmentUniformVectors",
  "maximumColorAttachments",
  "maximumDrawBuffers",
  "maximumSamples",
  "minimumAliasedLineWidth",
  "maximumAliasedLineWidth",
  "minimumAliasedPointSize",
  "maximumAliasedPointSize",
  "maximumViewportWidth",
  "maximumViewportHeight",
  "highpFloatSupported",
  "highpIntSupported",
];

/**
 * Publish the composed values into the **kept** upstream `Renderer/ContextLimits.js` module.
 *
 * Upstream reads them through module-level getters (`ContextLimits.js:32-330`), so the replacement
 * writes the backing fields `_<member>` during its constructor — before any logic-layer read. The
 * function is exported (rather than inlined in `Context.ts`) so the unit test can assert that all
 * 23 members are written and that a missing member is reported instead of silently skipped.
 *
 * @returns the member names that were written.
 */
export function applyContextLimits(
  limits: ContextLimitsSnapshot,
  target: Record<string, unknown>,
): readonly string[] {
  const written: string[] = [];
  for (const member of CONTEXT_LIMITS_MEMBERS) {
    const backing = `_${member}`;
    if (!(backing in target)) {
      throw new DiagnosticError(
        "internal",
        `ContextLimits publication failed: the kept upstream module has no backing field "${backing}". ` +
          "Every one of the 23 members MUST be published during Context construction (research §4, G-2 check " +
          '"context-limits-written-to-kept-upstream-module").',
        { backend: "webgpu", upstreamModule: "Renderer/ContextLimits.js", requirementRef: "FR-030", entryPoint: "capability.applyContextLimits" },
      );
    }
    target[backing] = limits[member];
    written.push(backing);
  }
  return written;
}
