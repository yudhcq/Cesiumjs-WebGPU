/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/TextureCache.js`
 * (kind: "adapt") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * The upstream module is **GL-free** (its `glCallSites` count is 0): it is pure reference-counted
 * bookkeeping over `Texture` objects. The replacement keeps the semantics verbatim — keyword →
 * `{texture, count}`, `destroy()` deferred until the last reference is released, then
 * `destroyReleasedTextures()` — because two places depend on them:
 *   - the replacement `Context` constructs it (`Context.js:82`) and the logic layer reads
 *     `context.textureCache` (`Scene/Scene.js:4428`, `Scene/SpecularEnvironmentCubeMap.js`);
 *   - the deferred-release protocol is what makes the default texture safe to share across commands.
 *
 * The only WebGPU-specific consequence lives in the `Texture` replacement (W3 / T056), which owns what
 * `finalDestroy` actually releases. Task T043 could not be satisfied with a placeholder here: the
 * upstream `Scene` constructor builds a `TextureCache` through the replacement `Context`.
 */
import defined from "@cesium/engine/Source/Core/defined.js";
import destroyObject from "@cesium/engine/Source/Core/destroyObject.js";

/** The slice of the `Texture` replacement this cache needs (W3 / T056 fills it in). */
export interface CacheableTexture {
  destroy?: (() => void) | undefined;
  finalDestroy?: (() => void) | undefined;
  [key: string]: unknown;
}

interface CacheEntry {
  texture: CacheableTexture;
  count: number;
}

export default class TextureCache {
  readonly _textures: Record<string, CacheEntry> = {};
  _numberOfTextures = 0;
  _texturesToRelease: Record<string, CacheEntry> = {};

  get numberOfTextures(): number {
    return this._numberOfTextures;
  }

  /** Return the cached texture for `keyword`, bumping its reference count. */
  getTexture(keyword: string): CacheableTexture | undefined {
    const cachedTexture = this._textures[keyword];
    if (!defined(cachedTexture)) return undefined;
    // No longer want to release this if it was previously released.
    delete this._texturesToRelease[keyword];
    cachedTexture!.count += 1;
    return cachedTexture!.texture;
  }

  /** Cache `texture` under `keyword`, replacing its `destroy` with the deferred-release one. */
  addTexture(keyword: string, texture: CacheableTexture): void {
    const cachedTexture: CacheEntry = { texture, count: 1 };
    texture.finalDestroy = texture.destroy;
    texture.destroy = () => {
      cachedTexture.count -= 1;
      if (cachedTexture.count === 0) this._texturesToRelease[keyword] = cachedTexture;
    };
    this._textures[keyword] = cachedTexture;
    this._numberOfTextures += 1;
  }

  /** Release every texture whose last reference went away. */
  destroyReleasedTextures(): void {
    for (const keyword of Object.keys(this._texturesToRelease)) {
      const cachedTexture = this._texturesToRelease[keyword] as CacheEntry;
      delete this._textures[keyword];
      cachedTexture.texture.finalDestroy?.();
      this._numberOfTextures -= 1;
    }
    this._texturesToRelease = {};
  }

  isDestroyed(): boolean {
    return false;
  }

  destroy(): void {
    for (const keyword of Object.keys(this._textures)) this._textures[keyword]?.texture.finalDestroy?.();
    return destroyObject(this) as unknown as void;
  }
}
