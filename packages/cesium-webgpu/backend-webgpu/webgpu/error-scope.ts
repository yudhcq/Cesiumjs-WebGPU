/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Error collection and diagnosable failure (research §6.2, contract render-path-api.md §6,
 * tasks.md T052).
 *
 * Why this module exists: `createShaderModule` / `createRenderPipeline` are **synchronous** calls but
 * report validation errors **asynchronously**, through `device.pushErrorScope` /
 * `device.onuncapturederror`. Upstream's observable semantics are "a shader that fails to compile
 * throws" (`ShaderProgram` used to throw a `RuntimeError` from `gl.getProgramInfoLog`). If the
 * replacement simply ignored the asynchronous channel, that semantic would be lost **silently** —
 * exactly the failure mode principle III forbids.
 *
 * So the backend opens the three error scopes at the start of a frame, closes them at the end of the
 * frame, and turns anything collected into a single diagnosable error at that point. Test/dev mode
 * enables the scopes by default; production leaves it on as well unless
 * `globalThis.__CESIUM_WEBGPU_ERROR_SCOPE__ === false` is set explicitly (the cost is three scope
 * pushes per frame, and the payoff is never shipping a silently broken pipeline).
 */
import { DiagnosticError } from "./errors.js";

/** One collected validation/out-of-memory/internal problem, normalised for diagnostics. */
export interface CollectedGpuError {
  readonly scope: GPUErrorFilter;
  readonly name: string;
  readonly message: string;
}

export interface ErrorScopeOptions {
  /** `false` disables collection entirely (declared as a deliberate blind spot, never silent). */
  readonly enabled?: boolean;
  /** Called for every problem as soon as it is collected (status/diagnostics plumbing). */
  readonly onError?: (error: CollectedGpuError) => void;
}

const SCOPES: readonly GPUErrorFilter[] = ["validation", "out-of-memory", "internal"];

/** Whether collection is on: explicit option > global override > default (on). */
export function errorScopeEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  const override = (globalThis as { __CESIUM_WEBGPU_ERROR_SCOPE__?: unknown }).__CESIUM_WEBGPU_ERROR_SCOPE__;
  return override !== false;
}

/**
 * Collects the asynchronous GPU error channels of one device and raises them **at frame end**.
 *
 * The collector is deliberately frame-scoped: raising immediately would attribute the error to
 * whichever `draw` happened to be running, while the frame boundary is the point at which the
 * backend knows which frame's pipelines/commands produced it (T052).
 */
export class ErrorScopeCollector {
  readonly #device: GPUDevice;
  readonly #enabled: boolean;
  readonly #onError: ((error: CollectedGpuError) => void) | null;
  #collected: CollectedGpuError[] = [];
  #uncaptured: CollectedGpuError[] = [];
  #scopeOpen = false;
  #frameIndex = 0;
  #unsubscribe: (() => void) | null = null;

  constructor(device: GPUDevice, options: ErrorScopeOptions = {}) {
    this.#device = device;
    this.#enabled = errorScopeEnabled(options.enabled);
    this.#onError = options.onError ?? null;
    if (this.#enabled) {
      const handler = (event: GPUUncapturedErrorEvent): void => {
        this.#uncaptured.push(normalise("uncaptured", event.error));
      };
      this.#device.onuncapturederror = handler as GPUDevice["onuncapturederror"];
      this.#unsubscribe = () => {
        this.#device.onuncapturederror = null;
      };
    }
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Problems collected during the frame currently being built. */
  get pending(): readonly CollectedGpuError[] {
    return [...this.#collected, ...this.#uncaptured];
  }

  /** Open the frame's error scopes (called from `Context.beginFrame`). */
  beginFrame(): void {
    if (!this.#enabled) return;
    if (this.#scopeOpen) {
      throw new DiagnosticError(
        "internal",
        "error-scope: beginFrame() was called while the scopes of the previous frame were still open. Every frame " +
          "MUST be closed by endFrame(), otherwise a validation error would be attributed to the wrong frame (T052).",
        { backend: "webgpu", requirementRef: "FR-023", entryPoint: "error-scope.beginFrame" },
      );
    }
    for (const scope of SCOPES) this.#device.pushErrorScope(scope);
    this.#scopeOpen = true;
    this.#frameIndex += 1;
  }

  /**
   * Close the frame's scopes, collect what they hold and **throw** a diagnosable error when anything
   * was reported. Called from `Context.endFrame` *before* `queue.submit()` so a broken frame is never
   * presented.
   */
  async endFrame(): Promise<void> {
    if (!this.#enabled) return;
    if (!this.#scopeOpen) {
      throw new DiagnosticError(
        "internal",
        "error-scope: endFrame() was called without a matching beginFrame(); the scopes would be unbalanced (T052).",
        { backend: "webgpu", requirementRef: "FR-023", entryPoint: "error-scope.endFrame" },
      );
    }
    this.#scopeOpen = false;
    // Scopes are a stack: the last pushed is popped first. Reverse-order popping keeps the
    // (scope → error) pairing meaningful for the diagnostics.
    const popped: { scope: GPUErrorFilter; error: GPUError | null }[] = [];
    for (const scope of [...SCOPES].reverse()) {
      popped.unshift({ scope, error: await this.#device.popErrorScope() });
    }
    const found: CollectedGpuError[] = [];
    for (const { scope, error } of popped) {
      if (error === null || error === undefined) continue;
      const normalised = normalise(scope, error);
      found.push(normalised);
      this.#collected.push(normalised);
      this.#onError?.(normalised);
    }
    for (const error of this.#uncaptured) {
      found.push(error);
      this.#collected.push(error);
      this.#onError?.(error);
    }
    this.#uncaptured = [];
    if (found.length > 0) {
      throw new DiagnosticError(
        "render-failed",
        `frame ${this.#frameIndex} produced ${found.length} GPU error(s): ` +
          `${found.map((entry) => `[${entry.scope}] ${entry.message}`).join(" | ")}. ` +
          "The WebGPU backend raises this at frame end to preserve upstream's \"a shader that does not compile " +
          "throws\" semantics (research §6.2) — it MUST NOT be swallowed.",
        {
          backend: "webgpu",
          upstreamModule: "Renderer/ShaderProgram.js",
          requirementRef: "FR-023",
          entryPoint: "error-scope.endFrame",
          extra: { frame: this.#frameIndex, count: found.length, scopes: found.map((entry) => entry.scope).join(",") },
        },
      );
    }
  }

  /** Every problem collected so far (evidence artefacts). */
  history(): readonly CollectedGpuError[] {
    return this.#collected.map((entry) => ({ ...entry }));
  }

  destroy(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#scopeOpen = false;
  }
}

function normalise(scope: string, error: unknown): CollectedGpuError {
  const name = (error as { name?: string } | null)?.name ?? "GPUError";
  const message = (error as { message?: string } | null)?.message ?? String(error);
  return { scope: scope as GPUErrorFilter, name, message };
}
