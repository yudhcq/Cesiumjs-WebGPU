/**
 * T046 — derived pass state machine (`层=单元`, tasks.md T046; research §1.5/§5.2, data-model §4.1, gate G-3).
 *
 * Two halves:
 *   1. the structural rules: identity change or `endFrame` closes a pass; program / `PassState` /
 *      vertex array / uniforms / `RenderState` changes do **not**; a pass opens on the first work
 *      operation, never on a state change; `sampleCount: 4` always comes with `resolveTarget`.
 *   2. **record–replay on G-3's real trace**: the 83 recorded platform calls of one upstream frame are
 *      replayed through the state machine and compared against the 9 passes G-3 measured
 *      (`experiments/gates/out/g3.json → measurements.passKeys`): pass count, per-pass clear/draw
 *      counts, sample counts and viewports must all agree.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { exists, readJson, repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";

const BACKEND = "packages/cesium-webgpu/backend-webgpu";
const TRACE_PATH = "experiments/gates/out/g3-trace.json";
const G3_PATH = "experiments/gates/out/g3.json";

async function loadMachine() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/pass-encoder.ts`));
}

/** A recording encoder factory: the machine only needs `beginRenderPass` + `end`. */
function recorder() {
  const opened = [];
  return {
    opened,
    openEncoder(descriptor) {
      const calls = [];
      const pass = {
        __descriptor: descriptor,
        __calls: calls,
        setPipeline: (pipeline) => calls.push(["setPipeline", pipeline]),
        draw: (...args) => calls.push(["draw", ...args]),
        drawIndexed: (...args) => calls.push(["drawIndexed", ...args]),
        end: () => calls.push(["end"]),
      };
      opened.push(pass);
      return pass;
    },
  };
}

/** Attachments synthesised from a key (the real views belong to the framebuffer implementations). */
function targetsFor(key) {
  return {
    colorAttachments: key.colorTargets.map((id) => {
      const attachment = { view: { __target: id }, loadOp: "load", storeOp: "store" };
      if (key.sampleCount > 1) attachment.resolveTarget = { __resolveOf: id };
      return attachment;
    }),
    ...(key.depthStencilTarget === null ? {} : { depthStencilAttachment: { view: { __target: key.depthStencilTarget }, depthLoadOp: "load", depthStoreOp: "store" } }),
  };
}

function keyOf(targetId, viewport, overrides = {}) {
  return {
    colorTargets: [targetId],
    depthStencilTarget: overrides.depthStencilTarget ?? null,
    sampleCount: overrides.sampleCount ?? 1,
    viewport,
    scissorRect: overrides.scissorRect ?? null,
  };
}

const VIEWPORT = [0, 0, 300, 150];

test("a pass opens on the first work operation; state changes never split it", async () => {
  const { PassStateMachine } = await loadMachine();
  const sink = recorder();
  const machine = new PassStateMachine({ targets: targetsFor, openEncoder: sink.openEncoder });

  machine.beginFrame();
  assert.equal(machine.isPassOpen(), false, "no pass may be open before the first work operation");
  for (const change of ["pass", "passState", "program", "vertexArray", "uniforms", "renderState"]) {
    assert.equal(machine.noteStateChange(change), -1, `a ${change} change before any work MUST NOT open a pass`);
  }

  machine.beginWork(keyOf("swapchain", VIEWPORT), { kind: "clear", seq: 1 });
  assert.equal(machine.isPassOpen(), true);
  for (const change of ["pass", "passState", "program", "vertexArray", "uniforms", "renderState"]) {
    assert.equal(machine.noteStateChange(change), 0, `a ${change} change inside one pass MUST stay in that pass`);
  }
  machine.beginWork(keyOf("swapchain", VIEWPORT), { kind: "draw", seq: 2, drawKind: "drawIndexed" });
  machine.endFrame();

  const sequence = machine.sequence();
  assert.equal(sequence.passes.length, 1, "six boundary-shaped state changes MUST NOT create passes");
  assert.deepEqual(sequence.passes[0].workOps.map((op) => op.kind), ["clear", "draw"]);
  assert.equal(sequence.passes[0].openedWithLoadOpClear, true, "a clear that opens its pass uses loadOp");
  assert.equal(sequence.passes[0].workOps[0].clearMechanism, "loadOp");
  assert.deepEqual(sequence.nonBoundaryChanges.map((entry) => entry.causedBoundary), new Array(12).fill(false));
  assert.equal(sequence.passOpenAtEnd, false, "endFrame MUST close the pass (check (c) of G-3)");
  assert.equal(sink.opened[0].__descriptor.colorAttachments[0].loadOp, "clear");
});

test("an identity change closes the pass; a redundant re-bind does not", async () => {
  const { PassStateMachine } = await loadMachine();
  const sink = recorder();
  const machine = new PassStateMachine({ targets: targetsFor, openEncoder: sink.openEncoder });
  machine.beginFrame();
  machine.beginWork(keyOf("fb-1", VIEWPORT), { kind: "draw", seq: 1 });
  machine.beginWork(keyOf("fb-1", VIEWPORT), { kind: "draw", seq: 2 });
  machine.noteStateChange("redundant-target-rebind");
  machine.beginWork(keyOf("fb-2", VIEWPORT), { kind: "draw", seq: 3 });
  machine.endFrame();

  const { passes } = machine.sequence();
  assert.equal(passes.length, 2, "only the identity change splits the frame");
  assert.equal(passes[0].drawOps, 2, "the redundant re-bind stays inside pass 0");
  assert.equal(passes[0].closedBy, "identity-change");
  assert.equal(passes[1].closedBy, "endFrame");
});

test("a second clear inside a pass uses the fallback, never loadOp", async () => {
  const { PassStateMachine } = await loadMachine();
  const sink = recorder();
  const machine = new PassStateMachine({ targets: targetsFor, openEncoder: sink.openEncoder });
  machine.beginFrame();
  const first = machine.beginWork(keyOf("fb-1", VIEWPORT), { kind: "clear", seq: 1 });
  const second = machine.beginWork(keyOf("fb-1", VIEWPORT), { kind: "clear", seq: 2 });
  machine.beginWork(keyOf("fb-1", VIEWPORT), { kind: "draw", seq: 3 });
  machine.endFrame();

  assert.equal(first.clearMechanism, "loadOp");
  assert.notEqual(second.clearMechanism, "loadOp", "the second clear MUST NOT silently reuse loadOp (research §5.1)");
  const pass = machine.sequence().passes[0];
  assert.equal(pass.clearOps, 2);
  assert.equal(pass.workOps.map((op) => op.clearMechanism)[1], second.clearMechanism);
  // Whatever mechanism the runtime supports, the derived pass count is unchanged.
  assert.equal(machine.sequence().passes.length, 1);
  if (second.clearMechanism === "reopenWithLoadOpClear") {
    assert.equal(pass.gpuPassCount, 2, "the spec-native fallback reopens the GPU pass but keeps the derived pass");
  }
});

test("4x MSAA always pairs sampleCount with a resolveTarget (data-model §4.1)", async () => {
  const { PassStateMachine } = await loadMachine();
  const sink = recorder();
  const machine = new PassStateMachine({ targets: targetsFor, openEncoder: sink.openEncoder });
  machine.beginFrame();
  machine.beginWork(keyOf("msaa", VIEWPORT, { sampleCount: 4, depthStencilTarget: "depth" }), { kind: "clear", seq: 1 });
  machine.beginWork(keyOf("msaa", VIEWPORT, { sampleCount: 4, depthStencilTarget: "depth" }), { kind: "draw", seq: 2 });
  machine.endFrame();

  const descriptor = sink.opened[0].__descriptor;
  assert.equal(descriptor.colorAttachments[0].loadOp, "clear");
  assert.equal(sink.opened[0].__calls.at(-1)[0], "end");
  const pass = machine.sequence().passes[0];
  assert.equal(pass.sampleCount, 4);
  for (const attachment of descriptor.colorAttachments) {
    if (pass.sampleCount > 1) assert.ok(attachment.resolveTarget !== undefined, "sampleCount>1 REQUIRES a resolveTarget");
  }
  assert.equal(machine.sequence().passes.length, 1);
});

test("a work operation outside a frame is rejected, not silently dropped", async () => {
  const { PassStateMachine } = await loadMachine();
  const sink = recorder();
  const machine = new PassStateMachine({ targets: targetsFor, openEncoder: sink.openEncoder });
  assert.throws(() => machine.beginWork(keyOf("swapchain", VIEWPORT), { kind: "draw", seq: 1 }), (error) => {
    assert.equal(error.name, "DiagnosticError");
    assert.match(error.message, /outside a frame/);
    return true;
  });
});

test("record–replay on G-3's recorded frame reproduces the 9 measured passes", async (t) => {
  assert.ok(exists(TRACE_PATH), `${TRACE_PATH} MUST be present: it is the recorded input of this replay (gate G-3 / T020)`);
  assert.ok(exists(G3_PATH), `${G3_PATH} MUST be present: it carries the measured partition this replay compares against`);
  const trace = readJson(TRACE_PATH);
  const gate = readJson(G3_PATH);
  const expected = gate.measurements.passKeys;
  assert.equal(expected.length, 9, "the G-3 conclusion records 9 derived passes for this frame");

  const { PassStateMachine } = await loadMachine();
  const sink = recorder();
  const machine = new PassStateMachine({ targets: targetsFor, openEncoder: sink.openEncoder });

  const WORK = new Set(["clear", "clearBufferfv", "clearBufferiv", "clearBufferfi", "drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]);
  // G-3's derived identity is expressed over the *attachment* identities it observed on the platform
  // (`colorTargets=[canvas]`, `renderbuffer(rb-1)`, …). The replay therefore keys on the same fields so
  // the two partitions are directly comparable; in production the `Context` keys on its registered
  // target ids, which is the same granularity (G-3 measured 7 distinct targets).
  const toKey = (identity) => ({
    colorTargets: [...identity.colorTargets],
    depthStencilTarget: identity.depthStencilTarget ?? null,
    sampleCount: identity.sampleCount ?? 1,
    viewport: [identity.viewport?.x ?? 0, identity.viewport?.y ?? 0, identity.viewport?.width ?? 0, identity.viewport?.height ?? 0],
    scissorRect: identity.scissorRect === null || identity.scissorRect === undefined ? null : [identity.scissorRect.x ?? 0, identity.scissorRect.y ?? 0, identity.scissorRect.width ?? 0, identity.scissorRect.height ?? 0],
  });

  machine.beginFrame();
  let workOps = 0;
  for (const op of trace.ops) {
    if (!WORK.has(op.op) || op.identity === undefined || op.identity === null) continue;
    workOps += 1;
    if (op.op.startsWith("clear")) machine.beginWork(toKey(op.identity), { kind: "clear", seq: op.seq });
    else {
      const indexed = op.op.startsWith("drawElements");
      machine.beginWork(toKey(op.identity), { kind: "draw", seq: op.seq, drawKind: indexed ? "drawIndexed" : "draw" });
    }
  }
  machine.endFrame();

  const { passes } = machine.sequence();
  assert.equal(workOps, gate.measurements.partition.drawCount + gate.measurements.partition.clearCount, "every recorded work operation MUST be replayed");
  assert.equal(passes.length, expected.length, `pass count MUST match G-3: got ${passes.length}, expected ${expected.length}`);
  assert.equal(passes.length, gate.measurements.partition.passCount);

  for (const measured of expected) {
    const replayed = passes[measured.index];
    assert.ok(replayed !== undefined, `pass #${measured.index} MUST exist`);
    assert.equal(replayed.clearOps, measured.cleared, `pass #${measured.index} clear count`);
    assert.equal(replayed.drawOps, measured.drew, `pass #${measured.index} draw count`);
    assert.equal(replayed.sampleCount, 1, `pass #${measured.index} sample count (G-3 F-3: all attachments are single-sampled)`);
    assert.deepEqual(replayed.key.viewport, [0, 0, 300, 150], `pass #${measured.index} viewport`);
    assert.ok(measured.key.includes(`colorTargets=[${replayed.key.colorTargets.join("|")}]`), `pass #${measured.index} colour targets MUST be part of the measured key`);
    assert.ok(measured.key.includes(`depthStencilTarget=${replayed.key.depthStencilTarget}`), `pass #${measured.index} depth target`);
  }
  const fallbackClears = passes.reduce((total, pass) => total + pass.workOps.filter((op) => op.clearMechanism !== undefined && op.clearMechanism !== "loadOp").length, 0);
  const loadOpClears = passes.reduce((total, pass) => total + pass.workOps.filter((op) => op.clearMechanism === "loadOp").length, 0);
  assert.equal(loadOpClears, expected.filter((entry) => entry.cleared > 0).length, "one loadOp clear per pass that starts with a clear");
  assert.equal(fallbackClears, gate.measurements.partition.clearCount - loadOpClears, "every later clear uses the fallback (research §5.1)");
  assert.equal(sink.opened.length, passes.length + fallbackClears, "a fallback clear reopens the GPU pass; the DERIVED pass count is unchanged");
  assert.equal(passes.at(-1).closedBy, "endFrame", "the frame ends by closing the last pass (G-3 check (c))");
  t.diagnostic(
    `replayed ${workOps} work operations into ${passes.length} derived passes (${sink.opened.length} GPU passes: ` +
      `${loadOpClears} loadOp clears + ${fallbackClears} fallback clears), matching G-3's partition exactly`,
  );
});
