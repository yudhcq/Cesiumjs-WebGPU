/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * Capability composition (research §4, data-model §3.1, gate G-2/T045): the replacement
 * `Context` publishes the flags the logic layer gates on, and synthesises `ContextLimits` from
 * the adapter limits. The measured facts this module must honour:
 *
 *   - `webgl2: true` means "modern rendering capabilities are available" (historical name);
 *   - a `false` capability MUST carry a `notes` entry (FR-023) — never a silent downgrade;
 *   - every value MUST record where it came from (adapter limit / feature / fixed choice);
 *   - `depthTexture` is `false` in slice A and `true` in slice B, and
 *     `sliceBComplete === true` implies `depthTexture === true`.
 *
 * PHASE 3 (W1) SKELETON: composition lands in W2/T045; the shapes and the invariant are frozen
 * here so the audit (A8) and the unit tests can assert them.
 */
import { throwNotImplemented } from "./errors.js";

const CAPABILITY = "capability composition";

/** The capability flags the upstream logic layer gates on (research §4). */
export interface BackendCapabilities {
  readonly webgl2: boolean;
  readonly msaa: boolean;
  readonly depthTexture: boolean;
  readonly fragmentDepth: boolean;
  readonly instancedArrays: boolean;
  readonly drawBuffers: boolean;
  readonly elementIndexUint: boolean;
  readonly stencilBuffer: boolean;
  readonly textureFilterAnisotropic: boolean;
  readonly supportsBasis: boolean;
  readonly colorBufferFloat: boolean;
  readonly colorBufferHalfFloat: boolean;
  readonly floatingPointTexture: boolean;
  readonly halfFloatingPointTexture: boolean;
}

/** `ContextLimits` values the backend synthesises for the logic layer. */
export interface ContextLimitsSnapshot {
  readonly maximumTextureSize: number;
  readonly maximumCubeMapSize: number;
  readonly maximum3DTextureSize: number;
  readonly maximumTextureImageUnits: number;
  readonly maximumVertexTextureImageUnits: number;
  readonly maximumCombinedTextureImageUnits: number;
  readonly maximumTextureFilterAnisotropy: number;
  readonly maximumRenderbufferSize: number;
  readonly maximumVertexAttributes: number;
  readonly maximumVaryingVectors: number;
  readonly maximumVertexUniformVectors: number;
  readonly maximumFragmentUniformVectors: number;
  readonly maximumColorAttachments: number;
  readonly maximumDrawBuffers: number;
  readonly maximumSamples: number;
  readonly minimumAliasedLineWidth: number;
  readonly maximumAliasedLineWidth: number;
  readonly minimumAliasedPointSize: number;
  readonly maximumAliasedPointSize: number;
  readonly maximumViewportWidth: number;
  readonly maximumViewportHeight: number;
  readonly highpFloatSupported: boolean;
  readonly highpIntSupported: boolean;
}

/** One composed capability value together with its provenance and its degradation note. */
export interface CapabilityValue {
  readonly value: boolean | number;
  /** Where the value came from: `adapter.limits.maxTextureDimension2D`, `fixed`, … */
  readonly source: string;
  /** Blind spot / degradation note; REQUIRED whenever a flag is `false` (FR-023). */
  readonly notes?: string;
}

/** Compose the flags and the limits snapshot from the adapter (W2/T045). */
export function composeCapabilities(_adapter: unknown): {
  readonly capabilities: BackendCapabilities;
  readonly limits: ContextLimitsSnapshot;
  readonly provenance: Readonly<Record<string, CapabilityValue>>;
} {
  return throwNotImplemented(CAPABILITY, {
    entryPoint: "capability.composeCapabilities",
    plannedPhase: "W2 (T045)",
    requirementRef: "FR-030",
  });
}

/**
 * The two capability profiles of this increment (data-model §3.1, §11 A8).
 *
 * Slice A ships with the depth-texture capability switched off (a temporary, declared
 * degradation: the reason MUST be recorded in `notes`, FR-023); slice B turns it on. The
 * consistency rule "a completed slice B implies `depthTexture`" is expressed here as data — so
 * the architecture scan (A8) can read it — and enforced by `assertSliceConsistency` below.
 */
export const SLICE_PROFILES = {
  sliceA: {
    sliceBComplete: false,
    depthTexture: false,
    notes: ["depthTexture temporarily off (slice A): the offscreen depth attachment lands in slice B"],
  },
  sliceB: {
    sliceBComplete: true,
    depthTexture: true,
    notes: [],
  },
} as const;

/**
 * The slice-B consistency invariant (data-model §11 A8): a completed slice B MUST have the depth
 * texture capability. Kept as a real predicate so it can be asserted without the backend.
 */
export function assertSliceConsistency(capabilities: Pick<BackendCapabilities, "depthTexture">, sliceBComplete: boolean): void {
  if (sliceBComplete && capabilities.depthTexture !== true) {
    throw new Error("slice-B consistency violated: sliceBComplete === true requires depthTexture === true (data-model §11 A8)");
  }
}
