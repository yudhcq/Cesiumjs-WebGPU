/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Slice-C surface registry (tasks.md T053, research §6.1/§7, contract render-path-api.md §6).
 *
 * The MVP reaches a terrain path and nothing else. Everything outside it — picking read-back,
 * `readPixels`, fence `Sync`, cube maps, 3D textures, texture atlases, the GPGPU `ComputeEngine` and
 * the GL context multiplexer `SharedContext` — MUST fail with `category: "not-implemented"` and a
 * message that names the owning phase. Returning an empty result, a black frame or "0 pixels read"
 * would be indistinguishable from a correct render and is forbidden by FR-033.
 *
 * The registry is the single source of that vocabulary, so the `Context` face, the replaced modules
 * and the unit test all agree on the wording, and so a capability that silently disappears from the
 * failure list is itself detectable.
 */
import { notImplemented, type DiagnosticError } from "./errors.js";

/** One capability outside the MVP, with the phase that will own it. */
export interface SliceCSurfaceEntry {
  /** Entry point as the logic layer reaches it (`Context#readPixels`, `CubeMap`, …). */
  readonly capability: string;
  /** Where the failure is raised. */
  readonly surface: "context" | "module" | "shader" | "shared-context";
  /** Upstream module the entry point belongs to. */
  readonly upstreamModule: string;
  /** Task/phase that will implement it (the message MUST name it). */
  readonly plannedPhase: string;
  /** Why it is out of scope for this increment. */
  readonly reason: string;
  /** `upstreamModule` value of the matching `manifest.json` entry, when the capability is a module. */
  readonly manifestModule?: string;
}

/**
 * The slice-C boundary. `Tasks.md` T053 names `readPixels`/`readPixelsToPBO`/`Sync`/`CubeMap`/
 * `Texture3D`/`TextureAtlas`/`ComputeEngine` explicitly; `createPickId`/`getObjectByPickColor` and
 * `defaultCubeMap` are the remaining `Context` members whose only implementation would be a pick /
 * cube-map read-back (research §6.1), and `SharedContext` is the GL multiplexer research §6.1 lists as
 * having no WebGPU counterpart.
 */
export const SLICE_C_SURFACE: readonly SliceCSurfaceEntry[] = [
  {
    capability: "readPixels",
    surface: "context",
    upstreamModule: "Renderer/Context.js",
    plannedPhase: "slice C (blocking read-back; see research §7 and T097/T098a for the offscreen-depth half)",
    reason: "webgl2 的同步回读在 WebGPU 无等价物（`copyTextureToBuffer` + `mapAsync` 是异步的），忙等会破坏 SC-004 的交互流畅性。",
  },
  {
    capability: "readPixelsToPBO",
    surface: "context",
    upstreamModule: "Renderer/Context.js",
    plannedPhase: "slice C (asynchronous read-back pipeline)",
    reason: "同上：PBO 语义在 WebGPU 由 `mapAsync` + 环形缓冲承担，属切片 C。",
  },
  {
    capability: "createPickId",
    surface: "context",
    upstreamModule: "Renderer/Context.js",
    plannedPhase: "slice C (picking)",
    reason: "pick id 依赖 pick framebuffer 回读（`Scene/PickFramebuffer.js`），属 picking 增量。",
  },
  {
    capability: "getObjectByPickColor",
    surface: "context",
    upstreamModule: "Renderer/Context.js",
    plannedPhase: "slice C (picking)",
    reason: "同上：需要先有 pick 回读结果。",
  },
  {
    capability: "defaultCubeMap",
    surface: "context",
    upstreamModule: "Renderer/Context.js",
    plannedPhase: "slice C (CubeMap)",
    reason: "立方体贴图在本增量只交付显式失败桩（skyBox 关闭，地形路径不可达）。",
  },
  {
    capability: "defaultEmissiveTexture",
    surface: "context",
    upstreamModule: "Renderer/Context.js",
    plannedPhase: "W3 (T056 `Renderer/Texture` replacement)",
    reason: "upstream 的 1×1 占位纹理是 `Texture` 实例；替换实现落地前不得返回一个假的纹理对象。",
  },
  {
    capability: "defaultNormalTexture",
    surface: "context",
    upstreamModule: "Renderer/Context.js",
    plannedPhase: "W3 (T056 `Renderer/Texture` replacement)",
    reason: "同上（模型法线占位纹理）。",
  },
  { capability: "Texture3D", surface: "module", upstreamModule: "Renderer/Texture3D.js", manifestModule: "Renderer/Texture3D.js", plannedPhase: "slice C (3D textures / voxel paths)", reason: "地形 MVP 不可达；只交付显式失败桩。" },
  { capability: "CubeMap", surface: "module", upstreamModule: "Renderer/CubeMap.js", manifestModule: "Renderer/CubeMap.js", plannedPhase: "slice C (skyBox / IBL)", reason: "地形 MVP 不可达；只交付显式失败桩。" },
  { capability: "CubeMapFace", surface: "module", upstreamModule: "Renderer/CubeMapFace.js", manifestModule: "Renderer/CubeMapFace.js", plannedPhase: "slice C (skyBox / IBL)", reason: "随 CubeMap 一并落在切片 C 之外。" },
  { capability: "TextureAtlas", surface: "module", upstreamModule: "Renderer/TextureAtlas.js", manifestModule: "Renderer/TextureAtlas.js", plannedPhase: "slice C (billboards / labels)", reason: "图集属模型/标签路径，不在 MVP 范围。" },
  { capability: "Sync", surface: "module", upstreamModule: "Renderer/Sync.js", manifestModule: "Renderer/Sync.js", plannedPhase: "slice C (fence/read-back synchronisation)", reason: "GL fence 在 WebGPU 由 `mapAsync` 承担。" },
  {
    capability: "ComputeEngine",
    surface: "module",
    upstreamModule: "Renderer/ComputeEngine.js",
    plannedPhase: "slice C (GPGPU paths)",
    reason: "MVP 场景配置（`baseLayer:false`/`skyBox:false`/`skyAtmosphere:false`）保证零派发；一旦到达即报错。",
  },
  {
    capability: "SharedContext",
    surface: "shared-context",
    upstreamModule: "Renderer/SharedContext.js",
    plannedPhase: "not planned: WebGPU has no shared-context multiplexer",
    reason: "GL 上下文多路复用 + 2D blit 在 WebGPU 无对应语义，且本增量不存在多上下文场景。",
  },
];

/** Look one entry up by capability (throws for an unknown name — the registry is closed). */
export function sliceCEntry(capability: string): SliceCSurfaceEntry {
  const entry = SLICE_C_SURFACE.find((candidate) => candidate.capability === capability);
  if (entry === undefined) {
    throw new Error(
      `not-implemented registry: "${capability}" is not a known slice-C capability. Adding a failure MUST go through ` +
        "SLICE_C_SURFACE so the boundary stays enumerable (T053).",
    );
  }
  return entry;
}

/** The `localFile` values `manifest.json` MUST mark `stub-not-implemented` (T031/T053 agreement). */
export function stubManifestModules(): readonly string[] {
  return SLICE_C_SURFACE.filter((entry) => entry.manifestModule !== undefined).map((entry) => entry.manifestModule as string);
}

/** Build the diagnosable error for one slice-C capability. */
export function sliceCNotImplemented(capability: string): DiagnosticError {
  const entry = sliceCEntry(capability);
  return notImplemented(capability, {
    upstreamModule: entry.upstreamModule,
    entryPoint: entry.surface === "context" ? `Context#${capability}` : capability,
    plannedPhase: entry.plannedPhase,
    requirementRef: "FR-033",
    extra: { reason: entry.reason, surface: entry.surface },
  });
}

/**
 * Fail loudly for `SharedContext` under the WebGPU path (contract §9).
 *
 * Kept separate from the generic helper because the message MUST say *why* there is no counterpart,
 * rather than only naming a phase.
 */
export function sharedContextNotImplemented(): DiagnosticError {
  const entry = sliceCEntry("SharedContext");
  return notImplemented("SharedContext (GL context multiplexing / 2D blit)", {
    upstreamModule: entry.upstreamModule,
    entryPoint: "SharedContext",
    plannedPhase: entry.plannedPhase,
    requirementRef: "FR-033",
    extra: { reason: entry.reason },
  });
}
