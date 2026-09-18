/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * T059 — `Sampler` semantics → `GPUSamplerDescriptor` (research §6.1, tasks.md T059, FR-030).
 *
 * `Renderer/Sampler.js` is a **kept** upstream module: it holds no GL state and is consumed
 * byte-identically (its hash is in `manifest.json → keptModules`). The backend therefore never
 * replaces it; it *reads* it. That is why this module works on the six values a `Sampler` exposes
 * (`wrapS`/`wrapT`/`wrapR`/`minificationFilter`/`magnificationFilter`/`maximumAnisotropy`) and
 * returns a `GPUSamplerDescriptor` — there is exactly one place where `Sampler` becomes a GPU
 * object, so two textures can never sample the same sampler differently.
 *
 * Two upstream members have no WebGPU counterpart and are handled explicitly rather than silently:
 *
 *   - **mipmap minification filters** map onto the `(minFilter, mipmapFilter)` pair, which is a
 *     *split* of one GL enum into two WebGPU fields (not a degradation);
 *   - **`maximumAnisotropy > 1`** has no core-WebGPU counterpart at all (the `maxAnisotropy`
 *     sampler member is a separate proposal). It is **recorded** in `anisotropyRecords` and
 *     surfaced through `samplerMappingNotes()`, because FR-023 forbids an undeclared approximation.
 *     Nothing in the MVP reaches it: the replacement `Context` publishes
 *     `textureFilterAnisotropic === false`, so upstream's `maximumTextureFilterAnisotropy` is 1 and
 *     every caller keeps the default (G-2 / `docs/gate-g2-conclusion.md`).
 */
import TextureMagnificationFilter from "@cesium/engine/Source/Renderer/TextureMagnificationFilter.js";
import TextureMinificationFilter from "@cesium/engine/Source/Renderer/TextureMinificationFilter.js";
import TextureWrap from "@cesium/engine/Source/Renderer/TextureWrap.js";

import { DiagnosticError } from "./errors.js";

const UPSTREAM_MODULE = "Renderer/Sampler.js";

/** `TextureWrap.*` → `GPUAddressMode`, covering all three upstream members. */
export const WRAP_TO_ADDRESS_MODE: Readonly<Record<number, GPUAddressMode>> = Object.freeze({
  [TextureWrap.CLAMP_TO_EDGE]: "clamp-to-edge",
  [TextureWrap.REPEAT]: "repeat",
  [TextureWrap.MIRRORED_REPEAT]: "mirror-repeat",
});

/**
 * `TextureMinificationFilter.*` → the `(minFilter, mipmapFilter)` pair.
 *
 * GL folds "how to filter inside a level" and "how to pick between levels" into one enum; WebGPU
 * keeps them apart. Every one of the six upstream members is listed, so a new member cannot fall
 * through unnoticed.
 */
export const MINIFICATION_TO_FILTERS: Readonly<Record<number, { readonly minFilter: GPUFilterMode; readonly mipmapFilter: GPUMipmapFilterMode }>> = Object.freeze({
  [TextureMinificationFilter.NEAREST]: { minFilter: "nearest", mipmapFilter: "nearest" },
  [TextureMinificationFilter.LINEAR]: { minFilter: "linear", mipmapFilter: "nearest" },
  [TextureMinificationFilter.NEAREST_MIPMAP_NEAREST]: { minFilter: "nearest", mipmapFilter: "nearest" },
  [TextureMinificationFilter.LINEAR_MIPMAP_NEAREST]: { minFilter: "linear", mipmapFilter: "nearest" },
  [TextureMinificationFilter.NEAREST_MIPMAP_LINEAR]: { minFilter: "nearest", mipmapFilter: "linear" },
  [TextureMinificationFilter.LINEAR_MIPMAP_LINEAR]: { minFilter: "linear", mipmapFilter: "linear" },
});

/** `TextureMagnificationFilter.*` → `GPUFilterMode` (magnification only has nearest/linear). */
export const MAGNIFICATION_TO_FILTER: Readonly<Record<number, GPUFilterMode>> = Object.freeze({
  [TextureMagnificationFilter.NEAREST]: "nearest",
  [TextureMagnificationFilter.LINEAR]: "linear",
});

/** The six values a `Sampler` exposes; the backend reads them, it never owns the object. */
export interface SamplerLike {
  readonly wrapS?: number | undefined;
  readonly wrapT?: number | undefined;
  readonly wrapR?: number | undefined;
  readonly minificationFilter?: number | undefined;
  readonly magnificationFilter?: number | undefined;
  readonly maximumAnisotropy?: number | undefined;
}

/** One recorded anisotropy request that WebGPU could not honour. */
export interface AnisotropyRecord {
  /** What the logic layer asked for (`Sampler#maximumAnisotropy`). */
  readonly requested: number;
  /** What the sampler actually filters with (always `1` — WebGPU's fixed value). */
  readonly applied: 1;
  /** Why the value could not be honoured. */
  readonly reason: string;
  /** How often this exact value has been requested in this session. */
  readonly count: number;
}

export interface SamplerMapping {
  readonly descriptor: GPUSamplerDescriptor;
  /** `true` when every upstream member mapped exactly; `false` when something was recorded. */
  readonly exact: boolean;
  /** Recorded approximations (empty for every sampler the MVP can construct). */
  readonly notes: readonly string[];
}

const anisotropyRequests = new Map<number, AnisotropyRecord>();

/** Every anisotropy request WebGPU could not honour, one entry per distinct requested value (FR-023). */
export function anisotropyRecords(): readonly AnisotropyRecord[] {
  return [...anisotropyRequests.values()].map((record) => ({ ...record }));
}

/** Human-readable notes for the status surface; empty while every sampler maps exactly. */
export function samplerMappingNotes(): readonly string[] {
  return [...anisotropyRequests.values()].map(
    (record) =>
      `sampler.maximumAnisotropy=${record.requested} requested ${record.count} time(s): WebGPU core has no anisotropic sampler; ` +
      "filtering stays isotropic (1x)",
  );
}

/** Test/lifecycle hook: forget the recorded anisotropy requests (one backend per session). */
export function resetSamplerMappingRecords(): void {
  anisotropyRequests.clear();
}

function invalidMember(member: string, value: unknown): never {
  throw new DiagnosticError(
    "internal",
    `sampler-map: ${member}=${String(value)} is not a valid upstream enum member (the kept Sampler validates the same value). ` +
      "The replacement MUST fail loudly rather than fall back to a default filter, which would silently change every sampled image.",
    {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "sampler-map.mapSampler",
      requirementRef: "FR-030",
      extra: { member, value: String(value) },
    },
  );
}

/**
 * Map an upstream `Sampler` (or anything with the same six values) to a `GPUSamplerDescriptor`.
 *
 * @param sampler the upstream `Sampler` instance the logic layer attached to a texture
 * @param options `label` for the GPU object; `maxAnisotropy` is accepted only so the caller can
 *   pass the advertised limit through — the MVP publishes `1`.
 */
export function mapSampler(sampler: SamplerLike, options: { label?: string; maxAnisotropy?: number } = {}): SamplerMapping {
  const wrapS = sampler.wrapS ?? TextureWrap.CLAMP_TO_EDGE;
  const wrapT = sampler.wrapT ?? TextureWrap.CLAMP_TO_EDGE;
  const wrapR = sampler.wrapR ?? TextureWrap.CLAMP_TO_EDGE;
  const minificationFilter = sampler.minificationFilter ?? TextureMinificationFilter.LINEAR;
  const magnificationFilter = sampler.magnificationFilter ?? TextureMagnificationFilter.LINEAR;
  const maximumAnisotropy = sampler.maximumAnisotropy ?? 1.0;

  if (!TextureWrap.validate(wrapS)) invalidMember("sampler.wrapS", wrapS);
  if (!TextureWrap.validate(wrapT)) invalidMember("sampler.wrapT", wrapT);
  if (!TextureWrap.validate(wrapR)) invalidMember("sampler.wrapR", wrapR);
  if (!TextureMinificationFilter.validate(minificationFilter)) invalidMember("sampler.minificationFilter", minificationFilter);
  if (!TextureMagnificationFilter.validate(magnificationFilter)) invalidMember("sampler.magnificationFilter", magnificationFilter);

  const minification = MINIFICATION_TO_FILTERS[minificationFilter];
  const magnification = MAGNIFICATION_TO_FILTER[magnificationFilter];
  const addressModeU = WRAP_TO_ADDRESS_MODE[wrapS];
  const addressModeV = WRAP_TO_ADDRESS_MODE[wrapT];
  const addressModeW = WRAP_TO_ADDRESS_MODE[wrapR];
  if (minification === undefined || magnification === undefined || addressModeU === undefined || addressModeV === undefined || addressModeW === undefined) {
    invalidMember("sampler", `${wrapS}/${wrapT}/${wrapR}/${minificationFilter}/${magnificationFilter}`);
  }

  const notes: string[] = [];
  if (maximumAnisotropy > 1) {
    const existing = anisotropyRequests.get(maximumAnisotropy);
    anisotropyRequests.set(maximumAnisotropy, {
      requested: maximumAnisotropy,
      applied: 1,
      reason: "WebGPU core exposes no anisotropic sampler (the `maxAnisotropy` member is a separate proposal); the sampler filters isotropically",
      count: (existing?.count ?? 0) + 1,
    });
    notes.push(
      `maximumAnisotropy=${maximumAnisotropy} is recorded but not applied: WebGPU core filtering is isotropic (1×). ` +
        "The replacement Context publishes `textureFilterAnisotropic === false`, so upstream's maximum stays 1 (FR-023).",
    );
  }

  const descriptor: GPUSamplerDescriptor = {
    ...(options.label === undefined ? {} : { label: options.label }),
    addressModeU,
    addressModeV,
    addressModeW,
    magFilter: magnification,
    minFilter: minification.minFilter,
    mipmapFilter: minification.mipmapFilter,
    // No `lodMinClamp`/`lodMaxClamp`/`compare`: upstream's `Sampler` has no member for them, and a
    // free choice here would silently change sampling. WebGPU's defaults are used instead.
  };

  return { descriptor, exact: notes.length === 0, notes };
}

/** The upstream enum members the two tables MUST cover (asserted by the unit test). */
export const SAMPLER_ENUM_MEMBERS = {
  wraps: [TextureWrap.CLAMP_TO_EDGE, TextureWrap.REPEAT, TextureWrap.MIRRORED_REPEAT],
  minificationFilters: [
    TextureMinificationFilter.NEAREST,
    TextureMinificationFilter.LINEAR,
    TextureMinificationFilter.NEAREST_MIPMAP_NEAREST,
    TextureMinificationFilter.LINEAR_MIPMAP_NEAREST,
    TextureMinificationFilter.NEAREST_MIPMAP_LINEAR,
    TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
  ],
  magnificationFilters: [TextureMagnificationFilter.NEAREST, TextureMagnificationFilter.LINEAR],
} as const;

export const upstreamSamplerEnums = { TextureWrap, TextureMinificationFilter, TextureMagnificationFilter } as const;
