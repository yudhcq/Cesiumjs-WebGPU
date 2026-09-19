/**
 * T090 — upstream terrain vertex-buffer attribute layout, MEASURED (`层=单元`).
 *
 * Why this file exists: the patch layer consumes the terrain vertex buffer, and it currently decides
 * locations/offsets from constants it **copied** out of upstream
 * (`packages/cesium-webgpu/backend-webgpu/webgpu/varying-contract.ts:63-67`, `:320-326`, whose own
 * comment says "`TerrainEncoding.js:650-656`"). A copy is only as good as the commit it was read from.
 * So this suite calls the upstream implementation itself — `TerrainEncoding#getAttributeLocations()`
 * and `TerrainEncoding#getAttributes()` — and never restates a table of its own. Every number below
 * was produced by upstream at test time; a duplicated constant table here would have no discriminative
 * power against the duplication it is meant to catch.
 *
 * 勘误（以实测为准；派发说明与实际不符之处，均给上游出处）:
 *   1. 属性名→location **随量化模式变化**（`Core/TerrainEncoding.js:649-658`, `:733-738`）。只有 NONE 返回
 *      `position3DAndHeight: 0` / `textureCoordAndEncodedNormals: 1` / `geodeticSurfaceNormal: 2`；
 *      BITS12 返回 `compressed0: 0` / `compressed1: 1` / `geodeticSurfaceNormal: 2`。
 *      「position3DAndHeight→0 …」这一组断言只对 NONE 成立，BITS12 下前两个名字上游根本没有。
 *   2. `getAttributeLocations()` 返回的是**静态表**，与 `getAttributes()`（`:689-723`）实际发出的属性
 *      **不是**一一对应：表里恒有 3 个名字，而 `geodeticSurfaceNormal` / `compressed1` 只在对应开关
 *      打开时才被发出（用例 2/3 实测）。槽位表因此不能当作"缓冲区里有什么"的承诺。
 *   3. 上游 `Renderer/VertexArray.js` 已**没有** `vertexFormat` 参数（grep 零命中）；属性以
 *      `{componentDatatype, componentsPerAttribute, normalize, offsetInBytes, strideInBytes}` 描述
 *      （`VertexArray.js:615-631`, `:664`, `:102` 的默认值）。`IndexDatatype` 只出现在
 *      `VertexArray.fromGeometry`（`VertexArray.js:697-715`），而它需要真实 GPU context，单元层无法
 *      构造，故索引规则改为直接实测 `IndexDatatype.createTypedArray`（用例 6），另附一条标注为
 *      **结构核对（非行为）** 的源码检查把该规则挂回 `fromGeometry`。
 *   4. 顶点属性类型为 FLOAT 且**非归一化**的实际含义是：`getAttributes()` 的 descriptor **根本不带**
 *      `normalize`/`normalized` 键（用例 5 实测键集），而 `VertexArray` 对缺失值取 `?? false`
 *      （`VertexArray.js:102`）——不是 descriptor 里写着 `normalize: false`。
 *   5. 用例标题沿用仓库实际多数派（英文）：实测 `tests/unit/**` 现有 442 个顶层用例中 441 个用英文
 *      标题（唯一例外是 `check-gate.test.mjs` 的 1 个），而非派发说明里写的"中文标题"；中文说明放注释。
 *
 * `TerrainEncoding`（`TerrainEncoding.js:38`）与 `TerrainQuantization`（`TerrainQuantization.js:8`）
 * 上游均标注 `@private`。本文件只在**测试层**直接读这两个模块，这是允许的；已核对 `packages` 目录下的
 * 全部 `.ts` 文件对这两个名字**没有任何 import**（只有注释/字符串提及），即产品代码不引用它们。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../support/repo.mjs";

const TERRAIN_ENCODING_MODULE = "@cesium/engine/Source/Core/TerrainEncoding.js";
const VERTEX_ARRAY_SOURCE = "node_modules/@cesium/engine/Source/Renderer/VertexArray.js";

const { default: TerrainEncoding } = await import(TERRAIN_ENCODING_MODULE);
const { default: TerrainQuantization } = await import("@cesium/engine/Source/Core/TerrainQuantization.js");
const { default: AxisAlignedBoundingBox } = await import("@cesium/engine/Source/Core/AxisAlignedBoundingBox.js");
const { default: Cartesian3 } = await import("@cesium/engine/Source/Core/Cartesian3.js");
const { default: Matrix4 } = await import("@cesium/engine/Source/Core/Matrix4.js");
const { default: ComponentDatatype } = await import("@cesium/engine/Source/Core/ComponentDatatype.js");
const { default: IndexDatatype } = await import("@cesium/engine/Source/Core/IndexDatatype.js");
const { default: CesiumMath } = await import("@cesium/engine/Source/Core/Math.js");
const { default: VertexArray } = await import("@cesium/engine/Source/Renderer/VertexArray.js");

const FLOAT = ComponentDatatype.FLOAT;
const FLOAT_BYTES = ComponentDatatype.getSizeInBytes(FLOAT);

/** NONE: upstream stays unquantized when the bounding-box arguments are missing (`TerrainEncoding.js:56-77`). */
function unquantized({ vertexNormals = false, webMercatorT = false, geodeticSurfaceNormals = false } = {}) {
  return new TerrainEncoding(undefined, undefined, undefined, undefined, undefined, vertexNormals, webMercatorT, geodeticSurfaceNormals);
}

/** BITS12: the largest tile dimension must be `< 4095` for upstream to pick the 12-bit layout (same lines). */
function quantized({ vertexNormals = false, webMercatorT = false, geodeticSurfaceNormals = false, extent = 200 } = {}) {
  return new TerrainEncoding(
    Cartesian3.ZERO,
    new AxisAlignedBoundingBox(new Cartesian3(0, 0, 0), new Cartesian3(extent, extent, extent)),
    0,
    extent,
    Matrix4.IDENTITY,
    vertexNormals,
    webMercatorT,
    geodeticSurfaceNormals,
  );
}

/** Raw descriptors, exactly as `getAttributes()` returns them (keys included — see use case 6). */
function descriptorsOf(encoding, vertexCount = 4) {
  return encoding.getAttributes(new Float32Array(encoding.stride * vertexCount));
}

/** `[location, datatype, componentsPerAttribute, offsetInBytes, strideInBytes]` per emitted attribute. */
function tuplesOf(encoding) {
  return descriptorsOf(encoding).map((attribute) => [
    attribute.index,
    attribute.componentDatatype,
    attribute.componentsPerAttribute,
    attribute.offsetInBytes,
    attribute.strideInBytes,
  ]);
}

test("the attribute-name → location table is produced by upstream getAttributeLocations()", () => {
  assert.equal(TerrainQuantization.NONE, 0);
  assert.equal(TerrainQuantization.BITS12, 1);

  const none = unquantized({ vertexNormals: true, webMercatorT: true, geodeticSurfaceNormals: true });
  const bits12 = quantized({ vertexNormals: true, webMercatorT: true, geodeticSurfaceNormals: true });
  assert.equal(none.quantization, TerrainQuantization.NONE);
  assert.equal(bits12.quantization, TerrainQuantization.BITS12);

  // The trio the dispatch names — a live read of upstream, not a copy of `TerrainEncoding.js:649-653`.
  const noneLocations = none.getAttributeLocations();
  assert.equal(noneLocations.position3DAndHeight, 0);
  assert.equal(noneLocations.textureCoordAndEncodedNormals, 1);
  assert.equal(noneLocations.geodeticSurfaceNormal, 2, "geodeticSurfaceNormal IS in upstream's NONE table (TerrainEncoding.js:649-653)");
  assert.deepEqual(noneLocations, { position3DAndHeight: 0, textureCoordAndEncodedNormals: 1, geodeticSurfaceNormal: 2 });

  // Erratum 1: BITS12 renames slots 0/1 (`TerrainEncoding.js:654-658`); the dispatch's names do not exist there.
  const bits12Locations = bits12.getAttributeLocations();
  assert.deepEqual(bits12Locations, { compressed0: 0, compressed1: 1, geodeticSurfaceNormal: 2 });
  assert.equal("position3DAndHeight" in bits12Locations, false, "BITS12 has no position3DAndHeight");
  assert.equal("textureCoordAndEncodedNormals" in bits12Locations, false, "BITS12 has no textureCoordAndEncodedNormals");

  // Names ↔ slots are a closed loop per mode: every emitted slot is named, and names are unique.
  for (const [label, encoding, table] of [["NONE", none, noneLocations], ["BITS12", bits12, bits12Locations]]) {
    const values = Object.values(table);
    assert.equal(new Set(values).size, values.length, `${label}: upstream's names must map to distinct slots`);
    const named = new Set(values);
    for (const attribute of descriptorsOf(encoding)) {
      assert.ok(named.has(attribute.index), `${label}: emitted slot ${attribute.index} has no name in upstream's table`);
    }
    assert.equal(table.geodeticSurfaceNormal, 2, `${label}: the one name both modes share keeps slot 2`);
  }
});

test("quantization NONE: componentsPerAttribute / offsetInBytes / strideInBytes per attribute", () => {
  const full = unquantized({ vertexNormals: true, webMercatorT: true, geodeticSurfaceNormals: true });
  assert.equal(full.stride, 11, "upstream counts the stride in FLOATS: 6 + 1 + 1 + 3 (TerrainEncoding.js:624-646)");
  assert.deepEqual(tuplesOf(full), [
    [0, FLOAT, 4, 0, 44],
    [1, FLOAT, 4, 16, 44],
    [2, FLOAT, 3, 32, 44],
  ]);

  const fullDescriptors = descriptorsOf(full);
  assert.equal(fullDescriptors[0].strideInBytes, full.stride * FLOAT_BYTES, "descriptor stride = upstream's float stride × 4 bytes");
  let cursor = 0;
  for (const attribute of fullDescriptors) {
    assert.equal(attribute.offsetInBytes, cursor, `slot ${attribute.index} starts exactly where the previous one ended (no padding)`);
    assert.equal(attribute.strideInBytes, full.stride * FLOAT_BYTES);
    cursor += attribute.componentsPerAttribute * FLOAT_BYTES;
  }
  assert.equal(cursor, fullDescriptors[0].strideInBytes, "the attributes exactly fill the stride — one interleaved buffer");

  // The layout is a function of the flags, which is why a hard-coded offset table cannot be right in general.
  assert.deepEqual(tuplesOf(unquantized()), [
    [0, FLOAT, 4, 0, 24],
    [1, FLOAT, 2, 16, 24],
  ], "bare NONE: 6 floats/vertex, vec2 texture coordinates, and no slot 2 at all");
  assert.deepEqual(tuplesOf(unquantized({ webMercatorT: true })), [
    [0, FLOAT, 4, 0, 28],
    [1, FLOAT, 3, 16, 28],
  ], "webMercatorT adds exactly one component to slot 1 (7 floats = 28 bytes)");
  assert.deepEqual(tuplesOf(unquantized({ vertexNormals: true })), [
    [0, FLOAT, 4, 0, 28],
    [1, FLOAT, 3, 16, 28],
  ], "a vertex normal adds one component to the same slot — the descriptor alone cannot tell the two apart");
  assert.deepEqual(tuplesOf(unquantized({ geodeticSurfaceNormals: true })), [
    [0, FLOAT, 4, 0, 36],
    [1, FLOAT, 2, 16, 36],
    [2, FLOAT, 3, 24, 36],
  ], "geodeticSurfaceNormals is the only flag that creates slot 2 in NONE mode");

  // Erratum 2, measured: the static table still names slot 2 although nothing is emitted there.
  const bare = unquantized();
  assert.equal(bare.getAttributeLocations().geodeticSurfaceNormal, 2);
  assert.equal(tuplesOf(bare).some(([index]) => index === 2), false, "the table is not a promise about the buffer");
});

test("quantization BITS12: componentsPerAttribute / offsetInBytes / strideInBytes per attribute", () => {
  const full = quantized({ vertexNormals: true, webMercatorT: true, geodeticSurfaceNormals: true });
  assert.equal(full.stride, 8, "upstream counts the stride in FLOATS: 3 + 1 + 1 + 3 (TerrainEncoding.js:624-646)");
  assert.deepEqual(tuplesOf(full), [
    [0, FLOAT, 4, 0, 32],
    [1, FLOAT, 1, 16, 32],
    [2, FLOAT, 3, 20, 32],
  ], "compressed1 appears only because BOTH webMercatorT and vertex normals are set (TerrainEncoding.js:707-718)");

  // Erratum 2 in the other direction: `compressed1: 1` is always in the table, but the attribute is conditional.
  assert.equal(full.getAttributeLocations().compressed1, 1);
  assert.deepEqual(tuplesOf(quantized()), [
    [0, FLOAT, 3, 0, 12],
  ], "bare BITS12: 3 floats/vertex and NEITHER compressed1 nor geodeticSurfaceNormal is emitted");
  assert.deepEqual(tuplesOf(quantized({ webMercatorT: true })), [
    [0, FLOAT, 4, 0, 16],
  ], "one optional component widens compressed0 to vec4 instead of emitting compressed1");
  assert.deepEqual(tuplesOf(quantized({ vertexNormals: true })), [
    [0, FLOAT, 4, 0, 16],
  ], "same widening for a vertex normal");
  assert.deepEqual(tuplesOf(quantized({ geodeticSurfaceNormals: true })), [
    [0, FLOAT, 3, 0, 24],
    [2, FLOAT, 3, 12, 24],
  ], "geodeticSurfaceNormals keeps slot 2 and skips slot 1 entirely");

  const fullDescriptors = descriptorsOf(full);
  let cursor = 0;
  for (const attribute of fullDescriptors) {
    assert.equal(attribute.offsetInBytes, cursor, `slot ${attribute.index} is contiguous`);
    cursor += attribute.componentsPerAttribute * FLOAT_BYTES;
  }
  assert.equal(cursor, fullDescriptors[0].strideInBytes, "compressed0/compressed1/geodeticSurfaceNormal exactly fill 32 bytes");
});

test("the two quantization modes really produce different layouts (otherwise the mode axis proves nothing)", () => {
  const none = unquantized({ vertexNormals: true, webMercatorT: true, geodeticSurfaceNormals: true });
  const bits12 = quantized({ vertexNormals: true, webMercatorT: true, geodeticSurfaceNormals: true });
  const noneTuples = tuplesOf(none);
  const bits12Tuples = tuplesOf(bits12);

  assert.notDeepEqual(noneTuples, bits12Tuples);
  assert.notEqual(none.stride, bits12.stride, "11 floats/vertex vs 8");
  assert.notEqual(noneTuples[0].at(-1), bits12Tuples[0].at(-1), "44-byte stride vs 32-byte stride");

  const differences = noneTuples
    .map((tuple, index) => [tuple, bits12Tuples[index]])
    .filter(([left, right]) => JSON.stringify(left) !== JSON.stringify(right));
  assert.ok(differences.length > 0, "at least one attribute must differ field-for-field");
  assert.equal(noneTuples.length, bits12Tuples.length, "both modes still emit three attributes with all flags on");

  // Both modes are genuinely reachable, and the extent alone flips them — so neither branch is dead code.
  assert.equal(quantized({ extent: 4094 }).quantization, TerrainQuantization.BITS12, "maxDim 4094 < 4095 ⇒ BITS12");
  assert.equal(quantized({ extent: 4095 }).quantization, TerrainQuantization.NONE, "maxDim 4095 is NOT < 4095 ⇒ NONE");
  const noneViaBox = quantized({ extent: 9000, vertexNormals: true, webMercatorT: true, geodeticSurfaceNormals: true });
  assert.equal(noneViaBox.quantization, TerrainQuantization.NONE);
  assert.deepEqual(tuplesOf(noneViaBox), noneTuples, "NONE reached through a large bounding box behaves identically");
});

test("every vertex attribute is FLOAT and none of them asks to be normalized", () => {
  assert.equal(FLOAT, 5126, "ComponentDatatype.FLOAT");
  assert.equal(FLOAT_BYTES, 4);

  const encodings = [
    unquantized({ vertexNormals: true, webMercatorT: true, geodeticSurfaceNormals: true }),
    unquantized(),
    quantized({ vertexNormals: true, webMercatorT: true, geodeticSurfaceNormals: true }),
    quantized(),
  ];

  for (const encoding of encodings) {
    const label = `quantization ${encoding.quantization}`;
    const descriptors = descriptorsOf(encoding);
    assert.ok(descriptors.length > 0, `${label}: at least one attribute`);
    for (const attribute of descriptors) {
      assert.equal(attribute.componentDatatype, FLOAT, `${label} slot ${attribute.index} must be FLOAT`);
      // The decisive fact: upstream's descriptor does not carry a normalization request at all, so the
      // renderer's default applies — `VertexArray.js:102` reads `attribute.normalize ?? false`.
      assert.deepEqual(
        Object.keys(attribute),
        ["index", "vertexBuffer", "componentDatatype", "componentsPerAttribute", "offsetInBytes", "strideInBytes"],
        `${label} slot ${attribute.index} must not request normalization`,
      );
      assert.equal(attribute.normalize, undefined, `${label} slot ${attribute.index}`);
      assert.equal(attribute.normalized, undefined, `${label} slot ${attribute.index}`);
    }
  }

  // Structural check (NOT behavioural): pins the default the missing key above falls back to. `VertexArray`
  // itself needs a GPU context, so its constructor cannot be run in this layer.
  const vertexArraySource = readText(VERTEX_ARRAY_SOURCE);
  assert.match(vertexArraySource, /normalize:\s*attribute\.normalize\s*\?\?\s*false/, "VertexArray.js:102 must still default normalize to false");
});

test("the index type follows the vertex count; both Uint16 and Uint32 are exercised", () => {
  assert.equal(CesiumMath.SIXTY_FOUR_KILOBYTES, 65536, "upstream's threshold (IndexDatatype.js:132)");
  assert.equal(IndexDatatype.UNSIGNED_SHORT, 5123);
  assert.equal(IndexDatatype.UNSIGNED_INT, 5125);

  // The rule, measured: `createTypedArray` switches to Uint32 exactly at 65536 vertices.
  assert.equal(IndexDatatype.createTypedArray(65535, 3).constructor, Uint16Array);
  assert.equal(IndexDatatype.createTypedArray(65536, 3).constructor, Uint32Array);
  assert.equal(IndexDatatype.createTypedArray(0, 0).constructor, Uint16Array, "an empty mesh stays Uint16");
  assert.equal(IndexDatatype.createTypedArray(65 * 65, 6).constructor, Uint16Array, "a 65×65 tile grid stays Uint16");
  assert.equal(IndexDatatype.createTypedArray(257 * 257, 6).constructor, Uint32Array, "a 257×257 tile grid needs Uint32");

  // Both types are not merely covered but *necessary*: the same index value survives only Uint32.
  assert.equal(IndexDatatype.createTypedArray(65536, [70000])[0], 70000);
  assert.equal(IndexDatatype.createTypedArray(65535, [70000])[0], 4464, "Uint16 would silently truncate an index above 65535");

  // The datatype constants agree with the typed arrays the rule returns.
  assert.equal(IndexDatatype.fromSizeInBytes(Uint16Array.BYTES_PER_ELEMENT), IndexDatatype.UNSIGNED_SHORT);
  assert.equal(IndexDatatype.fromSizeInBytes(Uint32Array.BYTES_PER_ELEMENT), IndexDatatype.UNSIGNED_INT);
  assert.equal(IndexDatatype.getSizeInBytes(IndexDatatype.UNSIGNED_SHORT), 2);
  assert.equal(IndexDatatype.getSizeInBytes(IndexDatatype.UNSIGNED_INT), 4);

  // Structural check (NOT behavioural): `VertexArray.fromGeometry` (VertexArray.js:697-715) applies the same
  // threshold and the same two datatypes, but it needs a live context (`Check.defined("options.context", …)`),
  // which the unit layer cannot provide — so the branch itself is exercised by the GPU-backed suite instead.
  const vertexArraySource = readText(VERTEX_ARRAY_SOURCE);
  assert.equal(typeof VertexArray.fromGeometry, "function");
  assert.match(vertexArraySource, /Geometry\.computeNumberOfVertices\(geometry\)\s*>=\s*CesiumMath\.SIXTY_FOUR_KILOBYTES/);
  assert.match(vertexArraySource, /indexDatatype:\s*IndexDatatype\.UNSIGNED_INT/);
  assert.match(vertexArraySource, /indexDatatype:\s*IndexDatatype\.UNSIGNED_SHORT/);
});
