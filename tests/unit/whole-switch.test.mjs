/**
 * T051 — device-loss whole switch (`层=单元`, tasks.md T051; FR-003/FR-006, data-model §2.4/§10④).
 *
 * The switch is a **teardown**, so the failure modes matter more than the happy path: 0 destroyed
 * resources, a rebuild that throws, or any draw reaching a backend while the switch runs MUST all be
 * rejected. `WholeSwitchRecord` is the observable contract (`destroyedResources > 0`,
 * `residualDraws === 0`).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { createFakeDevice, installWebgpuGlobals } from "../support/fake-gpu.mjs";

installWebgpuGlobals();

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function loadWholeSwitch() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/whole-switch.ts`));
}

/** A step recorder with sane defaults for one successful switch. */
function steps(overrides = {}) {
  const calls = [];
  let residual = 0;
  const base = {
    calls,
    stopSubmitting: () => calls.push("stop"),
    destroy: () => {
      calls.push("destroy");
      return { destroyedResources: 7 };
    },
    rebuild: async () => {
      calls.push("rebuild");
      return "webgpu";
    },
    residualDraws: () => residual,
    now: (() => {
      let tick = 1000;
      return () => (tick += 5);
    })(),
    __setResidual: (value) => {
      residual = value;
    },
  };
  return { ...base, ...overrides, calls };
}

test("a successful switch tears down, rebuilds and records the evidence", async () => {
  const { performWholeSwitch } = await loadWholeSwitch();
  const sink = steps();
  const record = await performWholeSwitch("device-lost", sink, "webgpu");

  assert.deepEqual(sink.calls, ["stop", "destroy", "rebuild"], "the order is: stop submitting → destroy → rebuild (contract §3)");
  assert.equal(record.trigger, "device-lost");
  assert.equal(record.from, "webgpu");
  assert.equal(record.to, "webgpu");
  assert.ok(record.destroyedResources > 0, "destroyedResources MUST be > 0 (data-model §2.4)");
  assert.equal(record.residualDraws, 0, "residualDraws MUST be 0 — no draw may reach either backend during the switch");
  assert.ok(record.rebuildMs >= 0);
  assert.ok(record.finishedAt >= record.startedAt);
  assert.ok(record.notes.length > 0, "the record MUST state that no stale frame is kept (no overlay)");
});

test("a rebuild that ends on WebGL2 is recorded as a declared degradation", async () => {
  const { performWholeSwitch } = await loadWholeSwitch();
  const record = await performWholeSwitch("device-lost", steps({ rebuild: async () => "webgl2" }), "webgpu");
  assert.equal(record.to, "webgl2");
  assert.ok(
    record.notes.some((note) => /degradation/.test(note)),
    "an unsuccessful WebGPU rebuild is a degradation and MUST be visible (FR-023)",
  );
});

test("a teardown that released nothing is rejected", async () => {
  const { performWholeSwitch } = await loadWholeSwitch();
  await assert.rejects(performWholeSwitch("device-lost", steps({ destroy: () => ({ destroyedResources: 0 }) })), (error) => {
    assert.equal(error.name, "DiagnosticError");
    assert.match(error.message, /released 0 GPU resources/);
    return true;
  });
});

test("a failed rebuild is reported, never left half-built", async () => {
  const { performWholeSwitch } = await loadWholeSwitch();
  await assert.rejects(
    performWholeSwitch(
      "device-lost",
      steps({
        rebuild: async () => {
          throw new Error("no adapter after the reset");
        },
      }),
    ),
    /no adapter after the reset/,
  );
});

test("a draw that slipped through during the switch is detected", async () => {
  const { performWholeSwitch } = await loadWholeSwitch();
  const sink = steps();
  sink.__setResidual(1);
  await assert.rejects(performWholeSwitch("device-lost", sink), (error) => {
    assert.equal(error.name, "DiagnosticError");
    assert.match(error.message, /1 draw\(s\) were submitted after the switch started/);
    return true;
  });
});

test("the record is handed to the status sink", async () => {
  const { performWholeSwitch } = await loadWholeSwitch();
  const seen = [];
  const record = await performWholeSwitch("device-lost", steps({ onRecord: (value) => seen.push(value) }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0], record);
});

test("watchDeviceLoss runs the handler once and reports the trigger", async () => {
  const { watchDeviceLoss } = await loadWholeSwitch();
  const device = createFakeDevice();
  const seen = [];
  const unsubscribe = watchDeviceLoss(device, (info, trigger) => {
    seen.push({ reason: info.reason, trigger });
  });
  device.__lose("destroyed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, [{ reason: "destroyed", trigger: "manual" }], "an explicit destroy() is a manual switch, not a hardware loss");
  unsubscribe();
});

test("a device with no lost promise is rejected (loss must be observable)", async () => {
  const { watchDeviceLoss } = await loadWholeSwitch();
  assert.throws(() => watchDeviceLoss({}, () => {}), /exposes no `lost` promise/);
});
