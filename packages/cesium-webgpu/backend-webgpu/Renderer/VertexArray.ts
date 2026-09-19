/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/VertexArray.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * T060 — `VertexArray` → `GPUVertexBufferLayout[]` + per-draw `setVertexBuffer` (FR-030).
 *
 * WHAT IS PRESERVED
 *   the constructor option bag (`context`, `attributes[]`, `indexBuffer`) with **every** attribute
 *   field (`index` / `vertexBuffer` / `value` / `componentDatatype` / `componentsPerAttribute` /
 *   `normalized` (upstream also spells it `normalize`) / `offsetInBytes` / `strideInBytes` /
 *   `instanced` / `divisor` (upstream also spells it `instanceDivisor`)), `fromGeometry()`,
 *   `numberOfAttributes`, `numberOfVertices`, `indexBuffer`, `getAttribute()`,
 *   `copyAttributeFromRange()` / `copyIndexFromRange()`, `_bind()` / `_unBind()`, `destroy()`,
 *   and the upstream validation errors.
 *
 * WHAT CHANGES
 *   * **There is no vertex-array object in WebGPU.** The old VAO concept is replaced by a
 *     `GPUVertexBufferLayout` per buffer, bound per draw call. `_bind()`/`_unBind()` therefore have
 *     nothing to preserve and are documented no-ops; `toGpuVertexBuffers()` is the new, additive
 *     accessor the draw path uses (`Context#draw` reads it through the `__webgpu` payload).
 *   * `instanced` / `divisor > 0` becomes `stepMode: "instance"`. WebGPU has exactly two step modes,
 *     so `divisor > 1` (GL's "advance every N instances") has no counterpart and fails loudly.
 *   * a **constant attribute** (`value` instead of `vertexBuffer`) has no `glVertexAttrib4fv`
 *     counterpart: the value is uploaded once into its own tiny buffer and read with
 *     `arrayStride: 0`, which is WebGPU's "same element for every vertex".
 */
import { requireDevice } from "../webgpu/context-device.js";
import { DiagnosticError } from "../webgpu/errors.js";
import { ComponentDatatype, componentDatatypeSizeInBytes, vertexFormatFor } from "../webgpu/format-map.js";
import type { VertexAttributeLike } from "../webgpu/pipeline-cache.js";
import Buffer from "./Buffer.js";

const UPSTREAM_MODULE = "Renderer/VertexArray.js";

/** One attribute as the logic layer passes it (superset of both upstream spellings). */
export interface VertexArrayAttributeOptions {
  readonly index?: number | undefined;
  readonly enabled?: boolean | undefined;
  readonly vertexBuffer?: Buffer | undefined;
  readonly value?: readonly number[] | undefined;
  readonly componentDatatype?: number | undefined;
  readonly componentsPerAttribute?: number | undefined;
  /** Upstream's internal spelling (`addAttribute` normalises to this). */
  readonly normalize?: boolean | undefined;
  /** The spelling `fromGeometry` accepts from `GeometryAttribute.normalized`. */
  readonly normalized?: boolean | undefined;
  readonly offsetInBytes?: number | undefined;
  readonly strideInBytes?: number | undefined;
  readonly instanced?: boolean | undefined;
  readonly divisor?: number | undefined;
  readonly instanceDivisor?: number | undefined;
}

export interface VertexArrayOptions {
  readonly context: unknown;
  readonly attributes: readonly VertexArrayAttributeOptions[];
  readonly indexBuffer?: Buffer | undefined;
}

/** Upstream's normalised attribute (`addAttribute`'s output), kept field-for-field. */
export interface VertexArrayAttribute {
  readonly index: number;
  readonly enabled: boolean;
  readonly vertexBuffer: Buffer | undefined;
  readonly value: readonly number[] | undefined;
  readonly componentsPerAttribute: number;
  readonly componentDatatype: number;
  readonly normalize: boolean;
  readonly normalized: boolean;
  readonly offsetInBytes: number;
  readonly strideInBytes: number;
  readonly instanceDivisor: number;
}

/** One `GPUVertexBufferLayout` plus the binding data `Context#draw` needs. */
export interface GpuVertexBufferBinding {
  readonly slot: number;
  readonly buffer: GPUBuffer;
  readonly offset: number;
  readonly size: number | undefined;
  readonly layout: GPUVertexBufferLayout;
}

/** The payload the replacement `VertexArray` hands to the draw path. */
export interface VertexArrayDrawPayload {
  readonly vertexBuffers: readonly { readonly slot: number; readonly buffer: GPUBuffer; readonly offset?: number; readonly size?: number }[];
  /**
   * The `GPUVertexBufferLayout`s of those bindings, in the same order (W5).
   *
   * The draw path hands these to `ShaderProgram#createPipeline`, so the pipeline's attribute formats and
   * `arrayStride` are the ones the bound buffer actually has. Deriving them from the shader emission
   * instead is only correct when the two agree, and for the real terrain vertex layout they do not
   * (`TerrainEncoding` with `hasVertexNormals === false` is 28 bytes/vertex with `float32x3` at
   * location 1, while the assembled GLSL declares `vec4 textureCoordAndEncodedNormals`).
   */
  readonly gpuVertexBuffers: readonly GPUVertexBufferLayout[];
  readonly indexBuffer: { readonly buffer: GPUBuffer; readonly format: GPUIndexFormat; readonly offset?: number; readonly size?: number } | null;
  readonly vertexLayout: readonly VertexAttributeLike[];
  readonly indexed: boolean;
}

function requireContext(context: unknown, entryPoint: string): void {
  if (context === undefined || context === null) {
    throw new DiagnosticError("internal", `${entryPoint}: Check.defined("options.context", options.context) failed.`, {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      requirementRef: "FR-030",
      entryPoint,
    });
  }
}

/**
 * The replacement `VertexArray`.
 *
 * Upstream declares `VertexArray` as a plain function used with `new`; the construction shape and
 * the option bag are unchanged.
 */
export default class VertexArray {
  readonly _context: unknown;
  readonly _attributes: readonly VertexArrayAttribute[];
  readonly _indexBuffer: Buffer | undefined;
  readonly _numberOfVertices: number;
  readonly _hasInstancedAttributes: boolean;
  readonly _hasConstantAttributes: boolean;
  /** Constant attributes get their own one-element buffer; it is owned (and destroyed) by the VA. */
  readonly #constantBuffers: GPUBuffer[] = [];
  #gpuBindings: readonly GpuVertexBufferBinding[] | null = null;
  #destroyed = false;

  constructor(options: VertexArrayOptions = {} as VertexArrayOptions) {
    requireContext(options.context, "VertexArray#constructor");
    const attributes = options.attributes;
    if (attributes === undefined || attributes === null) {
      throw new DiagnosticError("internal", 'VertexArray: Check.defined("options.attributes", options.attributes) failed.', {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "VertexArray#constructor",
      });
    }
    this._context = options.context;

    const normalised: VertexArrayAttribute[] = [];
    for (let index = 0; index < attributes.length; index += 1) {
      normalised.push(addAttribute(attributes[index] as VertexArrayAttributeOptions, index));
    }

    // Upstream: the first non-instanced buffer-backed attribute defines the vertex count, on the
    // assumption that every vertex buffer of the array holds the same number of vertices.
    let numberOfVertices = 1;
    for (const attribute of normalised) {
      if (attribute.vertexBuffer !== undefined && attribute.instanceDivisor === 0) {
        const bytes = attribute.strideInBytes || attribute.componentsPerAttribute * componentDatatypeSizeInBytes(attribute.componentDatatype);
        numberOfVertices = attribute.vertexBuffer.sizeInBytes / bytes;
        break;
      }
    }

    const uniqueIndices = new Set<number>();
    for (const attribute of normalised) {
      if (uniqueIndices.has(attribute.index)) {
        throw new DiagnosticError("internal", `VertexArray: index ${attribute.index} is used by more than one attribute.`, {
          backend: "webgpu",
          upstreamModule: UPSTREAM_MODULE,
          requirementRef: "FR-030",
          entryPoint: "VertexArray#constructor",
        });
      }
      uniqueIndices.add(attribute.index);
    }

    this._attributes = normalised;
    this._indexBuffer = options.indexBuffer;
    this._numberOfVertices = numberOfVertices;
    this._hasInstancedAttributes = normalised.some((attribute) => attribute.instanceDivisor > 0);
    this._hasConstantAttributes = normalised.some((attribute) => attribute.value !== undefined);
  }

  get numberOfAttributes(): number {
    return this._attributes.length;
  }

  get numberOfVertices(): number {
    return this._numberOfVertices;
  }

  get indexBuffer(): Buffer | undefined {
    return this._indexBuffer;
  }

  /** `true` when an instanced attribute drives `stepMode: "instance"` (T060 mapping evidence). */
  get hasInstancedAttributes(): boolean {
    return this._hasInstancedAttributes;
  }

  /** Upstream `getAttribute(index)` — the *position* in the array, not the attribute's `index`. */
  getAttribute(index: number): VertexArrayAttribute {
    if (index === undefined || index === null) {
      throw new DiagnosticError("internal", 'VertexArray.getAttribute: Check.defined("index", index) failed.', {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "VertexArray#getAttribute",
      });
    }
    const attribute = this._attributes[index];
    if (attribute === undefined) {
      throw new DiagnosticError("internal", `VertexArray.getAttribute: no attribute at position ${index} (the array has ${this._attributes.length}).`, {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "VertexArray#getAttribute",
      });
    }
    return attribute;
  }

  /**
   * The `GPUVertexBufferLayout`s plus the binding data for one draw (T060's replacement for the VAO).
   *
   * Computed once and cached: the descriptors are pure functions of the attribute list.
   */
  toGpuVertexBuffers(): readonly GpuVertexBufferBinding[] {
    this.#assertAlive("toGpuVertexBuffers");
    if (this.#gpuBindings !== null) return this.#gpuBindings;
    this.#gpuBindings = buildBindings(this._attributes, this._context, this.#constantBuffers);
    return this.#gpuBindings;
  }

  /** The index buffer binding (`null` for a non-indexed draw). */
  toGpuIndexBuffer(): VertexArrayDrawPayload["indexBuffer"] {
    this.#assertAlive("toGpuIndexBuffer");
    const indexBuffer = this._indexBuffer;
    if (indexBuffer === undefined) return null;
    return { buffer: indexBuffer._getBuffer(), format: indexBuffer._getGpuIndexFormat(), offset: 0 };
  }

  /**
   * The additive payload `Context#draw` consumes when the command carries the geometry but no
   * explicit backend inputs (`Context.ts` `WebgpuDrawInputs`).
   */
  get __webgpu(): VertexArrayDrawPayload {
    const bindings = this.toGpuVertexBuffers();
    const indexBuffer = this.toGpuIndexBuffer();
    return {
      vertexBuffers: bindings.map((binding) => ({
        slot: binding.slot,
        buffer: binding.buffer,
        offset: binding.offset,
        ...(binding.size === undefined ? {} : { size: binding.size }),
      })),
      // The `GPUVertexBufferLayout`s themselves (W5): the pipeline MUST describe the buffer that will
      // actually be bound. The first W5 terrain frame built its pipelines from the *emission contract*
      // instead (stride 32, `float32x4` at location 1) while the terrain buffer is 28 bytes with
      // `float32x3` at location 1 (`TerrainEncoding`, no vertex normals) — every vertex after the
      // first was read four bytes out of phase.
      gpuVertexBuffers: bindings.map((binding) => binding.layout),
      indexBuffer,
      vertexLayout: this.toVertexLayoutLike(),
      indexed: indexBuffer !== null,
    };
  }

  /** The upstream-shaped attribute list the pipeline cache fingerprints (research §5.3). */
  toVertexLayoutLike(): readonly VertexAttributeLike[] {
    return this._attributes.map((attribute) => ({
      index: attribute.index,
      componentDatatype: attribute.componentDatatype,
      componentsPerAttribute: attribute.componentsPerAttribute,
      normalized: attribute.normalize,
      offsetInBytes: attribute.offsetInBytes,
      strideInBytes: attribute.strideInBytes,
      instanced: attribute.instanceDivisor > 0,
      divisor: attribute.instanceDivisor,
    }));
  }

  /**
   * Upstream `copyAttributeFromRange(attribute, index, start, end)` — the per-attribute values
   * cached by `VertexArrayFacade` are not part of this replacement's surface (the facade owns its
   * own CPU array), so the method fails loudly instead of copying nothing.
   */
  copyAttributeFromRange(_attribute?: unknown, _index?: unknown, _start?: unknown, _end?: unknown): never {
    throw new DiagnosticError(
      "not-implemented",
      "VertexArray.copyAttributeFromRange needs the attribute's CPU-side `values`, which upstream stores on the attribute object created by " +
        "`VertexArrayFacade` (not on a `VertexArray` attribute). The MVP terrain path writes its vertex data through " +
        "`Buffer.createVertexBuffer`/`VertexArrayFacade`, both of which are implemented; this helper is only reached by the " +
        "polyline/polygon render buffers and lands with those paths.",
      {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "VertexArray#copyAttributeFromRange",
        plannedPhase: "out of the MVP slice (polyline/polygon render buffers)",
      },
    );
  }

  /** Upstream `copyIndexFromRange(index, start, end, buffer)` — same boundary as above. */
  copyIndexFromRange(_index?: unknown, _start?: unknown, _end?: unknown, _buffer?: unknown): never {
    throw new DiagnosticError(
      "not-implemented",
      "VertexArray.copyIndexFromRange needs the vertex array's CPU-side index list, which this replacement does not keep (WebGPU uploads the " +
        "indices into the index buffer at creation time). Reached only by the polyline/polygon render buffers, which are outside the MVP slice.",
      {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "VertexArray#copyIndexFromRange",
        plannedPhase: "out of the MVP slice (polyline/polygon render buffers)",
      },
    );
  }

  /**
   * Upstream `_bind()`. There is no vertex-array object in WebGPU: the layout is part of the
   * pipeline and the buffers are bound per draw call, so this is a documented no-op.
   */
  _bind(): void {
    // Intentionally empty: `glBindVertexArray` has no WebGPU counterpart.
  }

  /** Upstream `_unBind()`; see {@link VertexArray#_bind}. */
  _unBind(): void {
    // Intentionally empty: `glBindVertexArray(null)` has no WebGPU counterpart.
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  destroy(): void {
    if (this.#destroyed) return;
    for (const attribute of this._attributes) {
      const vertexBuffer = attribute.vertexBuffer;
      if (vertexBuffer !== undefined && !vertexBuffer.isDestroyed() && vertexBuffer.vertexArrayDestroyable) {
        vertexBuffer.destroy();
      }
    }
    const indexBuffer = this._indexBuffer;
    if (indexBuffer !== undefined && !indexBuffer.isDestroyed() && indexBuffer.vertexArrayDestroyable) {
      indexBuffer.destroy();
    }
    for (const constantBuffer of this.#constantBuffers) constantBuffer.destroy();
    this.#constantBuffers.length = 0;
    this.#destroyed = true;
  }

  /**
   * Upstream `VertexArray.fromGeometry` (research §6.1).
   *
   * Covered branches: an existing `typedArray` (what `GeometryPipeline` produces), per-attribute
   * `values`, and constant `value`s. The triangle order and the index type follow upstream
   * (`Uint32` only above 65 536 vertices **and** `context.elementIndexUint`).
   */
  static fromGeometry(
    options: {
      readonly context?: unknown;
      readonly geometry?: { readonly attributes?: Record<string, Record<string, unknown>> | undefined; readonly indices?: readonly number[] | undefined } | undefined;
      readonly bufferUsage?: number | undefined;
      readonly attributeLocations?: Record<string, number> | undefined;
      readonly interleave?: boolean | undefined;
      readonly vertexArrayAttributes?: readonly VertexArrayAttributeOptions[] | undefined;
    } = {},
  ): VertexArray {
    requireContext(options.context, "VertexArray.fromGeometry");
    const context = options.context as { elementIndexUint?: boolean };
    const geometry = options.geometry ?? {};
    const bufferUsage = options.bufferUsage ?? 0x88e8; // BufferUsage.DYNAMIC_DRAW
    const attributeLocations = options.attributeLocations ?? {};
    const attributes = geometry.attributes ?? {};
    const interleave = options.interleave === true;

    const vaAttributes: VertexArrayAttributeOptions[] = options.vertexArrayAttributes === undefined ? [] : [...options.vertexArrayAttributes];
    for (const name of Object.keys(attributes)) {
      const attribute = attributes[name];
      if (attribute === undefined || attribute === null) continue;
      const componentDatatype = (attribute.componentDatatype as number | undefined) ?? ComponentDatatype.FLOAT;
      const normalized = (attribute.normalized as boolean | undefined) ?? false;
      if (attribute.typedArray !== undefined) {
        const vertexBuffer = Buffer.createVertexBuffer({ context, typedArray: attribute.typedArray as ArrayBufferView, usage: bufferUsage });
        vaAttributes.push({
          index: attributeLocations[name] ?? 0,
          vertexBuffer,
          componentDatatype,
          componentsPerAttribute: (attribute.componentsPerAttribute as number | undefined) ?? 1,
          normalized,
          ...(attribute.instanceDivisor === undefined ? {} : { instanceDivisor: attribute.instanceDivisor as number }),
        });
      } else if (attribute.values !== undefined) {
        const values = attribute.values as readonly number[];
        const components = (attribute.componentsPerAttribute as number | undefined) ?? 1;
        const vertexBuffer = Buffer.createVertexBuffer({
          context,
          typedArray: createTypedArray(componentDatatype, values, values.length),
          usage: bufferUsage,
        });
        vaAttributes.push({
          index: attributeLocations[name] ?? 0,
          vertexBuffer,
          componentDatatype,
          componentsPerAttribute: components,
          normalized,
        });
      } else {
        vaAttributes.push({
          index: attributeLocations[name] ?? 0,
          value: attribute.value as readonly number[] | undefined,
          componentDatatype,
          normalized,
        });
      }
    }
    void interleave;

    let indexBuffer: Buffer | undefined;
    const indices = geometry.indices;
    if (indices !== undefined && indices !== null) {
      let maxIndex = 0;
      for (const value of indices) maxIndex = Math.max(maxIndex, value);
      const useUint32 = maxIndex >= 65536 && context.elementIndexUint === true;
      indexBuffer = Buffer.createIndexBuffer({
        context,
        typedArray: useUint32 ? new Uint32Array(indices) : new Uint16Array(indices),
        usage: bufferUsage,
        indexDatatype: useUint32 ? ComponentDatatype.UNSIGNED_INT : ComponentDatatype.UNSIGNED_SHORT,
      });
    }

    return new VertexArray({ context, attributes: vaAttributes, indexBuffer });
  }

  #assertAlive(entryPoint: string): void {
    if (this.#destroyed) {
      throw new DiagnosticError(
        "render-failed",
        `VertexArray.${entryPoint}: this vertex array was destroyed, i.e. destroy() was called (upstream's destroyObject contract).`,
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: `VertexArray#${entryPoint}` },
      );
    }
  }
}

/** Upstream's `addAttribute`: validation, normalisation and the `value`/`vertexBuffer` split. */
function addAttribute(attribute: VertexArrayAttributeOptions, index: number): VertexArrayAttribute {
  const hasVertexBuffer = attribute.vertexBuffer !== undefined;
  const value = attribute.value;
  const hasValue = value !== undefined;
  const componentsPerAttribute = hasValue ? (value as readonly number[]).length : (attribute.componentsPerAttribute ?? 0);

  if (!hasVertexBuffer && !hasValue) {
    throw new DiagnosticError("internal", "VertexArray: attribute must have a vertexBuffer or a value.", {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      requirementRef: "FR-030",
      entryPoint: "VertexArray#addAttribute",
    });
  }
  if (hasVertexBuffer && hasValue) {
    throw new DiagnosticError(
      "internal",
      "VertexArray: attribute cannot have both a vertexBuffer and a value. It must have either a vertexBuffer property defining " +
        "per-vertex data or a value property defining data for all vertices.",
      { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "VertexArray#addAttribute" },
    );
  }
  if (componentsPerAttribute !== 1 && componentsPerAttribute !== 2 && componentsPerAttribute !== 3 && componentsPerAttribute !== 4) {
    throw new DiagnosticError(
      "internal",
      hasValue ? "VertexArray: attribute.value.length must be in the range [1, 4]." : "VertexArray: attribute.componentsPerAttribute must be in the range [1, 4].",
      { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "VertexArray#addAttribute" },
    );
  }

  const componentDatatype = attribute.componentDatatype ?? ComponentDatatype.FLOAT;
  componentDatatypeSizeInBytes(componentDatatype);

  const instanceDivisor = attribute.instanceDivisor ?? attribute.divisor ?? (attribute.instanced === true ? 1 : 0);
  if (instanceDivisor < 0) {
    throw new DiagnosticError("internal", "VertexArray: attribute must have an instanceDivisor greater than or equal to zero.", {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      requirementRef: "FR-030",
      entryPoint: "VertexArray#addAttribute",
    });
  }
  if (instanceDivisor > 0 && hasValue) {
    throw new DiagnosticError("internal", "VertexArray: attribute cannot have an instanceDivisor if it is not backed by a buffer.", {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      requirementRef: "FR-030",
      entryPoint: "VertexArray#addAttribute",
    });
  }
  if (instanceDivisor > 0 && (attribute.index ?? index) === 0) {
    throw new DiagnosticError("internal", "VertexArray: attribute zero cannot have an instanceDivisor greater than 0.", {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      requirementRef: "FR-030",
      entryPoint: "VertexArray#addAttribute",
    });
  }
  if (instanceDivisor > 1) {
    // WebGPU has exactly two step modes (`vertex` / `instance`); GL's divisor N is not expressible.
    throw new DiagnosticError(
      "not-implemented",
      `VertexArray: instanceDivisor=${instanceDivisor} cannot be expressed in WebGPU — \`stepMode\` is binary (\`vertex\` | \`instance\`) and ` +
        "there is no per-vertex-buffer divisor. Upstream's terrain and model paths use 0 or 1; a divisor > 1 would need an explicit " +
        "per-instance data expansion, which is a separate increment.",
      {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "VertexArray#addAttribute",
        plannedPhase: "not planned: needs per-instance data expansion (see the T060 implementation notes)",
        extra: { instanceDivisor, index: attribute.index ?? index },
      },
    );
  }

  const normalize = attribute.normalize ?? attribute.normalized ?? false;
  if (attribute.strideInBytes !== undefined && attribute.strideInBytes > 255) {
    // Upstream rejects > 255 because that was the GL limit. The same caller error is reported with
    // the same wording; the WebGPU limit (maxVertexBufferArrayStride, 2048) is not what this check is.
    throw new DiagnosticError("internal", "VertexArray: attribute must have a strideInBytes less than or equal to 255 or not specify it.", {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      requirementRef: "FR-030",
      entryPoint: "VertexArray#addAttribute",
    });
  }

  return {
    index: attribute.index ?? index,
    enabled: attribute.enabled ?? true,
    vertexBuffer: attribute.vertexBuffer,
    value: hasValue ? [...(value as readonly number[])] : undefined,
    componentsPerAttribute,
    componentDatatype,
    normalize,
    normalized: normalize,
    offsetInBytes: attribute.offsetInBytes ?? 0,
    strideInBytes: attribute.strideInBytes ?? 0,
    instanceDivisor,
  };
}

/**
 * Turn the normalised attribute list into `GPUVertexBufferLayout`s.
 *
 * WebGPU's rules that shape this function:
 *   - one `arrayStride` **and one step mode per buffer**, so every attribute sharing a buffer MUST
 *     agree on both (upstream guarantees this for interleaved arrays; a violation is a caller error
 *     and fails loudly);
 *   - `arrayStride` may be `0`, which means "every vertex/instance reads the same element" — the
 *     counterpart of upstream's constant attribute.
 */
function buildBindings(attributes: readonly VertexArrayAttribute[], context: unknown, constantBuffers: GPUBuffer[]): readonly GpuVertexBufferBinding[] {
  const byBuffer = new Map<GPUBuffer, { buffer: GPUBuffer; stride: number; stepMode: GPUVertexStepMode; attributes: GPUVertexAttribute[] }>();
  const constantValues: { values: readonly number[]; datatype: number; attribute: VertexArrayAttribute }[] = [];

  for (const attribute of attributes) {
    if (attribute.value !== undefined) {
      constantValues.push({ values: attribute.value, datatype: attribute.componentDatatype, attribute });
      continue;
    }
    const vertexBuffer = attribute.vertexBuffer;
    if (vertexBuffer === undefined) continue;
    const gpuBuffer = vertexBuffer._getBuffer();
    const stepMode: GPUVertexStepMode = attribute.instanceDivisor > 0 ? "instance" : "vertex";
    const stride = attribute.strideInBytes;
    const mapping = vertexFormatFor(attribute.componentDatatype, attribute.componentsPerAttribute, attribute.normalize);
    const gpuAttribute: GPUVertexAttribute = { shaderLocation: attribute.index, offset: attribute.offsetInBytes, format: mapping.format };
    const entry = byBuffer.get(gpuBuffer);
    if (entry === undefined) {
      byBuffer.set(gpuBuffer, { buffer: gpuBuffer, stride, stepMode, attributes: [gpuAttribute] });
      continue;
    }
    if (entry.stepMode !== stepMode) {
      throw new DiagnosticError(
        "internal",
        "VertexArray: two attributes sharing one vertex buffer disagree on the step mode (instanced vs per-vertex). WebGPU declares the step " +
          "mode per buffer, so this layout cannot be expressed; upstream's interleaving never produces it.",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "VertexArray#toGpuVertexBuffers" },
      );
    }
    if (entry.stride !== stride) {
      throw new DiagnosticError(
        "internal",
        `VertexArray: two attributes sharing one vertex buffer declare different strides (${entry.stride} vs ${stride}). ` +
          "WebGPU declares one arrayStride per buffer, so this layout cannot be expressed.",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "VertexArray#toGpuVertexBuffers" },
      );
    }
    entry.attributes.push(gpuAttribute);
  }

  const device = constantValues.length === 0 ? null : requireDevice(context, "VertexArray#toGpuVertexBuffers", UPSTREAM_MODULE);
  const bindings: GpuVertexBufferBinding[] = [];
  let slot = 0;
  for (const entry of byBuffer.values()) {
    bindings.push({
      slot,
      buffer: entry.buffer,
      offset: 0,
      size: undefined,
      layout: { arrayStride: entry.stride, stepMode: entry.stepMode, attributes: [...entry.attributes].sort((left, right) => left.shaderLocation - right.shaderLocation) },
    });
    slot += 1;
  }

  for (const constant of constantValues) {
    // One element, read with `arrayStride: 0` so every vertex sees the same value — the WebGPU
    // counterpart of `gl.vertexAttrib4fv`.
    const components = constant.attribute.componentsPerAttribute;
    const typed = createTypedArray(constant.datatype, constant.values, components);
    const bytes = new Uint8Array(typed.buffer as ArrayBuffer, typed.byteOffset, typed.byteLength);
    const padded = new Uint8Array(Math.max(4, Math.ceil(bytes.byteLength / 4) * 4));
    padded.set(bytes, 0);
    const gpuBuffer = (device as GPUDevice).createBuffer({
      label: "cesium-webgpu:VertexArray:constant",
      size: padded.byteLength,
      usage: globalThis.GPUBufferUsage.VERTEX | globalThis.GPUBufferUsage.COPY_DST,
    });
    (device as GPUDevice).queue.writeBuffer(gpuBuffer, 0, padded);
    constantBuffers.push(gpuBuffer);
    const mapping = vertexFormatFor(constant.datatype, components, constant.attribute.normalize);
    bindings.push({
      slot,
      buffer: gpuBuffer,
      offset: 0,
      size: undefined,
      layout: { arrayStride: 0, stepMode: "vertex", attributes: [{ shaderLocation: constant.attribute.index, offset: 0, format: mapping.format }] },
    });
    slot += 1;
  }

  for (const binding of bindings) {
    for (const attribute of binding.layout.attributes) {
      if (binding.layout.arrayStride === 0) continue;
      const size = vertexFormatSizeInBytes(attribute.format);
      if (attribute.offset + size > binding.layout.arrayStride) {
        throw new DiagnosticError(
          "internal",
          `VertexArray: the attribute at shaderLocation ${attribute.shaderLocation} spans ${attribute.offset}..${attribute.offset + size} byte(s) but ` +
            `its buffer stride is ${binding.layout.arrayStride}. WebGPU would reject this layout at pipeline creation.`,
          { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "VertexArray#toGpuVertexBuffers" },
        );
      }
    }
  }
  return bindings;
}

/** Bytes one element of a `GPUVertexFormat` occupies. */
export function vertexFormatSizeInBytes(format: GPUVertexFormat): number {
  const match = /^(?:float|sint|uint|unorm|snorm)(\d+)(?:x(\d+))?$/.exec(format);
  if (match === null) {
    throw new DiagnosticError("internal", `VertexArray: unknown GPUVertexFormat "${format}".`, {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      requirementRef: "FR-030",
      entryPoint: "VertexArray#toGpuVertexBuffers",
    });
  }
  const componentBits = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  return (componentBits / 8) * count;
}

/** The same typed-array selection upstream's `ComponentDatatype.createTypedArray` performs. */
export function createTypedArray(componentDatatype: number, values: readonly number[], length: number): ArrayBufferView {
  switch (componentDatatype) {
    case ComponentDatatype.BYTE:
      return new Int8Array(values.slice(0, length));
    case ComponentDatatype.UNSIGNED_BYTE:
      return new Uint8Array(values.slice(0, length));
    case ComponentDatatype.SHORT:
      return new Int16Array(values.slice(0, length));
    case ComponentDatatype.UNSIGNED_SHORT:
      return new Uint16Array(values.slice(0, length));
    case ComponentDatatype.INT:
      return new Int32Array(values.slice(0, length));
    case ComponentDatatype.UNSIGNED_INT:
      return new Uint32Array(values.slice(0, length));
    case ComponentDatatype.DOUBLE:
    case ComponentDatatype.FLOAT:
    default:
      return new Float32Array(values.slice(0, length));
  }
}
