/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Derived pass state machine (research §5.2, data-model §4.1, gate G-3): a pass boundary is
 * **derived** from
 *
 *   RenderPassKey = (colorTargets, depthStencilTarget, sampleCount, viewport, scissorRect)
 *
 * and never from upstream's `Pass` objects or `passState` mutations. Changes of program, vertex
 * array, uniforms or `RenderState` MUST NOT split a pass; multisample resolve maps onto
 * `colorAttachments[i].resolveTarget`.
 *
 * PHASE 3 (W1) SKELETON: the state machine lands in W2/T046; the pass key shape is frozen here so
 * the manifest, the audit and the contract tests can refer to it.
 */
import { throwNotImplemented } from "./errors.js";

const CAPABILITY = "derived pass state machine";

/** Identity of one derived render pass (any change to these fields closes the current pass). */
export interface RenderPassKey {
  readonly colorTargets: readonly string[];
  readonly depthStencilTarget: string | null;
  readonly sampleCount: number;
  readonly viewport: readonly [number, number, number, number];
  readonly scissorRect: readonly [number, number, number, number];
}

/** Compare two pass keys (used by the state machine and the G-3 replay test). */
export function passKeyEquals(left: RenderPassKey, right: RenderPassKey): boolean {
  return (
    left.depthStencilTarget === right.depthStencilTarget &&
    left.sampleCount === right.sampleCount &&
    left.colorTargets.length === right.colorTargets.length &&
    left.colorTargets.every((target, index) => target === right.colorTargets[index]) &&
    left.viewport.every((value, index) => value === right.viewport[index]) &&
    left.scissorRect.every((value, index) => value === right.scissorRect[index])
  );
}

/** Open a pass encoder for a key (W2/T046). */
export function beginPass(_key: RenderPassKey): never {
  throwNotImplemented(CAPABILITY, {
    entryPoint: "pass-encoder.beginPass",
    plannedPhase: "W2 (T046)",
    requirementRef: "FR-030",
  });
}

/** Close the current pass; called whenever the derived key changes and at `endFrame` (W2/T046). */
export function closePass(): never {
  throwNotImplemented(CAPABILITY, {
    entryPoint: "pass-encoder.closePass",
    plannedPhase: "W2 (T046)",
    requirementRef: "FR-030",
  });
}

/** True while a pass is open — asserted by the "no pass left open at endFrame" contract test. */
export function isPassOpen(): never {
  throwNotImplemented(CAPABILITY, {
    entryPoint: "pass-encoder.isPassOpen",
    plannedPhase: "W2 (T046)",
    requirementRef: "FR-030",
  });
}
