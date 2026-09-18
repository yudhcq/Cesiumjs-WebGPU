/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * **Bind-group layout + WGSL uniform `struct` generator** (tasks.md **T077**, H-4; research §5.4;
 * data-model §4.3 `UniformBlockLayout` / `BindingPlan`).
 *
 * Given the uniform declarations the **real assembled terrain GLSL** actually references, this
 * module produces
 *
 *   - a WGSL `struct` (uniform address space) and the matching `@group(0)` bindings, and
 *   - a CPU-side layout table with, per field, `byteOffset` / `byteSize` / `align` / `arrayStride` /
 *     `columnStride` and the scalar decomposition needed to write it,
 *
 * implementing the WGSL uniform-address-space rules that research §5.4 flags as the H-4 risk:
 * `vec3` aligns to 16 bytes (size 12), a `mat3` is three **16-byte-padded columns** (size 48), and
 * `bool`/`bvec*` **cannot be a uniform member** (mapped to `u32`/`vecN<u32>` — GLSL
 * `uniform bool u_dayTextureUseWebMercatorT[TEXTURE_UNITS]` is real).
 *
 * **Conservative array layout (decision R-1, plan Complexity Tracking).** `StrideOf(array<E,N>)` is
 * not address-space dependent, so an `array<f32,N>` always has stride 4 — but the uniform address
 * space *requires* the element stride to be a multiple of 16 (`RequiredAlignOf(array<T,N>, uniform) =
 * roundUp(16, AlignOf(T))`). WGSL has no stride attribute, so the only conforming declaration changes
 * the element type; this generator widens to `vec4<T>` (align 16, size 16), the specification's own
 * remedy. **Only the first `components` lanes are meaningful**; the rest is padding the CPU-side
 * writer never touches. The alternative — keeping the compact 4-byte layout because Chrome 153/Tint
 * tolerates it — was what the first G-4 run did, and it is invalid on any implementation that does not
 * announce the `uniform_buffer_standard_layout` language extension. Correctness MUST NOT depend on the
 * implementation being lenient.
 *
 * Samplers are not struct members at all: a GLSL `sampler2D x[N]` becomes N texture+sampler pairs and
 * lives in an **independent bind group** (data-model §4.3) so that a change in the texture set does
 * not invalidate the uniform block.
 *
 * Ported from the verified G-4 gate implementation
 * (`experiments/gates/g4-uniform-layout/uniform-layout.mjs` + `assemble-glsl.mjs`).
 *
 * Zero dependencies, cross-platform, no `node:` import.
 */
import { activeLines, preprocess } from "./glsl-preprocess.js";
import type { DefineList } from "./glsl-preprocess.js";

// ------------------------------------------------------------------------------------------------
// GLSL type tables
// ------------------------------------------------------------------------------------------------

const SCALAR_BY_GLSL: Readonly<Record<string, string>> = {
  float: "f32",
  int: "i32",
  bool: "u32", // bool is not host-shareable in the uniform address space
};

const VECTOR_BY_GLSL: Readonly<Record<string, { scalar: string; components: number }>> = {
  vec2: { scalar: "f32", components: 2 },
  vec3: { scalar: "f32", components: 3 },
  vec4: { scalar: "f32", components: 4 },
  ivec2: { scalar: "i32", components: 2 },
  ivec3: { scalar: "i32", components: 3 },
  ivec4: { scalar: "i32", components: 4 },
  bvec2: { scalar: "u32", components: 2 },
  bvec3: { scalar: "u32", components: 3 },
  bvec4: { scalar: "u32", components: 4 },
};

const MATRIX_BY_GLSL: Readonly<Record<string, { columns: number; rows: number }>> = {
  mat2: { columns: 2, rows: 2 },
  mat3: { columns: 3, rows: 3 },
  mat4: { columns: 4, rows: 4 },
};

const SAMPLER_BY_GLSL: Readonly<Record<string, { texture: string; label: string }>> = {
  sampler2D: { texture: "texture_2d<f32>", label: "2d" },
  samplerCube: { texture: "texture_cube<f32>", label: "cube" },
  sampler2DArray: { texture: "texture_2d_array<f32>", label: "2d-array" },
  sampler3D: { texture: "texture_3d<f32>", label: "3d" },
};

const PADDED_ELEMENT_WGSL: Readonly<Record<string, string>> = {
  f32: "vec4<f32>",
  i32: "vec4<i32>",
  u32: "vec4<u32>",
  "vec2<f32>": "vec4<f32>",
  "vec2<i32>": "vec4<i32>",
  "vec2<u32>": "vec4<u32>",
};

export const roundUp = (value: number, multiple: number): number => Math.ceil(value / multiple) * multiple;

/** Type information for one GLSL uniform type. An unknown type is an error, never a guess. */
export interface UniformTypeInfo {
  readonly kind: "scalar" | "vector" | "matrix" | "sampler";
  readonly scalar: string;
  readonly components: number;
  readonly columns: number;
  readonly wgsl: string;
  readonly glsl: string;
  readonly texture?: string;
  readonly label?: string;
}

export function typeInfo(glslType: string): UniformTypeInfo {
  const scalar = SCALAR_BY_GLSL[glslType];
  if (scalar !== undefined) return { kind: "scalar", scalar, components: 1, columns: 1, wgsl: scalar, glsl: glslType };
  const vector = VECTOR_BY_GLSL[glslType];
  if (vector !== undefined) return { kind: "vector", scalar: vector.scalar, components: vector.components, columns: 1, wgsl: `vec${vector.components}<${vector.scalar}>`, glsl: glslType };
  const matrix = MATRIX_BY_GLSL[glslType];
  if (matrix !== undefined) return { kind: "matrix", scalar: "f32", components: matrix.rows, columns: matrix.columns, wgsl: `mat${matrix.columns}x${matrix.rows}<f32>`, glsl: glslType };
  const sampler = SAMPLER_BY_GLSL[glslType];
  if (sampler !== undefined) return { kind: "sampler", scalar: "f32", components: 1, columns: 1, wgsl: "sampler", glsl: glslType, texture: sampler.texture, label: sampler.label };
  throw new Error(`bind-layout: unsupported GLSL uniform type "${glslType}"`);
}

/** Alignment/size of one value in the WGSL uniform address space (research §5.4 H-4). */
export function shapeOf(info: UniformTypeInfo): { align: number; size: number; columnStride?: number } {
  if (info.kind === "scalar") return { align: 4, size: 4 };
  if (info.kind === "vector") {
    // WGSL AlignOf: vec2<f32> = 8, vec3<f32> = 16 (size stays 12), vecN<f32> = 4N.
    const align = info.components === 2 ? 8 : Math.max(16, info.components * 4);
    return { align, size: info.components * 4 };
  }
  // matrix: column stride is roundUp(16, alignOf(vecRows)) — uniform address space
  const columnStride = roundUp(info.components === 2 ? 8 : info.components * 4, 16);
  return { align: 16, size: info.columns * columnStride, columnStride };
}

// ------------------------------------------------------------------------------------------------
// uniform collection from the assembled GLSL
// ------------------------------------------------------------------------------------------------

/** One uniform declaration found in the assembled GLSL. */
export interface UniformDeclaration {
  readonly name: string;
  readonly glslType: string;
  readonly size: number;
  readonly declaration: string;
  readonly origin: "automatic" | "shader";
}

const DECLARATION = /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[\s*([A-Za-z_0-9\s+*/-]+?)\s*\])?\s*;/;

/** Which uniform names the backend treats as Cesium automatic uniforms (`Renderer/AutomaticUniforms.js`). */
export type AutomaticUniformNames = ReadonlySet<string>;

function arraySize(expression: string | undefined, defines: DefineList): number {
  if (expression === undefined) return 1;
  const trimmed = expression.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const evaluated = preprocess(`#if ${trimmed}\n#endif`, defines);
  void evaluated;
  const macros = new Map<string, string>();
  for (const define of defines) {
    const text = String(define).trim();
    if (text.length === 0) continue;
    const space = text.search(/\s/);
    if (space < 0) macros.set(text, "");
    else macros.set(text.slice(0, space), text.slice(space + 1).trim());
  }
  const substituted = trimmed.replace(/\b([A-Za-z_]\w*)\b/g, (all, name: string) => {
    const value = macros.get(name);
    return value === undefined || value.length === 0 ? all : value;
  });
  const value = Number(substituted);
  return Number.isFinite(value) ? value : 0;
}

/**
 * The uniforms one assembled stage actually declares, with its conditionals evaluated — the set the
 * GL driver would receive declarations for.
 */
export function collectDeclaredUniforms(source: string, defines: DefineList, automaticUniforms: AutomaticUniformNames = new Set<string>()): Map<string, UniformDeclaration> {
  const active = activeLines(source, defines);
  const lines = source.split("\n");
  const found = new Map<string, UniformDeclaration>();
  lines.forEach((line, index) => {
    if (active[index] !== true) return;
    const match = DECLARATION.exec(line);
    if (match === null) return;
    const glslType = match[1] ?? "";
    const name = match[2] ?? "";
    found.set(name, { name, glslType, size: arraySize(match[3], defines), declaration: line.trim(), origin: automaticUniforms.has(name) ? "automatic" : "shader" });
  });
  return found;
}

/** Identifiers the *active* code references (used to check that a declared uniform is really used). */
export function collectReferencedIdentifiers(source: string, defines: DefineList): Set<string> {
  const active = activeLines(source, defines);
  const lines = source.split("\n");
  const referenced = new Set<string>();
  lines.forEach((line, index) => {
    if (active[index] !== true) return;
    for (const match of line.matchAll(/\b([A-Za-z_]\w*)\b/g)) referenced.add(match[1] ?? "");
  });
  return referenced;
}

// ------------------------------------------------------------------------------------------------
// the layout table
// ------------------------------------------------------------------------------------------------

/** `data-model §4.3 UniformBlockLayout.fields[i]`. */
export interface UniformField {
  readonly name: string;
  readonly kind: "scalar" | "vector" | "matrix";
  readonly glslType: string;
  readonly wgslType: string;
  readonly elementWgslType: string;
  readonly paddedElement: boolean;
  readonly scalar: string;
  readonly components: number;
  readonly columns: number;
  readonly length: number;
  readonly arrayStride: number | null;
  readonly columnStride: number | null;
  readonly align: number;
  readonly byteOffset: number;
  readonly byteSize: number;
  readonly scalarOffsets: readonly number[];
}

/** `data-model §4.3 BindingPlan.groups[i].entries[j]`. */
export interface BindingPlanEntry {
  readonly binding: number;
  readonly kind: "uniform" | "texture" | "sampler" | "storage";
  readonly name: string;
  readonly slot: number;
}

export interface BindingPlanGroup {
  readonly groupIndex: number;
  readonly entries: readonly BindingPlanEntry[];
}

/** `data-model §4.3 BindingPlan`. */
export interface BindingPlan {
  readonly groups: readonly BindingPlanGroup[];
  readonly textureCount: number;
  readonly samplerCount: number;
}

/** One texture+sampler pair the layout declares (a GLSL `sampler2D x[N]` becomes N pairs). */
export interface SamplerBinding {
  readonly name: string;
  readonly glslName: string;
  readonly element: number;
  readonly glslType: string;
  readonly textureType: string;
  readonly textureBinding: number;
  readonly samplerBinding: number;
  /** Which bind group the pair lives in: textures/samplers get their own (data-model §4.3). */
  readonly groupIndex: number;
}

/** `data-model §4.3 UniformBlockLayout`. */
export interface UniformBlockLayout {
  readonly uniformNames: readonly string[];
  readonly fields: readonly UniformField[];
  readonly blockSize: number;
  readonly wgslStruct: string;
}

export interface LayoutUniformInput {
  readonly name: string;
  readonly glslType: string;
  readonly size?: number;
}

export interface BindLayoutResult {
  readonly structName: string;
  readonly uniformBlock: UniformBlockLayout;
  readonly bindingPlan: BindingPlan;
  readonly samplers: readonly SamplerBinding[];
  readonly notes: readonly string[];
  readonly padding: readonly { readonly after: string; readonly before: string; readonly bytes: number }[];
  readonly structAlign: number;
  readonly structSize: number;
  readonly bindingCount: number;
  /** The WGSL `@group(g) @binding(b)` declarations for the uniform block and every sampler pair. */
  readonly wgslBindings: string;
  /** `data-model §4.3` validation: entries ≤ `maxBindingsPerBindGroup`. */
  readonly maxBindingsPerGroup: number;
  /**
   * The WGSL `struct` declaration — the same text as `uniformBlock.wgslStruct`, exposed at the top
   * level because the emitter assembles the module from it directly (and because the pre-W4 gate
   * shape the harness/artefacts were built around had it there).
   */
  readonly wgslStruct: string;
  /** Convenience accessor used by the emitter to render padded array reads. */
  readonly members: readonly UniformField[];
}

/** The texture/sampler bind group index (independent from the uniform block, data-model §4.3). */
export const SAMPLER_GROUP_INDEX = 1;

/**
 * Generate the layout for a list of uniform declarations (the G-4 generator).
 */
export function layoutUniforms(uniforms: readonly LayoutUniformInput[], options: { structName?: string; samplerGroupIndex?: number } = {}): BindLayoutResult {
  const structName = options.structName ?? "TerrainUniforms";
  const samplerGroup = options.samplerGroupIndex ?? SAMPLER_GROUP_INDEX;
  const fields: UniformField[] = [];
  const samplers: SamplerBinding[] = [];
  const notes: string[] = [];
  let offset = 0;
  let maxAlign = 16;
  let binding = 1; // @binding(0) of group 0 is the uniform buffer itself

  for (const uniform of uniforms) {
    const info = typeInfo(uniform.glslType);
    const size = uniform.size ?? 1;
    if (info.kind === "sampler") {
      // Samplers cannot be struct members; a GLSL `sampler2D x[N]` becomes N texture+sampler pairs
      // (fixed-size arrays of textures would need `binding_array`, which is not core-guaranteed yet).
      const before = samplers.length;
      for (let element = 0; element < size; element += 1) {
        const suffix = size > 1 ? `_${element}` : "";
        const textureBinding = binding;
        const samplerBinding = binding + 1;
        binding += 2;
        samplers.push({
          name: `${uniform.name}${suffix}`,
          glslName: uniform.name,
          element,
          glslType: uniform.glslType,
          textureType: info.texture ?? "texture_2d<f32>",
          textureBinding,
          samplerBinding,
          groupIndex: samplerGroup,
        });
      }
      notes.push(`${uniform.name}: ${uniform.glslType}${size > 1 ? `[${size}]` : ""} → ${samplers.length - before} texture/sampler binding pair(s) (must not live in the uniform struct; group ${samplerGroup})`);
      continue;
    }

    const shape = shapeOf(info);
    // Array layout. WGSL derives the element stride from the element type and offers no attribute to
    // change it, so a **conforming** uniform array MUST have an element type whose align and size are
    // already multiples of 16 → packed element types (scalars, `vec2`) are widened to `vec4<T>`.
    const paddedElement = size > 1 && shape.align < 16;
    const elementWgslType = paddedElement ? (PADDED_ELEMENT_WGSL[info.wgsl] ?? "") : info.wgsl;
    if (paddedElement && elementWgslType.length === 0) throw new Error(`bind-layout: no 16-byte widening registered for array element type "${info.wgsl}"`);
    const arrayStride = size > 1 ? (paddedElement ? 16 : roundUp(shape.size, shape.align)) : null;
    const align = paddedElement ? 16 : shape.align;
    offset = roundUp(offset, align);
    const byteSize = size > 1 ? size * (arrayStride ?? 0) : shape.size;
    fields.push({
      name: uniform.name,
      kind: info.kind,
      glslType: uniform.glslType,
      wgslType: size > 1 ? `array<${elementWgslType}, ${size}>` : info.wgsl,
      elementWgslType,
      paddedElement,
      scalar: info.scalar,
      components: info.components,
      columns: info.columns,
      length: size,
      arrayStride,
      columnStride: shape.columnStride ?? null,
      align,
      byteOffset: offset,
      byteSize,
      scalarOffsets: scalarOffsets(offset, size, arrayStride, shape, info),
    });
    if (info.kind === "matrix") notes.push(`${uniform.name}: mat3/mat4 columns are 16-byte padded (columnStride=${shape.columnStride ?? 0})`);
    if (size > 1) {
      notes.push(
        paddedElement
          ? `${uniform.name}: array<${info.wgsl}, ${size}> → array<${elementWgslType}, ${size}> (element stride 16, required by the uniform address space; only lane .x${info.components > 1 ? "/.xy" : ""} is meaningful)`
          : `${uniform.name}: array<${info.wgsl}, ${size}> element stride = roundUp(SizeOf, AlignOf) = ${arrayStride ?? 0} bytes (already a multiple of 16)`,
      );
    }
    if (info.components === 3) notes.push(`${uniform.name}: vec3 occupies 12 bytes but is aligned to 16 (uniform address space)`);
    if (uniform.glslType.startsWith("bvec") || uniform.glslType === "bool") notes.push(`${uniform.name}: GLSL ${uniform.glslType} → WGSL ${info.wgsl} (bool is not host-shareable in the uniform address space)`);
    offset += byteSize;
    maxAlign = Math.max(maxAlign, align);
  }

  const structAlign = roundUp(16, maxAlign);
  const structSize = roundUp(offset, structAlign);
  const padding: { after: string; before: string; bytes: number }[] = [];
  for (let index = 1; index < fields.length; index += 1) {
    const previous = fields[index - 1];
    const current = fields[index];
    if (previous === undefined || current === undefined) continue;
    const gap = current.byteOffset - (previous.byteOffset + previous.byteSize);
    if (gap > 0) padding.push({ after: previous.name, before: current.name, bytes: gap });
  }
  const last = fields[fields.length - 1];
  const tail = structSize - (last === undefined ? 0 : last.byteOffset + last.byteSize);
  if (tail > 0 && last !== undefined) padding.push({ after: last.name, before: "<struct end>", bytes: tail });

  const wgslStruct = emitWgslStruct(fields, structName, samplers.length);
  const group0Entries: BindingPlanEntry[] = [{ binding: 0, kind: "uniform", name: structName, slot: 0 }];
  const group1Entries: BindingPlanEntry[] = [];
  samplers.forEach((sampler, slot) => {
    group1Entries.push({ binding: sampler.textureBinding, kind: "texture", name: `${sampler.name}_texture`, slot });
    group1Entries.push({ binding: sampler.samplerBinding, kind: "sampler", name: `${sampler.name}_sampler`, slot });
  });
  const groups: BindingPlanGroup[] = samplers.length === 0 ? [{ groupIndex: 0, entries: group0Entries }] : [{ groupIndex: 0, entries: group0Entries }, { groupIndex: samplerGroup, entries: group1Entries }];

  return {
    structName,
    uniformBlock: { uniformNames: uniforms.map((uniform) => uniform.name), fields, blockSize: structSize, wgslStruct },
    bindingPlan: { groups, textureCount: samplers.length, samplerCount: samplers.length },
    samplers,
    notes: [...new Set(notes)],
    padding,
    structAlign,
    structSize,
    bindingCount: binding,
    wgslBindings: emitBindings(structName, samplers),
    maxBindingsPerGroup: Math.max(group0Entries.length, group1Entries.length),
    wgslStruct,
    members: fields,
  };
}

/** Byte offsets of every scalar inside one member (element × column × component). */
function scalarOffsets(baseOffset: number, length: number, arrayStride: number | null, shape: { columnStride?: number }, info: UniformTypeInfo): number[] {
  const offsets: number[] = [];
  for (let element = 0; element < length; element += 1) {
    const elementOffset = baseOffset + element * (arrayStride ?? 0);
    for (let column = 0; column < info.columns; column += 1) {
      const columnOffset = elementOffset + column * (shape.columnStride ?? 0);
      for (let component = 0; component < info.components; component += 1) offsets.push(columnOffset + component * 4);
    }
  }
  return offsets;
}

/** Emit the WGSL `struct` declaration matching a layout (same generator, both sides). */
export function emitWgslStruct(layoutOrFields: BindLayoutResult | readonly UniformField[], structName?: string, samplerCount?: number): string {
  const fields = Array.isArray(layoutOrFields) ? (layoutOrFields as readonly UniformField[]) : (layoutOrFields as BindLayoutResult).uniformBlock.fields;
  const name = typeof structName === "string" ? structName : Array.isArray(layoutOrFields) ? "TerrainUniforms" : (layoutOrFields as BindLayoutResult).structName;
  const samplers = samplerCount ?? (Array.isArray(layoutOrFields) ? 0 : (layoutOrFields as BindLayoutResult).samplers.length);
  const lines = [`struct ${name} {`];
  for (const field of fields) lines.push(`  ${field.name} : ${field.wgslType},`);
  lines.push("}");
  if (fields.length === 0) lines.push(`// (no numeric uniform members; ${samplers} sampler binding(s) only)`);
  return lines.join("\n");
}

function emitBindings(structName: string, samplers: readonly SamplerBinding[]): string {
  const lines = [`@group(0) @binding(0) var<uniform> czm : ${structName};`];
  for (const sampler of samplers) {
    lines.push(`@group(${sampler.groupIndex}) @binding(${sampler.textureBinding}) var ${sampler.name}_texture : ${sampler.textureType};`);
    lines.push(`@group(${sampler.groupIndex}) @binding(${sampler.samplerBinding}) var ${sampler.name}_sampler : sampler;`);
  }
  return lines.join("\n");
}

/**
 * The uniform-array element access rendered **from the layout table**.
 *
 * The uniform address space requires a 16-byte element stride, so a packed `float[]`/`bool[]` is
 * widened to `vec4<f32>`/`vec4<u32>` by this generator. Only the first lane(s) of such an element are
 * meaningful, so the emitted read appends `.x`/`.xy`. Deriving the suffix from the table — instead of
 * hard-coding it in the WGSL leaves — is what keeps the emitted text and the CPU-side writer from
 * silently disagreeing when the layout changes.
 */
export function uniformElementAccess(layout: BindLayoutResult): (name: string, index: number) => string {
  return (name, index) => {
    const member = layout.members.find((candidate) => candidate.name === name);
    if (member === undefined || !member.paddedElement) return `czm.${name}[${index}]`;
    return `czm.${name}[${index}].${"xyzw".slice(0, member.components)}`;
  };
}

/** Every referenced uniform of one stage pair, i.e. the input of `layoutUniforms`. */
export function referencedUniforms(stages: readonly { source: string; defines: DefineList }[], automaticUniforms: AutomaticUniformNames = new Set<string>()): LayoutUniformInput[] {
  const declared = new Map<string, { name: string; glslType: string; size: number }>();
  for (const stage of stages) {
    for (const [name, entry] of collectDeclaredUniforms(stage.source, stage.defines, automaticUniforms)) {
      const existing = declared.get(name);
      if (existing === undefined) declared.set(name, { name: entry.name, glslType: entry.glslType, size: entry.size });
      else {
        if (existing.glslType !== entry.glslType) throw new Error(`bind-layout: uniform "${name}" has conflicting types across stages (${existing.glslType} vs ${entry.glslType})`);
        // `TEXTURE_UNITS`-sized arrays legitimately differ in length between variants; the union
        // layout takes the maximum, and the per-variant length is recorded by the caller.
        existing.size = Math.max(existing.size, entry.size);
      }
    }
  }
  const referenced = new Set<string>();
  for (const stage of stages) for (const name of collectReferencedIdentifiers(stage.source, stage.defines)) referenced.add(name);
  return [...declared.values()].filter((entry) => referenced.has(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
}

/** The uniform-block layout of one assembled shader stage pair (T077 entry point). */
export function buildBindLayout({ vertexSource, fragmentSource, defines, structName = "TerrainUniforms", automaticUniforms = new Set<string>(), limits = null }: { vertexSource: string; fragmentSource: string; defines: DefineList; structName?: string; automaticUniforms?: AutomaticUniformNames; limits?: { maxBindingsPerBindGroup: number; maxUniformBufferBindingSize: number } | null }): BindLayoutResult {
  const uniforms = Array.from(
    referencedUniforms(
      [
        { source: vertexSource, defines },
        { source: fragmentSource, defines },
      ],
      automaticUniforms,
    ),
  );
  const layout = layoutUniforms(uniforms, { structName });
  if (limits !== null) {
    // data-model §4.3 validation: `blockSize ≤ maxUniformBufferBindingSize`,
    // `BindingPlan.entries ≤ maxBindingsPerBindGroup`. A device whose limits are exceeded gets a
    // diagnosable failure, not a silently truncated layout.
    for (const group of layout.bindingPlan.groups) {
      if (group.entries.length > limits.maxBindingsPerBindGroup) {
        throw new Error(`bind-layout: bind group ${group.groupIndex} needs ${group.entries.length} entries, device limit maxBindingsPerBindGroup = ${limits.maxBindingsPerBindGroup}`);
      }
    }
    if (layout.structSize > limits.maxUniformBufferBindingSize) {
      throw new Error(`bind-layout: uniform block is ${layout.structSize} bytes, device limit maxUniformBufferBindingSize = ${limits.maxUniformBufferBindingSize}`);
    }
  }
  return layout;
}

/** The number of `u_dayTextures` bindings the layout declares: the blend chain can never exceed it. */
export function maxTextureUnitsFromLayout(layout: BindLayoutResult): number {
  const units = layout.samplers.filter((sampler) => sampler.glslName === "u_dayTextures").length;
  if (units < 1) throw new Error("bind-layout: the layout declares no u_dayTextures binding — cannot size computeDayColor");
  return units;
}
