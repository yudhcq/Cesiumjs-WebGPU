/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * WGSL shader library (contract fork-patch-layer §5 rule R3): the terrain closure of the
 * upstream shader tree, translated once and kept here — the upstream `Source/Shaders/**` tree is
 * never modified and no WGSL is ever written into it.
 *
 * Coverage of this increment: `GlobeVS`, `GlobeFS`, `AtmosphereCommon`, `GroundAtmosphere` plus
 * the `czm_` built-ins the terrain path needs. The remaining 319 `.glsl` files / 244 built-ins are
 * outside this increment (contract §5 "MVP coverage").
 *
 * PHASE 3 (W1) SKELETON: the library lands with the shader front end in W4; `.wgsl` files are
 * added to this directory and indexed by `webgpu/shader-leaf-map.json`.
 */
import { throwNotImplemented } from "../errors.js";

const CAPABILITY = "WGSL shader library";

/** One library entry: the WGSL module for one upstream shader leaf. */
export interface WgslLibraryEntry {
  readonly name: string;
  /** Path relative to `backend-webgpu/webgpu/wgsl/`, e.g. `globe-vs.wgsl`. */
  readonly wgslFile: string;
  /** Hash of the upstream leaf text this module was translated from (drift detection, R7). */
  readonly leafHash: string;
  /** Set to `true` only after the real-device pipeline check passed (contract §5 R5). */
  readonly verifiedOnRealGpu: boolean;
}

/** Load the library index (backed by `shader-leaf-map.json`; W4). */
export function loadShaderLibrary(): readonly WgslLibraryEntry[] {
  return throwNotImplemented(CAPABILITY, {
    entryPoint: "wgsl.loadShaderLibrary",
    plannedPhase: "W4 (shader front end)",
    requirementRef: "FR-031",
  });
}

/** Read one WGSL module by upstream leaf name (W4). */
export function readWgslModule(_leafName: string): string {
  return throwNotImplemented(CAPABILITY, {
    entryPoint: "wgsl.readWgslModule",
    plannedPhase: "W4 (shader front end)",
    requirementRef: "FR-031",
  });
}
