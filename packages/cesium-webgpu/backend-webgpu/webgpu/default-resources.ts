/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Default resources published by the replacement `Context` during construction (tasks.md T043).
 *
 * Upstream creates `defaultTexture` lazily on first access as a **1×1 RGBA8** texture filled with
 * `Texture.defaultColor` (= `Color.WHITE`, so `[255, 255, 255, 255]`), `flipY: false`, and a
 * `Sampler` with `CLAMP_TO_EDGE` wrap and `LINEAR` filtering (`Context.js` `defaultTexture` getter).
 * The logic layer passes `context.defaultTexture` into uniform maps wherever a texture unit must be
 * bound but no image is available yet (`Scene/GlobeSurfaceTileProvider.js:2049`,
 * `Scene/BatchTexture.js:503`, …), so the *observable* facts are: 1×1, RGBA8, white, not flipped,
 * clamped+linear.
 *
 * The WebGPU side cannot hand the logic layer anything until the `Texture` replacement lands (W3 /
 * T056), which is why this module returns a **WebGPU-side descriptor** and the `Context` exposes it
 * under a backend-internal name. W3 wires it into the upstream-shaped `Texture` object; the values
 * asserted by `tests/unit/context-construction.test.mjs` (size, format, flipY, sampler wrap/filter)
 * are the frozen contract between the two.
 */
import { DiagnosticError } from "./errors.js";

/** GL enums upstream uses for the default texture (spelled numerically; no upstream import). */
export const PIXEL_FORMAT_RGBA = 0x1908;
export const PIXEL_DATATYPE_UNSIGNED_BYTE = 0x1401;
/** `TextureWrap.CLAMP_TO_EDGE` / `TextureMinificationFilter.LINEAR` / `...MagnificationFilter.LINEAR`. */
export const TEXTURE_WRAP_CLAMP_TO_EDGE = 0x812f;
export const TEXTURE_FILTER_LINEAR = 0x2601;

/** The default texture's RGBA8 bytes — upstream's `Texture.defaultColor === Color.WHITE`. */
export const DEFAULT_TEXTURE_RGBA8: readonly [number, number, number, number] = [255, 255, 255, 255];

/** Everything the logic layer can observe about the default texture, plus the GPU handles. */
export interface DefaultTexture {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly samplerDescriptor: GPUSamplerDescriptor;
  readonly width: 1;
  readonly height: 1;
  readonly pixelFormat: number;
  readonly pixelDatatype: number;
  readonly flipY: false;
  readonly rgba8: readonly [number, number, number, number];
  destroy(): void;
}

/**
 * Create the 1×1 white RGBA8 default texture and its CLAMP_TO_EDGE/LINEAR sampler.
 *
 * @throws a `DiagnosticError` when the device cannot create the resources — the backend MUST NOT
 *   publish a `defaultTexture` that does not exist, because the logic layer would bind "nothing" and
 *   the resulting frame would look plausible while being wrong.
 */
export function createDefaultTexture(device: GPUDevice, options: { label?: string } = {}): DefaultTexture {
  const label = options.label ?? "cesium-webgpu:default-texture";
  try {
    const texture = device.createTexture({
      label,
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    device.queue.writeTexture(
      { texture },
      new Uint8Array(DEFAULT_TEXTURE_RGBA8),
      { bytesPerRow: 4, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    const samplerDescriptor: GPUSamplerDescriptor = {
      label: `${label}:sampler`,
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    };
    const sampler = device.createSampler(samplerDescriptor);
    return {
      texture,
      view: texture.createView(),
      sampler,
      samplerDescriptor,
      width: 1,
      height: 1,
      pixelFormat: PIXEL_FORMAT_RGBA,
      pixelDatatype: PIXEL_DATATYPE_UNSIGNED_BYTE,
      flipY: false,
      rgba8: DEFAULT_TEXTURE_RGBA8,
      destroy(): void {
        texture.destroy();
      },
    };
  } catch (error) {
    throw new DiagnosticError(
      "render-failed",
      `the default texture (1×1 RGBA8, white, flipY:false) could not be created: ${(error as Error)?.message ?? String(error)}. ` +
        "The replacement Context MUST NOT publish a default texture that does not exist (T043).",
      { backend: "webgpu", upstreamModule: "Renderer/Context.js", requirementRef: "FR-030", entryPoint: "default-resources.createDefaultTexture", cause: error },
    );
  }
}
