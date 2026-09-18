/**
 * T076 — uniform writer, per-frame ring buffer and the replaced `createUniform` setters
 * (`层=单元`, tasks.md T076; research §5.4, data-model §4.3).
 *
 * The risk T076 owns is *silent drift between the WGSL `struct` the GPU reads and the bytes the CPU
 * writes*. Every case therefore asserts an invariant of the layout table (offset, stride, padding,
 * self-diff) rather than a copied constant: a `mat3` is three 16-byte-padded columns, a packed scalar
 * array is widened to `array<vec4<T>,N>` with only lane `.x` meaningful, a `vec3` keeps size 12 but
 * aligns to 16, a GLSL `bool` is stored as `u32`, and the write plan MUST agree byte for byte with
 * `UniformField.scalarOffsets` — the cross-check data-model §4.3 requires.
 *
 * The modules are executed, not pattern-matched: `tests/support/ts-module-loader.mjs` compiles and
 * bundles the real TypeScript sources, so these assertions hold for the code the build ships.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

/** The writer plus the layout generator it is driven by (`webgpu/bind-layout.ts`). */
async function loadWriter() {
  const layout = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/bind-layout.ts`));
  const writer = await loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/uniform-writer.ts`));
  return { layout, writer };
}

async function loadCreateUniform() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/createUniform.ts`));
}

async function loadCreateUniformArray() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/createUniformArray.ts`));
}

function fieldOf(layout, name) {
  const field = layout.members.find((member) => member.name === name);
  assert.ok(field !== undefined, `the layout MUST declare the member "${name}"`);
  return field;
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A poisoned target: any byte the writer touches stops being 0xab, so padding is provable. */
function poisonedStruct(layout) {
  const buffer = new ArrayBuffer(Math.max(layout.structSize, 16));
  new Uint8Array(buffer).fill(0xab);
  return buffer;
}

test("a mat3 is three 16-byte-padded columns (byteSize 48) and its scalars land at column*16 + row*4", async () => {
  const { layout, writer } = await loadWriter();
  const generated = layout.layoutUniforms([
    { name: "u_normal", glslType: "mat3" },
    { name: "u_scale", glslType: "float" },
  ]);
  const normal = fieldOf(generated, "u_normal");
  assert.equal(normal.byteSize, 48, "a mat3 occupies 3 columns × 16 padded bytes in the uniform address space");
  assert.equal(normal.columnStride, 16, "mat3 columns MUST be 16-byte padded (columnStride is the only allowed stride source)");
  assert.equal(fieldOf(generated, "u_scale").byteOffset, 48, "the next member MUST start right after the 48-byte mat3 (already 16-aligned)");

  const lanes = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const { bytes, plan } = writer.writeStruct(generated, { u_normal: lanes, u_scale: 2.5 });
  const view = viewOf(bytes);
  assert.equal(plan.filter((entry) => entry.member === "u_normal").length, 9, "a mat3 MUST contribute exactly 9 scalars");
  lanes.forEach((lane, index) => {
    const column = Math.floor(index / 3);
    const row = index % 3;
    const byteOffset = normal.byteOffset + column * 16 + row * 4;
    assert.equal(view.getFloat32(byteOffset, true), lane, `mat3 scalar ${index} MUST land at byteOffset + column*16 + row*4`);
    const entry = plan.find((candidate) => candidate.member === "u_normal" && candidate.column === column && candidate.component === row);
    assert.ok(entry !== undefined, `the plan MUST carry mat3 column ${column} row ${row}`);
    assert.equal(entry.byteOffset, byteOffset, "the plan offset MUST be the one the buffer actually uses");
  });
  [0, 1, 2].forEach((column) => {
    assert.equal(view.getFloat32(normal.byteOffset + column * 16 + 12, true), 0, `the 4 padding bytes of mat3 column ${column} MUST stay untouched`);
  });
});

test("a packed float[3] is widened to array<vec4<f32>,3>: stride 16, only lane .x written, padding intact", async () => {
  const { layout, writer } = await loadWriter();
  const generated = layout.layoutUniforms([{ name: "u_scales", glslType: "float", size: 3 }]);
  const scales = fieldOf(generated, "u_scales");
  assert.equal(scales.wgslType, "array<vec4<f32>, 3>", "a uniform array element MUST be widened to a 16-byte element type (decision R-1)");
  assert.equal(scales.paddedElement, true, "the layout MUST flag the element as padded so the writer knows only some lanes are meaningful");
  assert.equal(scales.arrayStride, 16, "the uniform address space requires a 16-byte element stride");
  assert.equal(scales.byteSize, 48, "three 16-byte elements MUST occupy 48 bytes");

  const { bytes, plan } = writer.writeStruct(generated, { u_scales: [11, 22, 33] }, { into: poisonedStruct(generated) });
  assert.deepEqual(
    plan.map((entry) => entry.byteOffset),
    [0, 16, 32],
    "each element MUST be written at arrayStride intervals, never at the packed 4-byte stride",
  );
  assert.deepEqual(
    plan.map((entry) => entry.component),
    [0, 0, 0],
    "only lane .x of a widened element is meaningful, so no other lane may be written",
  );
  const view = viewOf(bytes);
  [11, 22, 33].forEach((value, element) => {
    assert.equal(view.getFloat32(element * 16, true), value, `element ${element} MUST be readable at its own arrayStride offset`);
    for (let lane = 1; lane < 4; lane += 1) {
      assert.equal(bytes[element * 16 + lane * 4], 0xab, `the padding lanes of element ${element} MUST never be touched`);
    }
  });
});

test("a vec3 keeps size 12 but aligns to 16, so a following 16-byte member starts 16-aligned", async () => {
  const { layout, writer } = await loadWriter();
  const generated = layout.layoutUniforms([
    { name: "u_normal", glslType: "vec3" },
    { name: "u_rect", glslType: "vec4" },
  ]);
  const normal = fieldOf(generated, "u_normal");
  const rect = fieldOf(generated, "u_rect");
  assert.equal(normal.byteSize, 12, "vec3 occupies 12 bytes (it is not padded to 16 in size)");
  assert.equal(normal.align, 16, "vec3 aligns to 16 in the uniform address space");
  assert.equal(normal.byteOffset % 16, 0, "the vec3 member itself MUST start 16-aligned");
  assert.equal(rect.byteOffset, 16, "a member that needs 16-byte alignment MUST start at 16 after a vec3, leaving a 4-byte gap at 12");
  assert.equal(rect.byteOffset % 16, 0, "every uniform member offset MUST satisfy its own alignment");

  const { bytes, plan } = writer.writeStruct(generated, { u_normal: { x: 1, y: 2, z: 3 }, u_rect: [4, 5, 6, 7] }, { into: poisonedStruct(generated) });
  assert.deepEqual(
    plan.filter((entry) => entry.member === "u_normal").map((entry) => entry.component),
    [0, 1, 2],
    "a vec3 has exactly three meaningful components — there is no .w to write",
  );
  const view = viewOf(bytes);
  assert.deepEqual([0, 1, 2].map((row) => view.getFloat32(normal.byteOffset + row * 4, true)), [1, 2, 3]);
  for (let byte = normal.byteOffset + 12; byte < rect.byteOffset; byte += 1) {
    assert.equal(bytes[byte], 0xab, "the 4 alignment bytes between a vec3 and a 16-byte member MUST stay untouched");
  }

  // A scalar only needs 4-byte alignment, so WGSL packs it at 12 (AlignOf(f32) = 4) — the writer MUST
  // follow the layout table there too instead of assuming a 16-byte stride.
  const packed = layout.layoutUniforms([
    { name: "u_normal", glslType: "vec3" },
    { name: "u_scale", glslType: "float" },
  ]);
  assert.equal(fieldOf(packed, "u_scale").byteOffset, 12, "the layout table (WGSL AlignOf) decides where a scalar lands after a vec3");
  const packedResult = writer.writeStruct(packed, { u_normal: { x: 1, y: 2, z: 3 }, u_scale: 9 });
  assert.equal(viewOf(packedResult.bytes).getFloat32(12, true), 9, "the writer MUST place the scalar where the table says, not at a hand-computed 16");
  assert.equal(packedResult.plan.length, 4, "the vec3 + scalar struct MUST write 4 scalars and no padding");
});

test("GLSL bool/bvec2 accept true/false/0/1 and are stored as u32", async () => {
  const { layout, writer } = await loadWriter();
  const generated = layout.layoutUniforms([
    { name: "u_enabled", glslType: "bool" },
    { name: "u_swizzle", glslType: "bvec2" },
  ]);
  assert.equal(fieldOf(generated, "u_enabled").scalar, "u32", "bool is not host-shareable, so the layout MUST store it as u32");
  assert.equal(fieldOf(generated, "u_swizzle").scalar, "u32", "bvec2 MUST be stored as vec2<u32>");

  assert.equal(writer.encodeScalar("u32", true), 1, "a GLSL bool true MUST encode to 1");
  assert.equal(writer.encodeScalar("u32", false), 0, "a GLSL bool false MUST encode to 0");
  assert.equal(writer.encodeScalar("u32", 0), 0, "a numeric flag MUST be accepted as-is");
  assert.equal(writer.encodeScalar("u32", 1), 1, "a numeric flag MUST be accepted as-is");
  assert.equal(writer.encodeScalar("u32", 7), 7, "a u32 uniform MUST accept any finite number");

  const swizzle = fieldOf(generated, "u_swizzle");
  for (const [enabled, lanes] of [
    [true, [false, 1]],
    [1, [0, 1]],
    [false, [true, 0]],
  ]) {
    const { bytes } = writer.writeStruct(generated, { u_enabled: enabled, u_swizzle: lanes });
    const view = viewOf(bytes);
    assert.equal(
      writer.readScalar(view, fieldOf(generated, "u_enabled").byteOffset, "u32"),
      enabled === true || enabled === 1 ? 1 : 0,
      `bool value ${String(enabled)} MUST be readable back as u32`,
    );
    assert.deepEqual(
      [0, 1].map((component) => writer.readScalar(view, swizzle.byteOffset + component * 4, "u32")),
      lanes.map((lane) => (lane === true ? 1 : lane === false ? 0 : lane)),
      "both bvec2 lanes MUST be readable back as u32",
    );
  }
});

test("the write plan agrees with every member's scalarOffsets (data-model §4.3 cross-check)", async () => {
  const { layout, writer } = await loadWriter();
  const generated = layout.layoutUniforms([
    { name: "u_float", glslType: "float" },
    { name: "u_vec3", glslType: "vec3" },
    { name: "u_mat3", glslType: "mat3" },
    { name: "u_mat2", glslType: "mat2" },
    { name: "u_ivec4", glslType: "ivec4" },
    { name: "u_flags", glslType: "bvec2", size: 2 },
    { name: "u_scales", glslType: "float", size: 3 },
    { name: "u_rects", glslType: "vec4", size: 2 },
  ]);
  const values = {
    u_float: 1.5,
    u_vec3: { x: 2, y: 3, z: 4 },
    u_mat3: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    u_mat2: [10, 11, 12, 13],
    u_ivec4: new Int32Array([14, 15, 16, 17]),
    u_flags: [
      [true, false],
      [1, 0],
    ],
    u_scales: [18, 19, 20],
    u_rects: [
      [21, 22, 23, 24],
      [25, 26, 27, 28],
    ],
  };
  const { bytes, plan } = writer.writeStruct(generated, values);
  const expected = generated.members.flatMap((member) => member.scalarOffsets.map((byteOffset) => [member.name, byteOffset]));
  assert.deepEqual(
    plan.map((entry) => [entry.member, entry.byteOffset]),
    expected,
    "every scalar the plan writes MUST sit exactly on the offset the layout table declares (element×stride + column×columnStride + component×4)",
  );
  const scalarCount = generated.members.reduce((total, member) => total + member.length * member.columns * member.components, 0);
  assert.equal(plan.length, scalarCount, `the plan MUST cover all ${scalarCount} scalars of the struct`);

  const view = viewOf(bytes);
  for (const entry of plan) {
    assert.ok(
      Object.is(writer.readScalar(view, entry.byteOffset, entry.scalar), entry.value),
      `the plan entry for ${entry.member}[${entry.element}][${entry.column}].${"xyzw"[entry.component]} MUST be readable at its own offset with its own scalar kind`,
    );
  }
  assert.equal(bytes.byteLength, generated.structSize, "the struct region MUST be exactly structSize bytes");
});

test("missing values write nothing and stay observable; corrupt values raise internal", async () => {
  const { layout, writer } = await loadWriter();
  const generated = layout.layoutUniforms([
    { name: "u_normal", glslType: "mat3" },
    { name: "u_scales", glslType: "float", size: 3 },
    { name: "u_scale", glslType: "float" },
  ]);
  const { plan } = writer.writeStruct(generated, {});
  assert.deepEqual(plan, [], "a member without a value MUST NOT be written (the missingUniforms rule of tools/shader-verify.mjs serialiseScene)");

  assert.throws(
    () => writer.writeStruct(generated, { u_normal: [1, 2, 3] }),
    (error) => {
      assert.equal(error.name, "DiagnosticError");
      assert.equal(error.category, "internal");
      assert.match(error.message, /9 components are required/);
      return true;
    },
    "a matrix shorter than its column count is the state-corrupting case: it MUST throw instead of zero-filling",
  );
  assert.throws(
    () => writer.writeStruct(generated, { u_scales: [1, 2, 3, 4] }),
    (error) => {
      assert.equal(error.category, "internal");
      assert.match(error.message, /would overwrite/);
      return true;
    },
    "an array longer than the struct declares MUST throw — writing it would corrupt the next member",
  );
  assert.throws(
    () => writer.writeStruct(generated, { u_scale: "1.0" }),
    (error) => {
      assert.equal(error.category, "internal");
      assert.match(error.message, /cannot read 1 component/);
      return true;
    },
    "a non-numeric value MUST NOT be coerced silently",
  );
  assert.throws(() => writer.writeStruct(generated, { u_scale: 1 }, { byteOffset: generated.structSize }), /does not fit/, "writing past the target buffer MUST fail loudly");
});

test("UniformStaging writes the automatic block once and skips identical frames (lazy set + self-diff)", async () => {
  const { layout, writer } = await loadWriter();
  const generated = layout.layoutUniforms([
    { name: "u_scale", glslType: "float" },
    { name: "u_enabled", glslType: "bool" },
  ]);
  const staging = new writer.UniformStaging(generated);
  assert.equal(staging.bytesWritten, 0, "a fresh staging area MUST have written nothing");
  assert.equal(staging.skippedWrites, 0, "a fresh staging area MUST have skipped nothing");

  assert.equal(staging.writeLazy({ u_scale: 1, u_enabled: true }), true, "the first frame MUST stage its values");
  assert.equal(staging.bytesWritten, 8, "two scalars MUST be 8 bytes");
  assert.deepEqual(staging.missingMembers, [], "every member carried a value, so nothing may be reported missing");

  const afterFirstFrame = staging.bytesWritten;
  assert.equal(staging.writeLazy({ u_scale: 1, u_enabled: true }), false, "an identical frame MUST NOT write (值未变不写)");
  assert.equal(staging.bytesWritten, afterFirstFrame, "a skipped write MUST NOT change bytesWritten");
  assert.equal(staging.skippedWrites, 1, "the skip MUST be counted — it is the evidence for the self-diff");

  assert.equal(staging.writeLazy({ u_scale: 2, u_enabled: true }), true, "a changed value MUST be written");
  assert.equal(staging.bytesWritten, afterFirstFrame + 4, "only the changed scalar (4 bytes) may be copied into the ring");

  const view = new DataView(staging.ring.buffer);
  const scaleOffset = fieldOf(generated, "u_scale").byteOffset;
  const enabledOffset = fieldOf(generated, "u_enabled").byteOffset;
  assert.equal(staging.writeLazy({ u_scale: 3 }), true, "a frame that carries no value for one member MUST still write the members it does carry");
  assert.deepEqual(staging.missingMembers, ["u_enabled"], "a member the frame carried no value for MUST be reported (the missingUniforms discipline)");
  assert.equal(
    writer.readScalar(view, scaleOffset, "f32"),
    3,
    "the staged bytes MUST be readable at the layout offsets",
  );
  assert.equal(
    writer.readScalar(view, enabledOffset, "u32"),
    1,
    "a member omitted by a later frame MUST keep the bytes of the previous frame",
  );

  // `writeMember` is the sink the automatic setters use; it writes the same block.
  assert.equal(typeof staging.writeMember, "function", "UniformStaging MUST satisfy UniformWriteSink for the createUniform setters");
  staging.writeMember("u_scale", 7);
  assert.equal(writer.readScalar(view, scaleOffset, "f32"), 7, "writeMember MUST land on the same automatic block");
  assert.throws(() => staging.writeMember("u_absent", 1), /not a member of struct/, "writeMember MUST refuse a name the layout does not declare");
});

test("the ring buffer hands out aligned dynamic offsets, rewinds per frame and refuses to overflow", async () => {
  const { layout, writer } = await loadWriter();
  assert.equal(writer.DEFAULT_DYNAMIC_OFFSET_ALIGNMENT, 256, "the default MUST be WebGPU's minUniformBufferOffsetAlignment floor");
  const generated = layout.layoutUniforms([{ name: "u_scale", glslType: "float" }]);
  const staging = new writer.UniformStaging(generated);
  staging.beginFrame();
  assert.equal(staging.ring.writeOffset, staging.slotSize, "command slots MUST start after the automatic block");
  assert.deepEqual(staging.ring.dynamicOffsetsUsed, [], "beginFrame MUST forget the previous frame's offsets");

  const first = staging.writeCommand({ u_scale: 1 });
  const second = staging.writeCommand({ u_scale: 2 });
  assert.equal(first.dynamicOffset % 256, 0, "every dynamic offset MUST be a multiple of the 256-byte alignment");
  assert.equal(second.dynamicOffset, first.dynamicOffset + staging.slotSize, "each command MUST take its own slot");
  assert.deepEqual(staging.ring.dynamicOffsetsUsed, [first.dynamicOffset, second.dynamicOffset], "the ring MUST record the offsets a frame used");
  assert.equal(first.bytes.byteLength, generated.structSize, "a command slot MUST expose exactly the struct bytes it wrote");
  staging.beginFrame();
  assert.deepEqual(staging.ring.dynamicOffsetsUsed, [], "beginFrame MUST reset the frame's dynamic offsets");
  assert.equal(staging.ring.writeOffset, staging.slotSize, "beginFrame MUST rewind the command cursor");

  const tiny = new writer.UniformStaging(generated, { frameCapacityBytes: staging.slotSize * 2 });
  tiny.writeCommand({ u_scale: 1 });
  assert.throws(
    () => tiny.writeCommand({ u_scale: 2 }),
    (error) => {
      assert.equal(error.category, "internal");
      assert.match(error.message, /beginFrame/);
      return true;
    },
    "an exhausted ring MUST name the missing beginFrame() instead of overwriting the previous command's slot",
  );
  assert.throws(() => writer.createRingBuffer(1000), (error) => error.category === "internal" && /multiple/.test(error.message), "a capacity that is not a multiple of the alignment MUST be refused");
  assert.throws(() => new writer.UniformStaging(generated, { frameCapacityBytes: 128 }), /automatic block plus one command slot/, "a staging area too small for the automatic block MUST be refused");
});

test("uniformBlockLayout() reproduces the layout's UniformBlockLayout field for field", async () => {
  const { layout, writer } = await loadWriter();
  const generated = layout.layoutUniforms([
    { name: "u_mat3", glslType: "mat3" },
    { name: "u_scales", glslType: "float", size: 3 },
    { name: "u_scale", glslType: "float" },
  ]);
  const block = writer.uniformBlockLayout(generated);
  assert.deepEqual(block.uniformNames, generated.uniformBlock.uniformNames, "the member name list MUST be carried over unchanged");
  assert.equal(block.blockSize, generated.uniformBlock.blockSize, "blockSize MUST be the layout's (data-model §4.3 validation uses it)");
  assert.equal(block.wgslStruct, generated.uniformBlock.wgslStruct, "the WGSL struct text MUST be the very text the module was generated from");
  assert.equal(block.fields.length, generated.uniformBlock.fields.length, "no field may be dropped or added by the projection");
  block.fields.forEach((field, index) => {
    const source = generated.uniformBlock.fields[index];
    assert.equal(field.name, source.name, `field ${index} MUST keep the layout's name`);
    assert.equal(field.kind, source.kind, `field ${index} MUST keep the layout's kind`);
    assert.equal(field.byteOffset, source.byteOffset, `field ${index} MUST keep the layout's byteOffset`);
    assert.equal(field.byteSize, source.byteSize, `field ${index} MUST keep the layout's byteSize`);
    assert.equal(field.arrayStride ?? null, source.arrayStride, `field ${index} MUST keep the layout's arrayStride (absent ⇔ null)`);
  });
});

test("createUniform keeps the setter shape and the lazy set of upstream, standalone and with a sink", async () => {
  const { layout } = await loadWriter();
  const createUniform = (await loadCreateUniform()).default;
  const generated = layout.layoutUniforms([
    { name: "u_scale", glslType: "float" },
    { name: "u_height", glslType: "float" },
  ]);

  // (a) standalone "no-GPU" mode: no layout, no writer — the implicit layout still encodes real bytes.
  const standalone = createUniform(undefined, { name: "u_scale", type: 0x1406 }, "u_scale", undefined);
  assert.equal(standalone.name, "u_scale", "the setter MUST keep upstream's `.name` (ShaderProgram's uniformMap lookup uses it)");
  assert.equal(standalone.value, undefined, "the setter MUST start with `value === undefined`, exactly like upstream");
  assert.equal(typeof standalone.set, "function", "the setter MUST carry upstream's `set()`");
  assert.equal(standalone._setSampler, undefined, "a numeric setter MUST NOT expose `_setSampler` (ShaderProgram switches on its presence)");
  assert.equal(standalone._target.field.name, "u_scale", "the implicit layout MUST declare the uniform the setter was created for");
  standalone.value = 1.25;
  standalone.set();
  assert.equal(new DataView(standalone._buffer).getFloat32(0, true), 1.25, "the standalone mode MUST really encode through the layout");
  assert.ok(
    standalone._buffer.byteLength >= standalone._target.field.byteOffset + 4,
    "the local buffer MUST cover the member the setter writes (the implicit struct of a float is 16 bytes)",
  );

  // (b) with a layout, without a writer: the same encoding, at the layout's own offset.
  const height = fieldOf(generated, "u_height");
  const local = createUniform(undefined, { glslType: "float" }, "u_height", undefined, { layout: generated });
  local.value = 4.5;
  local.set();
  assert.equal(local._bytesWritten, 4, "the first assignment MUST write exactly one f32");
  assert.equal(
    new DataView(local._buffer).getFloat32(height.byteOffset, true),
    4.5,
    "the value MUST land on the layout's byteOffset (4 for the second member), never on 0",
  );
  local.set();
  assert.equal(local._bytesWritten, 4, "assigning an equal value MUST NOT write (upstream lazy set + self-diff)");
  local.value = 4.5000001;
  local.set();
  assert.equal(local._bytesWritten, 4, "a value that encodes to the same f32 MUST NOT write — the diff is on bytes, not on JS identity");
  local.value = 5;
  local.set();
  assert.equal(local._bytesWritten, 8, "a genuinely different value MUST write again");

  // (c) with a writer: changed members only, and no local buffer.
  const calls = [];
  const sunk = createUniform(undefined, { glslType: "float" }, "u_height", undefined, {
    layout: generated,
    writer: { writeMember: (name, value) => calls.push([name, value]) },
  });
  sunk.value = 12;
  sunk.set();
  assert.equal(calls.length, 1, "the sink MUST receive exactly the changed member");
  assert.deepEqual(calls[0], ["u_height", 12], "the sink MUST be called with the uniform's name and its raw value");
  sunk.set();
  assert.equal(calls.length, 1, "an unchanged value MUST NOT reach the sink");
  assert.equal(sunk._buffer, undefined, "with a sink the setter MUST NOT allocate a local struct buffer");

  // (d) a name the layout does not declare is detached, recorded, and writes nowhere.
  const detached = createUniform(undefined, { glslType: "float" }, "u_notInLayout", undefined, { layout: generated });
  assert.match(String(detached._detachedReason), /declares no uniform "u_notInLayout"/, "a detached uniform MUST record why nothing is written");
  detached.value = 99;
  detached.set();
  assert.equal(detached._bytesWritten, 0, "a detached uniform MUST NOT write into another member's bytes");

  // (e) a uniform type this slice cannot express MUST fail as `not-implemented`, never guess.
  assert.throws(
    () => createUniform(undefined, { type: 0x8b5d }, "u_skew", undefined),
    (error) => {
      assert.equal(error.name, "DiagnosticError");
      assert.equal(error.category, "not-implemented");
      assert.match(error.message, /0x8b5d/);
      return true;
    },
    "an unknown GL uniform type MUST raise not-implemented (FR-033) instead of building a wrong struct",
  );
  // (f) a missing descriptor is a wiring error and MUST still be diagnosable (contract §6).
  assert.throws(
    () => createUniform(undefined, undefined, "u_scale", undefined),
    (error) => {
      assert.equal(error.name, "DiagnosticError");
      assert.equal(error.category, "internal");
      assert.match(error.message, /uniform descriptor/);
      return true;
    },
    "a missing WebGLActiveInfo MUST raise a DiagnosticError, never a bare TypeError",
  );
});

test("sampler setters keep upstream's texture-unit bookkeeping and fail loudly on bind", async () => {
  const { layout } = await loadWriter();
  const createUniform = (await loadCreateUniform()).default;
  const createUniformArray = (await loadCreateUniformArray()).default;
  const generated = layout.layoutUniforms([{ name: "u_dayTextures", glslType: "sampler2D", size: 2 }]);
  assert.equal(generated.samplers.length, 2, "a sampler2D[N] MUST become N texture/sampler pairs in the sampler bind group");
  assert.equal(generated.members.length, 0, "a sampler MUST NOT be a member of the uniform struct (data-model §4.3)");

  const single = createUniform(undefined, { glslType: "sampler2D" }, "u_dayTextures", undefined, { layout: generated });
  assert.equal(typeof single._setSampler, "function", "a sampler setter MUST keep upstream's `_setSampler` hook");
  assert.equal(single.textureUnitIndex, undefined, "no texture unit is assigned before ShaderProgram walks its samplers");
  assert.equal(single._setSampler(3), 4, "a single sampler MUST consume exactly one texture unit index");
  assert.equal(single.textureUnitIndex, 3, "_setSampler MUST record the index upstream would have assigned");
  assert.throws(
    () => single.set(),
    (error) => {
      assert.equal(error.name, "DiagnosticError");
      assert.equal(error.category, "not-implemented");
      assert.match(error.message, /u_dayTextures/);
      return true;
    },
    "binding a texture is outside the uniform-buffer slice, so set() MUST fail loudly instead of silently drawing black (FR-033)",
  );

  const array = createUniformArray(undefined, { glslType: "sampler2D", size: 2 }, "u_dayTextures", 2, { layout: generated });
  assert.equal(array.value.length, 2, "an array setter MUST expose one value slot per element, like upstream");
  assert.equal(array._locations.length, 2, "an array sampler MUST keep upstream's `_locations`");
  assert.equal(array._setSampler(0), 2, "an array sampler MUST consume one texture unit per element");
  assert.throws(() => array.set(), /not-implemented|u_dayTextures/, "the array sampler MUST fail loudly too");

  // A sink that can bind textures takes over: this is how T075 wires the sampler bind group.
  const bound = [];
  const wired = createUniform(undefined, { glslType: "sampler2D" }, "u_dayTextures", undefined, {
    layout: generated,
    writer: { writeMember: () => {}, writeSampler: (name, value) => bound.push([name, value]) },
  });
  wired.value = "texture-0";
  wired.set();
  assert.deepEqual(bound, [["u_dayTextures", "texture-0"]], "a bind-group-capable writer MUST receive the sampler value instead of the diagnostic");
});

test("createUniformArray diffs per element and reuses upstream's array setter shape", async () => {
  const { layout, writer } = await loadWriter();
  const createUniformArray = (await loadCreateUniformArray()).default;
  const generated = layout.layoutUniforms([{ name: "u_scales", glslType: "float", size: 3 }]);

  const setter = createUniformArray(undefined, { glslType: "float", size: 3 }, "u_scales", 3, { layout: generated });
  assert.equal(setter.name, "u_scales", "the array setter MUST keep upstream's `.name`");
  assert.equal(setter.value.length, 3, "upstream sizes `value` from the element count");
  assert.equal(setter._location, undefined, "an element count carries no GL location, so `_location` MUST stay undefined");
  const withLocations = createUniformArray(undefined, { glslType: "float", size: 3 }, "u_scales", ["loc-0", "loc-1", "loc-2"], { layout: generated });
  assert.equal(withLocations._location, "loc-0", "upstream keeps `locations[0]` as `_location`, and so MUST this replacement");
  assert.equal(withLocations.value.length, 3, "the element count MUST also come from an explicit locations array");
  setter.value = [1, 2, 3];
  setter.set();
  assert.equal(setter._bytesWritten, 12, "three f32 elements MUST be 12 bytes");
  const view = new DataView(setter._buffer);
  assert.deepEqual(
    [0, 1, 2].map((element) => writer.readScalar(view, element * 16, "f32")),
    [1, 2, 3],
    "each element MUST be written at the widened arrayStride",
  );
  setter.set();
  assert.equal(setter._bytesWritten, 12, "re-assigning equal elements MUST NOT write again");
  setter.value[1] = 20;
  setter.set();
  assert.equal(setter._bytesWritten, 16, "only the element that changed may be rewritten (4 bytes)");

  // Standalone mode sizes the implicit layout from the element count too.
  const implicit = createUniformArray(undefined, { glslType: "vec2", size: 2 }, "u_offsets", 2);
  assert.equal(implicit.value.length, 2, "the standalone mode MUST size `value` from the element count");
  assert.equal(implicit._target.field.length, 2, "the implicit array layout MUST declare two elements");
  assert.equal(implicit._target.field.paddedElement, true, "a vec2 array MUST be widened to vec4 elements in the uniform address space");
  implicit.value = [
    { x: 1, y: 2 },
    { x: 3, y: 4 },
  ];
  implicit.set();
  assert.equal(implicit._bytesWritten, 16, "two vec2 elements MUST write 2 lanes each, and never touch the padding lanes");
});
