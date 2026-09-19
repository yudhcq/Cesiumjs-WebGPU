/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * The **runtime half** of the uniform path (data-model 搂4.3, research 搂5.4).
 *
 * `webgpu/uniform-writer.ts` (T076) owns the CPU side: it encodes the program's uniform `struct`
 * field by field into an `ArrayBuffer` ring whose slot 0 is the automatic block and whose remaining
 * slots are the per-command blocks addressed by dynamic offset. What was missing until W5 is the GPU
 * half 鈥?a `GPUBuffer` mirroring that ring, the bind group over it, and a driver that runs once per
 * frame and once per draw. Without it `Context.draw` never calls `ShaderProgram._setUniforms`, the
 * uniform block is never written, and every vertex of the real terrain arrives with a zero
 * model-view-projection matrix: the whole globe is clipped away and the frame is empty while the
 * draw counters look healthy. (W2/W3 contract workloads built their own pipelines **and** passed
 * explicit bind groups, so nothing exercised this path before the terrain scene did.)
 *
 * Binding shape (one program, two groups):
 *
 *   group 0 鈥?`binding: 0`, the uniform block, `hasDynamicOffset: true`, `size = structSize`.
 *             Slot 0 carries the automatic block (written once per frame, lazily), and each command's
 *             manual uniforms go into their own slot; `setBindGroup(0, group, [offset])` selects it.
 *   group 1 鈥?the texture/sampler pairs, assembled by the sampler path (`writeSampler`); it exists
 *             only for programs whose layout declares samplers.
 */
import { DiagnosticError } from "./errors.js";
import { UniformStaging } from "./uniform-writer.js";
import type { BindLayoutResult } from "./bind-layout.js";

const MODULE = "backend-webgpu/webgpu/uniform-gpu-staging.ts";

/**
 * Shader stages the uniform block is visible to (`ShaderProgram` binds it to both).
 *
 * Read **lazily**: `GPUShaderStage` is a WebGPU global that does not exist in the Node unit layer, and a
 * module-scope read made every unit test that imports the backend fail with
 * `ReferenceError: GPUShaderStage is not defined` (measured in W5).
 */
function shaderStageVertexFragment(): GPUShaderStageFlags {
  const stage = (globalThis as { GPUShaderStage?: { VERTEX: number; FRAGMENT: number } }).GPUShaderStage;
  // Spec-fixed values, used when the runtime global is absent (the Node unit layer).
  return (stage === undefined ? 0x1 | 0x2 : stage.VERTEX | stage.FRAGMENT) as GPUShaderStageFlags;
}

export interface GpuUniformStagingCounters {
  /** Frames this staging area has seen. */
  readonly frames: number;
  /** Uploads of the ring to the GPU buffer. */
  readonly uploads: number;
  /** Uploads skipped because nothing had changed since the previous one. */
  readonly skippedUploads: number;
  /** Command slots handed out (one per draw that carried manual uniforms or automatic changes). */
  readonly commandSlots: number;
  /** Bytes the CPU side actually wrote (from `UniformStaging`). */
  readonly bytesWritten: number;
}

/**
 * The GPU mirror of one program's uniform ring plus the bind group that exposes it.
 *
 * `flush()` uploads the whole ring through `queue.writeBuffer`; the upload is skipped when the CPU
 * side has not written a single byte since the previous one, which is the common case for a command
 * whose uniforms did not change (T076's "value unchanged 鈬?no write" semantic, extended to the GPU).
 */
export interface GpuUniformStaging {
  readonly staging: UniformStaging;
  readonly buffer: GPUBuffer;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly bindGroup: GPUBindGroup;
  readonly structSize: number;
  readonly slotSize: number;
  /** Rewind the command cursor for a new frame (called once per context frame). */
  beginFrame(): void;
  /** Write one command's manual uniforms and return the dynamic offset that selects them. */
  writeCommand(values: Readonly<Record<string, unknown>>): number;
  /** Upload the ring if anything changed since the previous upload. */
  flush(): void;
  counters(): GpuUniformStagingCounters;
  destroy(): void;
}

interface MutableCounters {
  frames: number;
  uploads: number;
  skippedUploads: number;
  commandSlots: number;
}

/**
 * Create the GPU staging area of one uniform layout.
 *
 * @throws a `DiagnosticError` when the device refuses the buffer/bind group 鈥?publishing a staging
 *   area that cannot be bound would make every draw of the program a validation error at frame end,
 *   far from the cause (FR-033: fail where the problem is).
 */
/**
 * The `GPUBufferUsage` bits this module needs.
 *
 * Read from the global when it exists (the browser), else from the values the WebGPU specification
 * fixes — the Node unit layer has no WebGPU globals, and a module-scope read made the whole backend
 * unimportable there (measured in W5: `ReferenceError: GPUBufferUsage is not defined`).
 */
function bufferUsage(): { readonly UNIFORM: number; readonly COPY_DST: number } {
  const usage = (globalThis as { GPUBufferUsage?: { UNIFORM: number; COPY_DST: number } }).GPUBufferUsage;
  return usage === undefined ? { UNIFORM: 0x40, COPY_DST: 0x8 } : usage;
}

export function createGpuUniformStaging(device: GPUDevice, layout: BindLayoutResult, options: { readonly label?: string } = {}): GpuUniformStaging {
  const label = options.label ?? `cesium-webgpu:uniforms-${layout.structName}`;
  const usage = bufferUsage();
  try {
    const staging = new UniformStaging(layout);
    const buffer = device.createBuffer({
      label: `${label}:ring`,
      size: staging.ring.frameCapacityBytes,
      usage: usage.UNIFORM | usage.COPY_DST,
    });
    const bindGroupLayout = device.createBindGroupLayout({
      label: `${label}:group0`,
      entries: [
        {
          binding: 0,
          visibility: shaderStageVertexFragment(),
          buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: layout.structSize },
        },
      ],
    });
    const bindGroup = device.createBindGroup({
      label: `${label}:bind-group`,
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer, offset: 0, size: layout.structSize } }],
    });
    const counters: MutableCounters = { frames: 0, uploads: 0, skippedUploads: 0, commandSlots: 0 };
    // Only the automatic block's own uploads move this cursor: `writeCommand` uploads its slot itself, so
    // it must not mark the automatic block as uploaded (the first version did, and the automatic block 鈥?    // every `czm_*` matrix included 鈥?stayed all zeros on the GPU while the draws looked healthy).
    let flushedBytes = -1;
    return {
      staging,
      buffer,
      bindGroupLayout,
      bindGroup,
      structSize: layout.structSize,
      slotSize: staging.slotSize,
      beginFrame(): void {
        staging.beginFrame();
        counters.frames += 1;
      },
      writeCommand(values: Readonly<Record<string, unknown>>): number {
        // A command slot is a **snapshot of the automatic block plus this command's overrides**: the
        // shader reads the same `struct` for both kinds of uniform, so a slot that carried only the
        // overrides would zero every automatic member. Seeding the slot from slot 0 is what makes
        // `setBindGroup(0, group, [dynamicOffset])` a complete uniform block.
        const target = staging.ring.writeOffset;
        new Uint8Array(staging.ring.buffer).copyWithin(target, 0, layout.structSize);
        const resolved: Record<string, unknown> = {};
        const callbacks = values as Record<string, () => unknown>;
        for (const name of Object.keys(values)) {
          const value = values[name];
          resolved[name] = typeof value === "function" ? callbacks[name]!() : value;
        }
        const { dynamicOffset, bytes } = staging.writeCommand(resolved);
        device.queue.writeBuffer(buffer, dynamicOffset, bytes as Uint8Array<ArrayBuffer>);
        counters.commandSlots += 1;
        return dynamicOffset;
      },
      flush(): void {
        if (flushedBytes === staging.bytesWritten) {
          counters.skippedUploads += 1;
          return;
        }
        device.queue.writeBuffer(buffer, 0, new Uint8Array(staging.ring.buffer as ArrayBuffer, 0, layout.structSize));
        flushedBytes = staging.bytesWritten;
        counters.uploads += 1;
      },
      counters(): GpuUniformStagingCounters {
        return { ...counters, bytesWritten: staging.bytesWritten };
      },
      destroy(): void {
        buffer.destroy();
      },
    };
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    throw new DiagnosticError(
      "render-failed",
      `the uniform staging area of "${layout.structName}" (${layout.structSize} bytes) could not be created: ${(error as Error)?.message ?? String(error)}. ` +
        "Every draw of this program needs a bound uniform block, so the backend MUST NOT continue without one.",
      { backend: "webgpu", upstreamModule: "Renderer/ShaderProgram.js", requirementRef: "FR-030", entryPoint: `${MODULE}#createGpuUniformStaging`, cause: error },
    );
  }
}

/** The `GPUBindGroupLayout` of the uniform block, as the pipeline layout must declare it. */
export function uniformBlockLayoutEntries(structSize: number): GPUBindGroupLayoutEntry[] {
  return [{ binding: 0, visibility: shaderStageVertexFragment(), buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: structSize } }];
}
