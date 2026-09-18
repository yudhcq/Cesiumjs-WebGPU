/**
 * G-5 gate — **varying pairing derived from the real assembled GLSL** (tasks.md T023 (b);
 * contract R5 of `specs/001-webgpu-terrain-mvp/contracts/fork-patch-layer.md`).
 *
 * Why this is not a formality (measured, `experiments/shader-spike/REPORT.md` §4 E1): GLSL
 * matches varyings **by name** and the GL linker silently **prunes** ones the fragment stage does
 * not consume, so Cesium declares `out vec3 v_normalMC/v_normalEC` in `GlobeVS` and
 * `in vec3 v_normalMC/v_normalEC` in `GlobeFS` unconditionally while, for the
 * `ENABLE_DAYNIGHT_SHADING` configuration, the vertex stage never writes them. WGSL matches by
 * **`@location`** and a fragment input without a corresponding vertex output is a **hard
 * `CreateRenderPipeline` validation error**. The fork layer therefore MUST derive the varying set
 * **per variant** from what the vertex stage actually writes and the fragment stage actually reads.
 *
 * Two things make "actually writes" non-trivial, and both occur in the terrain path:
 *   1. declarations are conditional (`#if`-guarded) — the conditionals must be evaluated first
 *      (`glsl-preprocess.mjs`, contract R4);
 *   2. a varying can be written **through an `out`/`inout` function parameter** rather than by an
 *      assignment — `GroundAtmosphere.glsl`'s
 *      `computeAtmosphereScattering(vec3, vec3, out vec3, out vec3, out float)` writes
 *      `v_atmosphereRayleighColor` / `v_atmosphereMieColor` / `v_atmosphereOpacity` that way.
 *
 * Node-only, zero dependencies, cross-platform.
 */
import { preprocess } from "./glsl-preprocess.mjs";

const GLSL_TYPE_TO_WGSL = {
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

export function wgslTypeOf(glslType) {
  const wgsl = GLSL_TYPE_TO_WGSL[glslType];
  if (wgsl === undefined) throw new Error(`g5: no WGSL mapping for GLSL varying type "${glslType}"`);
  return wgsl;
}

/** GLSL ES 3.00 vertex-attribute locations from `Core/TerrainEncoding.js:650-656`. */
export const TERRAIN_ATTRIBUTE_LOCATIONS = {
  none: { position3DAndHeight: 0, textureCoordAndEncodedNormals: 1 },
  bits12: { compressed0: 0, compressed1: 1 },
};

const DECLARATION = /^\s*(?:(?:flat|smooth|noperspective|centroid|invariant|lowp|mediump|highp)\s+)*(in|out)\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*;\s*$/;
const ATTRIBUTE_DECLARATION = /^\s*(?:(?:lowp|mediump|highp)\s+)*in\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*;\s*$/;
const FUNCTION_DEFINITION = /(?:^|\n)\s*(?:void|float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|mat[234])\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/g;

/**
 * Function signatures with parameter qualifiers, so `out`/`inout` arguments can be recognised as
 * writes. Parsed from the *preprocessed* text (inactive definitions must not contribute).
 */
export function parseFunctionSignatures(text) {
  const signatures = new Map();
  FUNCTION_DEFINITION.lastIndex = 0;
  let match;
  while ((match = FUNCTION_DEFINITION.exec(text)) !== null) {
    const [, name, parameterList] = match;
    const parameters = parameterList
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const parts = entry.split(/\s+/);
        const qualifier = ["in", "out", "inout"].includes(parts[0]) ? parts.shift() : "in";
        return { qualifier, type: parts[0] ?? "", name: parts[1] ?? "" };
      });
    signatures.set(name, parameters);
  }
  return signatures;
}

/** Split the argument list of a call site at top-level commas. */
function splitArguments(text) {
  const args = [];
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

/** Find `name ( ... )` call sites, returning `{ name, arguments }` for every balanced paren group. */
function findCallSites(text) {
  const calls = [];
  const callStart = /\b([A-Za-z_]\w*)\s*\(/g;
  let match;
  while ((match = callStart.exec(text)) !== null) {
    const name = match[1];
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

/**
 * @param {string} source assembled GLSL for one stage
 * @param {string[]} defines
 * @returns {{ declares: Map<string,{name,type,declarationLine}>, assigns: Set<string>, reads: Set<string>,
 *             qualified: Set<string>, diagnostics: object[] }}
 */
export function analyseStage(source, defines) {
  const evaluated = preprocess(source, defines, { substituteText: false });
  const text = evaluated.text;
  const lines = text.split("\n");
  const active = evaluated.activeMask;
  const signatures = parseFunctionSignatures(text);

  const declares = new Map();
  const assigns = new Set();
  const reads = new Set();
  const qualified = new Set();

  lines.forEach((line, index) => {
    if (active[index] !== true) return;
    const declaration = DECLARATION.exec(line);
    if (declaration !== null) {
      // The declaration itself is not a read of the varying's value; active uses elsewhere are.
      declares.set(declaration[3], { name: declaration[3], qualifier: declaration[1], type: declaration[2], declarationLine: index + 1 });
      return;
    }
    for (const match of line.matchAll(/\b([A-Za-z_]\w*)\b/g)) reads.add(match[1]);
  });

  // Assignment writes (`x = …`, `x.y = …`, `x[0] = …`) — `==`/`<=`/`>=`/`!=` are excluded.
  const assignment = /\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\]|\.\w+)*\s*(?:[-+*/%&|^])?=(?!=)/g;
  lines.forEach((line, index) => {
    if (active[index] !== true || DECLARATION.test(line)) return;
    for (const match of line.matchAll(assignment)) assigns.add(match[1]);
  });

  // Writes through `out`/`inout` parameters.
  for (const call of findCallSites(text)) {
    const parameters = signatures.get(call.name);
    if (parameters === undefined) continue;
    parameters.forEach((parameter, position) => {
      if (parameter.qualifier !== "out" && parameter.qualifier !== "inout") return;
      const argument = call.arguments[position];
      if (argument === undefined) return;
      const identifier = /^([A-Za-z_]\w*)$/.exec(argument.trim());
      if (identifier === null) return;
      assigns.add(identifier[1]);
      qualified.add(`${call.name}#${position}`);
    });
  }

  return { declares, assigns, reads, qualified, diagnostics: evaluated.diagnostics, preprocessed: evaluated };
}

/**
 * Derive the per-variant varying set a WebGPU pipeline needs.
 *
 * @param {{ vertexSource: string, fragmentSource: string, defines: string[], attributeLocations?: object }} input
 */
export function deriveVaryingPairs({ vertexSource, fragmentSource, defines, attributeLocations = null }) {
  const vertex = analyseStage(vertexSource, defines);
  const fragment = analyseStage(fragmentSource, defines);

  const vsWrites = [...vertex.declares.values()].filter((entry) => entry.qualifier === "out" && vertex.assigns.has(entry.name));
  const vsDeclaredButUnwritten = [...vertex.declares.values()].filter((entry) => entry.qualifier === "out" && !vertex.assigns.has(entry.name)).map((entry) => entry.name);
  const fsInputs = [...fragment.declares.values()].filter((entry) => entry.qualifier === "in");
  const fsReads = fsInputs.filter((entry) => fragment.reads.has(entry.name));
  const fsDeclaredButUnread = fsInputs.filter((entry) => !fragment.reads.has(entry.name)).map((entry) => entry.name);

  const written = new Map(vsWrites.map((entry) => [entry.name, entry]));
  const paired = fsReads
    .filter((entry) => written.has(entry.name))
    .map((entry) => ({ name: entry.name, type: entry.type, wgslType: wgslTypeOf(entry.type), vsType: written.get(entry.name).type }));
  const typeMismatches = paired.filter((entry) => entry.type !== entry.vsType).map((entry) => ({ name: entry.name, vertex: entry.vsType, fragment: entry.type }));
  const unpairedFragmentInputs = fsReads.filter((entry) => !written.has(entry.name)).map((entry) => ({ name: entry.name, type: entry.type }));
  const vertexOnlyOutputs = vsWrites.filter((entry) => !fsReads.some((input) => input.name === entry.name)).map((entry) => entry.name);

  // Deterministic shared location table: the order in which the vertex stage declares them.
  const order = vsWrites.map((entry) => entry.name);
  const unpairedOrdered = unpairedFragmentInputs.map((entry) => entry.name).filter((name) => !order.includes(name));
  const locations = new Map([...order, ...unpairedOrdered].map((name, index) => [name, index]));

  const attributes = deriveVertexAttributes(vertex, defines, attributeLocations);

  return {
    defines: [...defines],
    vsWrites: vsWrites.map((entry) => ({ name: entry.name, type: entry.type, location: locations.get(entry.name) })),
    vsDeclaredButUnwritten,
    fsReads: fsReads.map((entry) => ({ name: entry.name, type: entry.type, location: locations.get(entry.name) })),
    fsDeclaredButUnread,
    paired: paired.map((entry) => ({ ...entry, location: locations.get(entry.name) })),
    typeMismatches,
    unpairedFragmentInputs: unpairedFragmentInputs.map((entry) => ({ ...entry, location: locations.get(entry.name) })),
    vertexOnlyOutputs,
    attributes,
    consistent: unpairedFragmentInputs.length === 0 && typeMismatches.length === 0,
    diagnostics: [...vertex.diagnostics, ...fragment.diagnostics],
  };
}

/** Vertex attributes actually consumed by the vertex stage, with their upstream locations. */
export function deriveVertexAttributes(vertexAnalysis, defines, attributeLocations) {
  const quantized = defines.some((define) => /^QUANTIZATION_BITS12\b/.test(define));
  const known = { ...(quantized ? TERRAIN_ATTRIBUTE_LOCATIONS.bits12 : TERRAIN_ATTRIBUTE_LOCATIONS.none), ...(attributeLocations ?? {}) };
  const declared = [...vertexAnalysis.declares.values()].filter((entry) => entry.qualifier === "in");
  let next = Math.max(-1, ...Object.values(known)) + 1;
  return declared.map((entry) => {
    const location = known[entry.name];
    if (location !== undefined) return { name: entry.name, type: entry.type, wgslType: wgslTypeOf(entry.type), location, source: "TerrainEncoding.getAttributeLocations()" };
    // `geodeticSurfaceNormal` is supplied by the tile provider; its location is not part of
    // `TerrainEncoding` — assigned deterministically after the known ones (recorded as a deviation).
    const assigned = next;
    next += 1;
    return { name: entry.name, type: entry.type, wgslType: wgslTypeOf(entry.type), location: assigned, source: "gate-assigned (not part of TerrainEncoding.getAttributeLocations())" };
  });
}

/** WGSL vertex formats for the GLSL attribute types of `TerrainEncoding`. */
const VERTEX_FORMAT_BY_GLSL = { float: "float32", vec2: "float32x2", vec3: "float32x3", vec4: "float32x4" };
const VERTEX_FORMAT_BY_GLSL_SIZE = { float32: 4, float32x2: 8, float32x3: 12, float32x4: 16 };

/** Byte offsets of the upstream interleaved terrain vertex buffer (`TerrainEncoding.js:650-656`). */
const TERRAIN_ATTRIBUTE_OFFSETS = {
  position3DAndHeight: 0,
  textureCoordAndEncodedNormals: 16,
  compressed0: 0,
  compressed1: 16,
};

/**
 * The `GPUVertexBufferLayout` the pipeline needs, derived from the vertex stage's active `in`
 * declarations plus the upstream `TerrainEncoding` offsets — so the pipeline is created with the
 * attribute layout the real terrain path uses, not with a shape invented by the harness.
 */
export function attributeLayoutFromDerivation(derivation, { stride = null } = {}) {
  let nextOffset = Math.max(0, ...derivation.attributes.map((attribute) => TERRAIN_ATTRIBUTE_OFFSETS[attribute.name]).filter((value) => value !== undefined)) + 16;
  const layout = derivation.attributes.map((attribute) => {
    const known = TERRAIN_ATTRIBUTE_OFFSETS[attribute.name];
    const format = VERTEX_FORMAT_BY_GLSL[attribute.type];
    if (format === undefined) throw new Error(`g5: no vertex format for attribute type "${attribute.type}"`);
    const offset = known ?? nextOffset;
    const size = VERTEX_FORMAT_BY_GLSL_SIZE[format];
    if (known === undefined) nextOffset += size;
    return { name: attribute.name, location: attribute.location, format, offset, size, source: attribute.source };
  });
  // The stride must cover every attribute (`offset + size <= arrayStride`). The upstream interleaved
  // terrain layout is 32 bytes (two vec4s); `geodeticSurfaceNormal` sits after them, so the stride
  // grows to 48 for that configuration — exactly what a real vertex buffer would look like.
  const required = Math.max(32, ...layout.map((attribute) => attribute.offset + attribute.size));
  const arrayStride = stride ?? Math.ceil(required / 4) * 4;
  return layout.map(({ size: _size, ...attribute }) => ({ ...attribute, stride: arrayStride }));
}

/** WGSL struct declarations for one derivation (`VSIn` / `VSOut` / `FSIn`). */
export function emitVaryingStructs(derivation, { vertexStruct = "VSIn", vertexOutputStruct = "VSOut", fragmentStruct = "FSIn", fragmentBuiltins = false } = {}) {
  const attributes = derivation.attributes.map((entry) => `  @location(${entry.location}) ${entry.name} : ${entry.wgslType},`);
  // The vertex output struct carries every fragment input that is paired, plus the builtin.
  const outputs = derivation.paired.map((entry) => `  @location(${entry.location}) ${entry.name} : ${entry.wgslType},`);
  const inputs = derivation.paired.map((entry) => `  @location(${entry.location}) ${entry.name} : ${entry.wgslType},`);
  // `gl_FragCoord` -> `@builtin(position)` and `gl_FrontFacing` -> `@builtin(front_facing)`
  // (spike REPORT §6.3). Both are needed by the terrain fragment stage (APPLY_SPLIT / the
  // ground-atmosphere and underground branches test the facing).
  const builtins = fragmentBuiltins ? ["  @builtin(position) position : vec4<f32>,", "  @builtin(front_facing) front_facing : bool,"] : [];
  return {
    vertexStruct: [`struct ${vertexStruct} {`, ...attributes, "}"].join("\n"),
    vertexOutputStruct: [`struct ${vertexOutputStruct} {`, "  @builtin(position) position : vec4<f32>,", ...outputs, "}"].join("\n"),
    fragmentStruct: [`struct ${fragmentStruct} {`, ...builtins, ...inputs, "}"].join("\n"),
  };
}

/**
 * The varying set an emitted WGSL module pair actually uses — read back from the generated text so
 * the claim "the emitted WGSL pairs up" is checked against the artefact, not against the intent.
 */
export function deriveVaryingPairsFromWgsl(vertexWgsl, fragmentWgsl, deriving = null) {
  const structBody = (text, name) => {
    const start = text.indexOf(`struct ${name} {`);
    if (start < 0) return null;
    const end = text.indexOf("}", start);
    const body = text.slice(start + `struct ${name} {`.length, end);
    const entries = [];
    for (const line of body.split("\n")) {
      const match = /^\s*@location\((\d+)\)\s+([A-Za-z_]\w*)\s*:\s*(.+?),\s*$/.exec(line);
      if (match !== null) entries.push({ location: Number(match[1]), name: match[2], wgslType: match[3] });
    }
    return entries;
  };
  const names = deriving?.structNames ?? { vertexOutput: "VSOut", fragmentInput: "FSIn" };
  const vertexOutputs = structBody(vertexWgsl, names.vertexOutput) ?? [];
  const fragmentInputs = structBody(fragmentWgsl, names.fragmentInput) ?? [];
  const written = new Set([...vertexWgsl.matchAll(/\bout\.([A-Za-z_]\w*)\s*=/g)].map((match) => match[1]));
  const read = new Set([...fragmentWgsl.matchAll(/\binput\.([A-Za-z_]\w*)\b/g)].map((match) => match[1]));
  const outputNames = new Set(vertexOutputs.map((entry) => entry.name));
  const inputNames = new Set(fragmentInputs.map((entry) => entry.name));
  return {
    vertexOutputs,
    fragmentInputs,
    vertexWritesDeclared: [...outputNames].filter((name) => written.has(name)),
    vertexDeclaresNeverWritten: [...outputNames].filter((name) => !written.has(name)),
    fragmentReadsDeclared: [...inputNames].filter((name) => read.has(name)),
    fragmentDeclaresNeverRead: [...inputNames].filter((name) => !read.has(name)),
    unpaired: [...inputNames].filter((name) => !outputNames.has(name)),
    locationMismatch: fragmentInputs
      .filter((input) => vertexOutputs.some((output) => output.name === input.name && output.location !== input.location))
      .map((input) => ({ name: input.name, fragmentLocation: input.location, vertexLocations: vertexOutputs.filter((output) => output.name === input.name).map((output) => output.location) })),
  };
}
