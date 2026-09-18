/**
 * Status-model test suite (T038).
 *
 * The modules are executed for real (compiled + bundled in-process), so the invariants are
 * asserted on behaviour rather than on source text:
 *   - `degraded === true` without a note is rejected;
 *   - the reason and error category vocabularies match the contracts;
 *   - a diagnostic is delivered to every subscriber and, with no subscriber, to the sink —
 *     it is never silently swallowed, and a throwing subscriber cannot hide it from the others.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";

const SRC = "packages/cesium-webgpu/src";

const CONTRACT_REASONS = ["ok", "no-navigator-gpu", "no-adapter", "device-request-failed", "missing-feature", "below-limit", "timeout"];
const CONTRACT_CATEGORIES = ["not-implemented", "data-unavailable", "render-failed", "probe-failed", "device-lost", "internal"];

test("the reason vocabulary matches data-model §2.2 exactly", async () => {
  const status = await loadTypeScriptModule(`${SRC}/status/render-path-status.ts`);
  assert.deepEqual([...status.RENDER_PATH_REASONS], CONTRACT_REASONS);
  const types = readText(`${SRC}/api/types.ts`);
  for (const reason of CONTRACT_REASONS) assert.ok(types.includes(`"${reason}"`), `src/api/types.ts MUST declare "${reason}"`);
});

test("the error category vocabulary matches the contract and the public type", async () => {
  const errors = await loadTypeScriptModule(`${SRC}/api/errors.ts`);
  assert.deepEqual([...errors.DIAGNOSTIC_CATEGORIES], CONTRACT_CATEGORIES);
  const types = readText(`${SRC}/api/types.ts`);
  for (const category of CONTRACT_CATEGORIES) assert.ok(types.includes(`"${category}"`), `src/api/types.ts MUST declare "${category}"`);
});

test("a degraded status without notes is rejected; with notes it is accepted", async () => {
  const status = await loadTypeScriptModule(`${SRC}/status/render-path-status.ts`);

  assert.throws(
    () => status.createRenderPathStatus({ active: "webgl2", reason: "no-adapter", degraded: true }),
    /MUST carry at least one note/,
  );
  assert.throws(() => status.createRenderPathStatus({ active: "webgl2", reason: "no-adapter", degraded: true, notes: [] }), /MUST carry at least one note/);
  assert.throws(() => status.createRenderPathStatus({ active: "webgl2", reason: "no-adapter", degraded: true, notes: ["   "] }), /non-empty strings/);
  assert.throws(() => status.createRenderPathStatus({ active: "webgl2", reason: "made-up" }), /unknown render-path reason/);

  const healthy = status.createRenderPathStatus({ active: "webgpu", reason: "ok" });
  assert.deepEqual(healthy, { active: "webgpu", reason: "ok", degraded: false, notes: [] });
  assert.equal(status.isHealthy(healthy), true);

  const degraded = status.createRenderPathStatus({
    active: "webgl2",
    reason: "no-adapter",
    degraded: true,
    notes: ["software rasteriser adapter (CI)"],
  });
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.notes.length, 1);
  assert.equal(status.isHealthy(degraded), false);
  assert.doesNotThrow(() => status.assertStatusInvariant(degraded));
  assert.throws(() => status.assertStatusInvariant({ degraded: true, notes: [] }), /requires non-empty notes/);
});

test("the degradation catalogue carries a source for every declared note", async () => {
  const notes = await loadTypeScriptModule(`${SRC}/status/degradation-notes.ts`);
  assert.ok(notes.DEGRADATION_NOTES.length >= 5, "the blind-spot catalogue MUST cover the documented degradations");
  for (const entry of notes.DEGRADATION_NOTES) {
    assert.equal(typeof entry.note, "string");
    assert.ok(entry.note.length > 10, `${entry.key} MUST explain the degradation`);
    assert.ok(entry.source.length > 0, `${entry.key} MUST record where the fact comes from`);
  }
  const collected = notes.collectNotes(["slice-a-depth-texture", "wgsl-module-validation-only"]);
  assert.equal(collected.length, 2);
  assert.throws(() => notes.collectNotes(["not-a-key"]), /unknown degradation note key/);
});

test("the status emitter reports changes once and surfaces observer failures", async () => {
  const status = await loadTypeScriptModule(`${SRC}/status/render-path-status.ts`);
  const seen = [];
  const emitter = status.createStatusEmitter({ onStatus: (value) => seen.push(value) });

  emitter.emit({ active: "webgpu", reason: "ok" });
  emitter.emit({ active: "webgpu", reason: "ok" });
  assert.equal(seen.length, 1, "an unchanged status MUST NOT be re-reported");
  emitter.emit({ active: "webgl2", reason: "device-request-failed", degraded: true, notes: ["fell back after a probe failure"] });
  assert.equal(seen.length, 2);
  assert.equal(emitter.last().active, "webgl2");

  const failures = [];
  const failing = status.createStatusEmitter({ onStatus: () => { throw new Error("observer exploded"); }, onObserverError: (error) => failures.push(error) });
  failing.emit({ active: "webgl2", reason: "ok" });
  assert.equal(failures.length, 1, "an observer failure MUST be surfaced, never swallowed");

  const rethrowing = status.createStatusEmitter({ onStatus: () => { throw new Error("observer exploded"); } });
  assert.throws(() => rethrowing.emit({ active: "webgl2", reason: "ok" }), /observer exploded/);
});

test("diagnostics delivers every error to every subscriber and to the sink when nobody listens", async () => {
  const { createDiagnostics } = await loadTypeScriptModule(`${SRC}/api/diagnostics.ts`);
  const { DiagnosticError, notImplemented } = await loadTypeScriptModule(`${SRC}/api/errors.ts`);

  const sunk = [];
  const diagnostics = createDiagnostics({ sink: (error) => sunk.push(error) });
  const first = [];
  const second = [];
  const off = diagnostics.onError((error) => first.push(error));
  diagnostics.onError((error) => second.push(error));

  const failure = notImplemented("readPixels is outside slice A", { backend: "webgpu" });
  assert.ok(failure instanceof DiagnosticError);
  diagnostics.report(failure);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(sunk.length, 0, "with subscribers present the sink is not used");
  assert.equal(diagnostics.listenerCount(), 2);

  off();
  assert.equal(diagnostics.listenerCount(), 1);
  diagnostics.report(notImplemented("still not implemented"));
  assert.equal(first.length, 1, "an unsubscribed listener MUST NOT receive further diagnostics");
  assert.equal(second.length, 2);

  off(); // idempotent
  assert.equal(diagnostics.listenerCount(), 1);

  diagnostics.report(new DiagnosticError({ category: "render-failed", message: "shader compilation failed" }));
  assert.deepEqual(diagnostics.counts(), { "not-implemented": 2, "render-failed": 1 });
  assert.deepEqual(diagnostics.history().map((entry) => entry.category), ["not-implemented", "not-implemented", "render-failed"]);
});

test("with no subscriber the diagnostic reaches the sink instead of disappearing", async () => {
  const { createDiagnostics } = await loadTypeScriptModule(`${SRC}/api/diagnostics.ts`);
  const { notImplemented } = await loadTypeScriptModule(`${SRC}/api/errors.ts`);
  const sunk = [];
  const diagnostics = createDiagnostics({ sink: (error) => sunk.push(error) });

  diagnostics.report(notImplemented("no subscriber at all"));
  assert.equal(sunk.length, 1, "a diagnostic MUST NOT be swallowed when nobody is subscribed");
  assert.equal(sunk[0].category, "not-implemented");

  // A non-diagnostic value is surfaced as an internal failure rather than dropped.
  diagnostics.report("plain string");
  assert.equal(sunk.length, 2);
  assert.equal(sunk[1].category, "internal");
  assert.equal(sunk[0].category, "not-implemented");
});

test("a throwing subscriber cannot hide the diagnostic from the others", async () => {
  const { createDiagnostics } = await loadTypeScriptModule(`${SRC}/api/diagnostics.ts`);
  const { notImplemented } = await loadTypeScriptModule(`${SRC}/api/errors.ts`);
  const sunk = [];
  const received = [];
  const diagnostics = createDiagnostics({ sink: (error) => sunk.push(error) });

  diagnostics.onError(() => {
    throw new Error("subscriber exploded");
  });
  diagnostics.onError((error) => received.push(error));
  diagnostics.report(notImplemented("a capability outside the slice"));

  assert.equal(received.length, 1, "the remaining subscriber MUST still receive the diagnostic");
  assert.equal(sunk.length, 1, "the subscriber failure MUST be surfaced through the sink");
  assert.equal(sunk[0].category, "internal");
  assert.match(sunk[0].message, /listener threw/);
});

test("toDiagnosticError keeps unknown thrown values as diagnosable causes", async () => {
  const { toDiagnosticError, DiagnosticError, isDiagnosticError } = await loadTypeScriptModule(`${SRC}/api/errors.ts`);
  const already = new DiagnosticError({ category: "device-lost", message: "device lost" });
  assert.equal(toDiagnosticError(already), already);

  const wrapped = toDiagnosticError(new TypeError("bad argument"), { backend: "webgpu" });
  assert.equal(wrapped.category, "internal");
  assert.equal(wrapped.backend, "webgpu");
  assert.ok(wrapped.cause instanceof TypeError);

  const fromString = toDiagnosticError("something odd");
  assert.match(fromString.message, /non-error value thrown: something odd/);
  assert.equal(isDiagnosticError(fromString), true);
  assert.equal(isDiagnosticError({ name: "DiagnosticError", category: "internal", message: "from another realm" }), true);
  assert.equal(isDiagnosticError(undefined), false);
});
