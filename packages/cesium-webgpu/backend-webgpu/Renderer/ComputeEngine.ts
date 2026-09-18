/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/ComputeEngine.js`
 * (kind: "adapt") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * T053 draws the boundary at the **execution**, not at the construction: upstream's `Scene` builds a
 * `ComputeEngine` unconditionally (`Scene.js:182`), so a constructor that threw would make the whole
 * scene unconstructible — and T043's construct-time takeover impossible. The engine is therefore a
 * real, inert container here (upstream's constructor is literally `this._context = context`), and
 * `execute()` — the GPGPU path, which the MVP scene configuration keeps at zero dispatches
 * (data-model §11 A6) — fails loudly with `category: "not-implemented"`.
 *
 * Research §5.1 records the eventual mapping: upstream's `ComputeEngine` is not GPU compute at all but
 * "a full-screen viewport quad + a fragment shader writing a texture", i.e. one render pass onto an
 * offscreen target, which is why it is out of scope for W2 rather than technically impossible.
 */
import { sliceCNotImplemented } from "../webgpu/not-implemented.js";

export default class ComputeEngine {
  readonly _context: unknown;

  constructor(context: unknown) {
    // Upstream: `function ComputeEngine(context) { this._context = context; }` (ComputeEngine.js:18-20)
    this._context = context;
  }

  /**
   * Execute a `ComputeCommand`.
   *
   * @throws a `DiagnosticError` (`category: "not-implemented"`, FR-033) — never a silently skipped
   *   dispatch, which would leave the output texture with stale contents.
   */
  execute(computeCommand?: unknown): never {
    void computeCommand;
    throw sliceCNotImplemented("ComputeEngine");
  }

  /** The framebuffer the GPGPU pass would render into (upstream builds it per output texture). */
  isDestroyed(): boolean {
    return false;
  }

  destroy(): void {
    // Nothing to release while `execute()` cannot run: the engine holds no GPU resources yet.
  }
}
