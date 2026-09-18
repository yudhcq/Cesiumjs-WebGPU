/**
 * T042 — device hand-off slot (`层=单元`, tasks.md T042; contract render-path-api.md §2, research §3, G-2).
 *
 * The slot is the one place where "which backend runs" is decided, so its contract is asserted
 * exactly as G-2 measured it:
 *   - an empty slot returns `undefined` (the documented "no WebGPU device" state — in the product that
 *     is the construction-time whole delegation of plan.md D2-a, never a per-command fallback);
 *   - a second `install()` in the same cycle throws `device-handoff/already-installed`;
 *   - `take()` clears; `peek()` does not; `clear()` drops;
 *   - a whole switch re-opens the cycle through `resetCycle()`, which refuses while a device is parked.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assertDiagnostic, createFakeAdapter } from "../support/fake-gpu.mjs";

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function loadHandoff() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/device-handoff.ts`));
}

function payload(overrides = {}) {
  const adapter = createFakeAdapter();
  return { adapter, device: adapter.device, limits: adapter.limits, features: adapter.features, source: "unit-test", ...overrides };
}

test("an empty slot yields undefined and never a fabricated device", async () => {
  const handoff = await loadHandoff();
  handoff.resetSlot();
  assert.equal(handoff.take(), undefined, "take() on an empty slot MUST return undefined (plan.md D2-a delegation input)");
  assert.equal(handoff.peek(), undefined, "peek() on an empty slot MUST return undefined");
  const log = handoff.audit();
  assert.deepEqual(
    log.entries.map((entry) => entry.op),
    ["take-empty", "peek"],
    "every operation MUST be auditable, including the empty takes",
  );
  assert.equal(log.pending, false);
});

test("install once, take once: the slot empties and a second take is empty", async () => {
  const handoff = await loadHandoff();
  handoff.resetSlot();
  const installed = handoff.install(payload());
  assert.equal(installed.cycle, 0, "the first probe is cycle 0");
  assert.equal(handoff.audit().pending, true);

  const taken = handoff.take();
  assert.ok(taken !== undefined, "take() MUST return the installed payload");
  assert.equal(taken.device, installed.device, "take() MUST return the very device that was installed");
  assert.equal(taken.source, "unit-test");
  assert.equal(handoff.take(), undefined, "a device is consumed exactly once");
  const took = handoff.audit().entries.filter((entry) => entry.op === "take");
  assert.equal(took.length, 1, "exactly one take recorded");
  assert.match(String(took[0].stack ?? ""), /device-handoff/, "the take stack MUST be recorded (G-2's H-2 evidence)");
});

test("a second install in the same cycle fails loudly instead of swapping the device", async () => {
  const handoff = await loadHandoff();
  handoff.resetSlot();
  handoff.install(payload());
  assert.throws(
    () => handoff.install(payload()),
    (error) => assertDiagnostic(error, handoff.HANDOFF_CATEGORY.alreadyInstalled, "install() twice"),
  );

  // …and it keeps failing after the device was consumed, until the cycle is reset on purpose.
  handoff.take();
  assert.throws(
    () => handoff.install(payload()),
    (error) => assertDiagnostic(error, handoff.HANDOFF_CATEGORY.alreadyInstalled, "install() after a consumed install"),
  );
});

test("an incomplete payload is rejected with its own diagnosable category", async () => {
  const handoff = await loadHandoff();
  handoff.resetSlot();
  assert.throws(
    () => handoff.install({ adapter: createFakeAdapter() }),
    (error) => assertDiagnostic(error, handoff.HANDOFF_CATEGORY.invalidPayload, "install() without a device"),
  );
  assert.equal(handoff.audit().pending, false, "a rejected install MUST NOT leave anything in the slot");
});

test("peek never consumes, clear drops the payload", async () => {
  const handoff = await loadHandoff();
  handoff.resetSlot();
  const installed = handoff.install(payload());
  const peeked = handoff.peek();
  assert.equal(peeked.device, installed.device);
  assert.equal(handoff.peek().device, installed.device, "peek is idempotent");
  assert.equal(handoff.audit().pending, true, "peek MUST NOT clear the slot");
  handoff.clear();
  assert.equal(handoff.audit().pending, false);
  assert.equal(handoff.take(), undefined);
});

test("a whole switch re-opens the cycle, and only when the slot is empty", async () => {
  const handoff = await loadHandoff();
  handoff.resetSlot();
  handoff.install(payload({ source: "first-probe" }));
  assert.throws(
    () => handoff.resetCycle("device-lost"),
    (error) => assertDiagnostic(error, handoff.HANDOFF_CATEGORY.cycleNotResettable, "resetCycle with a pending device"),
  );

  handoff.take();
  handoff.resetCycle("device-lost");
  assert.equal(handoff.audit().cycle, 1, "the second cycle is cycle 1");
  const second = handoff.install(payload({ source: "re-probe-after-loss" }));
  assert.equal(second.cycle, 1, "the re-probed device belongs to the new cycle");
  assert.equal(handoff.take().source, "re-probe-after-loss");
});

test("the slot lives on the realm's global object so separately built bundles agree", async () => {
  const handoff = await loadHandoff();
  handoff.resetSlot();
  assert.equal(typeof handoff.DEVICE_HANDOFF_KEY, "string");
  handoff.install(payload());
  assert.ok(globalThis[handoff.DEVICE_HANDOFF_KEY] !== undefined, "the slot MUST be visible on globalThis (probe bundle vs backend bundle)");
  assert.equal(globalThis[handoff.DEVICE_HANDOFF_KEY].payload.device, handoff.peek().device);
  handoff.clear();
});

test("features default to the adapter's set and limits default to device.limits", async () => {
  const handoff = await loadHandoff();
  handoff.resetSlot();
  const adapter = createFakeAdapter();
  const installed = handoff.install({ adapter, device: adapter.device, source: "auto" });
  assert.deepEqual([...installed.features].sort(), [...adapter.features].sort());
  assert.equal(installed.limits.maxTextureDimension2D, adapter.limits.maxTextureDimension2D);
  assert.ok(installed.requestedAt > 0);
  handoff.clear();
});
