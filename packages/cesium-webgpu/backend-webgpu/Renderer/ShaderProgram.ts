/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/ShaderProgram.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * WHAT THIS MODULE IS (tasks.md T075 + T081; manifest `Renderer/ShaderProgram.js`, FR-030/FR-031)
 * ------------------------------------------------------------------------------------------------
 * Upstream `ShaderProgram` is a thin wrapper around the GL program object: the constructor is inert,
 * `initialize()` compiles+links through `gl.createShader`/`linkProgram`, reflection comes from
 * `gl.getActiveAttrib`/`gl.getActiveUniform`, and `_bind`/`_setUniforms` are GL calls. None of that
 * exists in WebGPU, so the port keeps **everything the logic layer can observe** and replaces the
 * device-facing half:
 *
 *   1. **The read surface is unchanged** (contract fork-patch-layer §5 **R2**, architecture rule A9):
 *      `vertexShaderSource` / `fragmentShaderSource` return the objects the caller supplied,
 *      **unchanged** — this module never assigns into them (the A9 scanner fails the build if any
 *      patch-layer file does), `_attributeLocations` is the very object `ShaderCache` forwarded, and
 *      `vertexAttributes` / `numberOfVertexAttributes` / `allUniforms` / `id` /
 *      `maximumTextureUnitIndex` / `destroy` / `releaseShaderProgram` behave as upstream. `id` is a
 *      fresh incrementing integer per program (`nextShaderProgramId`, upstream `:12,62`).
 *   2. **Two-phase initialisation instead of one.** Upstream's `initialize()` needs the device, which
 *      is what makes upstream's reflection untestable without a GL context. Here:
 *        - the **shader front end is device-free**: the WGSL module pair is produced at construction
 *          by `WgslEmission.emit` (`webgpu/wgsl-emitter.ts`) from the GLSL the caller assembled, and
 *          so are the vertex attributes and the bind layout. That is the part the unit suite drives;
 *        - the **device resources are lazy**: `GPUShaderModule`s, bind-group layouts and the
 *          `GPURenderPipeline` are created on first use (`initialize()` / `createPipeline()`), never
 *          in the constructor. Pipelines go through the W2 `webgpu/pipeline-cache.ts` — this module
 *          does not duplicate that cache's job, it only supplies the key's `shaderProgramId` and the
 *          descriptor the cache's factory builds.
 *   3. **A rejected emission fails loudly.** `WgslEmission.emit` returns `ok: false` **with no
 *      module** when the define set is outside the MVP slice or the varying pairing does not
 *      satisfy WGSL's hard check. A program is then *not* constructed: the constructor throws a
 *      `DiagnosticError` carrying the emitter's diagnostics. A partially emitted program would be a
 *      silently wrong draw, which is exactly what FR-033 forbids.
 *
 * T081 — THE `ShaderBuilder` BOUNDARY
 * ------------------------------------------------------------------------------------------------
 * `Renderer/ShaderBuilder.js` is a **kept module** (contract §5 **R9**: byte-identical in the MVP;
 * no local replacement exists, and none may be added). The model / voxel / Gaussian-splat shader
 * families it assembles are therefore reachable at run time but have no WGSL front end in this
 * slice; they MUST fail with `category: "not-implemented"` instead of being compiled. `shaderFamilyOf`
 * / `assertShaderFamilySupported` below are that boundary, and every criterion is a marker of the
 * **incoming** assembly (its sources, its define list) with the upstream line it was derived from
 * recorded next to it — so an upstream upgrade that changes the marker is a visible diff, not a
 * silent widening of the supported slice.
 *
 * The guard's default is "terrain" (the MVP closure: `GlobeVS`/`GlobeFS`/`AtmosphereCommon`/
 * `GroundAtmosphere`), and the define-level boundary is *also* enforced independently by the
 * emitter's explicit `SUPPORTED_DEFINES` allow-list — a define the emitter has no WGSL region for is
 * refused there even when no family marker matches.
 *
 * LAYOUT OWNERSHIP (and the one place this port is narrower than the G-6 model)
 * ------------------------------------------------------------------------------------------------
 * The bind layout the emitter and the uniform setters share is derived **per program** from the
 * program's own assembled GLSL (`webgpu/bind-layout.buildBindLayout`, T077). A caller that owns the
 * prewarm plan can inject the wider union layout through `options.layout`; upstream's own
 * `ShaderCache` option bag is forwarded verbatim, so the union layout is not reachable through
 * `ShaderProgram.fromCache` — see the report for this deviation.
 *
 * `createUniform` / `createUniformArray` ARE being replaced in parallel (T076). They are imported
 * here exactly as upstream imports them, but they are only *called* on first use of the uniform
 * surface (`allUniforms` / `_setUniforms`), and through `options.uniformFactory` when one is
 * supplied — so this module's own behaviour does not depend on the timing of that change.
 */
import ContextLimits from "@cesium/engine/Source/Renderer/ContextLimits.js";
import AutomaticUniforms from "@cesium/engine/Source/Renderer/AutomaticUniforms.js";
import DeveloperError from "@cesium/engine/Source/Core/DeveloperError.js";
import destroyObject from "@cesium/engine/Source/Core/destroyObject.js";
import defined from "@cesium/engine/Source/Core/defined.js";

import { buildBindLayout } from "../webgpu/bind-layout.js";
import type { BindLayoutResult } from "../webgpu/bind-layout.js";
import { hasGpuDevice, requireDevice } from "../webgpu/context-device.js";
import { DiagnosticError } from "../webgpu/errors.js";
import { applyFlagsFromDefines, textureUnitsFromDefines } from "../webgpu/generated-fragments.js";
import { getOrCreate as getOrCreatePipeline, renderStateFingerprint, vertexLayoutFingerprint } from "../webgpu/pipeline-cache.js";
import type { PipelineCacheKey, RenderStateLike, VertexAttributeLike } from "../webgpu/pipeline-cache.js";
import { MVP_SCENE_MODE } from "../webgpu/terrain-variants.js";
import { attributeLayoutFromContract } from "../webgpu/varying-contract.js";
import type { AttributeBinding, VaryingContract, VaryingRef } from "../webgpu/varying-contract.js";
import { WgslEmission } from "../webgpu/wgsl-emitter.js";
import type { ShaderEmissionDiagnostic, WgslEmissionResult, WgslEmissionStructure } from "../webgpu/wgsl-emitter.js";
import { createGpuUniformStaging, uniformBlockLayoutEntries, type GpuUniformStaging } from "../webgpu/uniform-gpu-staging.js";

import createUniformImpl from "./createUniform.js";
import createUniformArrayImpl from "./createUniformArray.js";

const UPSTREAM_MODULE = "Renderer/ShaderProgram.js";

/** The scope console logging uses (upstream `ShaderProgram.js:182`; the backend is not WebGL). */
const consolePrefix = "[Cesium WebGPU] ";

/**
 * `GPUShaderStage.VERTEX` / `.FRAGMENT` (WebGPU spec values). Spelled out rather than read from the
 * global so this module — and therefore its unit suite — never needs a browser environment.
 */
const SHADER_STAGE_VERTEX = 0x1;
const SHADER_STAGE_FRAGMENT = 0x2;
const SHADER_STAGE_VERTEX_FRAGMENT = SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT;

/** The vertex/fragment entry points of the emitted modules (`webgpu/wgsl/generated-library.ts`). */
export const VERTEX_ENTRY_POINT = "vs_main";
export const FRAGMENT_ENTRY_POINT = "fs_main";

// ------------------------------------------------------------------------------------------------
// T081 — the ShaderBuilder family boundary (contract §5 R9)
// ------------------------------------------------------------------------------------------------

/** The shader families the T081 boundary distinguishes. Only `terrain` is in this slice. */
export type ShaderFamily = "terrain" | "model" | "voxel" | "gaussian-splat";

/** One family the MVP must refuse, with the criterion derived from upstream. */
export interface ShaderFamilyBoundaryRule {
  readonly family: Exclude<ShaderFamily, "terrain">;
  /** Human label used in the diagnostic. */
  readonly label: string;
  /** Defines only this family pushes; matched on the define **name** (value ignored). */
  readonly defineMarkers: readonly string[];
  /** Markers of the **assembled GLSL text** (never of this backend's WGSL library). */
  readonly textMarkers: readonly RegExp[];
  /** The upstream line(s) the criterion was derived from — recorded so an upgrade is auditable. */
  readonly upstreamSource: string;
}

/**
 * The three `ShaderBuilder.js` families, each with the upstream line its criterion comes from.
 *
 * The criteria are deliberately *positive* markers of the model/voxel/splat paths rather than a
 * negative test of the terrain closure, because the terrain closure shares `czm_getMaterial` with the
 * model family (`Source/Shaders/GlobeFS.glsl:426` calls it too) and a criterion that cannot tell the
 * two apart would refuse the MVP's own shaders.
 */
export const SHADER_FAMILY_BOUNDARY: readonly ShaderFamilyBoundaryRule[] = [
  {
    family: "model",
    label: "3D Tiles / glTF model (`Renderer/ShaderBuilder.js`)",
    defineMarkers: ["HAS_NORMALS", "HAS_SILHOUETTE", "HAS_SKINNING", "HAS_TANGENTS", "HAS_BITANGENTS", "HAS_INSTANCING"],
    textMarkers: [/#\s*(?:if|ifdef|ifndef|elif)\b[^\n]*\bHAS_NORMALS\b/, /#\s*(?:if|ifdef|ifndef|elif)\b[^\n]*\bHAS_SILHOUETTE\b/],
    upstreamSource:
      'Source/Scene/Model/GeometryPipelineStage.js:260 (`shaderBuilder.addDefine("HAS_NORMALS")`, ShaderDestination.BOTH) emits Source/Shaders/Model/GeometryStageVS.glsl:25 and Model/MaterialStageFS.glsl:166 (`#ifdef HAS_NORMALS`); the silhouette variant is Source/Scene/Model/ModelSilhouettePipelineStage.js:61',
  },
  {
    family: "voxel",
    label: "VoxelPrimitive (`Renderer/ShaderBuilder.js`)",
    defineMarkers: ["VOXEL_", "SHAPE_BOX", "SHAPE_CYLINDER", "SHAPE_ELLIPSOID"],
    textMarkers: [/RayShapeIntersection\s+getVoxelIntersection\s*\(/, /getPropertiesFromMegatextureAtUv\s*\(/],
    upstreamSource:
      'Source/Scene/VoxelRenderResources.js:105 (`shaderBuilder.addDefine("SHAPE_BOX", undefined, ShaderDestination.FRAGMENT)`) plus :181 (`addFragmentLines([VoxelFS])`) → Source/Shaders/Voxels/VoxelFS.glsl:44 (`RayShapeIntersection getVoxelIntersection(…)`)',
  },
  {
    family: "gaussian-splat",
    label: "GaussianSplatPrimitive (`Renderer/ShaderBuilder.js`)",
    defineMarkers: ["HAS_SPHERICAL_HARMONICS"],
    textMarkers: [/v_splatColor\b/, /u_sphericalHarmonicsTexture\b/],
    upstreamSource:
      "Source/Scene/GaussianSplatPrimitive.js:1580-1581 (`shaderBuilder.addVertexLines(GaussianSplatVS); shaderBuilder.addFragmentLines(GaussianSplatFS);`) → Source/Shaders/PrimitiveGaussianSplatVS.glsl:10 (`#if defined(HAS_SPHERICAL_HARMONICS)`) and :188 (`v_splatColor = …`)",
  },
];

/** The assembly a family verdict is taken on: its sources, its defines, and the combined texts. */
export interface ShaderAssemblyView {
  readonly sources: readonly string[];
  readonly defines: readonly string[];
  /** The assembled vertex GLSL (optional; the sources are enough when it is absent). */
  readonly vertexText?: string | undefined;
  /** The assembled fragment GLSL (optional). */
  readonly fragmentText?: string | undefined;
}

/** The name part of a `#define` entry (`"TEXTURE_UNITS 3"` → `"TEXTURE_UNITS"`). */
function defineNameOf(define: string): string {
  return define.trim().split(/\s+/)[0] ?? "";
}

/**
 * Classify the incoming assembly.
 *
 * @returns `"terrain"` when no model/voxel/Gaussian-splat marker matches — the MVP closure — else the
 *   family that matched. The classification reads the **incoming** GLSL and define list only; the
 *   replaced WGSL leaf library is never a subject (it contains the word `Model` in comments that the
 *   remaining families' names would otherwise match).
 */
export function shaderFamilyOf(assembly: ShaderAssemblyView): ShaderFamily {
  const text = [assembly.vertexText ?? "", assembly.fragmentText ?? "", ...assembly.sources].join("\n");
  const defineNames = assembly.defines.map(defineNameOf);
  for (const rule of SHADER_FAMILY_BOUNDARY) {
    if (defineNames.some((name) => rule.defineMarkers.some((marker) => name === marker || name.startsWith(marker)))) return rule.family;
    if (rule.textMarkers.some((marker) => marker.test(text))) return rule.family;
  }
  return "terrain";
}

/**
 * The T081 guard: refuse the model / voxel / Gaussian-splat families explicitly.
 *
 * @throws a `DiagnosticError` with `category: "not-implemented"` naming the family and the upstream
 *   line the criterion came from. The guard never fires for the terrain closure, and it is checked
 *   **before** WGSL emission so the failure names the family rather than a define.
 */
export function assertShaderFamilySupported(assembly: ShaderAssemblyView): ShaderFamily {
  const family = shaderFamilyOf(assembly);
  if (family === "terrain") return family;
  const rule = SHADER_FAMILY_BOUNDARY.find((candidate) => candidate.family === family);
  const criterion = rule === undefined ? "(unrecorded)" : rule.upstreamSource;
  throw new DiagnosticError(
    "not-implemented",
    `the ${family} shader family${rule === undefined ? "" : ` (${rule.label})`} is not implemented in this build. ` +
      "`Renderer/ShaderBuilder.js` is kept byte-identical for the MVP (contract fork-patch-layer §5 R9) and there is no local " +
      `replacement for it, so its WGSL conversion is a later slice. Criterion: ${criterion}. ` +
      "Refusing here is required: compiling a program this backend cannot render would draw a plausible but wrong frame (FR-033).",
    {
      backend: "webgpu",
      upstreamModule: "Renderer/ShaderBuilder.js",
      requirementRef: "FR-030",
      entryPoint: "ShaderProgram#constructor",
      plannedPhase: "slice C (ShaderBuilder WGSL conversion, tasks.md T081 boundary)",
      extra: { shaderFamily: family },
    },
  );
}

// ------------------------------------------------------------------------------------------------
// upstream helper ports
// ------------------------------------------------------------------------------------------------

function extractUniforms(shaderText: string): string[] {
  const uniformNames: string[] = [];
  const uniformLines = shaderText.match(/uniform.*?(?![^{]*})(?=[=\[;])/g);
  if (defined(uniformLines) && uniformLines !== null) {
    for (let i = 0; i < uniformLines.length; i++) {
      const line = (uniformLines[i] ?? "").trim();
      const name = line.slice(line.lastIndexOf(" ") + 1);
      uniformNames.push(name);
    }
  }
  return uniformNames;
}

/**
 * Upstream `handleUniformPrecisionMismatches` (`ShaderProgram.js:144-180`), verbatim.
 *
 * The renaming exists for devices that only support `mediump` in the fragment stage; the replacement
 * `Context` publishes `highpFloatSupported === true`/`highpIntSupported === true`
 * (`webgpu/capability.ts:348-349` — "WGSL float32 is highp"), so in production this is a pass-through.
 * `options.precisionSupport` exists because the unit layer cannot mutate the kept upstream
 * `ContextLimits` module the build aliases: it lets a test pin the capability snapshot the real
 * context publishes instead of depending on the module's default `false`.
 */
function handleUniformPrecisionMismatches(
  vertexShaderText: string,
  fragmentShaderText: string,
  precisionSupport: { readonly float: boolean; readonly int: boolean },
): { fragmentShaderText: string; duplicateUniformNames: Record<string, string> } {
  const duplicateUniformNames: Record<string, string> = {};

  if (!precisionSupport.float || !precisionSupport.int) {
    const vertexShaderUniforms = extractUniforms(vertexShaderText);
    const fragmentShaderUniforms = extractUniforms(fragmentShaderText);

    for (let i = 0; i < vertexShaderUniforms.length; i++) {
      for (let j = 0; j < fragmentShaderUniforms.length; j++) {
        if (vertexShaderUniforms[i] === fragmentShaderUniforms[j]) {
          const uniformName = vertexShaderUniforms[i] as string;
          const duplicateName = `czm_mediump_${uniformName}`;
          const re = new RegExp(`${uniformName}\\b`, "g");
          fragmentShaderText = fragmentShaderText.replace(re, duplicateName);
          duplicateUniformNames[duplicateName] = uniformName;
        }
      }
    }
  }

  return { fragmentShaderText, duplicateUniformNames };
}

// ------------------------------------------------------------------------------------------------
// uniform setters (T076 seam)
// ------------------------------------------------------------------------------------------------

/** The setter shape upstream `createUniform`/`createUniformArray` return, as this module drives it. */
export interface UniformSetterLike {
  name: string;
  value: unknown;
  set(): void;
  textureUnitIndex?: number | undefined;
  _setSampler?(textureUnitIndex: number): number;
  readonly _locations?: readonly unknown[];
}

/** The options this program forwards to the uniform factory (`createUniform`'s `CreateUniformOptions`). */
export interface UniformFactoryOptions {
  readonly layout?: BindLayoutResult;
  readonly writer?: unknown;
}

/** The injected/imported uniform factory (`Renderer/createUniform.ts` + `createUniformArray.ts`). */
export interface UniformFactory {
  createUniform(gl: unknown, activeUniform: unknown, uniformName: string, location: unknown, options?: UniformFactoryOptions): UniformSetterLike;
  createUniformArray(gl: unknown, activeUniform: unknown, uniformName: string, locations: readonly unknown[] | number | undefined, options?: UniformFactoryOptions): UniformSetterLike;
}

type CreateUniformFn = (gl: unknown, activeUniform: unknown, uniformName: string, location: unknown, options?: UniformFactoryOptions) => UniformSetterLike;
type CreateUniformArrayFn = (gl: unknown, activeUniform: unknown, uniformName: string, locations: readonly unknown[] | number | undefined, options?: UniformFactoryOptions) => UniformSetterLike;

/**
 * The default factory: the sibling replacements, imported exactly as upstream imports them
 * (`ShaderProgram.js:9-10`) and called lazily on first use of the uniform surface.
 */
export function defaultUniformFactory(): UniformFactory {
  if (typeof createUniformImpl !== "function" || typeof createUniformArrayImpl !== "function") {
    throw new DiagnosticError(
      "internal",
      "ShaderProgram: the replacement `Renderer/createUniform`/`createUniformArray` modules do not export a default function, so the " +
        "uniform surface cannot be built. Pass `options.uniformFactory` explicitly, or land the T076 replacements.",
      { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "ShaderProgram#uniformFactory" },
    );
  }
  return {
    createUniform: createUniformImpl as unknown as CreateUniformFn,
    createUniformArray: createUniformArrayImpl as unknown as CreateUniformArrayFn,
  };
}

/** The upstream `AutomaticUniforms` entry this module needs (`getValue`, `ShaderProgram.js:574`). */
interface AutomaticUniformLike {
  getValue(uniformState: unknown): unknown;
}

/** `partitionUniforms` (`ShaderProgram.js:412-442`), unchanged. */
function partitionUniforms(
  shader: ShaderProgram,
  uniforms: Record<string, UniformSetterLike>,
): { automaticUniforms: { uniform: UniformSetterLike; automaticUniform: AutomaticUniformLike }[]; manualUniforms: UniformSetterLike[] } {
  const automaticUniforms: { uniform: UniformSetterLike; automaticUniform: AutomaticUniformLike }[] = [];
  const manualUniforms: UniformSetterLike[] = [];
  const table = AutomaticUniforms as unknown as Record<string, AutomaticUniformLike | undefined>;

  for (const name of Object.keys(uniforms)) {
    const uniformObject = uniforms[name] as UniformSetterLike;
    let uniformName = name;
    // if it's a duplicate uniform, use its original name so it is updated correctly
    const duplicateUniform = shader._duplicateUniformNames[uniformName];
    if (defined(duplicateUniform)) {
      uniformObject.name = duplicateUniform as string;
      uniformName = duplicateUniform as string;
    }
    const automaticUniform = table[uniformName];
    if (defined(automaticUniform)) automaticUniforms.push({ uniform: uniformObject, automaticUniform: automaticUniform as AutomaticUniformLike });
    else manualUniforms.push(uniformObject);
  }

  return { automaticUniforms, manualUniforms };
}

/**
 * `setSamplerUniforms` (`ShaderProgram.js:444-456`) without `gl.useProgram`.
 *
 * WebGPU has no "currently bound program": the texture-unit bookkeeping is all that survives, and it
 * is what `maximumTextureUnitIndex` reports (`Context.js:1317` reads it).
 */
function setSamplerUniforms(samplerUniforms: readonly UniformSetterLike[]): number {
  let textureUnitIndex = 0;
  for (let i = 0; i < samplerUniforms.length; i++) {
    const setter = samplerUniforms[i] as UniformSetterLike;
    textureUnitIndex = setter._setSampler === undefined ? textureUnitIndex + 1 : setter._setSampler(textureUnitIndex);
  }
  return textureUnitIndex;
}

// ------------------------------------------------------------------------------------------------
// the program
// ------------------------------------------------------------------------------------------------

let nextShaderProgramId = 0;

/** The `ShaderSource` surface this module reads (upstream `ShaderSource`; never written to). */
export interface ShaderSourceLike {
  readonly sources?: readonly string[];
  readonly defines?: readonly string[];
  readonly sceneMode?: string | undefined;
  getCacheKey?(): string;
}

/** One entry of `vertexAttributes` (upstream: `{name, type, index}` from `gl.getActiveAttrib`). */
export interface VertexAttributeRecord {
  readonly name: string;
  readonly type: string;
  readonly index: number;
  /** Backend addition: the WGSL type of the attribute, already reflected from the contract. */
  readonly wgslType: string;
}

/** The result of the device-free half: the module texts plus everything reflected from them. */
export interface ShaderProgramWgsl {
  readonly variantKey: string;
  readonly family: ShaderFamily;
  readonly vertexModule: string;
  readonly fragmentModule: string;
  readonly structure: WgslEmissionStructure;
  readonly contract: VaryingContract;
  readonly varyingSet: readonly VaryingRef[];
  readonly layout: BindLayoutResult;
  readonly attributeBindings: readonly AttributeBinding[];
  readonly diagnostics: readonly ShaderEmissionDiagnostic[];
  /** `true` when the caller provided `options.emission` instead of the emitter running here. */
  readonly injected: boolean;
}

/** The replaced `Renderer/RenderState.ts` surface `createPipeline` reads (T049). */
export interface ProgramRenderStateLike extends RenderStateLike {
  readonly topology?: string | undefined;
  readonly colorFormats?: readonly string[] | undefined;
  readonly depthFormat?: string | null | undefined;
  readonly sampleCount?: number | undefined;
  toPipelineState?(passState?: unknown): {
    readonly primitive: { readonly topology: string; readonly cullMode: GPUCullMode; readonly frontFace: GPUFrontFace; readonly stripIndexFormat?: GPUIndexFormat | undefined };
    readonly depthStencil: {
      readonly format: string | null;
      readonly depthWriteEnabled: boolean;
      readonly depthCompare: GPUCompareFunction;
      readonly depthBias: number;
      readonly depthBiasSlopeScale: number;
      readonly depthBiasClamp: number;
      readonly stencilFront: GPUStencilFaceState;
      readonly stencilBack: GPUStencilFaceState;
      readonly stencilReadMask: number;
      readonly stencilWriteMask: number;
    };
    readonly multisample: { readonly count: number };
    readonly targets: readonly { readonly writeMask: number; readonly blend: GPUBlendState | undefined }[];
  };
}

/** One `createPipeline` request (the W4 seam the replaced `Context.draw` uses). */
export interface ProgramPipelineRequest {
  /** The replaced `Renderer/RenderState` for this draw. */
  readonly renderState: ProgramRenderStateLike;
  /** Upstream `PassState` (read by `RenderState.toPipelineState` for viewport/scissor). */
  readonly passState?: unknown;
  /** The upstream vertex layout (`command.vertexArray.attributes`); participates in the cache key. */
  readonly vertexLayout?: readonly VertexAttributeLike[] | undefined;
  /** Explicit GPU vertex buffers; derived from the emission contract when omitted. */
  readonly vertexBuffers?: readonly GPUVertexBufferLayout[] | undefined;
  /** Overrides; each falls back to the render state's own value, never to an invented one. */
  readonly topology?: string | undefined;
  readonly colorFormats?: readonly string[] | undefined;
  readonly depthFormat?: string | null | undefined;
  readonly sampleCount?: number | undefined;
}

export interface ShaderProgramOptions {
  /** The replaced `Context` (it carries the device, the `ShaderCache` and the capability flags). */
  context?: unknown;
  /** Upstream keeps the GL handle here (`ShaderCache.js:121`); the WebGPU build keeps it for shape. */
  gl?: unknown;
  logShaderCompilation?: boolean;
  debugShaders?: unknown;
  vertexShaderSource: ShaderSourceLike;
  vertexShaderText: string;
  fragmentShaderSource: ShaderSourceLike;
  fragmentShaderText: string;
  attributeLocations?: Record<string, number> | undefined;
  /** Backend addition: the define list of the variant (defaults to the union of both sources'). */
  defines?: readonly string[] | undefined;
  /** Backend addition: the layout to emit against (defaults to this program's own union layout). */
  layout?: BindLayoutResult | undefined;
  /** Backend addition: the scene mode the runtime position functions are chosen by. */
  sceneMode?: string | undefined;
  /** Backend addition: a stable label for diagnostics and artefacts. */
  variantKey?: string | undefined;
  /** Backend addition: the uniform factory (defaults to the imported `createUniform*` replacements). */
  uniformFactory?: UniformFactory | undefined;
  /** Backend addition: the sink changed uniform values are pushed into (T076's staging). */
  uniformWriter?: unknown;
  /** Backend addition: the high-precision capability snapshot (defaults to the kept `ContextLimits`). */
  precisionSupport?: { readonly float: boolean; readonly int: boolean } | undefined;
  /** Backend addition: an already computed emission (prewarm plans, gates). */
  emission?: WgslEmissionResult | undefined;
}

/** The device-side state of one program (`_program`, upstream's GL program handle). */
export interface ShaderProgramDeviceState {
  readonly device: GPUDevice;
  readonly vertexModule: GPUShaderModule;
  readonly fragmentModule: GPUShaderModule;
  /** The bind-group layouts the pipeline layout is built from (group 0 uniform, group 1 samplers). */
  readonly bindGroupLayouts: readonly GPUBindGroupLayout[];
  readonly pipelineLayout: GPUPipelineLayout;
}

function internalError(message: string, entryPoint: string): DiagnosticError {
  return new DiagnosticError("internal", `ShaderProgram: ${message}`, {
    backend: "webgpu",
    upstreamModule: UPSTREAM_MODULE,
    requirementRef: "FR-030",
    entryPoint,
  });
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw internalError(`\`options.${name}\` is required and MUST be a string (the \`ShaderCache\` always supplies it).`, "ShaderProgram#constructor");
  }
  return value;
}

/**
 * The union of the two stages' define lists, plus any explicit list (order-stable, deduplicated).
 *
 * Upstream pushes **empty strings** for the optional globe defines
 * (`GlobeSurfaceShaderSet.js:153,164,171`: `quantizationDefine = ""`,
 * `cartographicLimitRectangleDefine = ""`, `imageryCutoutDefine = ""`, then pushed unconditionally at
 * `:278-282`). In GLSL a `#define` with no body is harmless; in the emitter's define space it is a
 * nameless entry that the allow-list correctly refuses, which stopped the first real terrain tile
 * program in W5 with `unsupported define ""`. Empty entries carry no information, so they are dropped
 * here — upstream's "define is absent" encoding, expressed once.
 */
function collectDefines(explicit: readonly string[] | undefined, ...sources: ShaderSourceLike[]): readonly string[] {
  const merged = new Set<string>();
  if (explicit !== undefined) for (const define of explicit) addDefine(merged, define);
  for (const source of sources) for (const define of source.defines ?? []) addDefine(merged, define);
  return Object.freeze([...merged]);
}

function addDefine(merged: Set<string>, define: unknown): void {
  if (typeof define !== "string") return;
  const trimmed = define.trim();
  if (trimmed.length === 0) return;
  merged.add(trimmed);
}

/** A stable, text-free variant label (`TEXTURE_UNITS 1|FOG`), used for diagnostics and artefacts. */
function variantKeyOf(defines: readonly string[]): string {
  const sorted = [...defines].sort();
  return sorted.length === 0 ? "(no-defines)" : sorted.join("|");
}

/** The `DeviceLimits` the layout is validated against, or `null` when no device is reachable. */
/** The context's frame counter, or `-1` when the context does not publish one (unit layer). */
function frameNumberOf(context: unknown): number {
  const frame = (context as { frameNumber?: unknown } | null | undefined)?.frameNumber;
  return typeof frame === "number" ? frame : -1;
}function layoutLimitsOf(context: unknown): { maxBindingsPerBindGroup: number; maxUniformBufferBindingSize: number } | null {
  const limits = (context as { device?: { limits?: Partial<GPUSupportedLimits> } } | null | undefined)?.device?.limits;
  const perGroup = limits?.maxBindingsPerBindGroup;
  const blockSize = limits?.maxUniformBufferBindingSize;
  if (typeof perGroup !== "number" || typeof blockSize !== "number") return null;
  return { maxBindingsPerBindGroup: perGroup, maxUniformBufferBindingSize: blockSize };
}

function diagnosticText(diagnostics: readonly ShaderEmissionDiagnostic[]): string {
  if (diagnostics.length === 0) return "(the emitter produced no diagnostic — see webgpu/wgsl-emitter.ts)";
  return diagnostics.map((diagnostic) => `[${diagnostic.severity}] ${diagnostic.message}`).join("; ");
}

/**
 * Device-free construction of the WGSL module pair and everything reflected from it.
 *
 * @throws a `DiagnosticError` (`not-implemented`) when the family guard refuses, when a layout cannot
 *   be built, or when the emitter rejects the variant. There is no partial result: a program either
 *   has both module texts or it is not constructed.
 */
function emitProgramWgsl(options: ShaderProgramOptions, vertexGlsl: string, fragmentGlsl: string, defines: readonly string[], variantKey: string): ShaderProgramWgsl {
  const assembly: ShaderAssemblyView = { sources: [...(options.vertexShaderSource.sources ?? []), ...(options.fragmentShaderSource.sources ?? [])], defines, vertexText: vertexGlsl, fragmentText: fragmentGlsl };
  const family = assertShaderFamilySupported(assembly);

  let layout = options.layout;
  if (layout === undefined) {
    try {
      layout = buildBindLayout({
        vertexSource: vertexGlsl,
        fragmentSource: fragmentGlsl,
        defines,
        structName: "TerrainUniforms",
        automaticUniforms: new Set(Object.keys(AutomaticUniforms)),
        limits: layoutLimitsOf(options.context),
      });
    } catch (cause) {
      throw new DiagnosticError(
        "not-implemented",
        `ShaderProgram: the bind layout of variant "${variantKey}" could not be built from its assembled GLSL: ` +
          `${cause instanceof Error ? cause.message : String(cause)}. Without a layout neither the WGSL \`struct\` nor the CPU-side uniform ` +
          "writer has a table, and inventing one would put the two sides out of step (T077/T076).",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "ShaderProgram#constructor", cause, extra: { variantKey } },
      );
    }
  }

  let emission = options.emission;
  if (emission === undefined) {
    try {
      emission = WgslEmission.emit({
        variantKey,
        vertexGlsl,
        fragmentGlsl,
        defines,
        attributeLocations: options.attributeLocations ?? null,
        destination: "both",
        textureUnits: textureUnitsFromDefines(defines),
        flags: applyFlagsFromDefines(defines),
        layout,
        sceneMode: options.sceneMode ?? MVP_SCENE_MODE,
      });
    } catch (cause) {
      if (cause instanceof DiagnosticError) throw cause;
      throw new DiagnosticError(
        "not-implemented",
        `ShaderProgram: WGSL emission failed for variant "${variantKey}": ${cause instanceof Error ? cause.message : String(cause)}`,
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "ShaderProgram#constructor", cause, extra: { variantKey } },
      );
    }
  }

  const vertexModule = emission.vertexModule;
  const fragmentModule = emission.fragmentModule;
  const contract = emission.contract;
  const structure = emission.structure;
  if (emission.ok !== true || vertexModule === null || fragmentModule === null || contract === null || structure === null) {
    throw new DiagnosticError(
      "not-implemented",
      `ShaderProgram: the WGSL emission for variant "${variantKey}" was rejected and no program was constructed: ${diagnosticText(emission.diagnostics)}`,
      {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "ShaderProgram#constructor",
        plannedPhase: "a slice whose WGSL coverage includes this variant (tasks.md T068-T071)",
        extra: { variantKey, family, diagnostics: emission.diagnostics.length },
      },
    );
  }

  return {
    variantKey,
    family,
    vertexModule,
    fragmentModule,
    structure,
    contract,
    varyingSet: emission.varyingSet,
    layout: emission.bindLayout ?? layout,
    attributeBindings: emission.attributeBindings,
    diagnostics: emission.diagnostics,
    injected: options.emission !== undefined,
  };
}

function attributeRecordsOf(bindings: readonly AttributeBinding[]): Record<string, VertexAttributeRecord> {
  const attributes: Record<string, VertexAttributeRecord> = {};
  for (const binding of bindings) attributes[binding.name] = { name: binding.name, type: binding.type, index: binding.location, wgslType: binding.wgslType };
  return attributes;
}

export default class ShaderProgram {
  /** The device state, created on first use (`initialize`); `undefined` while the program is inert. */
  _program: ShaderProgramDeviceState | undefined;

  _gl: unknown;
  _logShaderCompilation: boolean;
  _debugShaders: unknown;
  _attributeLocations: Record<string, number> | undefined;
  _numberOfVertexAttributes: number | undefined;
  _vertexAttributes: Record<string, VertexAttributeRecord> | undefined;
  _uniformsByName: Record<string, UniformSetterLike> | undefined;
  _uniforms: UniformSetterLike[] | undefined;
  _automaticUniforms: { uniform: UniformSetterLike; automaticUniform: AutomaticUniformLike }[] | undefined;
  _manualUniforms: UniformSetterLike[] | undefined;
  _duplicateUniformNames: Record<string, string>;
  /** Used by `ShaderCache` (upstream `ShaderProgram.js:47`). */
  _cachedShader: unknown;

  /**
   * The number of texture units the sampler uniforms occupy; upstream sets it in `reinitialize`
   * (`ShaderProgram.js:493`). This port sets it when the uniform surface is first initialised.
   */
  maximumTextureUnitIndex: number | undefined;

  _vertexShaderSource: ShaderSourceLike;
  _vertexShaderText: string;
  _fragmentShaderSource: ShaderSourceLike;
  _fragmentShaderText: string;

  /** Fresh incrementing identity per program (upstream `nextShaderProgramId`). */
  id: number;

  /** The device-free emission: module texts + reflected structure (T075). */
  readonly wgsl: ShaderProgramWgsl;

  #context: unknown;
  #defines: readonly string[];
  #sceneMode: string;
  #uniformFactory: UniformFactory | undefined;
  #uniformWriter: unknown;
  #gpuStaging: GpuUniformStaging | undefined;
  #uniformDynamicOffset = 0;
  #uniformFrame = -1;
  #lastPipeline: GPURenderPipeline | undefined;
  #lastPipelineKey: PipelineCacheKey | undefined;

  constructor(options: ShaderProgramOptions) {
    if (options === undefined || options === null) {
      throw internalError("`options` is required (upstream `ShaderProgram(options)`, `ShaderCache.js:120-129`).", "ShaderProgram#constructor");
    }
    let vertexShaderText = requireText(options.vertexShaderText, "vertexShaderText");
    let fragmentShaderText = requireText(options.fragmentShaderText, "fragmentShaderText");

    // SpectorJS rewrites `#line` directives for its editor; it is a WebGL tool, so this only ever
    // triggers when a page deliberately installed it (`typeof spector !== "undefined"`, upstream :21).
    if (typeof (globalThis as { spector?: unknown }).spector !== "undefined") {
      vertexShaderText = vertexShaderText.replace(/^#line/gm, "//#line");
      fragmentShaderText = fragmentShaderText.replace(/^#line/gm, "//#line");
    }

    const precisionSupport = options.precisionSupport ?? { float: ContextLimits.highpFloatSupported, int: ContextLimits.highpIntSupported };
    const modifiedFS = handleUniformPrecisionMismatches(vertexShaderText, fragmentShaderText, precisionSupport);

    this._gl = options.gl;
    this._logShaderCompilation = options.logShaderCompilation === true;
    this._debugShaders = options.debugShaders;
    this._attributeLocations = options.attributeLocations;

    this._program = undefined;
    this._numberOfVertexAttributes = undefined;
    this._vertexAttributes = undefined;
    this._uniformsByName = undefined;
    this._uniforms = undefined;
    this._automaticUniforms = undefined;
    this._manualUniforms = undefined;
    this._duplicateUniformNames = modifiedFS.duplicateUniformNames;
    this._cachedShader = undefined;

    this.maximumTextureUnitIndex = undefined;

    this._vertexShaderSource = options.vertexShaderSource;
    this._vertexShaderText = vertexShaderText;
    this._fragmentShaderSource = options.fragmentShaderSource;
    this._fragmentShaderText = modifiedFS.fragmentShaderText;

    this.id = nextShaderProgramId++;

    const defines = collectDefines(options.defines, options.vertexShaderSource, options.fragmentShaderSource);
    this.#context = options.context;
    this.#defines = defines;
    this.#sceneMode = options.sceneMode ?? MVP_SCENE_MODE;
    this.#uniformFactory = options.uniformFactory;
    this.#uniformWriter = options.uniformWriter;

    // ---- device-free half: the T081 guard, then the WGSL module pair -------------------------------
    this.wgsl = emitProgramWgsl(options, this._vertexShaderText, this._fragmentShaderText, defines, options.variantKey ?? variantKeyOf(defines));
    this._vertexAttributes = attributeRecordsOf(this.wgsl.attributeBindings);
    this._numberOfVertexAttributes = Object.keys(this._vertexAttributes).length;

    if (this._logShaderCompilation || this._debugShaders !== undefined) {
      // No driver compile log exists any more; recording the pairs keeps the upstream switch meaningful.
      console.log(`${consolePrefix}Shader program ${this.id} modules: vertex ${this.wgsl.vertexModule.length} B, fragment ${this.wgsl.fragmentModule.length} B`);
    }
  }

  // ---- the read surface (contract R2 / rule A9) --------------------------------------------------

  get vertexShaderSource(): ShaderSourceLike {
    return this._vertexShaderSource;
  }

  get fragmentShaderSource(): ShaderSourceLike {
    return this._fragmentShaderSource;
  }

  /** Reflected from the emission contract — device-free, unlike upstream's `gl.getActiveAttrib`. */
  get vertexAttributes(): Record<string, VertexAttributeRecord> {
    return this._vertexAttributes ?? {};
  }

  get numberOfVertexAttributes(): number {
    return this._numberOfVertexAttributes ?? 0;
  }

  /** Upstream's `allUniforms` (`ShaderProgram.js:122-127`), built on first use by `initializeUniforms`. */
  get allUniforms(): Record<string, UniformSetterLike> {
    initializeUniforms(this);
    return this._uniformsByName ?? {};
  }

  /** The context this program was created for (the replaced `Context`, not exposed upstream). */
  get context(): unknown {
    return this.#context;
  }

  /** The define list the emission used (union of both stages). */
  get defines(): readonly string[] {
    return this.#defines;
  }

  /** The layout the emitted `struct`, the bindings and the uniform setters share. */
  get layout(): BindLayoutResult {
    return this.wgsl.layout;
  }

  /** The emission structure (paired varyings, attribute bindings, overrides, pruning evidence). */
  get structure(): WgslEmissionStructure {
    return this.wgsl.structure;
  }

  /** The stable label of this variant. */
  get variantKey(): string {
    return this.wgsl.variantKey;
  }

  /** `true` once the device resources exist (first `_bind`/`createPipeline`). */
  get initialized(): boolean {
    return this._program !== undefined;
  }

  /** The pipeline created by the last `createPipeline` call, if any (`Context.draw` reads this). */
  get pipeline(): GPURenderPipeline | undefined {
    return this.#lastPipeline;
  }

  /**
   * The replaced `Context`'s draw-input seam: `Context.resolveDrawInputs` reads `program.__webgpu`
   * (`Renderer/Context.ts` § `resolveDrawInputs`). Only real values ever appear here — a pipeline is
   * published after `createPipeline` built it, never invented.
   */
  get __webgpu(): { readonly shaderProgramId: string; readonly pipeline?: GPURenderPipeline; readonly vertexLayout?: readonly VertexAttributeLike[]; readonly bindGroups?: readonly GPUBindGroup[]; readonly dynamicOffsets?: readonly number[] } {
    const staging = this.#gpuStaging;
    return {
      shaderProgramId: String(this.id),
      ...(this.#lastPipeline === undefined ? {} : { pipeline: this.#lastPipeline }),
      ...(staging === undefined ? {} : { bindGroups: [staging.bindGroup], dynamicOffsets: [this.#uniformDynamicOffset] }),
    };
  }

  // ---- upstream statics -------------------------------------------------------------------------

  /**
   * Upstream `ShaderProgram.fromCache` (`ShaderProgram.js:65-73`): delegate to the context's
   * `shaderCache`. The cache key is upstream's and depends on exactly four things — `context` (the
   * cache itself is per context), `vertexShaderSource`, `fragmentShaderSource` and
   * `attributeLocations` (`ShaderCache.js:98-104`).
   */
  static fromCache(options: ShaderProgramOptions): ShaderProgram {
    const context = (options ?? ({} as ShaderProgramOptions)).context;
    const shaderCache = (context as { shaderCache?: { getShaderProgram(options: ShaderProgramOptions): ShaderProgram } } | null | undefined)?.shaderCache;
    if (shaderCache === undefined || typeof shaderCache.getShaderProgram !== "function") {
      throw internalError(
        "`options.context.shaderCache` is required (`ShaderProgram.fromCache` upstream delegates to it, `ShaderProgram.js:72`). Without it the " +
          "variant-level cache — the thing that keeps the program count bounded — would be bypassed.",
        "ShaderProgram.fromCache",
      );
    }
    return shaderCache.getShaderProgram(options);
  }

  /** Upstream `ShaderProgram.replaceCache` (`ShaderProgram.js:75-83`). */
  static replaceCache(options: ShaderProgramOptions): ShaderProgram {
    const context = (options ?? ({} as ShaderProgramOptions)).context;
    const shaderCache = (context as { shaderCache?: { replaceShaderProgram(options: ShaderProgramOptions): ShaderProgram } } | null | undefined)?.shaderCache;
    if (shaderCache === undefined || typeof shaderCache.replaceShaderProgram !== "function") {
      throw internalError("`options.context.shaderCache` is required (`ShaderProgram.replaceCache` upstream delegates to it, `ShaderProgram.js:82`).", "ShaderProgram.replaceCache");
    }
    return shaderCache.replaceShaderProgram(options);
  }

  // ---- the device half (lazy; never in the constructor) -----------------------------------------

  /** Upstream `ShaderProgram.prototype._bind` (`ShaderProgram.js:541-544`) — device work is lazy. */
  _bind(): void {
    initialize(this);
  }

  /** Upstream `ShaderProgram.prototype._setUniforms` (`ShaderProgram.js:546-604`). */
  _setUniforms(uniformMap: Record<string, () => unknown> | undefined, uniformState: unknown, validate?: boolean): void {
    initializeUniforms(this);

    if (uniformMap !== undefined && uniformMap !== null) {
      const manualUniforms = this._manualUniforms ?? [];
      for (let i = 0; i < manualUniforms.length; ++i) {
        const mu = manualUniforms[i] as UniformSetterLike;
        if (!defined(uniformMap[mu.name])) throw new DeveloperError(`Unknown uniform: ${mu.name}`);
        // Invoked **as a method of the map**: upstream's callbacks read `this` (`GlobeSurfaceTileProvider.js:1905`
        // `u_initialColor: function () { return this.properties.initialColor; }`), so a detached call loses
        // the receiver and throws inside the callback (measured in W5).
        mu.value = (uniformMap as Record<string, () => unknown>)[mu.name]!();
      }
    }

    const automaticUniforms = this._automaticUniforms ?? [];
    for (let i = 0; i < automaticUniforms.length; ++i) {
      const au = automaticUniforms[i] as { uniform: UniformSetterLike; automaticUniform: AutomaticUniformLike };
      au.uniform.value = au.automaticUniform.getValue(uniformState);
    }

    // Upstream stages every value first and issues the GL calls afterwards (`ShaderProgram.js:577-587`);
    // here `set()` pushes the changed bytes into the layout-driven writer (T076), which keeps the same
    // "value unchanged ⇒ no write" semantic.
    const uniforms = this._uniforms ?? [];
    for (let i = 0; i < uniforms.length; ++i) (uniforms[i] as UniformSetterLike).set();

    // ---- GPU half (W5): the ring's frame boundary, the command slot and the upload ---------------
    // Upstream's `Context.draw` calls `_setUniforms` before every draw and then binds the uniform
    // buffer. The replacement `Context.draw` does the same (it calls this method and then binds
    // `__webgpu.bindGroups` with `__webgpu.dynamicOffsets`); what follows stages this frame's
    // automatic block and, when the command carries a `uniformMap`, claims a per-command slot that is
    // seeded from it.
    const staging = this.#gpuStaging;
    if (staging !== undefined) {
      const frame = frameNumberOf(this.#context);
      if (frame !== this.#uniformFrame) {
        staging.beginFrame();
        this.#uniformFrame = frame;
      }
      const manual = (uniformMap ?? null) as Record<string, unknown> | null;
      this.#uniformDynamicOffset = manual === null || Object.keys(manual).length === 0 ? 0 : staging.writeCommand(manual);
      staging.flush();
    }

    if (validate === true) {
      // `gl.validateProgram` has no WebGPU counterpart; refusing is the only honest answer.
      throw new DiagnosticError(
        "not-implemented",
        "ShaderProgram._setUniforms(…, validate: true): WebGPU has no `validateProgram`, so the WebGL validation pass cannot be reproduced. " +
          "The backend MUST NOT report a validation it did not run (FR-033); the equivalent guarantee comes from the error scopes (T052) and the " +
          "real-device pipeline check (SH-2 / T078).",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-033", entryPoint: "ShaderProgram#_setUniforms", plannedPhase: "W5 (T078/SH-2 real-device validation)" },
      );
    }
  }

  isDestroyed(): boolean {
    return false;
  }

  /** Upstream `ShaderProgram.prototype.destroy` (`ShaderProgram.js:610-613`). */
  destroy(): void {
    const cached = this._cachedShader as { cache?: { releaseShaderProgram(program: ShaderProgram): void } } | undefined;
    if (cached?.cache === undefined) {
      throw internalError(
        "`destroy()` requires the owning `ShaderCache` (`this._cachedShader.cache`, upstream `ShaderProgram.js:611`); a program that was never " +
          "cached cannot be released. `ShaderCache.getShaderProgram` sets the back-reference.",
        "ShaderProgram#destroy",
      );
    }
    cached.cache.releaseShaderProgram(this);
    return undefined;
  }

  /** Upstream `ShaderProgram.prototype.finalDestroy` (`ShaderProgram.js:615-618`). */
  finalDestroy(): undefined {
    // GPUShaderModule/pipeline-layout handles are garbage-collected rather than destroyed; dropping the
    // references is the whole release step. The pipelines themselves belong to the pipeline cache.
    this._program = undefined;
    this._uniformsByName = undefined;
    this._uniforms = undefined;
    this._automaticUniforms = undefined;
    this._manualUniforms = undefined;
    return destroyObject(this);
  }

  // ---- pipeline creation (through the W2 cache, T048) -------------------------------------------

  /**
   * The `GPUShaderModule` pair and the bind-group layouts of this program, created on first use.
   *
   * @throws a `DiagnosticError` when the context has no WebGPU device (`webgpu/context-device.ts`).
   */
  deviceState(): ShaderProgramDeviceState {
    initialize(this);
    return this._program as ShaderProgramDeviceState;
  }

  /**
   * Build (or reuse) the render pipeline for one draw.
   *
   * The pipeline is **always** obtained through `webgpu/pipeline-cache.ts` (T048), so the cache's
   * hit/miss counters stay the single source of truth for the G-6 compile budget; this method only
   * supplies the key and the factory. Nothing is created before this call — the shader front end is
   * device-free by design.
   */
  createPipeline(request: ProgramPipelineRequest): GPURenderPipeline {
    const state = this.deviceState();
    const renderState = request.renderState;
    const pipelineState = typeof renderState.toPipelineState === "function" ? renderState.toPipelineState(request.passState ?? null) : undefined;
    if (pipelineState === undefined) {
      throw internalError(
        "`request.renderState.toPipelineState()` is required to map the upstream `RenderState` onto the WebGPU pipeline state (T049). " +
          "Reading the fields directly here would duplicate that mapping table.",
        "ShaderProgram#createPipeline",
      );
    }

    const topology = request.topology ?? renderState.topology ?? pipelineState.primitive.topology;
    const colorFormats = request.colorFormats ?? renderState.colorFormats;
    if (colorFormats === undefined || colorFormats.length === 0) {
      throw internalError(
        "the colour formats of the draw are required (they come from the render state or from the pass's attachments). A pipeline created with an " +
          "invented format would silently mismatch the attachment.",
        "ShaderProgram#createPipeline",
      );
    }
    // `null` is a legitimate value here ("this draw has no depth attachment"), so the fallback chain
    // must test for `undefined` rather than use `??` — otherwise an explicit `null` would be replaced.
    const depthFormat = request.depthFormat !== undefined ? request.depthFormat : renderState.depthFormat !== undefined ? renderState.depthFormat : pipelineState.depthStencil.format;
    const sampleCount = request.sampleCount ?? renderState.sampleCount ?? pipelineState.multisample.count;
    const vertexLayout = request.vertexLayout ?? [];
    const parameterVertexBuffers = request.vertexBuffers;

    const key: PipelineCacheKey = {
      shaderProgramId: String(this.id),
      renderStateFingerprint: renderStateFingerprint(renderState),
      vertexLayoutFingerprint: vertexLayoutFingerprint(vertexLayout),
      topology,
      colorFormats,
      depthFormat,
      sampleCount,
    };

    const record = getOrCreatePipeline(key, () => state.device.createRenderPipeline(describePipeline(this, state, key, pipelineState, depthFormat, parameterVertexBuffers)));
    this.#lastPipelineKey = key;
    this.#lastPipeline = record.pipeline as GPURenderPipeline;
    return this.#lastPipeline;
  }

  /** The pipeline-cache key of the last `createPipeline` call (evidence for the artefact suites). */
  get lastPipelineKey(): PipelineCacheKey | undefined {
    return this.#lastPipelineKey;
  }

  /** The uniform factory this program uses (the injected one, else the imported replacements). */
  get uniformFactory(): UniformFactory {
    this.#uniformFactory ??= defaultUniformFactory();
    return this.#uniformFactory;
  }

  /** The device this program's context carries, or a diagnosable failure. */
  get device(): GPUDevice {
    return requireDevice(this.#context, "ShaderProgram#device", UPSTREAM_MODULE);
  }

  /** `true` when the context carries a WebGPU device (the device half is reachable). */
  get hasDevice(): boolean {
    return hasGpuDevice(this.#context);
  }

  /** The scene mode the emitted runtime position functions were chosen by. */
  get sceneMode(): string {
    return this.#sceneMode;
  }

  /** The uniform write sink forwarded to the uniform factory (T076), if any. */
  get uniformWriter(): unknown {
    return this.#uniformWriter;
  }

  /**
   * The GPU staging area of this program's uniform block (W5 integration).
   *
   * Created on first use, because it needs a device and the shader front end is deliberately
   * device-free. The bind group it owns is the one `Context.draw` binds to group 0 with this
   * command's dynamic offset.
   */
  gpuUniformStaging(): GpuUniformStaging {
    this.#gpuStaging ??= createGpuUniformStaging(this.device, this.layout, { label: `cesium-webgpu:program-${this.id}` });
    return this.#gpuStaging;
  }

  /** The staging area, when one has been created (no device work). */
  get hasGpuUniformStaging(): boolean {
    return this.#gpuStaging !== undefined;
  }

  /** The dynamic offset the last `_setUniforms` selected (`0` = the automatic block). */
  get uniformDynamicOffset(): number {
    return this.#uniformDynamicOffset;
  }
}

// ------------------------------------------------------------------------------------------------
// uniform initialisation (device-free, lazy — upstream does this inside `reinitialize`)
// ------------------------------------------------------------------------------------------------

function initializeUniforms(shader: ShaderProgram): void {
  if (defined(shader._uniformsByName)) return;

  const layout = shader.layout;
  const factory = shader.uniformFactory;
  // Production writes through the GPU staging area (the ring's slot 0 for automatic members); the unit
  // layer injects its own sink, and a program without a device stays device-free. The sink is the
  // `UniformStaging` itself — the GPU wrapper owns the buffer/bind group and delegates the encoding.
  const writer = shader.uniformWriter ?? (shader.hasDevice ? shader.gpuUniformStaging().staging : undefined);
  const factoryOptions: UniformFactoryOptions = {
    layout,
    ...(writer === undefined ? {} : { writer }),
  };

  const uniformsByName: Record<string, UniformSetterLike> = {};
  const uniforms: UniformSetterLike[] = [];
  const samplerUniforms: UniformSetterLike[] = [];

  // Numeric members: one setter per `struct` member, exactly like upstream's per-active-uniform setter.
  for (const member of layout.members) {
    const setter = factory.createUniform(null, { name: member.name, glslType: member.glslType, size: member.length }, member.name, undefined, factoryOptions);
    uniformsByName[member.name] = setter;
    uniforms.push(setter);
  }

  // Samplers are not `struct` members: one setter per GLSL sampler name (arrays take the element count).
  const samplerNames = [...new Set(layout.samplers.map((sampler) => sampler.glslName))];
  for (const name of samplerNames) {
    const elements = layout.samplers.filter((sampler) => sampler.glslName === name);
    const glslType = elements[0]?.glslType ?? "sampler2D";
    const setter =
      elements.length > 1
        ? factory.createUniformArray(null, { name, glslType, size: elements.length }, name, elements.length, factoryOptions)
        : factory.createUniform(null, { name, glslType, size: 1 }, name, undefined, factoryOptions);
    uniformsByName[name] = setter;
    uniforms.push(setter);
    samplerUniforms.push(setter);
  }

  const partitioned = partitionUniforms(shader, uniformsByName);
  shader._uniformsByName = uniformsByName;
  shader._uniforms = uniforms;
  shader._automaticUniforms = partitioned.automaticUniforms;
  shader._manualUniforms = partitioned.manualUniforms;
  shader.maximumTextureUnitIndex = setSamplerUniforms(samplerUniforms);
}

// ------------------------------------------------------------------------------------------------
// device initialisation (lazy)
// ------------------------------------------------------------------------------------------------

function initialize(shader: ShaderProgram): void {
  if (defined(shader._program)) return;
  reinitialize(shader);
}

/** The device resources of one program; created once, on first use. */
function reinitialize(shader: ShaderProgram): void {
  const device = requireDevice(shader.context, "ShaderProgram#initialize", UPSTREAM_MODULE);
  const label = `cesium-webgpu:program-${shader.id}`;

  // The module texts are the emission's artefacts: exactly two `createShaderModule` calls per program,
  // which is what keeps the compile count at `2 × distinct module texts` (G-6 rev3).
  const vertexModule = device.createShaderModule({ label: `${label}:vs`, code: shader.wgsl.vertexModule });
  const fragmentModule = device.createShaderModule({ label: `${label}:fs`, code: shader.wgsl.fragmentModule });

  // Group 0 is the uniform block, and its layout comes from the staging area that owns the bind group:
  // a pipeline layout and a bind group that disagree (e.g. `hasDynamicOffset`) would fail at draw time.
  // The staging area also decides the per-command dynamic offsets `Context.draw` passes.
  const staging = shader.gpuUniformStaging();
  const samplerEntries: GPUBindGroupLayoutEntry[] = [];
  for (const sampler of shader.layout.samplers) {
    samplerEntries.push({ binding: sampler.textureBinding, visibility: SHADER_STAGE_VERTEX_FRAGMENT, texture: { sampleType: "float", viewDimension: viewDimensionOf(sampler.textureType) } });
    samplerEntries.push({ binding: sampler.samplerBinding, visibility: SHADER_STAGE_VERTEX_FRAGMENT, sampler: { type: "filtering" } });
  }

  const bindGroupLayouts: GPUBindGroupLayout[] = [staging.bindGroupLayout];
  if (samplerEntries.length > 0) bindGroupLayouts.push(device.createBindGroupLayout({ label: `${label}:group1`, entries: samplerEntries }));
  void uniformBlockLayoutEntries;

  shader._program = {
    device,
    vertexModule,
    fragmentModule,
    bindGroupLayouts,
    pipelineLayout: device.createPipelineLayout({ label: `${label}:layout`, bindGroupLayouts }),
  };
}

/** The `GPUTextureViewDimension` of a WGSL texture type (`bind-layout.ts`'s sampler table). */
function viewDimensionOf(textureType: string): GPUTextureViewDimension {
  if (textureType.startsWith("texture_cube")) return "cube";
  if (textureType.startsWith("texture_3d")) return "3d";
  if (textureType.startsWith("texture_2d_array")) return "2d-array";
  if (textureType.startsWith("texture_1d")) return "1d";
  return "2d";
}

/** The vertex-buffer layout derived from the emission contract (the upstream terrain layout). */
function defaultVertexBuffers(shader: ShaderProgram): readonly GPUVertexBufferLayout[] {
  const attributes = attributeLayoutFromContract(shader.wgsl.contract);
  if (attributes.length === 0) return [];
  const stride = attributes[0]?.arrayStride ?? 0;
  return [
    {
      arrayStride: stride,
      attributes: attributes.map((attribute) => ({ shaderLocation: attribute.location, offset: attribute.offset, format: attribute.format as GPUVertexFormat })),
    },
  ];
}

/** The `GPURenderPipelineDescriptor` for one cache key (the factory the pipeline cache invokes). */
function describePipeline(
  shader: ShaderProgram,
  state: ShaderProgramDeviceState,
  key: PipelineCacheKey,
  pipelineState: NonNullable<ReturnType<NonNullable<ProgramRenderStateLike["toPipelineState"]>>>,
  depthFormat: string | null,
  parameterVertexBuffers: readonly GPUVertexBufferLayout[] | undefined,
): GPURenderPipelineDescriptor {
  const primitive = pipelineState.primitive;
  const stripIndexFormat = primitive.stripIndexFormat;
  const depthStencil = pipelineState.depthStencil;

  return {
    label: `cesium-webgpu:${key.shaderProgramId}:${key.topology}:samples=${key.sampleCount}`,
    layout: state.pipelineLayout,
    vertex: {
      module: state.vertexModule,
      entryPoint: VERTEX_ENTRY_POINT,
      buffers: parameterVertexBuffers ?? defaultVertexBuffers(shader),
    },
    fragment: {
      module: state.fragmentModule,
      entryPoint: FRAGMENT_ENTRY_POINT,
      targets: key.colorFormats.map((format, index) => {
        const target = pipelineState.targets[index];
        return {
          format: format as GPUTextureFormat,
          writeMask: target?.writeMask ?? 0xf,
          ...(target?.blend === undefined ? {} : { blend: target.blend }),
        };
      }),
    },
    primitive: {
      topology: key.topology as GPUPrimitiveTopology,
      cullMode: primitive.cullMode,
      frontFace: primitive.frontFace,
      ...(stripIndexFormat === undefined ? {} : { stripIndexFormat }),
    },
    ...(depthFormat === null
      ? {}
      : {
          depthStencil: {
            format: depthFormat as GPUTextureFormat,
            depthWriteEnabled: depthStencil.depthWriteEnabled,
            depthCompare: depthStencil.depthCompare,
            depthBias: depthStencil.depthBias,
            depthBiasSlopeScale: depthStencil.depthBiasSlopeScale,
            depthBiasClamp: depthStencil.depthBiasClamp,
            stencilFront: depthStencil.stencilFront,
            stencilBack: depthStencil.stencilBack,
            stencilReadMask: depthStencil.stencilReadMask,
            stencilWriteMask: depthStencil.stencilWriteMask,
          },
        }),
    multisample: { count: key.sampleCount },
  };
}
