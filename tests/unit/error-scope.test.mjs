/**
 * T052 — asynchronous GPU error collection and diagnosable failure (`层=单元`, tasks.md T052; research §6.2).
 *
 * Upstream's observable semantics are "a shader that does not compile throws". WebGPU reports the same
 * problem asynchronously (`pushErrorScope` / `onuncapturederror`), so the replacement has to collect the
 * three scopes per frame and **raise at frame end** — never swallow. The counter-example here is exactly
 * that case: an invalid WGSL module produces a `GPUValidationError`, and the frame MUST fail.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { createFakeDevice, installWebgpuGlobals } from "../support/fake-gpu.mjs";

installWebgpuGlobals();

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function loadErrorScope() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/error-scope.ts`));
}

function validationError(message = "invalid WGSL: unexpected token") {
  return Object.assign(new Error(message), { name: "GPUValidationError" });
}

test("a clean frame opens and closes the three scopes in balance and resolves", async () => {
  const { ErrorScopeCollector } = await loadErrorScope();
  const device = createFakeDevice();
  const collector = new ErrorScopeCollector(device);
  collector.beginFrame();
  assert.deepEqual(
    device.__calls.filter((call) => call.name === "pushErrorScope").map((call) => call.args[0]),
    ["validation", "out-of-memory", "internal"],
    "all three scopes MUST be opened for every frame",
  );
  await collector.endFrame();
  assert.equal(device.__calls.filter((call) => call.name === "popErrorScope").length, 3);
  assert.deepEqual(collector.history(), []);
  collector.destroy();
});

test("an invalid WGSL module makes the frame fail with a diagnosable error", async () => {
  const { ErrorScopeCollector } = await loadErrorScope();
  const device = createFakeDevice();
  const seen = [];
  const collector = new ErrorScopeCollector(device, { onError: (error) => seen.push(error) });
  collector.beginFrame();
  device.__pushError(validationError("invalid WGSL: expected 'fn' at line 3"));

  await assert.rejects(collector.endFrame(), (error) => {
    assert.equal(error.name, "DiagnosticError");
    assert.equal(error.category, "render-failed");
    assert.match(error.message, /invalid WGSL: expected 'fn' at line 3/, "the validation message MUST survive into the diagnostic");
    assert.match(error.message, /MUST NOT be swallowed/);
    assert.equal(error.details?.extra?.count, 1);
    assert.equal(error.details?.extra?.frame, 1);
    return true;
  });
  assert.equal(seen.length, 1, "the diagnostics sink MUST be called as soon as the problem is collected");
  assert.equal(seen[0].name, "GPUValidationError");
  assert.equal(collector.history().length, 1, "the problem stays in the history as evidence");
  collector.destroy();
});

test("uncaptured errors are collected on the same frame boundary", async () => {
  const { ErrorScopeCollector } = await loadErrorScope();
  const device = createFakeDevice();
  const collector = new ErrorScopeCollector(device);
  collector.beginFrame();
  assert.equal(typeof device.onuncapturederror, "function", "the collector MUST subscribe to the device's uncaptured channel");
  device.onuncapturederror({ error: validationError("uncaptured: draw without pipeline") });

  await assert.rejects(collector.endFrame(), /uncaptured: draw without pipeline/);
  collector.destroy();
  assert.equal(device.onuncapturederror, null, "destroy() MUST unsubscribe");
});

test("unbalanced frames are rejected instead of mis-attributing an error", async () => {
  const { ErrorScopeCollector } = await loadErrorScope();
  const device = createFakeDevice();
  const collector = new ErrorScopeCollector(device);
  await assert.rejects(collector.endFrame(), /without a matching beginFrame/);
  collector.beginFrame();
  assert.throws(() => collector.beginFrame(), /still open/);
  collector.destroy();
});

test("collection can be switched off only explicitly (a declared blind spot, never a silent one)", async () => {
  const { ErrorScopeCollector, errorScopeEnabled } = await loadErrorScope();
  const device = createFakeDevice();
  const off = new ErrorScopeCollector(device, { enabled: false });
  assert.equal(off.enabled, false);
  off.beginFrame();
  device.__pushError(validationError());
  await off.endFrame();
  assert.equal(device.__calls.filter((call) => call.name === "pushErrorScope").length, 0, "a disabled collector MUST NOT open scopes");
  off.destroy();

  assert.equal(errorScopeEnabled(), true, "collection is on by default");
  const previous = globalThis.__CESIUM_WEBGPU_ERROR_SCOPE__;
  globalThis.__CESIUM_WEBGPU_ERROR_SCOPE__ = false;
  assert.equal(errorScopeEnabled(), false, "the explicit global override is honoured");
  globalThis.__CESIUM_WEBGPU_ERROR_SCOPE__ = previous;
});

test("several problems are reported together, in scope order", async () => {
  const { ErrorScopeCollector } = await loadErrorScope();
  const device = createFakeDevice();
  const collector = new ErrorScopeCollector(device);
  collector.beginFrame();
  device.__pushError(validationError("first"));
  device.__pushError(validationError("second"));
  await assert.rejects(collector.endFrame(), (error) => {
    assert.match(error.message, /2 GPU error\(s\)/);
    assert.match(error.message, /first/);
    assert.match(error.message, /second/);
    return true;
  });
  collector.destroy();
});
