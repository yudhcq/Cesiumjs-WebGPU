/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/ShaderCache.js`
 * (kind: "adapt") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * WHY THIS MODULE IS IMPLEMENTED IN W2 (tasks.md T043 finding)
 *   The replacement `Context` constructs the cache exactly like upstream (`Context.js:81`), and the
 *   logic layer reads `context.shaderCache` in 32 places. Under the **full** manifest the upstream
 *   `ShaderCache` is replaced too, so a placeholder that threw on construction would make the whole
 *   upstream `Scene` constructor fail — i.e. T043's "construct-time takeover" could not be true.
 *   The cache bookkeeping (keyword → cached program, reference counting, deferred release) is
 *   therefore real here, and the **program creation step** is delegated to the replaced
 *   `ShaderProgram`, which raises a diagnosable `not-implemented` until W4 (T075) lands. Nothing is
 *   silently skipped: reaching a shader program fails loudly, and every cache operation around it
 *   behaves exactly as upstream.
 *
 * The cache key format is upstream's (`vertexShaderKey:fragmentShaderKey:attributeLocations`), so the
 * variant-level key semantics the logic layer relies on (`GlobeSurfaceShaderSet`'s
 * `[numberOfDayTextures][flags]` variants) stay intact once the program side lands.
 */
import defined from "@cesium/engine/Source/Core/defined.js";
import destroyObject from "@cesium/engine/Source/Core/destroyObject.js";

import ShaderProgram from "./ShaderProgram.js";
import ShaderSource from "./ShaderSource.js";

interface CacheEntry {
  cache: ShaderCache;
  shaderProgram: ShaderProgramLike;
  keyword: string;
  derivedKeywords: string[];
  count: number;
}

interface ShaderProgramLike {
  finalDestroy?: () => void;
  destroy?: () => void;
  _cachedShader?: CacheEntry;
}

interface ShaderSourceLike {
  getCacheKey(): string;
}

export interface ShaderCacheOptions {
  shaderProgram?: ShaderProgramLike | undefined;
  vertexShaderSource?: string | ShaderSourceLike;
  fragmentShaderSource?: string | ShaderSourceLike;
  attributeLocations?: Record<string, number> | undefined;
  [key: string]: unknown;
}

function toSortedJson(dictionary: Record<string, number>): string {
  const sortedKeys = Object.keys(dictionary).sort();
  return JSON.stringify(dictionary, sortedKeys);
}

/** Shader-program cache with upstream's keyword scheme and reference counting. */
export default class ShaderCache {
  readonly _context: unknown;
  readonly _shaders: Record<string, CacheEntry> = {};
  _numberOfShaders = 0;
  _shadersToRelease: Record<string, CacheEntry> = {};

  constructor(context: unknown) {
    this._context = context;
  }

  get numberOfShaders(): number {
    return this._numberOfShaders;
  }

  /** Destroy the previous program (if any) and return the cached/created one. */
  replaceShaderProgram(options: ShaderCacheOptions): ShaderProgramLike {
    if (defined(options.shaderProgram)) options.shaderProgram?.destroy?.();
    return this.getShaderProgram(options);
  }

  /**
   * Return the cached program for this variant, or create it through the replaced `ShaderProgram`.
   *
   * @throws a `DiagnosticError` (`not-implemented`, W4 / T075) as soon as the program itself has to be
   *   built — which is where the WGSL front-end is required.
   */
  getShaderProgram(options: ShaderCacheOptions): ShaderProgramLike {
    let vertexSourceInput = options.vertexShaderSource;
    let fragmentSourceInput = options.fragmentShaderSource;
    const attributeLocations = options.attributeLocations;

    if (typeof vertexSourceInput === "string") vertexSourceInput = new (ShaderSource as unknown as new (options: unknown) => ShaderSourceLike)({ sources: [vertexSourceInput] });
    if (typeof fragmentSourceInput === "string") fragmentSourceInput = new (ShaderSource as unknown as new (options: unknown) => ShaderSourceLike)({ sources: [fragmentSourceInput] });

    const vertexShaderKey = (vertexSourceInput as ShaderSourceLike).getCacheKey();
    const fragmentShaderKey = (fragmentSourceInput as ShaderSourceLike).getCacheKey();
    const attributeLocationKey = defined(attributeLocations) ? toSortedJson(attributeLocations as Record<string, number>) : "";
    const keyword = `${vertexShaderKey}:${fragmentShaderKey}:${attributeLocationKey}`;

    let cachedShader = this._shaders[keyword] as CacheEntry | undefined;
    if (defined(cachedShader)) {
      // No longer want to release this if it was previously released.
      delete this._shadersToRelease[keyword];
    } else {
      const context = this._context as { _gl?: unknown; logShaderCompilation?: boolean; debugShaders?: boolean };
      const shaderProgram = new (ShaderProgram as unknown as new (options: unknown) => ShaderProgramLike)({
        context,
        gl: context?._gl,
        logShaderCompilation: context?.logShaderCompilation,
        debugShaders: context?.debugShaders,
        vertexShaderSource: vertexSourceInput,
        fragmentShaderSource: fragmentSourceInput,
        attributeLocations,
      });
      cachedShader = { cache: this, shaderProgram, keyword, derivedKeywords: [], count: 0 };
      shaderProgram._cachedShader = cachedShader as CacheEntry;
      this._shaders[keyword] = cachedShader as CacheEntry;
      this._numberOfShaders += 1;
    }

    (cachedShader as CacheEntry).count += 1;
    return (cachedShader as CacheEntry).shaderProgram;
  }
  getDerivedShaderProgram(shaderProgram: ShaderProgramLike, keyword: string): ShaderProgramLike | undefined {
    const cachedShader = shaderProgram._cachedShader;
    if (cachedShader === undefined) return undefined;
    return this._shaders[`${keyword}${cachedShader.keyword}`]?.shaderProgram;
  }

  createDerivedShaderProgram(shaderProgram: ShaderProgramLike, keyword: string, options: ShaderCacheOptions): ShaderProgramLike {
    const cachedShader = shaderProgram._cachedShader as CacheEntry;
    const derivedKeyword = `${keyword}${cachedShader.keyword}`;
    let vertexSourceInput = options.vertexShaderSource;
    let fragmentSourceInput = options.fragmentShaderSource;
    if (typeof vertexSourceInput === "string") vertexSourceInput = new (ShaderSource as unknown as new (options: unknown) => ShaderSourceLike)({ sources: [vertexSourceInput] });
    if (typeof fragmentSourceInput === "string") fragmentSourceInput = new (ShaderSource as unknown as new (options: unknown) => ShaderSourceLike)({ sources: [fragmentSourceInput] });

    const derivedShaderProgram = new (ShaderProgram as unknown as new (options: unknown) => ShaderProgramLike)({
      context: this._context,
      vertexShaderSource: vertexSourceInput,
      fragmentShaderSource: fragmentSourceInput,
      attributeLocations: options.attributeLocations,
    });
    const derivedCachedShader: CacheEntry = { cache: this, shaderProgram: derivedShaderProgram, keyword: derivedKeyword, derivedKeywords: [], count: 0 };
    cachedShader.derivedKeywords.push(keyword);
    derivedShaderProgram._cachedShader = derivedCachedShader;
    this._shaders[derivedKeyword] = derivedCachedShader;
    return derivedShaderProgram;
  }

  replaceDerivedShaderProgram(shaderProgram: ShaderProgramLike, keyword: string, options: ShaderCacheOptions): ShaderProgramLike {
    const cachedShader = shaderProgram._cachedShader as CacheEntry;
    const derivedKeyword = `${keyword}${cachedShader.keyword}`;
    const cachedDerivedShader = this._shaders[derivedKeyword];
    if (defined(cachedDerivedShader)) {
      this.#destroyShader(cachedDerivedShader as CacheEntry);
      const index = cachedShader.derivedKeywords.indexOf(keyword);
      if (index > -1) cachedShader.derivedKeywords.splice(index, 1);
    }
    return this.createDerivedShaderProgram(shaderProgram, keyword, options);
  }

  #destroyShader(cachedShader: CacheEntry): void {
    for (const keyword of cachedShader.derivedKeywords) {
      const derived = this._shaders[`${keyword}${cachedShader.keyword}`];
      if (defined(derived)) this.#destroyShader(derived as CacheEntry);
    }
    delete this._shaders[cachedShader.keyword];
    cachedShader.shaderProgram.finalDestroy?.();
  }

  destroyReleasedShaderPrograms(): void {
    const shadersToRelease = this._shadersToRelease;
    for (const keyword of Object.keys(shadersToRelease)) {
      this.#destroyShader(shadersToRelease[keyword] as CacheEntry);
      this._numberOfShaders -= 1;
    }
    this._shadersToRelease = {};
  }

  releaseShaderProgram(shaderProgram: ShaderProgramLike | undefined): void {
    if (!defined(shaderProgram)) return;
    const cachedShader = shaderProgram?._cachedShader;
    if (defined(cachedShader) && (cachedShader as CacheEntry).count-- === 1) {
      this._shadersToRelease[(cachedShader as CacheEntry).keyword] = cachedShader as CacheEntry;
    }
  }

  isDestroyed(): boolean {
    return false;
  }

  destroy(): void {
    for (const keyword of Object.keys(this._shaders)) this._shaders[keyword]?.shaderProgram.finalDestroy?.();
    return destroyObject(this) as unknown as void;
  }

  /** Cache statistics (evidence for the variant-level budget of T079 / G-6). */
  get numberOfCachedPrograms(): number {
    return Object.keys(this._shaders).length;
  }
}
