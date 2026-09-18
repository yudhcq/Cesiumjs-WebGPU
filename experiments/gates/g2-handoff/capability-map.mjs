/**
 * G-2 gate — capability flags and `ContextLimits` composition (machine-readable research §4).
 *
 * This module is the **executable form of research.md §4** ("决策 D3：能力标志与 `ContextLimits`
 * 合成"): the flag table, the `ContextLimits` mapping table and the composition function that
 * derives every value from a real `GPUAdapter`/`GPUDevice`. It is deliberately dependency-free and
 * realm-agnostic so that
 *   - the gate page (`probe.js`) can compose capabilities from the real prefetched device, and
 *   - `tests/unit/capability-mapping.test.mjs` (tasks.md T017) can assert the mapping **without**
 *     a GPU: every `adapter.limits.*` source MUST name a real `GPUSupportedLimits` member of
 *     `@webgpu/types`, every `adapter.features.has("…")` source MUST name a real `GPUFeatureName`,
 *     `maximumSamples` MUST be `>= 4`, and every capability answered `false` MUST carry `notes`
 *     plus a declared *unimplemented branch* (MUST NOT 虚报 `true` — research §4).
 *
 * `MVP_SLICE = "A"` is the reason `depthTexture` is `false` here: slice A has no offscreen depth
 * texture / depth copy yet (research §4 + §8). The flip to `true` belongs to slice B (T098a) and
 * MUST re-run this gate — see the `depthTexture` entry's `notes`.
 */

/** The MVP slice this table describes (research §7 / §8: slice A = WebGPU terrain path, no depth copy). */
export const MVP_SLICE = "A";

/**
 * Capability (`Context` member) table — one entry per flag research §4 names.
 *
 * `kind`:
 *   - `constant`         — fixed by the WebGPU specification for the MVP (no adapter query needed);
 *   - `derived-limits`   — computed from `GPUAdapter.limits` (`derive(limits)`);
 *   - `derived-features` — computed from `GPUAdapter.features` (`derive(features)`);
 *   - `unimplemented`    — deliberately `false` because the MVP does not implement the capability;
 *                          `notes` + `unimplementedBranch` are mandatory and the logic layer takes
 *                          its own existing degradation branch.
 */
export const FLAG_TABLE = [
  {
    name: "webgl2",
    value: true,
    kind: "constant",
    source: "WebGPU core: modern pipeline (integer textures, instancing, MRT, sRGB targets)",
    researchRef: "§4 row 1",
    consumers: [
      "Core/FeatureDetection.js:392",
      "Core/PixelFormat.js:518",
      "Scene/Scene.js:3905 (research §4 — NOT reproducible in 26.3.0, see gate deviations)",
    ],
    notes:
      "The historical meaning of this flag is \"a modern GL pipeline is available\"; WebGPU provides the " +
      "equivalent semantics. The production replacement MUST carry a comment saying so (T045).",
    unimplementedBranch: null,
  },
  {
    name: "msaa",
    value: true,
    kind: "constant",
    source: "WebGPU core guarantees 4x MSAA (sampleCount 1|4)",
    researchRef: "§4 row 2",
    consumers: ["Scene/Scene.js:1721 (Scene#msaaSupported getter)"],
    notes: "WebGPU guarantees sampleCount 4; no adapter query is required (paired with maximumSamples = 4).",
    unimplementedBranch: null,
  },
  {
    name: "depthTexture",
    value: false,
    kind: "unimplemented",
    source: "slice A: no offscreen depth texture / depth copy implemented yet",
    researchRef: "§4 row 3 (切片 A：false（临时）；切片 B：true)",
    consumers: ["Scene/View.js:46 (GlobeDepth creation)", "Scene/GlobeTranslucencyState.js:222", "Scene/GroundPrimitive.js:983"],
    notes:
      "TEMPORARY slice-A degradation: with depthTexture=false the View does not create GlobeDepth " +
      "(View.js:46), so no depth texture/copy is required. Slice B (T098a) MUST flip this to true and " +
      "re-run this gate; the flip is registered in plan Complexity Tracking and MUST NOT become permanent.",
    unimplementedBranch:
      "Scene/View.js:46 `if (context.depthTexture)` → GlobeDepth is NOT created; GlobeTranslucencyState.js:222 " +
      "and GroundPrimitive.js:983 take their existing no-depth-texture branches. Asserted in G-2 by the " +
      "consequence probe: the whole Scene construction completes with ZERO WebGL context acquisitions.",
  },
  {
    name: "fragmentDepth",
    value: true,
    kind: "constant",
    source: "WGSL `@builtin(frag_depth)`",
    researchRef: "§4 row 4",
    consumers: ["Scene/Scene.js:195 (→ _logDepthBuffer)", "Scene/EllipsoidPrimitive.js:282"],
    notes: "true ⇒ Scene.js:195 sets _logDepthBuffer (Scene.defaultLogDepthBuffer) and Scene.js:723-726 sets camera near/far.",
    unimplementedBranch: null,
  },
  {
    name: "instancedArrays",
    value: true,
    kind: "constant",
    source: "WebGPU core: instance step mode in the vertex layout",
    researchRef: "§4 row 5",
    consumers: ["Scene/CloudCollection.js:955", "Scene/GltfLoader.js:1462"],
    notes: "Native instancing; no extension required.",
    unimplementedBranch: null,
  },
  {
    name: "drawBuffers",
    value: true,
    kind: "constant",
    source: "WebGPU core: multiple color attachments per render pass (maxColorAttachments)",
    researchRef: "§4 row 6",
    consumers: ["Scene/OIT.js:32"],
    notes: "Native MRT; the actual attachment count comes from ContextLimits.maximumDrawBuffers.",
    unimplementedBranch: null,
  },
  {
    name: "colorBufferFloat",
    value: true,
    kind: "derived-features",
    feature: "float32-blendable",
    derive: (features) => features.has("float32-blendable"),
    source: 'adapter.features.has("float32-blendable")',
    researchRef: "§4 row 7",
    consumers: ["Scene/Scene.js:1661", "Scene/OIT.js:31"],
    notes:
      "Adopted as the *blendable* 32-bit float capability so the logic layer's float framebuffer paths " +
      "(globe depth / OIT) are only taken when the device can actually blend them.",
    unimplementedBranch: null,
    falseBranch: "without float32-blendable the logic layer keeps its non-float framebuffer path (Scene.js:1661 → false).",
  },
  {
    name: "colorBufferHalfFloat",
    value: true,
    kind: "constant",
    source: "WebGPU core: rgba16float is renderable and blendable",
    researchRef: "§4 row 7",
    consumers: ["Scene/Scene.js:1661 (half-float arm)"],
    notes: "16-bit float render targets need no optional feature in WebGPU.",
    unimplementedBranch: null,
  },
  {
    name: "floatingPointTexture",
    value: true,
    kind: "constant",
    source: "WebGPU core texture format table: rgba32float / r32float are sampleable",
    researchRef: "§4 row 8",
    consumers: ["Scene/BatchTable.js:90", "Scene/GlobeDepth.js:281"],
    notes: "Linear filtering of 32-bit float textures is a separate flag (textureFloatLinear ← float32-filterable).",
    unimplementedBranch: null,
  },
  {
    name: "halfFloatingPointTexture",
    value: true,
    kind: "constant",
    source: "WebGPU core texture format table: rgba16float is sampleable and filterable",
    researchRef: "§4 row 8",
    consumers: ["Scene/GlobeDepth.js:281 (half-float arm)"],
    notes: "No optional feature required.",
    unimplementedBranch: null,
  },
  {
    name: "stencilBuffer",
    value: true,
    kind: "constant",
    source: "WebGPU core: depth24plus-stencil8 (8 stencil bits)",
    researchRef: "§4 row 9",
    consumers: ["Scene/Scene.js:2870", "Scene/Scene.js:3064", "Scene/Scene.js:3075"],
    notes: "stencilBits = 8 is published together with this flag.",
    unimplementedBranch: null,
  },
  {
    name: "stencilBits",
    value: 8,
    kind: "constant",
    source: "depth24plus-stencil8 → 8 stencil bits",
    researchRef: "§4 row 9",
    consumers: ["Scene/Scene.js:2870 (stencil clear path)"],
    notes: "Companion value of the stencilBuffer flag.",
    unimplementedBranch: null,
  },
  {
    name: "elementIndexUint",
    value: true,
    kind: "constant",
    source: "WebGPU core: uint32 index format",
    researchRef: "§4 row 10",
    consumers: ["Scene/Primitive.js:1263"],
    notes: "Native 32-bit indices.",
    unimplementedBranch: null,
  },
  {
    name: "textureFilterAnisotropic",
    value: false,
    kind: "unimplemented",
    source: "no anisotropic filtering in WebGPU core",
    researchRef: "§4 row 11",
    consumers: ["Scene/Scene.js (maximumTextureFilterAnisotropy)"],
    notes: "WebGPU has no anisotropic sampler; the logic layer already has a non-anisotropic path.",
    unimplementedBranch:
      "ContextLimits.maximumTextureFilterAnisotropy = 1 ⇒ the logic layer requests anisotropy 1 (no-op) — " +
      "the existing `maximumTextureFilterAnisotropy` clamp in the sampler creation path.",
  },
  {
    name: "s3tc",
    value: false,
    kind: "unimplemented",
    source: "compressed texture upload not implemented in the MVP",
    researchRef: "§4 row 12",
    consumers: ["Scene/Scene.js:1771-1781 (compressed-texture family probe)"],
    notes: "No compressed texture family is uploaded in the MVP; all six family flags are false so the logic layer takes its uncompressed path.",
    unimplementedBranch: "Scene.js:1771-1781 → all family probes false ⇒ the logic layer keeps its uncompressed texture path.",
  },
  {
    name: "pvrtc",
    value: false,
    kind: "unimplemented",
    source: "compressed texture upload not implemented in the MVP",
    researchRef: "§4 row 12",
    consumers: ["Scene/Scene.js:1771-1781"],
    notes: "See s3tc.",
    unimplementedBranch: "Scene.js:1771-1781 → false ⇒ uncompressed path.",
  },
  {
    name: "astc",
    value: false,
    kind: "unimplemented",
    source: "compressed texture upload not implemented in the MVP",
    researchRef: "§4 row 12",
    consumers: ["Scene/Scene.js:1771-1781"],
    notes: "See s3tc.",
    unimplementedBranch: "Scene.js:1771-1781 → false ⇒ uncompressed path.",
  },
  {
    name: "etc",
    value: false,
    kind: "unimplemented",
    source: "compressed texture upload not implemented in the MVP",
    researchRef: "§4 row 12",
    consumers: ["Scene/Scene.js:1771-1781"],
    notes: "See s3tc.",
    unimplementedBranch: "Scene.js:1771-1781 → false ⇒ uncompressed path.",
  },
  {
    name: "etc1",
    value: false,
    kind: "unimplemented",
    source: "compressed texture upload not implemented in the MVP",
    researchRef: "§4 row 12",
    consumers: ["Scene/Scene.js:1771-1781"],
    notes: "See s3tc.",
    unimplementedBranch: "Scene.js:1771-1781 → false ⇒ uncompressed path.",
  },
  {
    name: "bc7",
    value: false,
    kind: "unimplemented",
    source: "compressed texture upload not implemented in the MVP",
    researchRef: "§4 row 12",
    consumers: ["Scene/Scene.js:1771-1781"],
    notes: "See s3tc.",
    unimplementedBranch: "Scene.js:1771-1781 → false ⇒ uncompressed path.",
  },
  {
    name: "supportsBasis",
    value: false,
    kind: "unimplemented",
    source: "Basis transcoding depends on compressed texture families (all false)",
    researchRef: "§4 row 13",
    consumers: ["Scene/GltfLoader.js:586"],
    notes: "Basis/KTX2 transcoding targets compressed formats; not implemented in the MVP.",
    unimplementedBranch: "GltfLoader.js:586 → false ⇒ the loader keeps its non-Basis path (no transcoder is created).",
  },
  {
    name: "standardDerivatives",
    value: true,
    kind: "constant",
    source: "WGSL core: dpdx/dpdy/fwidth",
    researchRef: "§4 row 14 (no external consumer)",
    consumers: [],
    notes: "No external consumer in §1.3; internal implementation freedom.",
    unimplementedBranch: null,
  },
  {
    name: "blendMinmax",
    value: true,
    kind: "constant",
    source: 'WebGPU core blend operations include "min"/"max"',
    researchRef: "§4 row 14 (no external consumer)",
    consumers: [],
    notes: "No external consumer; min/max blend operations exist in core WebGPU.",
    unimplementedBranch: null,
  },
  {
    name: "textureFloatLinear",
    value: false,
    kind: "derived-features",
    feature: "float32-filterable",
    derive: (features) => features.has("float32-filterable"),
    source: 'adapter.features.has("float32-filterable")',
    researchRef: "§4 row 14 (no external consumer)",
    consumers: [],
    notes: "Linear filtering of 32-bit float textures; derived from the optional feature rather than assumed.",
    unimplementedBranch: "no external consumer; when false the sampler creation path clamps to nearest filtering for 32-bit float textures.",
  },
  {
    name: "textureHalfFloatLinear",
    value: true,
    kind: "constant",
    source: "WebGPU core: rgba16float is filterable",
    researchRef: "§4 row 14 (no external consumer)",
    consumers: [],
    notes: "No external consumer; 16-bit float filtering is core.",
    unimplementedBranch: null,
  },
  {
    name: "vertexArrayObject",
    value: true,
    kind: "constant",
    source: "WebGPU core: vertex layouts live in the render pipeline (no VAO object)",
    researchRef: "§4 row 14 (no external consumer)",
    consumers: [],
    notes: "Semantics (a fixed vertex layout per draw) are provided by the pipeline, not by a VAO handle.",
    unimplementedBranch: null,
  },
];

/**
 * `ContextLimits` member mapping — research §4's second table, one entry per **public** member of the
 * upstream (kept) module `Renderer/ContextLimits.js`. `consumers` is the number of logic-layer
 * consumption sites research §4 measured; `source` is the exact WebGPU provenance (a
 * `GPUSupportedLimits` member, a constant, or a documented conservative formula).
 */
export const LIMIT_TABLE = [
  { member: "maximumTextureSize", backing: "_maximumTextureSize", consumers: 16, source: "adapter.limits.maxTextureDimension2D", kind: "derived-limits", derive: (limits) => limits.maxTextureDimension2D, note: "research §4 ContextLimits row 1" },
  { member: "maximumCubeMapSize", backing: "_maximumCubeMapSize", consumers: 5, source: "adapter.limits.maxTextureDimension2D", kind: "derived-limits", derive: (limits) => limits.maxTextureDimension2D, note: "cube faces are 2D textures" },
  { member: "maximum3DTextureSize", backing: "_maximum3DTextureSize", consumers: 0, source: "adapter.limits.maxTextureDimension3D", kind: "derived-limits", derive: (limits) => limits.maxTextureDimension3D, note: "internal consumer only" },
  { member: "maximumVertexTextureImageUnits", backing: "_maximumVertexTextureImageUnits", consumers: 5, source: "adapter.limits.maxSampledTexturesPerShaderStage", kind: "derived-limits", derive: (limits) => limits.maxSampledTexturesPerShaderStage, note: "per-stage sampled texture budget" },
  { member: "maximumTextureImageUnits", backing: "_maximumTextureImageUnits", consumers: 1, source: "adapter.limits.maxSampledTexturesPerShaderStage", kind: "derived-limits", derive: (limits) => limits.maxSampledTexturesPerShaderStage, note: "per-stage sampled texture budget" },
  { member: "maximumCombinedTextureImageUnits", backing: "_maximumCombinedTextureImageUnits", consumers: 0, source: "adapter.limits.maxSampledTexturesPerShaderStage", kind: "derived-limits", derive: (limits) => limits.maxSampledTexturesPerShaderStage, note: "research §4: 组合值取同一值 (bind groups are per-stage, not combined)" },
  { member: "maximumRenderbufferSize", backing: "_maximumRenderbufferSize", consumers: 0, source: "adapter.limits.maxTextureDimension2D", kind: "derived-limits", derive: (limits) => limits.maxTextureDimension2D, note: "render targets are 2D textures in WebGPU" },
  { member: "maximumSamples", backing: "_maximumSamples", consumers: 1, source: "constant 4 (WebGPU guarantees 4x MSAA)", kind: "constant", value: 4, note: "MUST be >= 4 (T017); slice B may raise it only if a higher sampleCount is actually verified" },
  { member: "maximumVertexAttributes", backing: "_maximumVertexAttributes", consumers: 0, source: "adapter.limits.maxVertexAttributes", kind: "derived-limits", derive: (limits) => limits.maxVertexAttributes, note: "internal consumer only" },
  { member: "maximumVaryingVectors", backing: "_maximumVaryingVectors", consumers: 0, source: "adapter.limits.maxInterStageShaderVariables", kind: "derived-limits", derive: (limits) => limits.maxInterStageShaderVariables, note: "1 GLSL varying vec4 == 1 WGSL inter-stage variable (conservative: raw count, no rounding up)" },
  { member: "maximumVertexUniformVectors", backing: "_maximumVertexUniformVectors", consumers: 0, source: "min(floor(adapter.limits.maxUniformBufferBindingSize / 16), 4096)", kind: "derived-limits", derive: (limits) => Math.min(Math.floor(limits.maxUniformBufferBindingSize / 16), 4096), note: "conservative cap of 4096 vec4 per stage keeps the logic layer inside one uniform buffer binding" },
  { member: "maximumFragmentUniformVectors", backing: "_maximumFragmentUniformVectors", consumers: 0, source: "min(floor(adapter.limits.maxUniformBufferBindingSize / 16), 4096)", kind: "derived-limits", derive: (limits) => Math.min(Math.floor(limits.maxUniformBufferBindingSize / 16), 4096), note: "same conservative formula as the vertex stage" },
  { member: "minimumAliasedLineWidth", backing: "_minimumAliasedLineWidth", consumers: 1, source: "constant 1.0 (WebGPU has no wide lines)", kind: "constant", value: 1, note: "research §4: 逻辑层据此走 1px 线" },
  { member: "maximumAliasedLineWidth", backing: "_maximumAliasedLineWidth", consumers: 2, source: "constant 1.0 (WebGPU has no wide lines)", kind: "constant", value: 1, note: "RenderState.lineWidth MUST stay 1 (T049)" },
  { member: "minimumAliasedPointSize", backing: "_minimumAliasedPointSize", consumers: 0, source: "constant 1.0 (WebGPU point size is 1)", kind: "constant", value: 1, note: "companion of maximumAliasedPointSize" },
  { member: "maximumAliasedPointSize", backing: "_maximumAliasedPointSize", consumers: 1, source: "constant 1.0 (WebGPU point size is 1)", kind: "constant", value: 1, note: "research §4 row: maximumAliasedPointSize ← 1.0" },
  { member: "maximumViewportWidth", backing: "_maximumViewportWidth", consumers: 0, source: "adapter.limits.maxTextureDimension2D", kind: "derived-limits", derive: (limits) => limits.maxTextureDimension2D, note: "viewport is bounded by the render target size" },
  { member: "maximumViewportHeight", backing: "_maximumViewportHeight", consumers: 0, source: "adapter.limits.maxTextureDimension2D", kind: "derived-limits", derive: (limits) => limits.maxTextureDimension2D, note: "viewport is bounded by the render target size" },
  { member: "maximumTextureFilterAnisotropy", backing: "_maximumTextureFilterAnisotropy", consumers: 1, source: "constant 1.0 (no anisotropic filtering)", kind: "constant", value: 1, note: "pairs with the textureFilterAnisotropic capability flag (false)" },
  { member: "maximumDrawBuffers", backing: "_maximumDrawBuffers", consumers: 0, source: "adapter.limits.maxColorAttachments", kind: "derived-limits", derive: (limits) => limits.maxColorAttachments, note: "one draw buffer per color attachment" },
  { member: "maximumColorAttachments", backing: "_maximumColorAttachments", consumers: 0, source: "adapter.limits.maxColorAttachments", kind: "derived-limits", derive: (limits) => limits.maxColorAttachments, note: "research §4 second table last row" },
  { member: "highpFloatSupported", backing: "_highpFloatSupported", consumers: 0, source: "constant true (WGSL has no mediump/lowp in the MVP emission target)", kind: "constant", value: true, note: "WGSL float32 is highp; there is no reduced-precision fragment path" },
  { member: "highpIntSupported", backing: "_highpIntSupported", consumers: 0, source: "constant true (WGSL i32/u32 are 32-bit in the fragment stage)", kind: "constant", value: true, note: "WGSL integers are 32-bit everywhere" },
];

/** Research §4's flag names, in table order (used by the unit test to assert coverage). */
export const FLAG_NAMES = FLAG_TABLE.map((entry) => entry.name);

/** Research §4's `ContextLimits` member names, in table order. */
export const LIMIT_NAMES = LIMIT_TABLE.map((entry) => entry.member);

function toFeatureSet(features) {
  if (features === undefined || features === null) return new Set();
  if (typeof features.has === "function" && typeof features[Symbol.iterator] === "function") {
    return new Set(Array.from(features));
  }
  return new Set(Array.from(features));
}

/**
 * Compose the capability snapshot + `ContextLimits` values from a real device/adapter.
 *
 * @param {{adapter?: object, device?: object, limits?: object, features?: Iterable<string>, slice?: string}} payload
 * @returns {{slice: string, flags: Record<string, unknown>, limits: Record<string, number|boolean>,
 *            notes: Record<string, string>, unimplementedBranches: Record<string, string>,
 *            sources: Record<string, string>, falseFlags: string[]}}
 */
export function composeCapabilities(payload = {}) {
  const slice = payload.slice ?? MVP_SLICE;
  const adapter = payload.adapter ?? null;
  const device = payload.device ?? null;
  const limits = payload.limits ?? device?.limits ?? adapter?.limits ?? null;
  const features = toFeatureSet(payload.features ?? adapter?.features ?? device?.features ?? null);

  const flags = {};
  const notes = {};
  const unimplementedBranches = {};
  const sources = {};
  for (const entry of FLAG_TABLE) {
    let value = entry.value;
    if (entry.kind === "derived-features") value = entry.derive(features);
    else if (entry.kind === "derived-limits") value = entry.derive(limits);
    if (entry.name === "depthTexture" && slice !== "A") value = true;
    flags[entry.name] = value;
    notes[entry.name] = entry.notes;
    sources[entry.name] = entry.source;
    if (value === false) {
      unimplementedBranches[entry.name] = entry.unimplementedBranch ?? entry.falseBranch ?? "";
    }
  }

  const limitsOut = {};
  const limitSources = {};
  for (const entry of LIMIT_TABLE) {
    limitsOut[entry.member] = entry.kind === "derived-limits" ? entry.derive(limits) : entry.value;
    limitSources[entry.member] = entry.source;
  }

  return {
    slice,
    flags,
    limits: limitsOut,
    notes,
    unimplementedBranches,
    sources,
    limitSources,
    falseFlags: FLAG_TABLE.filter((entry) => flags[entry.name] === false).map((entry) => entry.name),
    defaults: Object.fromEntries(FLAG_TABLE.map((entry) => [entry.name, entry.value])),
  };
}
