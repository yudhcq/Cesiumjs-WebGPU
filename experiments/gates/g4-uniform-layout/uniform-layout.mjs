/**
 * G-4 gate — WGSL uniform `struct` + CPU-side layout generator (tasks.md T018/T019, H-4).
 *
 * Given the uniform declarations that the **real assembled terrain GLSL** actually references
 * (`assemble-glsl.mjs`), this module produces
 *
 *   - a WGSL `struct` (uniform address space) and the matching `@group(0)` bindings, and
 *   - a CPU-side layout table with, per field, `byteOffset` / `byteSize` / `align` / `arrayStride` /
 *     `columnStride` and the scalar decomposition needed to write it,
 *
 * implementing the WGSL uniform-address-space rules that `research.md` §5.4 flags as the H-4 risk:
 * `vec3` aligns to 16 bytes (size 12), a `mat3` is three **16-byte-padded columns** (size 48),
 * **array elements are 16-byte strided** (`StrideOf(array<T,N>) = roundUp(AlignOf(T), SizeOf(T))`
 * gives 4 for `array<f32,N>`, and the uniform address space *requires* that stride to be a multiple
 * of 16 — a packed `array<f32,N>` is invalid there unless the implementation supports the
 * `uniform_buffer_standard_layout` language extension; see `emitStruct` / `layoutUniforms`), a
 * struct's alignment is roundUp(16, max member align), and `bool`/`bvec*` **cannot be a uniform
 * member** (mapped to `u32`/`vecN<u32>` — GLSL `uniform bool u_dayTextureUseWebMercatorT[TEXTURE_UNITS]`
 * is real, see `Shaders/GlobeFS.js`). Samplers are not struct members at all: they become separate
 * bindings.
 *
 * Node-only, zero dependencies, cross-platform — the GPU half lives in `run-gpu.mjs`.
 */

const SCALAR_BY_GLSL = {
  float: "f32",
  int: "i32",
  bool: "u32", // bool is not host-shareable in the uniform address space
};

const VECTOR_BY_GLSL = {
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

const MATRIX_BY_GLSL = {
  mat2: { columns: 2, rows: 2 },
  mat3: { columns: 3, rows: 3 },
  mat4: { columns: 4, rows: 4 },
};

const SAMPLER_BY_GLSL = {
  sampler2D: { texture: "texture_2d<f32>", label: "2d" },
  samplerCube: { texture: "texture_cube<f32>", label: "cube" },
  sampler2DArray: { texture: "texture_2d_array<f32>", label: "2d-array" },
  sampler3D: { texture: "texture_3d<f32>", label: "3d" },
};

export const roundUp = (value, multiple) => Math.ceil(value / multiple) * multiple;

/**
 * The 16-byte element a **packed** array is widened to (the conservative, spec-conforming layout).
 *
 * `StrideOf(array<E,N>) = roundUp(AlignOf(E), SizeOf(E))` is not address-space dependent, so an
 * `array<f32,N>` always has stride 4 — but the uniform address space *requires* the element stride to
 * be a multiple of 16 (`RequiredAlignOf(array<T,N>, uniform) = roundUp(16, AlignOf(T))`; "Array
 * elements are aligned to 16 byte boundaries. That is, `StrideOf(array<T,N>) = 16 × k'`"). WGSL has no
 * stride attribute, so the only conforming way to declare such an array is to change the element type
 * — the specification's own remedy (`struct wrapped_f32 { @size(16) elem: f32 }`). This generator
 * widens to `vec4<T>` (align 16, size 16), which needs no extra declaration and keeps the element
 * addressable as a vector: **only the first `components` lanes are meaningful**, the rest is padding
 * that the CPU-side writer never touches.
 *
 * The alternative — keeping the compact 4-byte layout because Chrome 153/Tint tolerates it — is what
 * the first G-4 run did, and it is invalid on any implementation that does not announce the
 * `uniform_buffer_standard_layout` language extension (a relaxation merged 2025-10-24, gpuweb PR
 * #5347). Correctness MUST NOT depend on the implementation being lenient; see plan's R-1 row.
 */
const PADDED_ELEMENT_WGSL = {
  f32: "vec4<f32>",
  i32: "vec4<i32>",
  u32: "vec4<u32>",
  "vec2<f32>": "vec4<f32>",
  "vec2<i32>": "vec4<i32>",
  "vec2<u32>": "vec4<u32>",
};

/** Type information for one GLSL uniform type. */
export function typeInfo(glslType) {
  if (SCALAR_BY_GLSL[glslType] !== undefined) {
    return { kind: "scalar", scalar: SCALAR_BY_GLSL[glslType], components: 1, columns: 1, wgsl: SCALAR_BY_GLSL[glslType], glsl: glslType };
  }
  if (VECTOR_BY_GLSL[glslType] !== undefined) {
    const info = VECTOR_BY_GLSL[glslType];
    return { kind: "vector", scalar: info.scalar, components: info.components, columns: 1, wgsl: `vec${info.components}<${info.scalar}>`, glsl: glslType };
  }
  if (MATRIX_BY_GLSL[glslType] !== undefined) {
    const info = MATRIX_BY_GLSL[glslType];
    return { kind: "matrix", scalar: "f32", components: info.rows, columns: info.columns, wgsl: `mat${info.columns}x${info.rows}<f32>`, glsl: glslType };
  }
  if (SAMPLER_BY_GLSL[glslType] !== undefined) {
    return { kind: "sampler", texture: SAMPLER_BY_GLSL[glslType].texture, label: SAMPLER_BY_GLSL[glslType].label, wgsl: "sampler", glsl: glslType };
  }
  throw new Error(`g4: unsupported GLSL uniform type "${glslType}"`);
}

/**
 * Alignment and size of one scalar/vector/matrix value in the **WGSL uniform address space**
 * (the target of this gate; `research.md` §5.4 H-4).
 *
 * Uniform-address-space specifics implemented here:
 *   - `vec3<f32>` occupies 12 bytes and is aligned to **16**;
 *   - matrix columns are aligned to roundUp(16, alignOf(column vector)) → 16 for mat3/mat4;
 *   - array element strides are **16** (`layoutUniforms` widens a packed element type to `vec4<T>`,
 *     because the uniform address space requires `StrideOf(array<T,N>) = 16 × k'` and WGSL has no
 *     stride attribute — see `PADDED_ELEMENT_WGSL`).
 */
export function shapeOf(info) {
  if (info.kind === "scalar") return { align: 4, size: 4 };
  if (info.kind === "vector") {
    // WGSL AlignOf: vec2<f32> = 8, vec3<f32> = 16 (size stays 12), vecN<f32> = 4N.
    const align = info.components === 2 ? 8 : Math.max(16, info.components * 4);
    return { align, size: info.components * 4 };
  }
  // matrix: column stride is roundUp(16, alignOf(vecRows)) — uniform address space
  const columnAlign = roundUp(info.components === 2 ? 8 : info.components * 4, 16);
  return { align: 16, size: info.columns * columnAlign, columnStride: columnAlign };
}

/**
 * Generate the layout for a list of uniform declarations.
 *
 * @param {Array<{name: string, glslType: string, size?: number}>} uniforms
 * @param {{structName?: string}} [options]
 */
export function layoutUniforms(uniforms, options = {}) {
  const structName = options.structName ?? "TerrainUniforms";
  const members = [];
  const samplers = [];
  const notes = [];
  let offset = 0;
  let maxAlign = 16;
  let binding = 1; // @binding(0) is the uniform buffer itself

  for (const uniform of uniforms) {
    const info = typeInfo(uniform.glslType);
    const size = uniform.size ?? 1;
    if (info.kind === "sampler") {
      // Samplers cannot be struct members; a GLSL `sampler2D x[N]` becomes N texture+sampler pairs
      // (fixed-size arrays of textures would need `binding_array`, which is not core-guaranteed yet).
      const entries = [];
      for (let element = 0; element < size; element += 1) {
        const suffix = size > 1 ? `_${element}` : "";
        const textureBinding = binding;
        const samplerBinding = binding + 1;
        binding += 2;
        entries.push({ uniform: uniform.name, element, textureBinding, samplerBinding });
        samplers.push({
          name: `${uniform.name}${suffix}`,
          glslName: uniform.name,
          element,
          glslType: uniform.glslType,
          textureType: info.texture,
          textureBinding,
          samplerBinding,
        });
      }
      notes.push(`${uniform.name}: ${uniform.glslType}${size > 1 ? `[${size}]` : ""} → ${entries.length} texture/sampler binding pair(s) (must not live in the uniform struct)`);
      continue;
    }

    const shape = shapeOf(info);
    // Array layout. WGSL derives the element stride from the element type and offers no attribute to
    // change it, so a **conforming** uniform array MUST have an element type whose align and size are
    // already multiples of 16 → packed element types (scalars, `vec2`) are widened to `vec4<T>`
    // (`PADDED_ELEMENT_WGSL`), the array's own alignment becomes 16, and `arrayStride` is 16.
    // Elements whose align is already 16 (`vec3` → stride roundUp(12,16) = 16, `vec4`, `mat3`… ) are
    // emitted unchanged: their stride is already a multiple of 16.
    const paddedElement = size > 1 && shape.align < 16;
    const elementWgslType = paddedElement ? PADDED_ELEMENT_WGSL[info.wgsl] : info.wgsl;
    if (paddedElement && elementWgslType === undefined) throw new Error(`g4: no 16-byte widening registered for array element type "${info.wgsl}"`);
    const arrayStride = size > 1 ? (paddedElement ? 16 : roundUp(shape.size, shape.align)) : null;
    const align = paddedElement ? 16 : shape.align;
    offset = roundUp(offset, align);
    const byteSize = size > 1 ? size * arrayStride : shape.size;
    members.push({
      name: uniform.name,
      glslType: uniform.glslType,
      wgslType: size > 1 ? `array<${elementWgslType}, ${size}>` : info.wgsl,
      elementWgslType,
      paddedElement,
      kind: info.kind,
      scalar: info.scalar,
      components: info.components,
      columns: info.columns,
      length: size,
      arrayStride,
      columnStride: shape.columnStride ?? null,
      align,
      byteOffset: offset,
      byteSize,
      scalarCount: size * info.columns * info.components,
      scalarOffsets: scalarOffsets(offset, size, arrayStride, shape, info),
    });
    if (info.kind === "matrix") notes.push(`${uniform.name}: mat3/mat4 columns are 16-byte padded (columnStride=${shape.columnStride})`);
    if (size > 1) {
      notes.push(
        paddedElement
          ? `${uniform.name}: array<${info.wgsl}, ${size}> → array<${elementWgslType}, ${size}> (element stride 16, required by the uniform address space; only lane .x${info.components > 1 ? "/.xy" : ""} is meaningful)`
          : `${uniform.name}: array<${info.wgsl}, ${size}> element stride = roundUp(SizeOf, AlignOf) = ${arrayStride} bytes (already a multiple of 16)`,
      );
    }
    if (info.components === 3) notes.push(`${uniform.name}: vec3 occupies 12 bytes but is aligned to 16 (uniform address space)`);
    if (uniform.glslType.startsWith("bvec") || uniform.glslType === "bool") notes.push(`${uniform.name}: GLSL ${uniform.glslType} → WGSL ${info.wgsl} (bool is not host-shareable in the uniform address space)`);
    offset += byteSize;
    maxAlign = Math.max(maxAlign, align);
  }

  const structAlign = roundUp(16, maxAlign);
  const structSize = roundUp(offset, structAlign);
  const padding = [];
  for (let index = 1; index < members.length; index += 1) {
    const previous = members[index - 1];
    const gap = members[index].byteOffset - (previous.byteOffset + previous.byteSize);
    if (gap > 0) padding.push({ after: previous.name, before: members[index].name, bytes: gap });
  }
  const tail = structSize - (members.length === 0 ? 0 : members[members.length - 1].byteOffset + members[members.length - 1].byteSize);
  if (tail > 0 && members.length > 0) padding.push({ after: members[members.length - 1].name, before: "<struct end>", bytes: tail });

  return {
    structName,
    members,
    samplers,
    notes: [...new Set(notes)],
    padding,
    structAlign,
    structSize,
    bindingCount: binding,
    wgslStruct: emitStruct(structName, members, samplers),
    wgslBindings: emitBindings(structName, samplers),
    slotPlan: emitSlotPlan(members),
  };
}

/** Byte offsets of every scalar inside one member (element × column × component). */
function scalarOffsets(baseOffset, length, arrayStride, shape, info) {
  const offsets = [];
  for (let element = 0; element < length; element += 1) {
    const elementOffset = baseOffset + element * (arrayStride ?? 0);
    for (let column = 0; column < info.columns; column += 1) {
      const columnOffset = elementOffset + column * (shape.columnStride ?? 0);
      for (let component = 0; component < info.components; component += 1) {
        offsets.push(columnOffset + component * 4);
      }
    }
  }
  return offsets;
}

function emitStruct(structName, members, samplers) {
  const lines = [`struct ${structName} {`];
  for (const member of members) lines.push(`  ${member.name} : ${member.wgslType},`);
  lines.push("}");
  if (members.length === 0) lines.push(`// (no numeric uniform members; ${samplers.length} sampler binding(s) only)`);
  return lines.join("\n");
}

function emitBindings(structName, samplers) {
  const lines = [`@group(0) @binding(0) var<uniform> uniforms : ${structName};`];
  for (const sampler of samplers) {
    lines.push(`@group(0) @binding(${sampler.textureBinding}) var ${sampler.name}_texture : ${sampler.textureType};`);
    lines.push(`@group(0) @binding(${sampler.samplerBinding}) var ${sampler.name}_sampler : sampler;`);
  }
  return lines.join("\n");
}

/**
 * The per-slot plan used by the real-GPU assertion: every (member, element, column) triple becomes
 * one `vec4<f32>` output pixel, so a wrong offset/stride/padding shows up as a wrong pixel.
 */
export function emitSlotPlan(members) {
  const slots = [];
  for (const member of members) {
    for (let element = 0; element < member.length; element += 1) {
      for (let column = 0; column < member.columns; column += 1) {
        const base = member.byteOffset + element * (member.arrayStride ?? 0) + column * (member.columnStride ?? 0);
        slots.push({
          index: slots.length,
          member: member.name,
          element,
          column,
          components: member.components,
          scalar: member.scalar,
          isArray: member.length > 1,
          isMatrix: member.kind === "matrix",
          padded: member.paddedElement === true,
          byteOffset: base,
          byteOffsets: Array.from({ length: member.components }, (_unused, component) => base + component * 4),
        });
      }
    }
  }
  return slots;
}

/** WGSL expression that returns one slot's components (used to emit the verification fragment shader). */
function slotExpression(slot) {
  // Array elements and matrix columns are DIFFERENT axes: a matrix member is indexed by column only,
  // an array member by element only, and an array of matrices by both.
  const access = `${slot.isArray ? `[${slot.element}]` : ""}${slot.isMatrix ? `[${slot.column}]` : ""}`;
  // A widened (padded) array element is a `vec4<T>` whose only meaningful lane(s) are the first
  // `components` — read `.x` / `.xy` so the probe compares the documented scalars, not the padding.
  const value = slot.padded === true && slot.components === 1 ? `uniforms.${slot.member}${access}.x` : `uniforms.${slot.member}${access}`;
  const parts = [];
  for (let component = 0; component < slot.components; component += 1) {
    // WGSL vector constructors take either N scalars or ONE vector — never a mix — so every
    // component is addressed individually (`vec2.x`, matrix-column `.y`, …).
    const scalar = slot.components === 1 ? value : `${value}.${"xyzw"[component]}`;
    // Floats are already stored as `value/255` (exactly representable in rgba8unorm); integers and the
    // bool→u32 mapping are divided by 255 as well so that the readback equals the written scalar for
    // every scalar type (no per-type expectation special-casing).
    parts.push(slot.scalar === "f32" ? scalar : `(f32(${scalar}) / 255.0)`);
  }
  while (parts.length < 4) parts.push("0.0");
  return `vec4<f32>(${parts.join(", ")})`;
}

/**
 * Emit the **verification** WGSL program: a full-screen triangle whose fragment shader returns one
 * uniform slot per pixel (slot index = pixel x). Compiling and running this on a real device proves
 * that the generated struct/offsets are what the GPU actually sees.
 */
export function emitVerificationWgsl(layout) {
  const slots = layout.slotPlan;
  const cases = slots.map((slot) => `    case ${slot.index}u: { return ${slotExpression(slot)}; }`).join("\n");
  return [
    `// Generated by experiments/gates/g4-uniform-layout (G-4 gate, tasks.md T018/T019).`,
    `// Verification program: pixel x -> uniform slot x, so a wrong byteOffset/arrayStride/`,
    `// columnStride in the CPU layout table (or in the WGSL struct) changes a pixel.`,
    layout.wgslStruct,
    "",
    layout.wgslBindings,
    "",
    "@vertex",
    "fn vs(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {",
    "  // Full-screen triangle covering the whole target (slotCount x 1).",
    "  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));",
    "  let position = positions[index];",
    "  return vec4<f32>(position, 0.0, 1.0);",
    "}",
    "",
    "@fragment",
    "fn fs(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {",
    "  let slot = u32(position.x);",
    "  switch slot {",
    cases,
    "    default: { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }",
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Deterministic test value for one scalar (`1..255`, distinct per scalar index so that two fields
 * written at each other's offsets cannot compare equal by accident).
 */
export function testValue(scalarIndex, salt = 0) {
  return ((scalarIndex * 37 + salt * 11) % 251) + 1;
}

/**
 * CPU-side write plan for the whole struct, produced strictly through the layout table.
 *
 * @param {object} layout
 * @param {{salt?: number, perturb?: string|null, perturbSalt?: number}} [options]
 *   `perturb` = the member whose scalars use `perturbSalt` instead of `salt` (the per-field
 *   perturbation matrix of the real-device assertion).
 * @returns {{bytes: number, plan: Array<{byteOffset: number, scalar: string, value: number}>, encoded: Array<object>}}
 */
export function writeStructBytes(layout, { salt = 0, perturb = null, perturbSalt = 1 } = {}) {
  const bytes = roundUp(layout.structSize, 16) + 16;
  const plan = [];
  const encoded = [];
  let scalarIndex = 0;
  for (const member of layout.members) {
    const isPerturbed = perturb === member.name;
    for (let element = 0; element < member.length; element += 1) {
      for (let column = 0; column < member.columns; column += 1) {
        for (let component = 0; component < member.components; component += 1) {
          const byteOffset = member.byteOffset + element * (member.arrayStride ?? 0) + column * (member.columnStride ?? 0) + component * 4;
          const isBoolean = member.glslType === "bool" || member.glslType.startsWith("bvec");
          const raw = testValue(scalarIndex, isPerturbed ? perturbSalt : salt);
          const value = isBoolean ? raw % 2 : raw;
          plan.push({ byteOffset, scalar: member.scalar, value, member: member.name, element, column, component });
          encoded.push({ member: member.name, element, column, component, byteOffset, value });
          scalarIndex += 1;
        }
      }
    }
  }
  return { bytes, plan, encoded };
}

/** Bytes the GPU MUST return for a slot, derived from the same CPU-side writes (rgba8unorm). */
export function expectedSlotBytes(layout, written) {
  const slots = layout.slotPlan.map((slot) => {
    const components = [];
    for (let component = 0; component < slot.components; component += 1) {
      const scalar = written.encoded.find((entry) => entry.byteOffset === slot.byteOffsets[component]);
      if (scalar === undefined) throw new Error(`g4: slot ${slot.index} component ${component} has no CPU-side value (layout/writer mismatch)`);
      components.push(scalar.value);
    }
    return { index: slot.index, member: slot.member, element: slot.element, column: slot.column, rgba: [components[0] ?? 0, components[1] ?? 0, components[2] ?? 0, components[3] ?? 0] };
  });
  return slots;
}

/** Indices of the slots that belong to one member (used by the perturbation matrix). */
export function slotIndicesForMember(layout, memberName) {
  return layout.slotPlan.filter((slot) => slot.member === memberName).map((slot) => slot.index);
}
