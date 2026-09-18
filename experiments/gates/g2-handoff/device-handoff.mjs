/**
 * G-2 gate — device handoff slot (prototype of Phase 4 / T042).
 *
 * Tasks.md T016 asks for: "预取 `adapter/device` → 写入后端层交接槽 → **同步**构造上游 `Scene`
 * （桩 Context 从槽中取设备）". This module is the **slot**: the gate-local prototype of the
 * production `packages/cesium-webgpu/backend-webgpu/webgpu/device-handoff.ts` that T042 owns.
 *
 * Semantics (identical to the T042 contract, asserted by `tests/unit/capability-mapping.test.mjs`
 * consumers and by the gate runner):
 *   - `install({adapter, device, limits, features})` — allowed **once per process**, BEFORE any
 *     upstream object is constructed. A second `install()` throws (no silent overwrite: a stale
 *     device must never be installed behind the backend's back).
 *   - `take()` — returns the payload and **clears** the slot (a device is consumed exactly once).
 *     Returns `undefined` when nothing was installed: that is the "no WebGPU device" state which,
 *     in the product, means "construct the upstream WebGL2 path" (research §3 step 4). The gate
 *     stub turns it into a diagnosable failure instead (see `Renderer/Context.js`).
 *   - `peek()` — returns the payload without consuming it (probe/diagnostic only).
 *   - `clear()` — drops the payload (device-loss handling, T042 §destroy).
 *
 * Every call is appended to an audit log so the gate can prove *who* consumed the device and
 * *when* — in particular that the `take()` happened synchronously inside the `Context`
 * constructor (the central claim of H-2).
 *
 * Node + browser, zero dependencies, cross-platform.
 */

/** The slot lives on the realm's global object so both bundle and page observe the same one. */
export const HANDOFF_KEY = "__G2_DEVICE_HANDOFF__";

/** Stable diagnostic categories (mirrors `DiagnosticError.category` conventions). */
export const HANDOFF_CATEGORY = {
  alreadyInstalled: "device-handoff/already-installed",
  invalidPayload: "device-handoff/invalid-payload",
  missing: "device-handoff/missing",
};

function scopeOf(scope) {
  return scope ?? globalThis;
}

function slot(scope) {
  const target = scopeOf(scope);
  if (target[HANDOFF_KEY] === undefined) {
    target[HANDOFF_KEY] = { payload: null, installedAtTick: null, audit: [] };
  }
  return target[HANDOFF_KEY];
}

function diagnosableError(category, message) {
  const error = new Error(message);
  error.name = "DeviceHandoffError";
  error.category = category;
  error.backend = "device-handoff";
  return error;
}

/**
 * Install the pre-fetched device. MUST be called before the upstream `Scene` is constructed and
 * at most once per process.
 *
 * @param {{adapter: object, device: object, limits?: object, features?: Iterable<string>, source?: string}} payload
 * @param {{scope?: object, tick?: number}} [options]
 */
export function installHandoff(payload, options = {}) {
  const state = slot(options.scope);
  const tick = options.tick ?? null;
  if (state.payload !== null || state.audit.some((entry) => entry.op === "install")) {
    const error = diagnosableError(
      HANDOFF_CATEGORY.alreadyInstalled,
      "device handoff: install() was called twice in this process. The slot may be filled once, " +
        "before any upstream object exists — a second install would hand a different device to a " +
        "scene that is already bound to the first one.",
    );
    state.audit.push({ op: "install-rejected", tick, category: error.category });
    throw error;
  }
  if (payload === null || typeof payload !== "object" || payload.device === undefined || payload.device === null) {
    const error = diagnosableError(
      HANDOFF_CATEGORY.invalidPayload,
      "device handoff: install() requires a payload carrying at least { adapter, device }.",
    );
    state.audit.push({ op: "install-rejected", tick, category: error.category });
    throw error;
  }
  state.payload = {
    adapter: payload.adapter ?? null,
    device: payload.device,
    limits: payload.limits ?? payload.device?.limits ?? null,
    features: payload.features ?? null,
    source: payload.source ?? "gate",
  };
  state.installedAtTick = tick;
  state.audit.push({ op: "install", tick, source: state.payload.source });
  return state.payload;
}

/**
 * Consume the slot. Returns the payload (and empties the slot) or `undefined` when nothing was
 * installed. `stack` is recorded as evidence that the consumption happened inside the constructor.
 */
export function takeHandoff(options = {}) {
  const state = slot(options.scope);
  const tick = options.tick ?? null;
  const stack = options.stack ?? (typeof Error === "function" ? new Error().stack ?? null : null);
  const payload = state.payload;
  state.payload = null;
  state.audit.push({ op: payload === null ? "take-empty" : "take", tick, source: options.source ?? null, stack });
  return payload ?? undefined;
}

/** Inspect the slot without consuming it. */
export function peekHandoff(options = {}) {
  const state = slot(options.scope);
  state.audit.push({ op: "peek", tick: options.tick ?? null, source: options.source ?? null });
  return state.payload ?? undefined;
}

/** Drop the payload (device loss / teardown). */
export function clearHandoff(options = {}) {
  const state = slot(options.scope);
  state.payload = null;
  state.audit.push({ op: "clear", tick: options.tick ?? null, source: options.source ?? null });
}

/** Full audit log of the slot (gate evidence). */
export function handoffAudit(options = {}) {
  const state = slot(options.scope);
  return {
    installedAtTick: state.installedAtTick,
    pending: state.payload !== null,
    audit: state.audit.map((entry) => ({ ...entry })),
  };
}

/** Gate-only helper: wipe the slot (and its log) between runs in the same realm. */
export function resetHandoff(options = {}) {
  const target = scopeOf(options.scope);
  target[HANDOFF_KEY] = { payload: null, installedAtTick: null, audit: [] };
}
