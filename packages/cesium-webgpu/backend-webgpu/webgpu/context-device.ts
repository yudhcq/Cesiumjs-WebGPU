/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * The single guard every replaced resource class goes through (plan.md D2-a, tasks.md T055-T062).
 *
 * Under the static manifest **every** route to `Source/Renderer/*.js` is rewritten to the patch
 * layer, including the routes taken by the vendored upstream WebGL2 `Context` that the replacement
 * `Context` delegates to when the device hand-off slot is empty
 * (`vendor/upstream-webgl2/Context.js` imports `@cesium/engine/Source/Renderer/Buffer.js`, which the
 * alias plugin resolves to `Renderer/Buffer.ts`). The replacement resource classes therefore have to
 * answer one question before they touch anything: *which backend owns this context?*
 *
 * There are exactly two possible answers, and both are handled without guessing:
 *
 *   - the context is the replacement `Context` → it carries a `GPUDevice`, and the resource is
 *     realised with WebGPU handles;
 *   - the context is the delegated upstream WebGL2 implementation → it carries a `_gl` context and
 *     **no** device. Realising a GPU resource from it is the WebGL2 fallback build-out, which
 *     `PROVENANCE.json` and plan.md assign to W6 (T100/T101). Until that lands, the entry point
 *     fails loudly with `category: "not-implemented"` naming W6 — never a half-built resource, and
 *     never a silent `undefined`.
 *
 * Keeping this in one module means the failure wording, the category and the owning task are
 * identical for every resource class, so a fallback path that forgets one of them is detectable.
 */
import { DiagnosticError } from "./errors.js";

/** The backend-internal shape a replaced resource class needs from its context. */
export interface GpuContextLike {
  readonly device?: GPUDevice | undefined;
  readonly id?: string | undefined;
}

const WEBGL2_FALLBACK_PHASE = "W6 (T100/T101: WebGL2 fallback build-out)";

/** `true` when `context` is the replacement WebGPU `Context` (it carries a usable device). */
export function hasGpuDevice(context: unknown): boolean {
  const device = (context as GpuContextLike | null | undefined)?.device;
  return device !== undefined && device !== null && typeof (device as GPUDevice).createBuffer === "function";
}

/**
 * The device of a WebGPU context, or a diagnosable failure.
 *
 * @param context the `options.context` the logic layer passed in
 * @param entryPoint the entry point the failure belongs to (e.g. `Buffer#constructor`)
 * @param upstreamModule the upstream module the entry point replaces
 */
export function requireDevice(context: unknown, entryPoint: string, upstreamModule: string): GPUDevice {
  if (context === undefined || context === null) {
    throw new DiagnosticError(
      "internal",
      `${entryPoint}: a context is required (\`Check.defined("options.context", options.context)\` upstream). ` +
        "Without a context neither the WebGPU device nor the WebGL2 delegation is reachable.",
      { backend: "webgpu", upstreamModule, requirementRef: "FR-030", entryPoint },
    );
  }
  if (!hasGpuDevice(context)) {
    const looksLikeWebgl2 = (context as { _gl?: unknown })._gl !== undefined;
    throw new DiagnosticError(
      "not-implemented",
      `${entryPoint}: this context has no WebGPU device${looksLikeWebgl2 ? " (it is the delegated upstream WebGL2 context)" : ""}, so the ` +
        `resource cannot be realised with GPU handles. The WebGL2 fallback build-out is ${WEBGL2_FALLBACK_PHASE}; until it lands this ` +
        "entry point MUST fail loudly rather than hand back a resource that is not backed by anything (plan.md D2-a).",
      {
        backend: "webgpu",
        upstreamModule,
        requirementRef: "FR-030",
        entryPoint,
        plannedPhase: WEBGL2_FALLBACK_PHASE,
        extra: { contextLooksLikeWebgl2: looksLikeWebgl2 },
      },
    );
  }
  return (context as GpuContextLike).device as GPUDevice;
}

/** The phase that owns the WebGL2 fallback build-out (re-exported for the tests and the report). */
export const WEBGL2_FALLBACK_OWNER = WEBGL2_FALLBACK_PHASE;
