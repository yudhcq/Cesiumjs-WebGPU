/**
 * T021 — G-3 partition judgement unit test (`层=单元`, tasks.md T020/T021).
 *
 * The judge is exercised on **synthetic traces** whose expected verdict is known, so the gate's
 * conclusions cannot be an artefact of the one frame that happened to be recorded (a gate that cannot
 * fail proves nothing):
 *
 *   - a well-formed multi-pass trace (target switches at boundaries, a multisample resolve, the last
 *     pass on the presentation target) MUST pass all five checks;
 *   - a **switch in the middle of a pass** (out to another target and straight back) MUST be reported as
 *     an uncovered switch — the WebGPU backend would have to split a pass there;
 *   - a frame whose **last pass is not the presentation target** MUST fail the "no unclosed pass"
 *     check;
 *   - a **clear that is not the first work operation of its pass** MUST be reported (this is the
 *     evidence `research.md` §5.1 needs for the `loadOp:"clear"` vs `clearBuffer` decision);
 *   - a frame without a **multisample resolve blit** MUST fail the resolve-coverage check, and one with a
 *     `sampleCount 4 -> 1` resolve MUST pass it;
 *   - a frame recorded on the **real number of identity fields** is required: the identity key MUST
 *     expose exactly `(colorTargets, depthStencilTarget, sampleCount, viewport, scissorRect)`.
 *
 * When the recorded artefacts (`out/g3-trace.json`, `out/g3.json`) are present, the same assertions are
 * re-run on the real frame and cross-checked against the published verdict.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { identityKey, judgePartition, partitionTrace } from "./partition.mjs";
import { repoPath } from "../../../tests/support/repo.mjs";

// ------------------------------------------------------------------------------------------------
// synthetic trace helpers
// ------------------------------------------------------------------------------------------------

const DEFAULT_TARGET = { id: "default", kind: "default-framebuffer", color: ["canvas"], depthStencil: "canvas", sampleCount: 1 };
const VIEWPORT = { x: 0, y: 0, width: 300, height: 150 };

function target(id, { color = [`color(${id})`], depth = `depth(${id})`, sampleCount = 1, kind = "framebuffer" } = {}) {
  return { id, kind, color, depthStencil: depth, sampleCount };
}

function identity(targetDescription, { viewport = VIEWPORT, scissorRect = null } = {}) {
  return {
    colorTargets: targetDescription.color,
    depthStencilTarget: targetDescription.depthStencil,
    sampleCount: targetDescription.sampleCount,
    viewport: { ...viewport },
    scissorRect: scissorRect === null ? null : { ...scissorRect },
    targetId: targetDescription.id,
    targetKind: targetDescription.kind,
  };
}

/** Build a trace; every entry is `[op, targetDescription, extra]`. */
function trace(entries) {
  let seq = 0;
  return entries.map(([op, targetDescription, extra = {}]) => {
    seq += 1;
    const op0 = { seq, op, ...extra };
    if (targetDescription !== null && targetDescription !== undefined) op0.identity = identity(targetDescription, extra.identityOptions ?? {});
    return op0;
  });
}

const A = target("fb-A");
const B = target("fb-B");
const MSAA = target("fb-msaa", { sampleCount: 4 });

/** A well-formed frame: two passes on A, an MSAA resolve into B, ending on the presentation target. */
function wellFormedTrace() {
  return trace([
    ["bindFramebuffer", A, { targetId: "fb-A", previousTargetId: "default", changed: true }],
    ["viewport", A, { viewport: VIEWPORT }],
    ["clear", A, { mask: 16384 }],
    ["drawElements", A, { kind: "draw", mode: 4, count: 6 }],
    ["drawElements", A, { kind: "draw", mode: 4, count: 3 }],
    ["bindFramebuffer", MSAA, { targetId: "fb-msaa", previousTargetId: "fb-A", changed: true }],
    ["clear", MSAA, { mask: 16384 }],
    ["drawElements", MSAA, { kind: "draw", mode: 4, count: 12 }],
    ["bindFramebuffer", B, { targetId: "fb-B", previousTargetId: "fb-msaa", changed: true }],
    ["blitFramebuffer", B, { source: MSAA, destination: B, rect: { src: [0, 0, 300, 150], dst: [0, 0, 300, 150] }, mask: 16384, filter: 9729 }],
    ["drawElements", B, { kind: "draw", mode: 4, count: 6 }],
    ["bindFramebuffer", DEFAULT_TARGET, { targetId: "default", previousTargetId: "fb-B", changed: true }],
    ["drawElements", DEFAULT_TARGET, { kind: "draw", mode: 4, count: 6 }],
  ]);
}

function checkById(checks, id) {
  const entry = checks.find((candidate) => candidate.id === id);
  assert.ok(entry, `the judge MUST produce the check "${id}"`);
  return entry;
}

// ------------------------------------------------------------------------------------------------
// positive case
// ------------------------------------------------------------------------------------------------

test("a well-formed multi-pass frame passes every T021 check", () => {
  const ops = wellFormedTrace();
  const { checks, measurements } = judgePartition(ops, { frameEndSeq: ops[ops.length - 1].seq });
  for (const entry of checks) assert.equal(entry.ok, true, `${entry.id} should pass: ${entry.detail}`);
  assert.equal(measurements.passCount, 4, `A(clear+2 draws), MSAA(clear+draw), B(draw), default(draw); got ${JSON.stringify(measurements.passes.map((pass) => `${pass.targetId}:${pass.firstWorkOp}+${pass.drawOps}d`))}`);
  assert.equal(measurements.passesWithMultipleDraws, 1, "the first pass holds two draws → multi-draw pass");
  assert.equal(measurements.resolveBlitCrossingCount, 1, "one resolve blit crossing two targets");
  assert.equal(measurements.switches.filter((entry) => entry.effective).length, 5, "4 bindFramebuffer switches + 1 resolve blit");
  assert.equal(measurements.passes[measurements.passes.length - 1].targetId, "default");
});

// ------------------------------------------------------------------------------------------------
// negative controls — each one MUST be detected
// ------------------------------------------------------------------------------------------------

test("a target switch in the middle of a pass is reported as uncovered", () => {
  const ops = trace([
    ["bindFramebuffer", A, { targetId: "fb-A", previousTargetId: "default", changed: true }],
    ["clear", A, { mask: 16384 }],
    ["drawElements", A, { kind: "draw", mode: 4, count: 6 }],
    // out to another target and straight back: the work before and after shares one identity
    ["bindFramebuffer", B, { targetId: "fb-B", previousTargetId: "fb-A", changed: true }],
    ["bindFramebuffer", A, { targetId: "fb-A", previousTargetId: "fb-B", changed: true }],
    ["drawElements", A, { kind: "draw", mode: 4, count: 6 }],
    ["bindFramebuffer", DEFAULT_TARGET, { targetId: "default", previousTargetId: "fb-A", changed: true }],
    ["drawElements", DEFAULT_TARGET, { kind: "draw", mode: 4, count: 6 }],
  ]);
  const { checks, measurements } = judgePartition(ops, { frameEndSeq: ops[ops.length - 1].seq });
  const coverage = checkById(checks, "all-target-switches-covered");
  assert.equal(coverage.ok, false, `the mid-pass switch MUST be uncovered: ${coverage.detail}`);
  assert.ok(measurements.switches.some((entry) => entry.atPassBoundary === false), "at least one switch is not at a boundary");
});

test("a frame that does not end on the presentation target is reported as an unclosed pass", () => {
  const ops = trace([
    ["bindFramebuffer", A, { targetId: "fb-A", previousTargetId: "default", changed: true }],
    ["clear", A, { mask: 16384 }],
    ["drawElements", A, { kind: "draw", mode: 4, count: 6 }],
  ]);
  const { checks } = judgePartition(ops, { frameEndSeq: ops[ops.length - 1].seq });
  const unclosed = checkById(checks, "no-unclosed-pass-before-endframe");
  assert.equal(unclosed.ok, false, `the last pass draws off-screen, so endFrame would close a pass that never presented: ${unclosed.detail}`);
});

test("a clear that is not the first work operation of its pass is reported", () => {
  const ops = trace([
    ["bindFramebuffer", A, { targetId: "fb-A", previousTargetId: "default", changed: true }],
    ["drawElements", A, { kind: "draw", mode: 4, count: 6 }],
    ["clear", A, { mask: 16384 }],
    ["bindFramebuffer", DEFAULT_TARGET, { targetId: "default", previousTargetId: "fb-A", changed: true }],
    ["drawElements", DEFAULT_TARGET, { kind: "draw", mode: 4, count: 6 }],
  ]);
  const { checks } = judgePartition(ops, { frameEndSeq: ops[ops.length - 1].seq });
  const clears = checkById(checks, "clears-are-first-in-their-pass");
  assert.equal(clears.ok, false, `a clear after a draw needs the clearBuffer fallback: ${clears.detail}`);
});

test("a frame without a multisample resolve blit fails the resolve-coverage check", () => {
  const withoutResolve = trace([
    ["bindFramebuffer", A, { targetId: "fb-A", previousTargetId: "default", changed: true }],
    ["clear", A, { mask: 16384 }],
    ["drawElements", A, { kind: "draw", mode: 4, count: 6 }],
    ["bindFramebuffer", B, { targetId: "fb-B", previousTargetId: "fb-A", changed: true }],
    ["blitFramebuffer", B, { source: B, destination: B, rect: { src: [0, 0, 300, 150], dst: [0, 0, 300, 150] }, mask: 16384, filter: 9729 }],
    ["drawElements", B, { kind: "draw", mode: 4, count: 6 }],
    ["bindFramebuffer", DEFAULT_TARGET, { targetId: "default", previousTargetId: "fb-B", changed: true }],
    ["drawElements", DEFAULT_TARGET, { kind: "draw", mode: 4, count: 6 }],
  ]);
  const { checks } = judgePartition(withoutResolve, { frameEndSeq: withoutResolve[withoutResolve.length - 1].seq });
  const resolve = checkById(checks, "multisample-resolve-switch-covered");
  assert.equal(resolve.ok, false, `a self-blit resolves nothing: ${resolve.detail}`);
  assert.match(resolve.detail, /does not exercise resolveFramebuffers/);
});

test("the sampleCount dimension of the identity is part of the partition", () => {
  const ops = wellFormedTrace();
  const { measurements } = judgePartition(ops, { frameEndSeq: ops[ops.length - 1].seq });
  const msaaPass = measurements.passes.find((pass) => pass.targetId === "fb-msaa");
  assert.ok(msaaPass, "the 4x MSAA pass MUST be its own pass");
  assert.equal(msaaPass.sampleCount, 4);
  const resolve = measurements.switches.find((entry) => entry.op === "blitFramebuffer");
  assert.equal(resolve.sampleTransition, "4 -> 1", "the resolve transition MUST be recorded");
  assert.equal(resolve.atPassBoundary, true);
  // and the resolve target keeps its own pass afterwards
  assert.ok(measurements.passes.some((pass) => pass.targetId === "fb-B" && pass.sampleCount === 1));
});

// ------------------------------------------------------------------------------------------------
// identity + recorded artefacts
// ------------------------------------------------------------------------------------------------

test("the pass identity exposes exactly the five platform-visible fields", () => {
  const key = identityKey(identity(A, { scissorRect: { x: 1, y: 2, width: 3, height: 4 } }));
  for (const field of ["colorTargets", "depthStencilTarget", "sampleCount", "viewport", "scissorRect"]) {
    assert.ok(key.includes(`${field}=`), `the key MUST contain ${field}: ${key}`);
  }
  assert.match(key, /scissorRect=\{1,2,3,4\}/);
  assert.equal(identityKey(null), "<no-identity>");
});

test("the recorded trace (when present) partitions into the passes the artefact reports", (t) => {
  const tracePath = repoPath("experiments/gates/out/g3-trace.json");
  const gatePath = repoPath("experiments/gates/out/g3.json");
  if (!fs.existsSync(tracePath) || !fs.existsSync(gatePath)) {
    t.diagnostic(
      "experiments/gates/out/g3-trace.json / g3.json are absent (gate artefacts are gitignored and produced by " +
        "`node experiments/gates/g3-pass-trace/run.mjs`): the synthetic cases above still ran, but the recorded frame " +
        "was not cross-checked in this environment.",
    );
    return;
  }
  const recorded = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
  assert.equal(gate.gate, "g3");
  assert.equal(gate.verdict, "pass", "the recorded G-3 verdict MUST be pass for the cross-check to mean anything");
  const ops = recorded.ops;
  assert.ok(ops.length > 20, `the recorded frame MUST contain a real operation sequence, got ${ops.length}`);
  const { checks, measurements } = judgePartition(ops, { frameEndSeq: ops[ops.length - 1].seq });
  for (const entry of checks) assert.equal(entry.ok, true, `${entry.id} MUST hold for the recorded frame: ${entry.detail}`);
  assert.equal(measurements.passCount, gate.measurements.partition.passCount, "the artefact's pass count MUST match a fresh partition");
  assert.ok(measurements.drawCount > 1 && measurements.clearCount > 1, "the recorded frame MUST contain real draws and clears");
  assert.ok(measurements.passesWithMultipleDraws > 0, "at least one pass MUST hold several draws (terrain tiles share a pass)");
  assert.equal(measurements.passes[measurements.passes.length - 1].targetId, "default", "the frame MUST end on the presentation target");
  assert.ok(measurements.resolveBlitCount > 0, "the frame MUST contain the resolveFramebuffers blit");
  // The partition is derived, not stored: recomputing it from the trace MUST give the same switch set.
  assert.equal(partitionTrace(ops).switches.length, measurements.switchCount);
});
