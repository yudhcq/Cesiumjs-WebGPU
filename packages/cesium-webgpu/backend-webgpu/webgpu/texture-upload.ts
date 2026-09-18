/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * T058 — upload semantics and the texture-origin (Y-flip) policy (G-6, research §6.3, tasks.md T058).
 *
 * **The problem.** GL and WebGPU disagree about where a texture's origin is: GL's `t = 0` is the
 * *bottom* row of a texture, WebGPU's `v = 0` is the *top* row. Upstream compensates for images that
 * are stored top-down with `UNPACK_FLIP_Y_WEBGL = true` (the default: `Texture.js:27 flipY = true`),
 * which uploads the source's first row to GL's `t = 1`. A GLSL→WGSL port keeps `texture2D(u, st)`
 * as `textureSample(u, s, st)` verbatim, so the *same* `(s, t)` **MUST** sample the *same* texel.
 * Therefore WebGPU's `v` has to behave like GL's `t`: with `flipY` on, the source's first row MUST
 * end up at `v = 1`, i.e. **the rows are uploaded in reverse order** (G-6's measured policy).
 *
 * Two consequences this module makes explicit:
 *
 *   1. `queue.writeTexture` has no flip option, so a buffer source is reversed **on the CPU** before
 *      the upload (`flipRows`), while `queue.copyExternalImageToTexture` *does* have `flipY`
 *      (`GPUImageCopyTextureTagged.flipY`), so an image source passes the flag straight through and
 *      the copy stays on the GPU;
 *   2. WebGPU has no `RGB8`/`LUMINANCE`/`ALPHA` formats (see `format-map.ts`), so a source whose
 *      component count differs from the GPU format's is **widened** here, once, in one place —
 *      `copyExternalImageToTexture` always yields RGBA, so this only concerns buffer sources.
 *
 * `tests/visual/texture-origin.spec.mjs` (T058) fixes the behaviour with a four-corner texel
 * assertion on a real device, and includes the negative control (`flipY: false` MUST show the
 * vertically swapped image), so the policy cannot regress into "looks fine because both sides are
 * symmetric".
 */
import { DiagnosticError } from "./errors.js";

/** How the source bytes of one texel relate to the GPU format (mirrors `format-map.UploadShape`). */
export type UploadShape = "identity" | "widen" | "unpack";

/**
 * Freshly allocated upload bytes.
 *
 * Deliberately backed by a plain `ArrayBuffer`: `GPUQueue.writeTexture` (like every WebGPU data
 * entry point) rejects a `SharedArrayBuffer`-backed view, and the type makes that a compile-time
 * fact instead of a runtime validation error.
 */
export type UploadBytes = Uint8Array<ArrayBuffer>;

export interface UploadPlanOptions {
  /** The source bytes, row-major, top row first (the upstream convention). */
  readonly source: ArrayBufferView;
  readonly width: number;
  readonly height: number;
  /** Components per texel in `source` (1..4). */
  readonly sourceComponents: number;
  /** Components per texel in the GPU format (1..4). */
  readonly gpuComponents: number;
  /** Bytes per source component. */
  readonly bytesPerComponent: number;
  /** `Texture#flipY` (upstream default `true`). */
  readonly flipY: boolean;
  /** The transformation `format-map` selected for this `(PixelFormat, PixelDatatype)` pair. */
  readonly uploadShape: UploadShape;
  /** Set of valid sample values for a `uint` GPU format (widened lanes need it); default `255`. */
  readonly widenedAlpha?: number;
  /** `true` when the GPU format is an integer (`uint`) format — only `unpack`/`identity` are legal then. */
  readonly integerFormat?: boolean;
  /** Human-readable origin for diagnostics. */
  readonly where?: string;
}

/** The bytes plus the layout `GPUQueue.writeTexture` needs for one texture upload. */
export interface UploadPlan {
  readonly bytes: UploadBytes;
  readonly bytesPerRow: number;
  readonly rowsPerImage: number;
  readonly width: number;
  readonly height: number;
  /** `true` when the row order was reversed (the WebGPU counterpart of `UNPACK_FLIP_Y_WEBGL`). */
  readonly flipped: boolean;
  /** `true` when the texel layout was rewritten (`widen`/`unpack`). */
  readonly widened: boolean;
  readonly notes: readonly string[];
}

/**
 * Reverse the row order of a tightly packed image.
 *
 * @param data the source rows, top row first
 * @param bytesPerRow row stride in bytes
 * @param height number of rows
 * @returns a **new** buffer whose first row is the source's last row
 */
export function flipRows(data: Uint8Array, bytesPerRow: number, height: number): UploadBytes {
  const out = new Uint8Array(data.length);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = row * bytesPerRow;
    const targetStart = (height - 1 - row) * bytesPerRow;
    out.set(data.subarray(sourceStart, sourceStart + bytesPerRow), targetStart);
  }
  return out;
}

/**
 * Widen each texel from `sourceComponents` to `gpuComponents`.
 *
 * The replicate rules are the ones the format table documents:
 *   - `1 → 4` (LUMINANCE / ALPHA / RED→RGBX): a single channel becomes `(v, v, v, 1)` — this is what
 *     `LUMINANCE` and `ALPHA` mean upstream, and it is why `RED` is mapped to a 1-component GPU
 *     format instead of reaching this path;
 *   - `2 → 4` (LUMINANCE_ALPHA): `(l, a)` becomes `(l, l, l, a)`;
 *   - `3 → 4` (RGB): `(r, g, b)` becomes `(r, g, b, 1)`.
 */
export function widenTexels(data: Uint8Array, width: number, height: number, sourceComponents: number, gpuComponents: number, widenedAlpha: number): UploadBytes {
  const texels = width * height;
  const out = new Uint8Array(texels * gpuComponents);
  for (let texel = 0; texel < texels; texel += 1) {
    const source = texel * sourceComponents;
    const target = texel * gpuComponents;
    if (gpuComponents === 4 && sourceComponents === 1) {
      const value = data[source] ?? 0;
      out[target] = value;
      out[target + 1] = value;
      out[target + 2] = value;
      out[target + 3] = widenedAlpha;
    } else if (gpuComponents === 4 && sourceComponents === 2) {
      const luminance = data[source] ?? 0;
      out[target] = luminance;
      out[target + 1] = luminance;
      out[target + 2] = luminance;
      out[target + 3] = data[source + 1] ?? 0;
    } else if (gpuComponents === 4 && sourceComponents === 3) {
      out[target] = data[source] ?? 0;
      out[target + 1] = data[source + 1] ?? 0;
      out[target + 2] = data[source + 2] ?? 0;
      out[target + 3] = widenedAlpha;
    } else {
      throw new DiagnosticError(
        "internal",
        `texture-upload.widenTexels: ${sourceComponents} → ${gpuComponents} components has no widening rule. ` +
          "The format table only widens toward RGBA; any other pair means the mapping table and the uploader disagree.",
        { backend: "webgpu", upstreamModule: "Renderer/Texture.js", requirementRef: "FR-030", entryPoint: "texture-upload.widenTexels" },
      );
    }
  }
  return out;
}

/**
 * Build the upload plan for one buffer-source `Texture#copyFrom` / constructor `source`.
 *
 * @throws a `DiagnosticError` when the source does not match the declared geometry — a short source
 *   would otherwise be uploaded as a partially-uninitialised texture, i.e. an image that looks
 *   plausible and is wrong (FR-033).
 */
export function planTextureUpload(options: UploadPlanOptions): UploadPlan {
  const where = options.where ?? "texture-upload.planTextureUpload";
  const { width, height, sourceComponents, gpuComponents, bytesPerComponent, uploadShape, source } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new DiagnosticError("internal", `${where}: width/height MUST be positive integers (got ${width}×${height}).`, {
      backend: "webgpu",
      upstreamModule: "Renderer/Texture.js",
      requirementRef: "FR-030",
      entryPoint: where,
    });
  }
  const expected = width * height * sourceComponents * bytesPerComponent;
  if (source.byteLength !== expected) {
    throw new DiagnosticError(
      "internal",
      `${where}: the source is ${source.byteLength} byte(s) but ${width}×${height}×${sourceComponents}×${bytesPerComponent} = ${expected} byte(s) ` +
        "are required. Upstream size checks the same arithmetic; uploading a short source would leave the texture partly uninitialised.",
      { backend: "webgpu", upstreamModule: "Renderer/Texture.js", requirementRef: "FR-030", entryPoint: where, extra: { expected, actual: source.byteLength } },
    );
  }
  if (uploadShape === "unpack") {
    throw new DiagnosticError(
      "not-implemented",
      `${where}: packed 16-bit sources (RGB565 / RGBA4 / RGB5_A1) are not unpacked in this increment. ` +
        "The terrain path uses uncompressed 8-bit imagery; the packed path lands with the model/imagery increment.",
      {
        backend: "webgpu",
        upstreamModule: "Renderer/Texture.js",
        requirementRef: "FR-030",
        entryPoint: where,
        plannedPhase: "out of the MVP slice (packed 16-bit texture upload)",
      },
    );
  }

  const sourceBytes = new Uint8Array(source.buffer as ArrayBuffer, source.byteOffset, source.byteLength);
  const notes: string[] = [];
  let bytes: UploadBytes = Uint8Array.from(sourceBytes);
  let texelComponents = sourceComponents;
  if (uploadShape === "widen" && gpuComponents !== sourceComponents) {
    if (options.integerFormat === true) {
      throw new DiagnosticError(
        "internal",
        `${where}: an integer GPU format cannot take a widened source (integer textures have no 1/2/3-component form).`,
        { backend: "webgpu", upstreamModule: "Renderer/Texture.js", requirementRef: "FR-030", entryPoint: where },
      );
    }
    const widenedAlpha = options.widenedAlpha ?? 255;
    bytes = widenTexels(bytes, width, height, sourceComponents, gpuComponents, widenedAlpha);
    texelComponents = gpuComponents;
    notes.push(`texels widened ${sourceComponents} → ${gpuComponents} components (see format-map.ts for the recorded equivalence)`);
  }

  const bytesPerRow = width * texelComponents * bytesPerComponent;
  let flipped = false;
  if (options.flipY) {
    bytes = flipRows(bytes, bytesPerRow, height);
    flipped = true;
    notes.push(
      "rows uploaded in reverse order: the WebGPU counterpart of GL's `UNPACK_FLIP_Y_WEBGL = true` (v=0 is the top row in WebGPU, t=0 is the bottom row in GL)",
    );
  }

  return { bytes, bytesPerRow, rowsPerImage: height, width, height, flipped, widened: texelComponents !== sourceComponents, notes };
}

/**
 * Whether an image source needs the GPU-side flip flag, i.e. the `flipY` value to pass to
 * `queue.copyExternalImageToTexture`.
 *
 * `GPUImageCopyTextureTagged.flipY` means the same thing GL's `UNPACK_FLIP_Y_WEBGL` means ("flip the
 * source vertically while copying"), so upstream's `Texture#flipY` passes through unchanged. The
 * function exists so that claim is stated in code and asserted by the unit test rather than being
 * an implicit argument order.
 */
export function externalImageFlipY(textureFlipY: boolean): boolean {
  return textureFlipY;
}
