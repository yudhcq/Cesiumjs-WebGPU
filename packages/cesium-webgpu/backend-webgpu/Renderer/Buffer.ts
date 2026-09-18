/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/Buffer.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * T055 — `Buffer` → `GPUBuffer` (research §6.1, data-model §5.2, FR-030).
 *
 * WHAT IS PRESERVED (the logic layer sees exactly the upstream shape)
 *   the three factories (`createVertexBuffer` / `createIndexBuffer` / `createPixelBuffer`), the
 *   constructor option bag (`context`, `typedArray` XOR `sizeInBytes`, `usage`, `bufferTarget`),
 *   `sizeInBytes`, `usage`, the index-buffer extras (`indexDatatype` / `bytesPerIndex` /
 *   `numberOfIndices`), `vertexArrayDestroyable`, the internal `_getBuffer()` handle accessor, and
 *   `destroy()` / `isDestroyed()`.
 *
 * WHAT CHANGES (and why)
 *   * `gl.bindBuffer`/`gl.bufferData` become `device.createBuffer` + `queue.writeBuffer`. WebGPU has
 *     no buffer binding state, so `_bind()`/`_unBind()` are documented no-ops: they exist because
 *     upstream's internals call them, and "bind" has no counterpart to preserve. Nothing about the
 *     *data* changes.
 *   * `getBufferSubData` (synchronous read-back) has **no** WebGPU equivalent — `mapAsync` is
 *     asynchronous and busy-waiting would break SC-004 — so it fails loudly as a slice-C
 *     capability (research §6.2, T053).
 *   * `copyFromBuffer` uses a one-shot command encoder that is submitted immediately. WebGPU's queue
 *     executes in submission order, so the observable ordering is the same as GL's synchronous
 *     `copyBufferSubData`.
 *
 * WEBGPU'S 4-BYTE RULE (measured constraint, recorded rather than hidden)
 *   `GPUQueue.writeBuffer` requires `bufferOffset`, `size` and the data offset to be multiples of
 *   4 (gpuweb issue #5203 tracks lifting it). Two consequences are handled here explicitly:
 *   the `GPUBuffer` is allocated with a size rounded **up** to a multiple of 4 (the upstream-visible
 *   `sizeInBytes` stays exact), and a write whose byte length is not a multiple of 4 is zero-padded
 *   to the next multiple of 4 — recorded in `bufferWriteNotes()` because the 1–3 padding bytes are
 *   outside the range the caller wrote (the terrain path never reaches this: its vertex attributes
 *   are `float32` and its index counts are multiples of 6). A write at a **misaligned offset** cannot
 *   be emulated at all and fails loudly, naming the increment that would need a shadow-copy design.
 */
import BufferUsage from "@cesium/engine/Source/Renderer/BufferUsage.js";

import { requireDevice } from "../webgpu/context-device.js";
import { DiagnosticError } from "../webgpu/errors.js";
import { bufferUsageToGpu, IndexDatatype } from "../webgpu/format-map.js";
import { gpuResourceRegistry, nextResourceId } from "../webgpu/gpu-resource-registry.js";

const UPSTREAM_MODULE = "Renderer/Buffer.js";

/** `WebGLConstants` buffer targets (numeric; the kept `WebGLConstants` is not needed for four values). */
const ARRAY_BUFFER = 0x8892;
const ELEMENT_ARRAY_BUFFER = 0x8893;
const PIXEL_PACK_BUFFER = 0x88eb;

/** `true` for the three targets upstream can use (anything else is a caller error). */
function isKnownTarget(bufferTarget: number): boolean {
  return bufferTarget === ARRAY_BUFFER || bufferTarget === ELEMENT_ARRAY_BUFFER || bufferTarget === PIXEL_PACK_BUFFER;
}

/** The role a target implies, which selects the `GPUBufferUsage` combination (T055). */
function roleOfTarget(bufferTarget: number): "vertex" | "index" | "pixel" {
  if (bufferTarget === ELEMENT_ARRAY_BUFFER) return "index";
  if (bufferTarget === PIXEL_PACK_BUFFER) return "pixel";
  return "vertex";
}

/** Round up to the next multiple of 4 (WebGPU's `writeBuffer`/allocation granularity). */
function roundUp4(value: number): number {
  return Math.ceil(value / 4) * 4;
}

/** Recorded 4-byte-rule paddings; surfaced so the approximation is never silent (FR-023/FR-033). */
const paddingRecords: { bytes: number; count: number }[] = [];

/** How many writes needed a zero-padded tail, and how many bytes that added. */
export function bufferWriteNotes(): readonly { readonly bytes: number; readonly count: number }[] {
  return paddingRecords.map((record) => ({ ...record }));
}

/** Test/lifecycle hook: forget the recorded paddings. */
export function resetBufferWriteNotes(): void {
  paddingRecords.length = 0;
}

function notePadding(bytes: number): void {
  const existing = paddingRecords.find((record) => record.bytes === bytes);
  if (existing === undefined) paddingRecords.push({ bytes, count: 1 });
  else existing.count += 1;
}

export interface BufferOptions {
  readonly context: unknown;
  readonly typedArray?: ArrayBufferView | undefined;
  readonly sizeInBytes?: number | undefined;
  readonly usage: number;
  readonly bufferTarget?: number | undefined;
  readonly indexDatatype?: number | undefined;
}

/**
 * The replacement `Buffer`.
 *
 * Upstream declares `Buffer` as a plain function used with `new`, so the replacement keeps the same
 * construction shape and the same option bag.
 */
export default class Buffer {
  readonly _id: string;
  readonly _context: unknown;
  readonly _webgl2 = true;
  readonly _bufferTarget: number;
  readonly _sizeInBytes: number;
  readonly _usage: number;
  readonly #gpuBuffer: GPUBuffer;
  readonly #gpuSizeInBytes: number;
  readonly #registryId: string;
  /** Upstream `VertexArray#destroy` reads this flag before releasing the buffer. */
  vertexArrayDestroyable = true;
  #destroyed = false;

  constructor(options: BufferOptions = {} as BufferOptions) {
    const context = options.context;
    const device = requireDevice(context, "Buffer#constructor", UPSTREAM_MODULE);

    if (options.typedArray === undefined && options.sizeInBytes === undefined) {
      throw new DiagnosticError("internal", "Buffer: either options.sizeInBytes or options.typedArray is required.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer#constructor",
      });
    }
    if (options.typedArray !== undefined && options.sizeInBytes !== undefined) {
      throw new DiagnosticError("internal", "Buffer: cannot pass in both options.sizeInBytes and options.typedArray.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer#constructor",
      });
    }
    if (!BufferUsage.validate(options.usage)) {
      throw new DiagnosticError("internal", `Buffer: usage ${String(options.usage)} is invalid (BufferUsage.validate).`, {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer#constructor",
      });
    }

    const bufferTarget = options.bufferTarget ?? ARRAY_BUFFER;
    if (!isKnownTarget(bufferTarget)) {
      throw new DiagnosticError("internal", `Buffer: bufferTarget ${String(bufferTarget)} is not a known WebGL buffer target.`, {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer#constructor",
        extra: { bufferTarget },
      });
    }

    const typedArray = options.typedArray;
    const sizeInBytes = typedArray === undefined ? (options.sizeInBytes as number) : typedArray.byteLength;
    if (!(sizeInBytes > 0)) {
      throw new DiagnosticError("internal", `Buffer: sizeInBytes must be greater than zero (got ${String(sizeInBytes)}).`, {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer#constructor",
      });
    }

    this._id = nextResourceId("Buffer");
    this._context = context;
    this._bufferTarget = bufferTarget;
    this._sizeInBytes = sizeInBytes;
    this._usage = options.usage;

    // WebGPU requires buffer sizes to be a multiple of 4; upstream does not. The upstream-visible
    // `sizeInBytes` stays exact — the tail is unobservable while read-back is the slice-C boundary.
    this.#gpuSizeInBytes = roundUp4(sizeInBytes);
    this.#gpuBuffer = device.createBuffer({
      label: `cesium-webgpu:Buffer:${this._id}`,
      size: this.#gpuSizeInBytes,
      usage: bufferUsageToGpu(options.usage, roleOfTarget(bufferTarget)),
    });
    this.#registryId = nextResourceId("Buffer", this._id);
    gpuResourceRegistry.register({ id: this.#registryId, kind: "buffer", bytes: this.#gpuSizeInBytes, upstreamClass: "Buffer" });

    if (typedArray !== undefined) this.copyFromArrayView(typedArray, 0);
  }

  /** Upstream `Buffer.sizeInBytes` (bytes the logic layer asked for, not the padded allocation). */
  get sizeInBytes(): number {
    return this._sizeInBytes;
  }

  /** Upstream `Buffer.usage` (the `BufferUsage` member the logic layer passed). */
  get usage(): number {
    return this._usage;
  }

  /**
   * `Buffer.createPixelBuffer` — a buffer that exists to be read back (`gl.PIXEL_PACK_BUFFER`).
   *
   * Read-back itself stays the slice-C boundary (`Context#readPixels`); creating the buffer is
   * supported because `usage` mapping is exactly what T055 covers.
   */
  static createPixelBuffer(options: BufferOptions): Buffer {
    if (options.context === undefined || options.context === null) {
      throw new DiagnosticError("internal", 'Buffer.createPixelBuffer: Check.defined("options.context", options.context) failed.', {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer.createPixelBuffer",
      });
    }
    return new Buffer({ ...options, bufferTarget: PIXEL_PACK_BUFFER });
  }

  /** `Buffer.createVertexBuffer` — untyped vertex data in GPU memory. */
  static createVertexBuffer(options: BufferOptions): Buffer {
    if (options.context === undefined || options.context === null) {
      throw new DiagnosticError("internal", 'Buffer.createVertexBuffer: Check.defined("options.context", options.context) failed.', {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer.createVertexBuffer",
      });
    }
    return new Buffer({ ...options, bufferTarget: ARRAY_BUFFER });
  }

  /** `Buffer.createIndexBuffer` — typed indices, plus upstream's three derived members. */
  static createIndexBuffer(options: BufferOptions): Buffer {
    if (options.context === undefined || options.context === null) {
      throw new DiagnosticError("internal", 'Buffer.createIndexBuffer: Check.defined("options.context", options.context) failed.', {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer.createIndexBuffer",
      });
    }
    const indexDatatype = options.indexDatatype;
    if (!isIndexDatatype(indexDatatype)) {
      throw new DiagnosticError("internal", `Buffer.createIndexBuffer: invalid indexDatatype ${String(indexDatatype)}.`, {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer.createIndexBuffer",
        extra: { indexDatatype: String(indexDatatype) },
      });
    }
    // Upstream gates UNSIGNED_INT on the GL extension. WebGPU supports 32-bit indices unconditionally,
    // but the *logic layer's* capability flag is what decides which type it asks for, so the check is
    // kept in the same place with the same meaning (`context.elementIndexUint`).
    const elementIndexUint = (options.context as { elementIndexUint?: boolean }).elementIndexUint;
    if (indexDatatype === IndexDatatype.UNSIGNED_INT && elementIndexUint !== true) {
      throw new DiagnosticError(
        "internal",
        "Buffer.createIndexBuffer: IndexDatatype.UNSIGNED_INT requires OES_element_index_uint. Check context.elementIndexUint.",
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Buffer.createIndexBuffer" },
      );
    }

    const buffer = new Buffer({ ...options, bufferTarget: ELEMENT_ARRAY_BUFFER });
    const bytesPerIndex = indexDatatypeSizeInBytes(indexDatatype);
    const numberOfIndices = buffer.sizeInBytes / bytesPerIndex;
    Object.defineProperties(buffer, {
      indexDatatype: { get: () => indexDatatype, enumerable: true },
      bytesPerIndex: { get: () => bytesPerIndex, enumerable: true },
      numberOfIndices: { get: () => numberOfIndices, enumerable: true },
    });
    return buffer;
  }

  /** Upstream `_getBuffer()` — the raw platform handle (`GPUBuffer` in this backend). */
  _getBuffer(): GPUBuffer {
    this.#assertAlive("_getBuffer");
    return this.#gpuBuffer;
  }

  /** The `GPUIndexFormat` of an index buffer (`"uint16"` / `"uint32"`). */
  _getGpuIndexFormat(): GPUIndexFormat {
    this.#assertAlive("_getGpuIndexFormat");
    const indexDatatype = (this as { indexDatatype?: number }).indexDatatype;
    if (indexDatatype === IndexDatatype.UNSIGNED_INT) return "uint32";
    if (indexDatatype === IndexDatatype.UNSIGNED_SHORT) return "uint16";
    throw new DiagnosticError(
      "internal",
      "Buffer._getGpuIndexFormat: this buffer is not an index buffer (it carries no indexDatatype). " +
        "WebGPU selects the index format per draw, so the caller MUST name an index buffer.",
      { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Buffer#_getGpuIndexFormat" },
    );
  }

  /**
   * Upstream `_bind()`. WebGPU has no buffer-binding state (bindings are per draw call, see
   * `VertexArray#toGpuVertexBuffers`), so there is nothing to preserve — the call is a documented
   * no-op rather than a silent failure of a *capability*.
   */
  _bind(): void {
    // Intentionally empty: `gl.bindBuffer` has no WebGPU counterpart.
  }

  /** Upstream `_unBind()`; see {@link Buffer#_bind}. */
  _unBind(): void {
    // Intentionally empty: `gl.bindBuffer(target, null)` has no WebGPU counterpart.
  }

  /**
   * Upstream `copyFromArrayView` → `GPUQueue.writeBuffer`.
   *
   * @throws a `DiagnosticError` for a misaligned offset or a range outside the buffer.
   */
  copyFromArrayView(arrayView: ArrayBufferView, offsetInBytes = 0): void {
    this.#assertAlive("copyFromArrayView");
    if (arrayView === undefined || arrayView === null) {
      throw new DiagnosticError("internal", 'Buffer.copyFromArrayView: Check.defined("arrayView", arrayView) failed.', {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer#copyFromArrayView",
      });
    }
    if (offsetInBytes + arrayView.byteLength > this._sizeInBytes) {
      throw new DiagnosticError(
        "internal",
        `Buffer.copyFromArrayView: offsetInBytes (${offsetInBytes}) + arrayView.byteLength (${arrayView.byteLength}) exceeds ` +
          `sizeInBytes (${this._sizeInBytes}). Upstream rejects the same range; the replacement MUST NOT write past the buffer.`,
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: "Buffer#copyFromArrayView" },
      );
    }
    if (offsetInBytes % 4 !== 0) {
      throw new DiagnosticError(
        "not-implemented",
        `Buffer.copyFromArrayView: a write at byte offset ${offsetInBytes} cannot be expressed in WebGPU — \`GPUQueue.writeBuffer\` ` +
          "requires a 4-byte-aligned offset (gpuweb issue #5203), and no aligned fallback preserves neighbouring bytes without a " +
          "CPU shadow copy of the whole buffer. The terrain path writes float32 attributes at 4-byte-aligned offsets.",
        {
          backend: "webgpu",
          upstreamModule: UPSTREAM_MODULE,
          requirementRef: "FR-030",
          entryPoint: "Buffer#copyFromArrayView",
          plannedPhase: "not planned: needs a shadow-copy buffer design (see the T055 implementation notes)",
          extra: { offsetInBytes, byteLength: arrayView.byteLength },
        },
      );
    }

    const device = requireDevice(this._context, "Buffer#copyFromArrayView", UPSTREAM_MODULE);
    const bytes = new Uint8Array(arrayView.buffer as ArrayBuffer, arrayView.byteOffset, arrayView.byteLength);
    const remainder = arrayView.byteLength % 4;
    if (remainder === 0) {
      device.queue.writeBuffer(this.#gpuBuffer, offsetInBytes, bytes);
      return;
    }
    const padded = roundUp4(arrayView.byteLength);
    if (offsetInBytes + padded > this.#gpuSizeInBytes) {
      throw new DiagnosticError(
        "not-implemented",
        `Buffer.copyFromArrayView: the write is ${arrayView.byteLength} byte(s) long (not a multiple of 4) and padding it to ` +
          `${padded} byte(s) would exceed the buffer. WebGPU cannot write a partial 4-byte word, so the write MUST fail loudly.`,
        {
          backend: "webgpu",
          upstreamModule: UPSTREAM_MODULE,
          requirementRef: "FR-030",
          entryPoint: "Buffer#copyFromArrayView",
          extra: { offsetInBytes, byteLength: arrayView.byteLength, paddedSizeInBytes: this.#gpuSizeInBytes },
        },
      );
    }
    const paddedBytes = new Uint8Array(padded);
    paddedBytes.set(bytes, 0);
    notePadding(4 - remainder);
    device.queue.writeBuffer(this.#gpuBuffer, offsetInBytes, paddedBytes);
  }

  /**
   * Upstream `copyFromBuffer` → one-shot `copyBufferToBuffer`.
   *
   * A command encoder is created, used and submitted immediately: WebGPU queues execute in
   * submission order, which is exactly the ordering guarantee GL's synchronous `copyBufferSubData`
   * gave the logic layer.
   */
  copyFromBuffer(readBuffer: Buffer, readOffset: number, writeOffset: number, sizeInBytes: number): void {
    this.#assertAlive("copyFromBuffer");
    if (readBuffer === undefined || readBuffer === null) {
      throw new DiagnosticError("internal", "Buffer.copyFromBuffer: readBuffer must be defined.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer#copyFromBuffer",
      });
    }
    if (!(sizeInBytes > 0)) {
      throw new DiagnosticError("internal", "Buffer.copyFromBuffer: sizeInBytes must be defined and be greater than zero.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer#copyFromBuffer",
      });
    }
    if (readOffset < 0 || readOffset + sizeInBytes > readBuffer.sizeInBytes) {
      throw new DiagnosticError("internal", "Buffer.copyFromBuffer: readOffset + sizeInBytes must be within readBuffer.sizeInBytes.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer#copyFromBuffer",
      });
    }
    if (writeOffset < 0 || writeOffset + sizeInBytes > this._sizeInBytes) {
      throw new DiagnosticError("internal", "Buffer.copyFromBuffer: writeOffset + sizeInBytes must be within this.sizeInBytes.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer#copyFromBuffer",
      });
    }
    if ((this._bufferTarget === ELEMENT_ARRAY_BUFFER) !== (readBuffer._bufferTarget === ELEMENT_ARRAY_BUFFER)) {
      throw new DiagnosticError("internal", "Buffer.copyFromBuffer: can not copy an index buffer into another buffer type.", {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-030",
        entryPoint: "Buffer#copyFromBuffer",
      });
    }
    if (readOffset % 4 !== 0 || writeOffset % 4 !== 0 || sizeInBytes % 4 !== 0) {
      throw new DiagnosticError(
        "not-implemented",
        "Buffer.copyFromBuffer: WebGPU's `copyBufferToBuffer` requires 4-byte-aligned offsets and size (gpuweb issue #5203); " +
          `got readOffset=${readOffset}, writeOffset=${writeOffset}, sizeInBytes=${sizeInBytes}.`,
        {
          backend: "webgpu",
          upstreamModule: UPSTREAM_MODULE,
          requirementRef: "FR-030",
          entryPoint: "Buffer#copyFromBuffer",
          plannedPhase: "not planned: needs a shadow-copy buffer design (see the T055 implementation notes)",
        },
      );
    }

    const device = requireDevice(this._context, "Buffer#copyFromBuffer", UPSTREAM_MODULE);
    const encoder = device.createCommandEncoder({ label: `cesium-webgpu:Buffer-copy:${this._id}` });
    encoder.copyBufferToBuffer(readBuffer._getBuffer(), readOffset, this.#gpuBuffer, writeOffset, sizeInBytes);
    device.queue.submit([encoder.finish()]);
  }

  /**
   * Upstream `getBufferData` (synchronous read-back).
   *
   * @throws a `DiagnosticError` (`category: "not-implemented"`) — WebGPU's only read path is
   *   `mapAsync`, which is asynchronous; busy-waiting on it would stall the frame (SC-004).
   */
  getBufferData(..._args: unknown[]): never {
    void _args;
    throw new DiagnosticError(
      "not-implemented",
      "Buffer.getBufferData (synchronous read-back) has no WebGPU equivalent: `GPUBuffer.mapAsync` is asynchronous and a busy-wait " +
        "would break the interaction-smoothness criterion (SC-004). Read-back is the slice-C boundary (`Context#readPixels`, T053); " +
        "the replacement MUST NOT return zero-filled data, which would be indistinguishable from a correct read.",
      {
        backend: "webgpu",
        upstreamModule: UPSTREAM_MODULE,
        requirementRef: "FR-033",
        entryPoint: "Buffer#getBufferData",
        plannedPhase: "slice C (asynchronous read-back pipeline)",
      },
    );
  }

  /** Upstream `isDestroyed()`. */
  isDestroyed(): boolean {
    return this.#destroyed;
  }

  /** Upstream `destroy()` → release the `GPUBuffer` and its ledger entry (T063). */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    gpuResourceRegistry.release(this.#registryId);
    this.#gpuBuffer.destroy();
  }

  #assertAlive(entryPoint: string): void {
    if (this.#destroyed) {
      throw new DiagnosticError(
        "render-failed",
        `Buffer.${entryPoint}: this buffer was destroyed, i.e. destroy() was called (upstream's destroyObject contract).`,
        { backend: "webgpu", upstreamModule: UPSTREAM_MODULE, requirementRef: "FR-030", entryPoint: `Buffer#${entryPoint}` },
      );
    }
  }
}

function isIndexDatatype(value: unknown): value is number {
  return value === IndexDatatype.UNSIGNED_BYTE || value === IndexDatatype.UNSIGNED_SHORT || value === IndexDatatype.UNSIGNED_INT;
}

function indexDatatypeSizeInBytes(indexDatatype: number): number {
  if (indexDatatype === IndexDatatype.UNSIGNED_BYTE) return 1;
  if (indexDatatype === IndexDatatype.UNSIGNED_SHORT) return 2;
  return 4;
}
