/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Device hand-off slot (contract render-path-api.md §2 / research §3): the capability probe
 * fetches `adapter`/`device` **before** the upstream `Scene` is constructed and parks them here,
 * so the replacement `Context` can read them synchronously during construction — upstream reads
 * `ContextLimits` and the capability flags in its constructor, which rules out an async hand-off.
 *
 * PHASE 3 (W1) SKELETON: the slot semantics land in W2/T042. Until then every operation fails
 * loudly: an accidentally successful hand-off would let a half-built backend claim the context.
 */
import { throwNotImplemented } from "./errors.js";

const CAPABILITY = "device hand-off";

/** What the probe obtained; read synchronously by the replacement `Context` (research §3). */
export interface DeviceHandoff {
  readonly adapter: unknown;
  readonly device: unknown;
  readonly limits: Readonly<Record<string, number>>;
  readonly features: readonly string[];
  readonly requestedAt: number;
}

/** Install the probed device — exactly once, in the same process, before the scene exists. */
export function install(_handoff: DeviceHandoff): void {
  throwNotImplemented(CAPABILITY, {
    entryPoint: "device-handoff.install",
    plannedPhase: "W2 (T042)",
    requirementRef: "FR-005",
  });
}

/** Take the hand-off (and clear the slot) while constructing the replacement `Context`. */
export function take(): DeviceHandoff | undefined {
  throwNotImplemented(CAPABILITY, {
    entryPoint: "device-handoff.take",
    plannedPhase: "W2 (T042)",
    requirementRef: "FR-005",
  });
}

/** Read the hand-off without clearing it (diagnostics / status reporting). */
export function peek(): DeviceHandoff | undefined {
  throwNotImplemented(CAPABILITY, {
    entryPoint: "device-handoff.peek",
    plannedPhase: "W2 (T042)",
    requirementRef: "FR-005",
  });
}

/** Clear the slot (whole-backend switch, device loss). */
export function clear(): void {
  throwNotImplemented(CAPABILITY, {
    entryPoint: "device-handoff.clear",
    plannedPhase: "W2 (T042)",
    requirementRef: "FR-005",
  });
}
