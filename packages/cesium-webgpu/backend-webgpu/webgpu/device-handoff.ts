/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Device hand-off slot (contract render-path-api.md §2 / research §3, gate G-2, tasks.md T042):
 * the capability probe fetches `adapter`/`device` **before** the upstream `Scene` is constructed and
 * parks them here, so the replacement `Context` can read them synchronously during construction —
 * upstream reads `ContextLimits` and the capability flags in its constructor, which rules out an
 * asynchronous hand-off (research §3, measured in G-2: the `take()` call stack is
 * `take ← new Context ← new Scene`).
 *
 * WHY THE SLOT LIVES ON `globalThis`
 *   The probe is product code (`src/render-path/**`) and the consumer is patch-layer code
 *   (`backend-webgpu/**`). Architecture rule A2 forbids `src/**` from importing
 *   `backend-webgpu/**`, so the two sides cannot share a module instance by import. They share the
 *   realm's global object instead — the same mechanism G-2 used and validated. Consequences:
 *     - one slot per realm (window / worker / Node test process);
 *     - the slot is plain data, so either side can be bundled separately and still agree.
 *
 * SEMANTICS (asserted by `tests/unit/device-handoff.test.mjs`)
 *   - `install(payload)` fills the slot **once per hand-off cycle**, before any upstream object
 *     exists. A second `install()` without an intervening `resetCycle()` throws
 *     `device-handoff/already-installed`: a stale device must never be swapped in behind a backend
 *     that is already bound to the previous one.
 *   - `take()` returns the payload and **clears** the slot; `undefined` when nothing was installed.
 *     `undefined` is the documented "no WebGPU device" state — in the product that is the
 *     **one-shot, construction-time whole delegation** to the preserved upstream WebGL2
 *     implementation (plan.md decision D2-a). It is NOT a per-command or per-frame fallback.
 *   - `peek()` reads without consuming (diagnostics / status reporting).
 *   - `clear()` drops the payload (teardown).
 *   - `resetCycle(reason)` starts a new cycle — the whole-backend switch after `device.lost`
 *     (T051) re-probes and re-installs on the new device. It refuses to run while a payload is
 *     still pending, so a device cannot be silently replaced.
 *   - every operation is appended to an audit log (`audit()`) so a run can prove *who* consumed the
 *     device and *when*.
 */
import { DiagnosticError } from "./errors.js";

/** Global key both sides of the hand-off agree on (probe in `src/**`, consumer in `backend-webgpu/**`). */
export const DEVICE_HANDOFF_KEY = "__CESIUM_WEBGPU_DEVICE_HANDOFF__";

/** Stable diagnostic categories of the slot (mirrors the `DiagnosticError.category` vocabulary). */
export const HANDOFF_CATEGORY = {
  alreadyInstalled: "device-handoff/already-installed",
  invalidPayload: "device-handoff/invalid-payload",
  missing: "device-handoff/missing",
  cycleNotResettable: "device-handoff/cycle-not-resettable",
} as const;

export type HandoffCategory = (typeof HANDOFF_CATEGORY)[keyof typeof HANDOFF_CATEGORY];

/** What the probe obtained; read synchronously by the replacement `Context` (research §3). */
export interface DeviceHandoffPayload {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  /** Adapter limits; defaults to `device.limits` when omitted. */
  readonly limits?: Readonly<Record<string, number>>;
  /** Adapter/device feature names; defaults to `adapter.features` when omitted. */
  readonly features?: Iterable<string>;
  /** Free-form provenance label of the probe (`auto`, `preference=webgpu`, …). */
  readonly source?: string;
  /** `performance.now()` snapshot of the probe, for status reporting. */
  readonly requestedAt?: number;
}

/** The normalised payload stored in the slot. */
export interface DeviceHandoff {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly limits: Readonly<Record<string, number>>;
  readonly features: readonly string[];
  readonly requestedAt: number;
  readonly source: string;
  /** Monotonic hand-off cycle number: 0 for the first probe, 1 after the first whole switch, … */
  readonly cycle: number;
}

/** One audit entry; kept as data so a run can serialise it as evidence. */
export interface HandoffAuditEntry {
  readonly op: "install" | "install-rejected" | "take" | "take-empty" | "peek" | "clear" | "reset-cycle" | "reset-rejected";
  readonly cycle: number;
  readonly source: string | null;
  readonly category?: string;
  readonly stack?: string | null;
}

interface HandoffSlot {
  payload: DeviceHandoff | null;
  cycle: number;
  installCount: number;
  audit: HandoffAuditEntry[];
}

function realm(): typeof globalThis {
  return globalThis;
}

function slot(): HandoffSlot {
  const target = realm() as unknown as Record<string, HandoffSlot | undefined>;
  let state = target[DEVICE_HANDOFF_KEY];
  if (state === undefined) {
    state = { payload: null, cycle: 0, installCount: 0, audit: [] };
    target[DEVICE_HANDOFF_KEY] = state;
  }
  return state;
}

function handoffError(category: HandoffCategory, message: string): DiagnosticError {
  return new DiagnosticError(category, message, {
    backend: "webgpu",
    upstreamModule: "Renderer/Context.js",
    requirementRef: "FR-005",
    entryPoint: "webgpu/device-handoff.ts",
    extra: { category },
  });
}

function toFeatureList(features: Iterable<string> | undefined): readonly string[] {
  if (features === undefined || features === null) return [];
  return [...features];
}

/**
 * Install the pre-fetched device — **exactly once per hand-off cycle**, before any upstream object
 * is constructed.
 *
 * @throws `DiagnosticError` (`device-handoff/already-installed`) on a second install without an
 *   intervening `resetCycle()`, and (`device-handoff/invalid-payload`) when `{ adapter, device }`
 *   is incomplete.
 */
export function install(payload: DeviceHandoffPayload): DeviceHandoff {
  const state = slot();
  const source = payload?.source ?? "probe";
  if (state.payload !== null || state.installCount > 0) {
    const error = handoffError(
      HANDOFF_CATEGORY.alreadyInstalled,
      "device handoff: install() was called twice in one hand-off cycle. The slot may be filled once, " +
        "before any upstream object exists — a second install would hand a different device to a scene " +
        "that is already bound to the first one. A whole-backend switch MUST call resetCycle() first " +
        "(research §3, tasks.md T042/T051).",
    );
    state.audit.push({ op: "install-rejected", cycle: state.cycle, source, category: error.category });
    throw error;
  }
  if (payload === null || typeof payload !== "object" || payload.device === undefined || payload.device === null) {
    const error = handoffError(
      HANDOFF_CATEGORY.invalidPayload,
      "device handoff: install() requires a payload carrying at least { adapter, device } (research §3 step 2).",
    );
    state.audit.push({ op: "install-rejected", cycle: state.cycle, source, category: error.category });
    throw error;
  }
  const device = payload.device;
  const limits = payload.limits ?? (device.limits as unknown as Readonly<Record<string, number>>);
  const features = toFeatureList(payload.features ?? payload.adapter?.features);
  state.payload = {
    adapter: payload.adapter,
    device,
    limits,
    features,
    requestedAt: payload.requestedAt ?? Date.now(),
    source,
    cycle: state.cycle,
  };
  state.installCount += 1;
  state.audit.push({ op: "install", cycle: state.cycle, source });
  return state.payload;
}

/**
 * Consume the slot. Returns the payload (and empties the slot) or `undefined` when nothing was
 * installed. The call stack is recorded so a run can prove the consumption happened inside the
 * replacement `Context` constructor (the central claim of H-2 / G-2).
 */
export function take(): DeviceHandoff | undefined {
  const state = slot();
  const payload = state.payload;
  state.payload = null;
  if (payload === null) {
    state.audit.push({ op: "take-empty", cycle: state.cycle, source: null });
    return undefined;
  }
  state.audit.push({
    op: "take",
    cycle: state.cycle,
    source: payload.source,
    stack: typeof Error === "function" ? (new Error().stack ?? null) : null,
  });
  return payload;
}

/** Inspect the slot without consuming it (status reporting; never used to make a path decision). */
export function peek(): DeviceHandoff | undefined {
  const state = slot();
  state.audit.push({ op: "peek", cycle: state.cycle, source: null });
  return state.payload ?? undefined;
}

/** Drop the payload (teardown, device loss). */
export function clear(): void {
  const state = slot();
  state.payload = null;
  state.audit.push({ op: "clear", cycle: state.cycle, source: null });
}

/**
 * Begin a new hand-off cycle: the whole-backend switch after `device.lost` (T051) re-probes and
 * installs the replacement device. Refuses while a payload is still pending.
 */
export function resetCycle(reason: string): void {
  const state = slot();
  if (state.payload !== null) {
    const error = handoffError(
      HANDOFF_CATEGORY.cycleNotResettable,
      "device handoff: resetCycle() was called while a device is still parked in the slot. The pending " +
        "device MUST be taken or cleared first — restarting the cycle would drop a device that a backend " +
        "may already be about to consume.",
    );
    state.audit.push({ op: "reset-rejected", cycle: state.cycle, source: reason, category: error.category });
    throw error;
  }
  state.cycle += 1;
  state.installCount = 0;
  state.audit.push({ op: "reset-cycle", cycle: state.cycle, source: reason });
}

/** Full audit log of the slot (verification evidence). */
export function audit(): { readonly cycle: number; readonly pending: boolean; readonly entries: readonly HandoffAuditEntry[] } {
  const state = slot();
  return { cycle: state.cycle, pending: state.payload !== null, entries: state.audit.map((entry) => ({ ...entry })) };
}

/** Wipe the slot completely. Test/teardown helper; the product only ever uses `clear`/`resetCycle`. */
export function resetSlot(): void {
  (realm() as unknown as Record<string, unknown>)[DEVICE_HANDOFF_KEY] = {
    payload: null,
    cycle: 0,
    installCount: 0,
    audit: [],
  } satisfies HandoffSlot;
}
