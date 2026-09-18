/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * **Varying pairing derived from the real assembled GLSL** (tasks.md **T072**, H-5; contract
 * fork-patch-layer §5 rule **R5**; verification contract §4 SH-2 / data-model §4.5
 * `VaryingContract`).
 *
 * Why this is not a formality (measured, `experiments/shader-spike/REPORT.md` §4 E1): GLSL matches
 * varyings **by name** and the GL linker silently **prunes** ones the fragment stage does not
 * consume, so Cesium declares `out vec3 v_normalMC/v_normalEC` in `GlobeVS` and
 * `in vec3 v_normalMC/v_normalEC` in `GlobeFS` unconditionally while, for the
 * `ENABLE_DAYNIGHT_SHADING` configuration, the vertex stage never writes them. WGSL matches by
 * **`@location`** and a fragment input without a corresponding vertex output is a **hard
 * `CreateRenderPipeline` validation error**:
 *
 *   `The fragment input at location 7 doesn't have a corresponding vertex output.`
 *
 * The fork layer therefore MUST derive the varying set **per variant** from what the vertex stage
 * actually writes and the fragment stage actually reads.
 *
 * Two things make "actually writes" non-trivial, and both occur in the terrain path:
 *   1. declarations are conditional (`#if`-guarded) — the conditionals must be evaluated first
 *      (`glsl-preprocess.ts`, contract R4);
 *   2. a varying can be written **through an `out`/`inout` function parameter** rather than by an
 *      assignment — `GroundAtmosphere.glsl`'s
 *      `computeAtmosphereScattering(vec3, vec3, out vec3, out vec3, out float)` writes
 *      `v_atmosphereRayleighColor` / `v_atmosphereMieColor` / `v_atmosphereOpacity` that way.
 *
 * Ported from the verified G-5 gate implementation
 * (`experiments/gates/g5-shader/varying-pairing.mjs`); the `VaryingContract` record and the
 * diff-report on mismatch are new.
 *
 * Zero dependencies, cross-platform, no `node:` import.
 */
import { preprocess } from "./glsl-preprocess.js";
import type { DefineList } from "./glsl-preprocess.js";

/** GLSL varying/attribute type → WGSL type. A missing mapping is an error, never a guess. */
const GLSL_TYPE_TO_WGSL: Readonly<Record<string, string>> = {
  float: "f32",
  int: "i32",
  uint: "u32",
  bool: "bool",
  vec2: "vec2<f32>",
  vec3: "vec3<f32>",
  vec4: "vec4<f32>",
  ivec2: "vec2<i32>",
  ivec3: "vec3<i32>",
  ivec4: "vec4<i32>",
  uvec2: "vec2<u32>",
  uvec3: "vec3<u32>",
  uvec4: "vec4<u32>",
};

export function wgslTypeOf(glslType: string): string {
  const wgsl = GLSL_TYPE_TO_WGSL[glslType];
  if (wgsl === undefined) throw new Error(`varying-contract: no WGSL mapping for GLSL type "${glslType}"`);
  return wgsl;
}

/** GLSL ES 3.00 vertex-attribute locations from `Core/TerrainEncoding.js:650-656`. */
export const TERRAIN_ATTRIBUTE_LOCATIONS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  none: { position3DAndHeight: 0, textureCoordAndEncodedNormals: 1 },
  bits12: { compressed0: 0, compressed1: 1 },
};

/** One declaration of a varying or attribute, as it appears in the assembled GLSL. */
export interface StageDeclaration {
  readonly name: string;
  readonly qualifier: string;
  readonly type: string;
  readonly declarationLine: number;
}

/** One entry of a `VaryingContract` (data-model §4.5). */
export interface VaryingRef {
  readonly name: string;
  readonly wgslLocation: number;
  readonly type: string;
  readonly wgslType: string;
}

/** One vertex attribute, with the location the real terrain path uses. */
export interface AttributeBinding {
  readonly name: string;
  readonly type: string;
  readonly wgslType: string;
  readonly location: number;
  /** Where the location came from — `TerrainEncoding` or a deterministic backend assignment. */
  readonly source: string;
}

/**
 * `VaryingContract` (data-model §4.5) — `vsOutputs` MUST match `fsInputs` item by item; a mismatch
 * is a hard failure with a difference report, never a silent narrowing.
 */
export interface VaryingContract {
  readonly variantKey: string;
  readonly varyingSet: readonly VaryingRef[];
  readonly vsOutputs: readonly VaryingRef[];
  readonly fsInputs: readonly VaryingRef[];
  /** `varyingSet.length > 0` and every fragment input has a vertex output of the same type. */
  readonly consistent: boolean;
  /** The difference report SH-2 requires when `consistent === false`. */
  readonly differences: VaryingDifferences;
  readonly attributes: readonly AttributeBinding[];
  /** How the pairing was obtained (own GLSL vs. a witness variant) — provenance, always recorded. */
  readonly source: string;
}

/** Everything the emitted `VSOut`/`FSIn` pair must not violate. */
export interface VaryingDifferences {
  /** Fragment inputs with no vertex output — the hard `CreateRenderPipeline` failure. */
  readonly unpairedFragmentInputs: readonly { readonly name: string; readonly type: string; readonly wgslLocation: number }[];
  /** Declared on both sides with different types. */
  readonly typeMismatches: readonly { readonly name: string; readonly vertex: string; readonly fragment: string }[];
  /** Vertex outputs declared but never written (the E1 trap: benign in GL, fatal in WGSL). */
  readonly declaredButNeverWritten: readonly string[];
  /** Fragment inputs declared but never read (harmless in WGSL, kept for the report). */
  readonly declaredButNeverRead: readonly string[];
  /** Vertex outputs nobody reads (dropped from the WSOut struct deliberately). */
  readonly vertexOnlyOutputs: readonly string[];
}

export interface StageAnalysis {
  readonly declares: ReadonlyMap<string, StageDeclaration>;
  readonly assigns: ReadonlySet<string>;
  readonly reads: ReadonlySet<string>;
  /** `fnName#position` for every varying written through an `out`/`inout` parameter. */
  readonly qualified: ReadonlySet<string>;
}

const DECLARATION = /^\s*(?:(?:flat|smooth|noperspective|centroid|invariant|lowp|mediump|highp)\s+)*(in|out)\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*;\s*$/;
const FUNCTION_DEFINITION = /(?:^|\n)\s*(?:void|float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|mat[234])\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/g;

/** Function signatures with parameter qualifiers, so `out`/`inout` arguments can be seen as writes. */
export function parseFunctionSignatures(text: string): Map<string, { qualifier: string; type: string; name: string }[]> {
  const signatures = new Map<string, { qualifier: string; type: string; name: string }[]>();
  FUNCTION_DEFINITION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FUNCTION_DEFINITION.exec(text)) !== null) {
    const name = match[1] ?? "";
    const parameters = (match[2] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const parts = entry.split(/\s+/);
        const qualifier = ["in", "out", "inout"].includes(parts[0] ?? "") ? (parts.shift() as string) : "in";
        return { qualifier, type: parts[0] ?? "", name: parts[1] ?? "" };
      });
    signatures.set(name, parameters);
  }
  return signatures;
}

/** Split the argument list of a call site at top-level commas. */
function splitArguments(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

/** Find `name ( … )` call sites, returning `{ name, arguments }` for every balanced paren group. */
function findCallSites(text: string): { name: string; arguments: string[] }[] {
  const calls: { name: string; arguments: string[] }[] = [];
  const callStart = /\b([A-Za-z_]\w*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callStart.exec(text)) !== null) {
    const name = match[1] ?? "";
    let index = callStart.lastIndex;
    let depth = 1;
    while (index < text.length && depth > 0) {
      if (text[index] === "(") depth += 1;
      else if (text[index] === ")") depth -= 1;
      index += 1;
    }
    if (depth !== 0) continue;
    calls.push({ name, arguments: splitArguments(text.slice(callStart.lastIndex, index - 1)) });
  }
  return calls;
}

/** Declaration/assignment/read analysis of one assembled stage for one define set. */
export function analyseStage(source: string, defines: DefineList): StageAnalysis {
  const evaluated = preprocess(source, defines, { substituteText: false });
  const lines = evaluated.text.split("\n");
  const active = evaluated.activeMask;
  const signatures = parseFunctionSignatures(evaluated.text);

  const declares = new Map<string, StageDeclaration>();
  const assigns = new Set<string>();
  const reads = new Set<string>();
  const qualified = new Set<string>();

  lines.forEach((line, index) => {
    if (active[index] !== true) return;
    const declaration = DECLARATION.exec(line);
    if (declaration !== null) {
      // The declaration itself is not a read of the varying's value; active uses elsewhere are.
      const name = declaration[3] ?? "";
      declares.set(name, { name, qualifier: declaration[1] ?? "", type: declaration[2] ?? "", declarationLine: index + 1 });
      return;
    }
    for (const match of line.matchAll(/\b([A-Za-z_]\w*)\b/g)) reads.add(match[1] ?? "");
  });

  // Assignment writes (`x = …`, `x.y = …`, `x[0] = …`) — `==`/`<=`/`>=`/`!=` are excluded.
  const assignment = /\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\]|\.\w+)*\s*(?:[-+*/%&|^])?=(?!=)/g;
  lines.forEach((line, index) => {
    if (active[index] !== true || DECLARATION.test(line)) return;
    for (const match of line.matchAll(assignment)) assigns.add(match[1] ?? "");
  });

  // Writes through `out`/`inout` parameters.
  for (const call of findCallSites(evaluated.text)) {
    const parameters = signatures.get(call.name);
    if (parameters === undefined) continue;
    parameters.forEach((parameter, position) => {
      if (parameter.qualifier !== "out" && parameter.qualifier !== "inout") return;
      const argument = call.arguments[position];
      if (argument === undefined) return;
      const identifier = /^([A-Za-z_]\w*)$/.exec(argument.trim());
      if (identifier === null) return;
      assigns.add(identifier[1] ?? "");
      qualified.add(`${call.name}#${position}`);
    });
  }

  return { declares, assigns, reads, qualified };
}

/**
 * Derive the per-variant `VaryingContract` a WebGPU pipeline needs (T072, R5, SH-2).
 *
 * The locations are assigned in the order the **vertex stage declares** the written varyings, plus
 * any unpaired fragment input after them — a deterministic table that both emitted stages share.
 */
export function deriveVaryingContract({ vertexSource, fragmentSource, defines, variantKey = "unspecified", attributeLocations = null, source = "this variant's own assembled GLSL" }: { vertexSource: string; fragmentSource: string; defines: DefineList; variantKey?: string; attributeLocations?: Readonly<Record<string, number>> | null; source?: string }): VaryingContract {
  const vertex = analyseStage(vertexSource, defines);
  const fragment = analyseStage(fragmentSource, defines);

  const vsWrites = [...vertex.declares.values()].filter((entry) => entry.qualifier === "out" && vertex.assigns.has(entry.name));
  const vsDeclaredButUnwritten = [...vertex.declares.values()].filter((entry) => entry.qualifier === "out" && !vertex.assigns.has(entry.name)).map((entry) => entry.name);
  const fsInputs = [...fragment.declares.values()].filter((entry) => entry.qualifier === "in");
  const fsReads = fsInputs.filter((entry) => fragment.reads.has(entry.name));
  const fsDeclaredButUnread = fsInputs.filter((entry) => !fragment.reads.has(entry.name)).map((entry) => entry.name);

  const written = new Map(vsWrites.map((entry) => [entry.name, entry]));
  const paired = fsReads.filter((entry) => written.has(entry.name));
  const typeMismatches = paired.filter((entry) => entry.type !== written.get(entry.name)?.type).map((entry) => ({ name: entry.name, vertex: written.get(entry.name)?.type ?? "", fragment: entry.type }));
  const unpairedFragmentInputs = fsReads.filter((entry) => !written.has(entry.name));
  const vertexOnlyOutputs = vsWrites.filter((entry) => !fsReads.some((input) => input.name === entry.name)).map((entry) => entry.name);

  // Deterministic shared location table: the order in which the vertex stage declares them.
  const order = vsWrites.map((entry) => entry.name);
  const unpairedOrdered = unpairedFragmentInputs.map((entry) => entry.name).filter((name) => !order.includes(name));
  const locations = new Map<string, number>([...order, ...unpairedOrdered].map((name, index) => [name, index]));
  const locationOf = (name: string): number => locations.get(name) ?? 0;

  const toRef = (entry: StageDeclaration): VaryingRef => ({ name: entry.name, wgslLocation: locationOf(entry.name), type: entry.type, wgslType: wgslTypeOf(entry.type) });
  const varyingSet = paired.map(toRef);

  const attributes = deriveVertexAttributes(vertex, defines, attributeLocations);

  return {
    variantKey,
    varyingSet,
    vsOutputs: varyingSet,
    fsInputs: fsInputs.map(toRef),
    consistent: unpairedFragmentInputs.length === 0 && typeMismatches.length === 0,
    differences: {
      unpairedFragmentInputs: unpairedFragmentInputs.map((entry) => ({ name: entry.name, type: entry.type, wgslLocation: locationOf(entry.name) })),
      typeMismatches,
      declaredButNeverWritten: vsDeclaredButUnwritten,
      declaredButNeverRead: fsDeclaredButUnread,
      vertexOnlyOutputs,
    },
    attributes,
    source,
  };
}

/** Vertex attributes actually consumed by the vertex stage, with their upstream locations. */
export function deriveVertexAttributes(vertex: StageAnalysis, defines: DefineList, attributeLocations: Readonly<Record<string, number>> | null): AttributeBinding[] {
  const quantized = defines.some((define) => /^QUANTIZATION_BITS12\b/.test(define));
  const base = quantized ? TERRAIN_ATTRIBUTE_LOCATIONS.bits12 : TERRAIN_ATTRIBUTE_LOCATIONS.none;
  const known: Record<string, number> = { ...(base ?? {}), ...(attributeLocations ?? {}) };
  const declared = [...vertex.declares.values()].filter((entry) => entry.qualifier === "in");
  let next = Math.max(-1, ...Object.values(known)) + 1;
  return declared.map((entry) => {
    const location = known[entry.name];
    if (location !== undefined) return { name: entry.name, type: entry.type, wgslType: wgslTypeOf(entry.type), location, source: "TerrainEncoding.getAttributeLocations()" };
    // `geodeticSurfaceNormal` is supplied by the tile provider; its location is not part of
    // `TerrainEncoding` — assigned deterministically after the known ones (recorded as a deviation).
    const assigned = next;
    next += 1;
    return { name: entry.name, type: entry.type, wgslType: wgslTypeOf(entry.type), location: assigned, source: "backend-assigned (not part of TerrainEncoding.getAttributeLocations())" };
  });
}

/** WGSL vertex formats for the GLSL attribute types of `TerrainEncoding`. */
const VERTEX_FORMAT_BY_GLSL: Readonly<Record<string, string>> = { float: "float32", vec2: "float32x2", vec3: "float32x3", vec4: "float32x4" };
const VERTEX_FORMAT_SIZE: Readonly<Record<string, number>> = { float32: 4, float32x2: 8, float32x3: 12, float32x4: 16 };

/** Byte offsets of the upstream interleaved terrain vertex buffer (`TerrainEncoding.js:650-656`). */
const TERRAIN_ATTRIBUTE_OFFSETS: Readonly<Record<string, number>> = {
  position3DAndHeight: 0,
  textureCoordAndEncodedNormals: 16,
  compressed0: 0,
  compressed1: 16,
};

/** One attribute of the `GPUVertexBufferLayout` the pipeline is created with. */
export interface VertexBufferAttribute {
  readonly name: string;
  readonly location: number;
  readonly format: string;
  readonly offset: number;
  readonly arrayStride: number;
  readonly source: string;
}

/**
 * The `GPUVertexBufferLayout` derived from the vertex stage's active `in` declarations plus the
 * upstream `TerrainEncoding` offsets — so the pipeline is created with the attribute layout the real
 * terrain path uses, not with a shape invented by the harness.
 */
export function attributeLayoutFromContract(contract: VaryingContract, stride: number | null = null): VertexBufferAttribute[] {
  let nextOffset = Math.max(0, ...contract.attributes.map((attribute) => TERRAIN_ATTRIBUTE_OFFSETS[attribute.name]).filter((value): value is number => value !== undefined)) + 16;
  const withOffsets = contract.attributes.map((attribute) => {
    const known = TERRAIN_ATTRIBUTE_OFFSETS[attribute.name];
    const format = VERTEX_FORMAT_BY_GLSL[attribute.type];
    if (format === undefined) throw new Error(`varying-contract: no vertex format for attribute type "${attribute.type}"`);
    const offset = known ?? nextOffset;
    const size = VERTEX_FORMAT_SIZE[format] ?? 0;
    if (known === undefined) nextOffset += size;
    return { name: attribute.name, location: attribute.location, format, offset, size, source: attribute.source };
  });
  // The stride must cover every attribute (`offset + size <= arrayStride`). The upstream interleaved
  // terrain layout is 32 bytes (two vec4s); `geodeticSurfaceNormal` sits after them, so the stride
  // grows to 48 for that configuration — exactly what a real vertex buffer looks like.
  const required = Math.max(32, ...withOffsets.map((attribute) => attribute.offset + attribute.size));
  const arrayStride = stride ?? Math.ceil(required / 4) * 4;
  return withOffsets.map(({ size: _size, ...attribute }) => ({ ...attribute, arrayStride }));
}

/** WGSL struct declarations for one contract (`VSIn` / `VSOut` / `FSIn`). */
export function emitVaryingStructs(contract: VaryingContract, options: { vertexStruct?: string; vertexOutputStruct?: string; fragmentStruct?: string; fragmentBuiltins?: boolean } = {}): { vertexStruct: string; vertexOutputStruct: string; fragmentStruct: string } {
  const vertexStruct = options.vertexStruct ?? "VSIn";
  const vertexOutputStruct = options.vertexOutputStruct ?? "VSOut";
  const fragmentStruct = options.fragmentStruct ?? "FSIn";
  const attributes = contract.attributes.map((entry) => `  @location(${entry.location}) ${entry.name} : ${entry.wgslType},`);
  const outputs = contract.varyingSet.map((entry) => `  @location(${entry.wgslLocation}) ${entry.name} : ${entry.wgslType},`);
  const inputs = contract.varyingSet.map((entry) => `  @location(${entry.wgslLocation}) ${entry.name} : ${entry.wgslType},`);
  // `gl_FragCoord` -> `@builtin(position)` and `gl_FrontFacing` -> `@builtin(front_facing)`
  // (spike REPORT §6.3). Both are needed by the terrain fragment stage.
  const builtins = options.fragmentBuiltins === true ? ["  @builtin(position) position : vec4<f32>,",  "  @builtin(front_facing) front_facing : bool,"] : [];
  return {
    vertexStruct: [`struct ${vertexStruct} {`, ...attributes, "}"].join("\n"),
    vertexOutputStruct: [`struct ${vertexOutputStruct} {`, "  @builtin(position) position : vec4<f32>,", ...outputs, "}"].join("\n"),
    fragmentStruct: [`struct ${fragmentStruct} {`, ...builtins, ...inputs, "}"].join("\n"),
  };
}

/** What the emitted WGSL text actually pairs up — read back from the artefact, not from intent. */
export interface EmittedVaryingCheck {
  readonly vertexOutputs: readonly { readonly location: number; readonly name: string; readonly wgslType: string }[];
  readonly fragmentInputs: readonly { readonly location: number; readonly name: string; readonly wgslType: string }[];
  readonly vertexDeclaresNeverWritten: readonly string[];
  readonly fragmentReadsDeclared: readonly string[];
  readonly fragmentDeclaresNeverRead: readonly string[];
  readonly unpaired: readonly string[];
  readonly locationMismatch: readonly { readonly name: string; readonly fragmentLocation: number; readonly vertexLocations: readonly number[] }[];
}

/**
 * Re-derive the pairing **from the generated text**, so "the emitted WGSL pairs up" is checked
 * against the artefact rather than against the derivation that produced it (SH-2).
 */
export function varyingContractFromWgsl(vertexWgsl: string, fragmentWgsl: string, structNames: { vertexOutput?: string; fragmentInput?: string } = {}): EmittedVaryingCheck {
  const structBody = (text: string, name: string): { location: number; name: string; wgslType: string }[] => {
    const start = text.indexOf(`struct ${name} {`);
    if (start < 0) return [];
    const end = text.indexOf("}", start);
    const body = text.slice(start + `struct ${name} {`.length, end);
    const entries: { location: number; name: string; wgslType: string }[] = [];
    for (const line of body.split("\n")) {
      const match = /^\s*@location\((\d+)\)\s+([A-Za-z_]\w*)\s*:\s*(.+?),\s*$/.exec(line);
      if (match !== null) entries.push({ location: Number(match[1]), name: match[2] ?? "", wgslType: match[3] ?? "" });
    }
    return entries;
  };
  const vertexOutput = structNames.vertexOutput ?? "VSOut";
  const fragmentInput = structNames.fragmentInput ?? "FSIn";
  const vertexOutputs = structBody(vertexWgsl, vertexOutput);
  const fragmentInputs = structBody(fragmentWgsl, fragmentInput);
  const written = new Set([...vertexWgsl.matchAll(/\bout\.([A-Za-z_]\w*)\s*=/g)].map((match) => match[1] ?? ""));
  const read = new Set([...fragmentWgsl.matchAll(/\binput\.([A-Za-z_]\w*)\b/g)].map((match) => match[1] ?? ""));
  const outputNames = new Set(vertexOutputs.map((entry) => entry.name));
  const inputNames = new Set(fragmentInputs.map((entry) => entry.name));
  return {
    vertexOutputs,
    fragmentInputs,
    vertexDeclaresNeverWritten: [...outputNames].filter((name) => !written.has(name)),
    fragmentReadsDeclared: [...inputNames].filter((name) => read.has(name)),
    fragmentDeclaresNeverRead: [...inputNames].filter((name) => !read.has(name)),
    unpaired: [...inputNames].filter((name) => !outputNames.has(name)),
    locationMismatch: fragmentInputs
      .filter((input) => vertexOutputs.some((output) => output.name === input.name && output.location !== input.location))
      .map((input) => ({ name: input.name, fragmentLocation: input.location, vertexLocations: vertexOutputs.filter((output) => output.name === input.name).map((output) => output.location) })),
  };
}

/**
 * The SH-2 verdict for one emitted pair: `{ ok, checks }`. A non-`ok` verdict carries the
 * difference report rather than a bare boolean.
 */
export function assertVaryingContract(vertexWgsl: string, fragmentWgsl: string): { ok: boolean; checks: EmittedVaryingCheck; failures: string[] } {
  const checks = varyingContractFromWgsl(vertexWgsl, fragmentWgsl);
  const failures: string[] = [];
  if (checks.unpaired.length > 0) failures.push(`fragment input(s) without a vertex output: ${checks.unpaired.join(", ")}`);
  if (checks.locationMismatch.length > 0) failures.push(`location mismatch: ${JSON.stringify(checks.locationMismatch)}`);
  if (checks.vertexDeclaresNeverWritten.length > 0) failures.push(`vertex output(s) never written: ${checks.vertexDeclaresNeverWritten.join(", ")}`);
  return { ok: failures.length === 0, checks, failures };
}
