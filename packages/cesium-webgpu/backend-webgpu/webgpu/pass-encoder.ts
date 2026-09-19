/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Derived pass state machine (research §1.5/§5.2, data-model §4.1, gate G-3, tasks.md T046).
 *
 * A pass boundary is **derived** from platform-visible state only:
 *
 *   RenderPassKey = (colorTargets, depthStencilTarget, sampleCount, viewport, scissorRect)
 *
 * It is never derived from upstream's `Pass` enum, a `PassState` instance, the bound program, the
 * vertex array, the uniform values or the `RenderState`: research §1.5 established that upstream has
 * **no** pass callbacks at all (`beginPass`/`endPass` hit count 0 in `Source/**`) and G-3 measured that
 * every effective target switch in a real upstream frame already coincides with an identity change, so
 * the backend never has to ask the logic layer for a hint.
 *
 * The machine is *lazy*: a pass is opened by the **first work operation** (clear/draw), not by a state
 * change. G-3 measured 4 redundant re-binds of the already-current target in a single frame; opening a
 * pass on those would manufacture empty passes, and G-3's check (c)
 * ("no unclosed pass before endFrame") depends on not doing so.
 *
 * CLEARING (research §5.1, G-3 conclusion §2.2)
 *   * A clear that **opens** its pass becomes `loadOp: "clear"` — the measured main path (G-3:
 *     "every pass that contains a clear has it as its first work operation").
 *   * A clear in the *middle* of a pass has no direct WebGPU equivalent. The machine therefore tries
 *     `GPURenderPassEncoder.clearBuffer` **if the runtime exposes it** (it is not part of the published
 *     `@webgpu/types` 0.1.72 surface any more), and otherwise closes the GPU pass and reopens it with
 *     `loadOp: "clear"` while keeping the **same derived pass record** — so the derived sequence, which
 *     is what G-3 and T047 assert on, is unchanged.
 */
import { DiagnosticError } from "./errors.js";

/** Identity of one derived render pass; any change to these fields closes the current pass. */
export interface RenderPassKey {
  readonly colorTargets: readonly string[];
  readonly depthStencilTarget: string | null;
  readonly sampleCount: number;
  readonly viewport: readonly [number, number, number, number];
  readonly scissorRect: readonly [number, number, number, number] | null;
}

function tuplesEqual(left: readonly number[] | null, right: readonly number[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Compare two pass keys (used by the state machine and the G-3 replay test). */
export function passKeyEquals(left: RenderPassKey, right: RenderPassKey): boolean {
  return (
    left.depthStencilTarget === right.depthStencilTarget &&
    left.sampleCount === right.sampleCount &&
    left.colorTargets.length === right.colorTargets.length &&
    left.colorTargets.every((target, index) => target === right.colorTargets[index]) &&
    tuplesEqual(left.viewport, right.viewport) &&
    tuplesEqual(left.scissorRect, right.scissorRect)
  );
}

/** Canonical text of a pass key (diagnostics, evidence artefacts, offline comparison). */
export function passKeyToString(key: RenderPassKey): string {
  return (
    `color=[${key.colorTargets.join("|")}]; depth=${key.depthStencilTarget ?? "null"}; samples=${key.sampleCount}; ` +
    `viewport=[${key.viewport.join(",")}]; scissor=${key.scissorRect === null ? "full" : `[${key.scissorRect.join(",")}]`}`
  );
}

/** Color/depth target references for one pass, resolved from the key by the caller. */
export interface PassTargets {
  readonly colorAttachments: readonly GPURenderPassColorAttachment[];
  readonly depthStencilAttachment?: GPURenderPassDepthStencilAttachment;
}

/**
 * Resolves the WebGPU attachments for a key.
 *
 * `loadOp` for the first operation of a pass is decided by the machine; the provider only supplies
 * views and clear values, so the load/store evidence stays with the machine and can be replayed.
 */
export type PassTargetProvider = (key: RenderPassKey) => PassTargets;

/** Which clear mechanism a `clear` work operation used. */
export type ClearMechanism = "loadOp" | "clearBuffer" | "reopenWithLoadOpClear";

export interface PassWorkOp {
  readonly kind: "clear" | "draw";
  /** Sequence number of the originating operation (G-3 trace replay / contract evidence). */
  readonly seq: number;
  /** Only for `clear`: which mechanism actually cleared the attachments. */
  readonly clearMechanism?: ClearMechanism;
  /** Only for `draw`: which encoder entry point the backend used. */
  readonly drawKind?: "draw" | "drawIndexed";
}

export interface DerivedPassRecord {
  readonly index: number;
  readonly key: RenderPassKey;
  readonly keyText: string;
  /** `true` when the pass was opened with `loadOp:"clear"` (including a reopen). */
  readonly openedWithLoadOpClear: boolean;
  /** How many GPU passes this one derived pass needed (2+ only when a mid-pass clear had to reopen). */
  readonly gpuPassCount: number;
  readonly workOps: readonly PassWorkOp[];
  readonly clearOps: number;
  readonly drawOps: number;
  readonly closedBy: "identity-change" | "endFrame";
  readonly sampleCount: number;
}

/** Operations that MUST NOT constitute a pass boundary (research §1.5; asserted by the unit test). */
export const NON_BOUNDARY_CHANGES = [
  "pass",
  "passState",
  "program",
  "vertexArray",
  "uniforms",
  "renderState",
  "redundant-target-rebind",
] as const;
export type NonBoundaryChange = (typeof NON_BOUNDARY_CHANGES)[number];

export interface NonBoundaryRecord {
  readonly change: NonBoundaryChange;
  /** Index of the derived pass the change stayed inside, or `-1` when no pass was open. */
  readonly boundTo: number;
  readonly causedBoundary: false;
}

/** `clearBuffer` is not in the published `GPURenderPassEncoder` surface any more: probe for it. */
type ClearBufferCapable = { clearBuffer?: (bufferType: string, index: number) => void };

export class PassStateMachine {
  readonly #targets: PassTargetProvider;
  readonly #openEncoder: (descriptor: GPURenderPassDescriptor) => GPURenderPassEncoder;
  #current: { record: MutablePass; encoder: GPURenderPassEncoder; descriptor: GPURenderPassDescriptor } | null = null;
  #passes: MutablePass[] = [];
  #nonBoundary: NonBoundaryRecord[] = [];
  #frameOpen = false;
  #usedNativeClearBuffer = false;

  constructor(options: { targets: PassTargetProvider; openEncoder: (descriptor: GPURenderPassDescriptor) => GPURenderPassEncoder }) {
    this.#targets = options.targets;
    this.#openEncoder = options.openEncoder;
  }

  /** Start a frame; every pass of the previous frame must already be closed. */
  beginFrame(): void {
    if (this.#current !== null) this.closePass("endFrame");
    this.#frameOpen = true;
    this.#passes = [];
    this.#nonBoundary = [];
    this.#usedNativeClearBuffer = false;
  }

  /** True while a pass is open — asserted by the "no pass left open at endFrame" contract test. */
  isPassOpen(): boolean {
    return this.#current !== null;
  }

  /** True while a frame is open (between `beginFrame` and `endFrame`). */
  isFrameOpen(): boolean {
    return this.#frameOpen;
  }

  /** True when this frame cleared mid-pass through the runtime's native `clearBuffer`. */
  usedNativeClearBuffer(): boolean {
    return this.#usedNativeClearBuffer;
  }

  /**
   * Record a state change that MUST NOT split the pass. Returns the index of the pass it stayed in
   * (`-1` when no pass is open, i.e. the change happened before the first work operation — which is
   * exactly G-3's "a state change that produces no work does not create a pass").
   */
  noteStateChange(change: NonBoundaryChange): number {
    const boundTo = this.#current === null ? -1 : this.#current.record.index;
    this.#nonBoundary.push({ change, boundTo, causedBoundary: false });
    return boundTo;
  }

  /**
   * Open (if needed) the pass for `key` and record one work operation.
   *
   * Returns the live encoder plus the derived record. Opening is deferred to this call so a target
   * switch with no work in between never manufactures an empty pass.
   */
  beginWork(
    key: RenderPassKey,
    work: { kind: "clear" | "draw"; seq: number; drawKind?: "draw" | "drawIndexed"; clearValue?: GPUColor; clearColor?: boolean; clearDepthStencil?: boolean },
  ): { encoder: GPURenderPassEncoder; pass: DerivedPassRecord; openedByThisOp: boolean; clearMechanism?: ClearMechanism } {
    if (!this.#frameOpen) {
      throw new DiagnosticError(
        "internal",
        "pass-encoder: a work operation arrived outside a frame. `beginFrame` MUST run before any draw or clear " +
          "(research §5.1: beginFrame takes the swap-chain texture and creates the command encoder).",
        { backend: "webgpu", requirementRef: "FR-030", entryPoint: "pass-encoder.beginWork" },
      );
    }
    // A `clear` command names the attachment(s) it clears: upstream's `ClearCommand` carries `color`,
    // `depth` and `stencil` independently (`Renderer/ClearCommand.js`), and a depth-only clear MUST NOT
    // touch the colour attachment. Getting this wrong is invisible until a real frame has both kinds:
    // the W5 terrain frame's third clear is depth-only, it reopened the pass with `loadOp: "clear"`, and
    // the whole canvas — background included — became transparent black while 7 tile draws were issued.
    const clearColor = work.kind !== "clear" || work.clearColor !== false;
    const clearDepthStencil = work.kind !== "clear" || work.clearDepthStencil !== false;
    let openedByThisOp = false;
    if (this.#current !== null && !passKeyEquals(this.#current.record.key, key)) {
      this.closePass("identity-change");
    }
    if (this.#current === null) {
      openedByThisOp = true;
      const record: MutablePass = {
        index: this.#passes.length,
        key,
        keyText: passKeyToString(key),
        openedWithLoadOpClear: work.kind === "clear",
        gpuPassCount: 1,
        workOps: [],
        clearOps: 0,
        drawOps: 0,
        closedBy: "endFrame",
        sampleCount: key.sampleCount,
      };
      // Opening a pass **establishes every attachment**: the first work operation clears the colour and
      // the depth-stencil (a fresh target's content is otherwise undefined, which made the depth test
      // read garbage in the W2 workload). The per-attachment intent applies to a clear that arrives
      // *inside* an open pass — that is the case the W5 terrain frame measured (a depth-only clear used
      // to wipe the colour attachment).
      const descriptor = this.#descriptorFor(key, work.kind === "clear", work.clearValue);
      this.#passes.push(record);
      this.#current = { record, encoder: this.#openEncoder(descriptor), descriptor };
    }
    const record = this.#current!.record;
    if (work.kind === "clear") {
      const mechanism = this.#clearMechanism(work.clearValue, clearColor, clearDepthStencil);
      record.workOps.push({ kind: "clear", seq: work.seq, clearMechanism: mechanism });
      record.clearOps += 1;
      return { encoder: this.#current!.encoder, pass: snapshot(record), openedByThisOp, clearMechanism: mechanism };
    }
    record.workOps.push({ kind: "draw", seq: work.seq, drawKind: work.drawKind ?? "draw" });
    record.drawOps += 1;
    return { encoder: this.#current!.encoder, pass: snapshot(record), openedByThisOp };
  }

  /** The live encoder of the currently open pass. */
  currentEncoder(): GPURenderPassEncoder | null {
    return this.#current === null ? null : this.#current.encoder;
  }

  /** The descriptor the current pass was opened with (evidence for the descriptor assertions). */
  currentDescriptor(): GPURenderPassDescriptor | null {
    return this.#current === null ? null : this.#current.descriptor;
  }

  /** Close the current pass; called whenever the derived key changes and at `endFrame`. */
  closePass(closedBy: "identity-change" | "endFrame"): void {
    if (this.#current === null) return;
    this.#current.record.closedBy = closedBy;
    this.#current.encoder.end();
    this.#current = null;
  }

  /** Close the open pass (if any) and mark the frame finished. */
  endFrame(): void {
    this.closePass("endFrame");
    this.#frameOpen = false;
  }

  /** Derived pass sequence of the frame (evidence artefact for T047 / the offline comparator). */
  sequence(): {
    readonly passes: readonly DerivedPassRecord[];
    readonly nonBoundaryChanges: readonly NonBoundaryRecord[];
    readonly passOpenAtEnd: boolean;
  } {
    return {
      passes: this.#passes.map(snapshot),
      nonBoundaryChanges: this.#nonBoundary.map((entry) => ({ ...entry })),
      passOpenAtEnd: this.#current !== null,
    };
  }

  // -----------------------------------------------------------------------------------------------
  // internals
  // -----------------------------------------------------------------------------------------------

  /** Build the pass descriptor for `key`; `firstOpIsClear` decides every attachment's `loadOp`. */
  #descriptorFor(key: RenderPassKey, firstOpIsClear: boolean, clearValue: GPUColor | undefined, clearColor = true, clearDepthStencil = true): GPURenderPassDescriptor {
    const targets = this.#targets(key);
    const colorAttachments = targets.colorAttachments.map((attachment) =>
      firstOpIsClear && clearColor
        ? {
            ...attachment,
            loadOp: "clear" as const,
            clearValue: clearValue ?? attachment.clearValue ?? { r: 0, g: 0, b: 0, a: 0 },
            storeOp: attachment.storeOp ?? ("store" as const),
          }
        : { ...attachment, loadOp: "load" as const, storeOp: attachment.storeOp ?? ("store" as const) },
    );
    const depthStencilAttachment =
      targets.depthStencilAttachment === undefined
        ? undefined
        : {
            ...targets.depthStencilAttachment,
            ...(firstOpIsClear && clearDepthStencil
              ? {
                  depthLoadOp: "clear" as const,
                  depthClearValue: targets.depthStencilAttachment.depthClearValue ?? 1,
                  ...(targets.depthStencilAttachment.stencilStoreOp === undefined
                    ? {}
                    : { stencilLoadOp: "clear" as const, stencilClearValue: 0 }),
                }
              : { depthLoadOp: "load" as const }),
          };
    const descriptor: GPURenderPassDescriptor = {
      colorAttachments: colorAttachments as GPURenderPassColorAttachment[],
      ...(depthStencilAttachment === undefined ? {} : { depthStencilAttachment }),
    };
    return descriptor;
  }

  /** Clear the current pass's attachments, opening a new GPU pass first when necessary. */
  #clearMechanism(clearValue: GPUColor | undefined, clearColor = true, clearDepthStencil = true): ClearMechanism {
    const current = this.#current!;
    const record = current.record;
    if (record.clearOps === 0 && record.openedWithLoadOpClear) return "loadOp";
    const native = (current.encoder as unknown as ClearBufferCapable).clearBuffer;
    if (typeof native === "function") {
      const attachments = [...(current.descriptor.colorAttachments ?? [])];
      if (clearColor) for (let index = 0; index < attachments.length; index += 1) native.call(current.encoder, "color", index);
      if (clearDepthStencil && current.descriptor.depthStencilAttachment !== undefined) {
        native.call(current.encoder, "depth", 0);
        if (current.descriptor.depthStencilAttachment.stencilLoadOp !== undefined) native.call(current.encoder, "stencil", 0);
      }
      this.#usedNativeClearBuffer = true;
      return "clearBuffer";
    }
    // No in-pass clear is available: close this GPU pass and reopen the SAME derived pass with loadOp.
    // The derived record is reused, so the derived sequence G-3/T047 assert on is unchanged.
    current.encoder.end();
    const descriptor = this.#descriptorFor(record.key, true, clearValue, clearColor, clearDepthStencil);
    const encoder = this.#openEncoder(descriptor);
    record.gpuPassCount += 1;
    this.#current = { record, encoder, descriptor };
    return "reopenWithLoadOpClear";
  }
}

interface MutablePass {
  index: number;
  key: RenderPassKey;
  keyText: string;
  openedWithLoadOpClear: boolean;
  gpuPassCount: number;
  workOps: PassWorkOp[];
  clearOps: number;
  drawOps: number;
  closedBy: "identity-change" | "endFrame";
  sampleCount: number;
}

function snapshot(record: MutablePass): DerivedPassRecord {
  return {
    index: record.index,
    key: record.key,
    keyText: record.keyText,
    openedWithLoadOpClear: record.openedWithLoadOpClear,
    gpuPassCount: record.gpuPassCount,
    workOps: record.workOps.map((op) => ({ ...op })),
    clearOps: record.clearOps,
    drawOps: record.drawOps,
    closedBy: record.closedBy,
    sampleCount: record.sampleCount,
  };
}
