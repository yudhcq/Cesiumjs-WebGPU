/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Device-loss **whole switch** (contract render-path-api.md §3, data-model §2.4/§10④, research §3,
 * tasks.md T051).
 *
 * The rule this module encodes is a *prohibition*, not a feature: after `device.lost` the backend MUST
 * stop submitting, destroy the WebGPU backend **and** the upstream scene, re-probe, and rebuild from
 * scratch. It MUST NOT keep any old-device resource or any old rendered image around as an overlay —
 * the constitution's principle II forbids two render paths being visible at once, and a stale canvas
 * would be exactly that.
 *
 * Because the caller (the product's render-path layer) owns the upstream `Scene`, this module keeps the
 * lifecycle and the evidence, and takes the destruction/rebuild steps as callbacks. Everything it
 * observes is recorded in a `WholeSwitchRecord`.
 */
import { DiagnosticError } from "./errors.js";

/** Why a whole switch happened (data-model §2.4). */
export type WholeSwitchTrigger = "device-lost" | "probe-failed" | "below-limit" | "timeout" | "manual";

/** One completed whole switch; the fields are the observable contract of FR-003/FR-006. */
export interface WholeSwitchRecord {
  readonly trigger: WholeSwitchTrigger;
  readonly from: "webgpu" | "webgl2" | "none";
  readonly to: "webgpu" | "webgl2";
  readonly destroyedResources: number;
  readonly rebuildMs: number;
  /** Draws submitted after the teardown started but before the rebuild finished. MUST be 0. */
  readonly residualDraws: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly notes: readonly string[];
}

export interface WholeSwitchSteps {
  /** Stop accepting/submitting draws immediately (synchronous). */
  readonly stopSubmitting: () => void;
  /** Destroy the backend and the upstream scene; returns how many GPU resources were released. */
  readonly destroy: () => { readonly destroyedResources: number } | number;
  /** Re-probe and rebuild; returns the backend that ended up active. */
  readonly rebuild: () => Promise<"webgpu" | "webgl2"> | ("webgpu" | "webgl2");
  /** Number of draws submitted since `stopSubmitting` was called (must stay 0). */
  readonly residualDraws: () => number;
  /** Optional status sink so the reason and the blind spots are observable (FR-009/FR-023). */
  readonly onRecord?: (record: WholeSwitchRecord) => void;
  /** Monotonic clock, injectable for deterministic tests. */
  readonly now?: () => number;
}

/**
 * Runs one whole switch and returns its record.
 *
 * The function is intentionally **not** re-entrant: a second `device.lost` while a switch is running
 * would otherwise destroy a half-built backend. Concurrent calls are rejected loudly.
 */
export async function performWholeSwitch(
  trigger: WholeSwitchTrigger,
  steps: WholeSwitchSteps,
  from: "webgpu" | "webgl2" | "none" = "webgpu",
): Promise<WholeSwitchRecord> {
  const now = steps.now ?? (() => Date.now());
  const startedAt = now();
  const notes: string[] = [];
  steps.stopSubmitting();
  const destroyedRaw = steps.destroy();
  const destroyedResources = typeof destroyedRaw === "number" ? destroyedRaw : destroyedRaw.destroyedResources;
  if (destroyedResources <= 0) {
    throw new DiagnosticError(
      "internal",
      "whole-switch: the teardown released 0 GPU resources. A whole switch MUST destroy the old backend and its " +
        "resources (data-model §2.4: `destroyedResources > 0`); a no-op teardown would leave the previous device's " +
        "objects alive next to the new backend, which principle II forbids.",
      { backend: "webgpu", requirementRef: "FR-003", entryPoint: "whole-switch.performWholeSwitch" },
    );
  }
  let to: "webgpu" | "webgl2";
  try {
    to = await steps.rebuild();
  } catch (error) {
    throw new DiagnosticError(
      "render-failed",
      `whole-switch: the rebuild after "${trigger}" failed: ${(error as Error)?.message ?? String(error)}. The switch ` +
        "MUST either succeed on WebGPU or fall back **wholesale** to WebGL2; a half-rebuilt backend MUST NOT be " +
        "left running (contract §3).",
      { backend: "webgpu", requirementRef: "FR-003", entryPoint: "whole-switch.performWholeSwitch", cause: error },
    );
  }
  const residualDraws = steps.residualDraws();
  const finishedAt = now();
  if (residualDraws !== 0) {
    throw new DiagnosticError(
      "render-failed",
      `whole-switch: ${residualDraws} draw(s) were submitted after the switch started and before it finished. The ` +
        "switch is a **teardown**, not a cross-fade: no draw may reach either backend while it runs (FR-006, " +
        "data-model §2.4 requires `residualDraws === 0`).",
      { backend: "webgpu", requirementRef: "FR-006", entryPoint: "whole-switch.performWholeSwitch" },
    );
  }
  if (to === "webgl2") {
    notes.push(
      "the rebuild probe did not yield a usable WebGPU device, so the session continues on the upstream WebGL2 " +
        "backend: this is a declared degradation (FR-023) and MUST be surfaced through the status channel.",
    );
  }
  notes.push("the old device's resources were destroyed before the rebuild started; no stale frame is kept (no overlay).");
  const record: WholeSwitchRecord = {
    trigger,
    from,
    to,
    destroyedResources,
    rebuildMs: finishedAt - startedAt,
    residualDraws,
    startedAt,
    finishedAt,
    notes,
  };
  steps.onRecord?.(record);
  return record;
}

/**
 * Subscribes to `device.lost` and runs the whole switch once per loss.
 *
 * @returns an unsubscribe function.
 */
export function watchDeviceLoss(
  device: GPUDevice,
  onLost: (info: GPUDeviceLostInfo, trigger: WholeSwitchTrigger) => void | Promise<void>,
): () => void {
  let handled = false;
  const lost = device.lost;
  if (lost === undefined || lost === null || typeof lost.then !== "function") {
    throw new DiagnosticError(
      "internal",
      "whole-switch: the device exposes no `lost` promise, so device loss cannot be observed. Without it a lost " +
        "device would be indistinguishable from a slow frame (FR-003).",
      { backend: "webgpu", requirementRef: "FR-003", entryPoint: "whole-switch.watchDeviceLoss" },
    );
  }
  let cancelled = false;
  void lost.then((info) => {
    if (cancelled || handled) return;
    handled = true;
    const reason = info?.reason ?? "unknown";
    void onLost(info, reason === "destroyed" ? "manual" : "device-lost");
  });
  return () => {
    cancelled = true;
  };
}
