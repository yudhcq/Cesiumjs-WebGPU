/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/createUniformArray.js`
 * (kind: "replace") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * WHY THIS IS A REPLACEMENT AND NOT A TRANSLATION (tasks.md **T076**, FR-030)
 *   Upstream generates one object per active uniform *array* whose `set()` calls `gl.uniform*fv` at
 *   `locations[0]` (or `gl.uniform1i` per element for a `sampler2D[]`). WebGPU has neither: an array
 *   member is written as bytes at the layout's `arrayStride` (data-model §4.3), and `u_dayTextures`
 *   is not a struct member at all — it is N texture/sampler pairs in the sampler bind group.
 *
 *   Preserved exactly (see `Renderer/createUniform.ts` for the full rationale):
 *     createUniformArray(gl, activeUniform, uniformName, locations)
 *       → { name, value, set(), [_locations], [textureUnitIndex], [_setSampler] }
 *   with the **lazy set + self-diff** semantic: an equal value MUST NOT write.
 *
 * Array length: upstream sizes `value` from `locations.length`. In this backend the length comes from
 * the layout when one is supplied — `UniformField.length` is the union layout's element count, which
 * for a `TEXTURE_UNITS` array can legitimately exceed the variant's own `length` — and falls back to
 * the `locations` argument (then `activeUniform.size`) in standalone mode. A value that carries fewer
 * elements than the struct declares is written element by element and the rest is *recorded* as
 * missing (never zero-filled, never `NaN`); a value that carries **more** raises `internal`, because
 * writing it would overwrite the struct member that follows.
 */
import { DiagnosticError, throwNotImplemented } from "../webgpu/errors.js";
import { layoutUniforms } from "../webgpu/bind-layout.js";
import type { BindLayoutResult, SamplerBinding, UniformField } from "../webgpu/bind-layout.js";
import { MemberWriteTarget } from "../webgpu/uniform-writer.js";
import type { UniformWriteSink } from "../webgpu/uniform-writer.js";

import { GLSL_TYPE_BY_GL_ENUM } from "./createUniform.js";
import type { ActiveUniformDescriptor, CreateUniformOptions } from "./createUniform.js";

const UPSTREAM_MODULE = "Renderer/createUniformArray.js";
const ENTRY_POINT = "createUniformArray";

export interface NumericUniformArraySetter {
  name: string;
  value: unknown[];
  set(): void;
  readonly _gl: unknown;
  readonly _location: unknown;
  /** The member-level lazy writer (self-diff + offsets) behind this setter. */
  readonly _target: MemberWriteTarget;
  /** The local struct buffer in standalone (no writer) mode, `undefined` otherwise. */
  readonly _buffer: ArrayBuffer | undefined;
  /** Why this uniform is not a member of the program layout, if it is not. */
  readonly _detachedReason: string | undefined;
  readonly _bytesWritten: number;
}

export interface SamplerUniformArraySetter {
  name: string;
  value: unknown[];
  set(): void;
  /** Upstream keeps one GL location per element; the WebGPU backend keeps the count. */
  readonly _locations: readonly unknown[];
  textureUnitIndex: number | undefined;
  _setSampler(textureUnitIndex: number): number;
  readonly _gl: unknown;
}

export type UniformArraySetter = NumericUniformArraySetter | SamplerUniformArraySetter;

function internalError(message: string): DiagnosticError {
  return new DiagnosticError("internal", `createUniformArray: ${message}`, {
    backend: "webgpu",
    upstreamModule: UPSTREAM_MODULE,
    requirementRef: "FR-030",
  });
}

function glslTypeOf(descriptor: ActiveUniformDescriptor, uniformName: string): string {
  if (typeof descriptor.glslType === "string" && descriptor.glslType.length > 0) return descriptor.glslType;
  const glEnum = descriptor.type;
  const glslType = typeof glEnum === "number" ? GLSL_TYPE_BY_GL_ENUM[glEnum] : undefined;
  if (glslType === undefined) {
    return throwNotImplemented(`the uniform type of array "${uniformName}" (GL enum ${glEnum === undefined ? "(none)" : `0x${glEnum.toString(16)}`})`, {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: ENTRY_POINT,
      requirementRef: "FR-030",
      plannedPhase: "a slice that maps this GLSL uniform type onto a WGSL/WebGPU uniform",
      extra: { uniform: uniformName, glEnum: typeof glEnum === "number" ? glEnum : -1 },
    });
  }
  return glslType;
}

/** The standalone "no-GPU" layout for an array uniform (same generator the program layout uses). */
function implicitLayout(uniformName: string, descriptor: ActiveUniformDescriptor, size: number): BindLayoutResult {
  const glslType = glslTypeOf(descriptor, uniformName);
  try {
    return layoutUniforms([{ name: uniformName, glslType, size }]);
  } catch (cause) {
    return throwNotImplemented(`the uniform type "${glslType}" of array "${uniformName}"`, {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: ENTRY_POINT,
      requirementRef: "FR-030",
      plannedPhase: "a slice that maps this GLSL uniform type onto a WGSL/WebGPU uniform",
      cause,
    });
  }
}

function locationsLength(locations: readonly unknown[] | number | undefined): number | undefined {
  if (typeof locations === "number") return Number.isSafeInteger(locations) && locations > 0 ? locations : undefined;
  if (Array.isArray(locations)) return locations.length > 0 ? locations.length : undefined;
  return undefined;
}

interface ResolvedArrayMember {
  readonly layout: BindLayoutResult;
  readonly field: UniformField | undefined;
  readonly sampler: SamplerBinding | undefined;
  readonly samplers: readonly SamplerBinding[];
  readonly detachedReason: string | undefined;
}

function resolveArray(uniformName: string, descriptor: ActiveUniformDescriptor, locations: readonly unknown[] | number | undefined, options: CreateUniformOptions): ResolvedArrayMember {
  const layout = options.layout;
  if (layout === undefined) {
    const size = Math.max(1, locationsLength(locations) ?? descriptor.size ?? 1);
    const implicit = implicitLayout(uniformName, descriptor, size);
    const samplers = implicit.samplers;
    const sampler = samplers[0];
    if (sampler !== undefined) return { layout: implicit, field: undefined, sampler, samplers, detachedReason: undefined };
    const field = implicit.members[0];
    if (field === undefined) throw internalError(`the implicit layout of "${uniformName}" declares neither a member nor a sampler`);
    return { layout: implicit, field, sampler: undefined, samplers: [], detachedReason: undefined };
  }
  const samplers = layout.samplers.filter((candidate) => candidate.glslName === uniformName);
  const sampler = samplers[0];
  if (sampler !== undefined) return { layout, field: undefined, sampler, samplers, detachedReason: undefined };
  const field = layout.members.find((candidate) => candidate.name === uniformName);
  if (field !== undefined) return { layout, field, sampler: undefined, samplers: [], detachedReason: undefined };
  return {
    layout,
    field: undefined,
    sampler: undefined,
    samplers: [],
    detachedReason: `struct "${layout.structName}" declares no uniform "${uniformName}", so no WGSL statement can read it and no byte is written`,
  };
}

/**
 * Upstream entry point `createUniformArray(…)`.
 *
 * @param {WebGL2RenderingContext} gl kept for call-site fidelity; never used (WebGPU has no GL).
 * @param {WebGLActiveInfo} activeUniform the array's GL descriptor, or `{ glslType, size }`.
 * @param {string} uniformName the array's name.
 * @param {WebGLUniformLocation[]} locations one entry per element upstream (`_locations`); a plain
 *   element count is accepted too, because the WebGPU backend has no locations to hand over.
 * @param {object} [options] `{ layout, writer }` — see `Renderer/createUniform.ts`.
 * @returns {object} the setter object `ShaderProgram` drives.
 * @private
 */
export default function createUniformArray(
  gl: unknown,
  activeUniform: ActiveUniformDescriptor,
  uniformName: string,
  locations: readonly unknown[] | number | undefined,
  options: CreateUniformOptions = {},
): UniformArraySetter {
  // See `Renderer/createUniform.ts`: a missing argument MUST yield a diagnostic, not a `TypeError`.
  if (activeUniform === undefined || activeUniform === null) {
    throw internalError("the uniform descriptor (upstream's WebGLActiveInfo) is required but was not provided");
  }
  if (typeof uniformName !== "string" || uniformName.length === 0) {
    throw internalError(`the uniform name is required but was ${typeof uniformName === "string" ? "empty" : `a ${typeof uniformName}`}`);
  }
  const resolved = resolveArray(uniformName, activeUniform, locations, options);
  const fromLocations = locationsLength(locations);
  if (resolved.sampler !== undefined) {
    const length = Math.max(1, resolved.samplers.length, fromLocations ?? 1);
    const placeholders = Array.isArray(locations) ? locations : new Array<unknown>(length).fill(0);
    return new SamplerUniformArray(uniformName, gl, placeholders, options.writer, length);
  }
  const field = resolved.field;
  // `field === undefined` with a reason is the *detached* case (see `Renderer/createUniform.ts`).
  if (field === undefined && resolved.detachedReason === undefined) {
    throw internalError(`"${uniformName}" resolved to neither a member nor a sampler`);
  }
  const length = Math.max(1, fromLocations ?? field?.length ?? 1);
  const structSize = resolved.layout.structSize;
  let buffer: ArrayBuffer | undefined;
  let target: MemberWriteTarget;
  if (options.writer === undefined) {
    buffer = new ArrayBuffer(Math.max(structSize, 16));
    target = new MemberWriteTarget(field, { structSize, buffer });
  } else {
    target = new MemberWriteTarget(field, { structSize, sink: options.writer });
  }
  // Upstream stores `locations[0]`; an element count carries no location, so the slot stays undefined.
  const firstLocation = Array.isArray(locations) ? locations[0] : undefined;
  return new NumericUniformArray(uniformName, gl, firstLocation, target, buffer, resolved.detachedReason, length);
}

/** `UniformArrayFloat`/`…IntVec4`/`…Mat4`: one array member, lazy `set()`, no GL call. */
class NumericUniformArray implements NumericUniformArraySetter {
  name: string;
  value: unknown[];
  readonly _gl: unknown;
  readonly _location: unknown;
  readonly _target: MemberWriteTarget;
  readonly _buffer: ArrayBuffer | undefined;
  readonly _detachedReason: string | undefined;

  constructor(name: string, gl: unknown, location: unknown, target: MemberWriteTarget, buffer: ArrayBuffer | undefined, detachedReason: string | undefined, length: number) {
    this.name = name;
    this.value = new Array<unknown>(length);
    this._gl = gl;
    this._location = location;
    this._target = target;
    this._buffer = buffer;
    this._detachedReason = detachedReason;
  }

  get _bytesWritten(): number {
    return this._target.bytesWritten;
  }

  set(): void {
    this._target.set(this.value);
  }
}

/** `UniformArraySampler`: texture-unit bookkeeping only — binding happens in the sampler bind group. */
class SamplerUniformArray implements SamplerUniformArraySetter {
  name: string;
  value: unknown[];
  readonly _locations: readonly unknown[];
  textureUnitIndex: number | undefined = undefined;
  readonly _gl: unknown;
  readonly #sink: UniformWriteSink | undefined;
  readonly #length: number;

  constructor(name: string, gl: unknown, locations: readonly unknown[], sink: UniformWriteSink | undefined, length: number) {
    this.name = name;
    this.value = new Array<unknown>(length);
    this._locations = locations;
    this._gl = gl;
    this.#sink = sink;
    this.#length = length;
  }

  set(): void {
    const sink = this.#sink;
    if (sink !== undefined && sink.writeSampler !== undefined) {
      sink.writeSampler(this.name, this.value);
      return;
    }
    return throwNotImplemented(`binding the sampler array "${this.name}" (${this.#length} element(s)) to its textures`, {
      backend: "webgpu",
      upstreamModule: UPSTREAM_MODULE,
      entryPoint: "UniformArraySampler#set",
      requirementRef: "FR-030",
      plannedPhase: "W4 (T075: Renderer/ShaderProgram assembles the texture/sampler bind group)",
      extra: { uniform: this.name, elements: this.#length, textureUnitIndex: this.textureUnitIndex ?? -1 },
    });
  }

  _setSampler(textureUnitIndex: number): number {
    this.textureUnitIndex = textureUnitIndex;
    return textureUnitIndex + this.#length;
  }
}
