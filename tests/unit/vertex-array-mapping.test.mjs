/**
 * T060 — `VertexArray` → `GPUVertexBufferLayout[]` (`层=单元`, tasks.md T060; research §6.1/§1.6).
 *
 * The layout asserted here is the one the terrain path really uses: the attribute lists are produced
 * by the **real upstream `TerrainEncoding`** (`getAttributes()` + `getAttributeLocations()`) for both
 * quantization modes, so the test cannot drift away from what `GlobeSurfaceTile` will build in W5.
 *
 * Also asserted: every attribute field survives (`index` / `componentDatatype` /
 * `componentsPerAttribute` / `normalized` / `offsetInBytes` / `strideInBytes` / `instanced` /
 * `divisor`), `instanced`/`divisor: 1` becomes `stepMode: "instance"`, a constant attribute becomes
 * `arrayStride: 0`, the index buffer yields the right `GPUIndexFormat`, and the layouts WebGPU cannot
 * express (divisor > 1, one buffer with two strides) fail loudly.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assertDiagnostic, createFakeGpuContext, installWebgpuGlobals } from "../support/fake-gpu.mjs";
import { upstreamStubs } from "../support/upstream-stubs.mjs";

installWebgpuGlobals();

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function loadModules() {
  const { default: Buffer } = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/Buffer.ts`), { externals: upstreamStubs() });
  const { default: VertexArray } = await loadTypeScriptModule(repoPath(`${BACKEND}/Renderer/VertexArray.ts`), { externals: upstreamStubs() });
  return { Buffer, VertexArray };
}

async function upstreamEnums() {
  const { default: BufferUsage } = await import("@cesium/engine/Source/Renderer/BufferUsage.js");
  const { default: ComponentDatatype } = await import("@cesium/engine/Source/Core/ComponentDatatype.js");
  return { BufferUsage, ComponentDatatype };
}

test("the attribute list maps field-for-field onto a GPUVertexBufferLayout", async () => {
  const { Buffer, VertexArray } = await loadModules();
  const { BufferUsage, ComponentDatatype } = await upstreamEnums();
  const context = createFakeGpuContext();

  const vertexBuffer = Buffer.createVertexBuffer({ context, typedArray: new Float32Array(3 * 4), usage: BufferUsage.STATIC_DRAW });
  const indexBuffer = Buffer.createIndexBuffer({ context, typedArray: new Uint16Array([0, 1, 2]), usage: BufferUsage.STATIC_DRAW, indexDatatype: 0x1403 });
  const vertexArray = new VertexArray({
    context,
    attributes: [{ index: 0, vertexBuffer, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, normalize: false, offsetInBytes: 0, strideInBytes: 12 }],
    indexBuffer,
  });

  assert.equal(vertexArray.numberOfAttributes, 1);
  assert.equal(vertexArray.numberOfVertices, 4, "sizeInBytes / stride");
  assert.equal(vertexArray.indexBuffer, indexBuffer);
  assert.equal(vertexArray.hasInstancedAttributes, false);

  const bindings = vertexArray.toGpuVertexBuffers();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].slot, 0);
  assert.equal(bindings[0].buffer, vertexBuffer._getBuffer());
  assert.equal(bindings[0].layout.arrayStride, 12);
  assert.equal(bindings[0].layout.stepMode, "vertex");
  assert.deepEqual([...bindings[0].layout.attributes], [{ shaderLocation: 0, offset: 0, format: "float32x3" }]);

  const index = vertexArray.toGpuIndexBuffer();
  assert.equal(index.format, "uint16");
  assert.equal(index.offset, 0);
  assert.equal(index.buffer, indexBuffer._getBuffer());

  const payload = vertexArray.__webgpu;
  assert.equal(payload.indexed, true, "an index buffer means the draw is indexed");
  assert.equal(payload.vertexBuffers.length, 1);
  assert.equal(payload.vertexBuffers[0].slot, 0);
  assert.deepEqual(
    payload.vertexLayout.map((attribute) => ({ index: attribute.index, stride: attribute.strideInBytes, normalized: attribute.normalized })),
    [{ index: 0, stride: 12, normalized: false }],
    "the upstream-shaped list the pipeline cache fingerprints MUST stay in upstream's spelling",
  );

  vertexArray.destroy();
  assert.equal(vertexArray.isDestroyed(), true);
});

test("the terrain vertex layouts (both quantization modes) survive the mapping", async () => {
  const { Buffer, VertexArray } = await loadModules();
  const { BufferUsage, ComponentDatatype } = await upstreamEnums();
  const { default: TerrainEncoding } = await import("@cesium/engine/Source/Core/TerrainEncoding.js");
  const { default: TerrainQuantization } = await import("@cesium/engine/Source/Core/TerrainQuantization.js");
  const { default: AxisAlignedBoundingBox } = await import("@cesium/engine/Source/Core/AxisAlignedBoundingBox.js");
  const { default: Cartesian3 } = await import("@cesium/engine/Source/Core/Cartesian3.js");
  const { default: Matrix4 } = await import("@cesium/engine/Source/Core/Matrix4.js");

  /** Build a VertexArray exactly the way `GlobeSurfaceTile` will: `encoding.getAttributes(buffer)`. */
  const layoutFor = (encoding, vertexCount) => {
    const context = createFakeGpuContext();
    const byteLength = encoding.stride * ComponentDatatype.getSizeInBytes(ComponentDatatype.FLOAT) * vertexCount;
    const buffer = Buffer.createVertexBuffer({ context, typedArray: new Float32Array(byteLength / 4), usage: BufferUsage.DYNAMIC_DRAW });
    const attributes = encoding.getAttributes(buffer);
    const vertexArray = new VertexArray({ context, attributes });
    return { vertexArray, attributes, strideInBytes: encoding.stride * 4, context };
  };

  // ---- quantization NONE: no bounding box means the encoding stays unquantized (upstream:73-77),
  // so this is the layout the REAL constructor produces, not a patched property.
  const none = new TerrainEncoding(undefined, undefined, undefined, undefined, undefined, true, true, true);
  assert.equal(none.quantization, TerrainQuantization.NONE);
  assert.deepEqual(none.getAttributeLocations(), { position3DAndHeight: 0, textureCoordAndEncodedNormals: 1, geodeticSurfaceNormal: 2 });
  const noneLayout = layoutFor(none, 4);
  const noneBindings = noneLayout.vertexArray.toGpuVertexBuffers();
  assert.equal(noneBindings.length, 1, "every attribute shares one interleaved buffer");
  assert.equal(noneBindings[0].layout.arrayStride, noneLayout.strideInBytes);
  const noneAttributes = [...noneBindings[0].layout.attributes].sort((left, right) => left.shaderLocation - right.shaderLocation);
  assert.deepEqual(
    noneAttributes,
    [
      { shaderLocation: 0, offset: 0, format: "float32x4" },
      { shaderLocation: 1, offset: 16, format: "float32x4" },
      { shaderLocation: 2, offset: 32, format: "float32x3" },
    ],
    "the NONE-quantization layout of upstream 26.3.0",
  );
  assert.equal(noneLayout.vertexArray.numberOfVertices, 4);
  assert.deepEqual(
    noneLayout.vertexArray.toVertexLayoutLike().map((attribute) => [attribute.index, attribute.componentDatatype, attribute.componentsPerAttribute, attribute.offsetInBytes, attribute.strideInBytes]),
    [
      [0, ComponentDatatype.FLOAT, 4, 0, noneLayout.strideInBytes],
      [1, ComponentDatatype.FLOAT, 4, 16, noneLayout.strideInBytes],
      [2, ComponentDatatype.FLOAT, 3, 32, noneLayout.strideInBytes],
    ],
    "every attribute field is preserved for the pipeline fingerprint",
  );

  // ---- quantization BITS12: a small bounding box drives upstream into the quantized layout
  // (`TerrainEncoding.js:73-77`), which is what a real terrain tile with a < 4095 m diagonal uses.
  const bits12 = new TerrainEncoding(
    Cartesian3.ZERO,
    new AxisAlignedBoundingBox(new Cartesian3(-100, -100, -100), new Cartesian3(100, 100, 100)),
    0,
    200,
    Matrix4.IDENTITY,
    true,
    true,
    true,
  );
  assert.equal(bits12.quantization, TerrainQuantization.BITS12);
  assert.deepEqual(bits12.getAttributeLocations(), { compressed0: 0, compressed1: 1, geodeticSurfaceNormal: 2 });
  const bits12Layout = layoutFor(bits12, 4);
  const bits12Bindings = bits12Layout.vertexArray.toGpuVertexBuffers();
  assert.equal(bits12Bindings.length, 1);
  const bits12Attributes = [...bits12Bindings[0].layout.attributes].sort((left, right) => left.shaderLocation - right.shaderLocation);
  assert.deepEqual(bits12Attributes, [
    { shaderLocation: 0, offset: 0, format: "float32x4" },
    { shaderLocation: 1, offset: 16, format: "float32" },
    { shaderLocation: 2, offset: 20, format: "float32x3" },
  ]);
  assert.equal(bits12Bindings[0].layout.arrayStride, bits12Layout.strideInBytes);
});

test("instanced attributes become stepMode instance; a constant attribute becomes arrayStride 0", async () => {
  const { Buffer, VertexArray } = await loadModules();
  const { BufferUsage, ComponentDatatype } = await upstreamEnums();
  const context = createFakeGpuContext();

  const perVertex = Buffer.createVertexBuffer({ context, typedArray: new Float32Array(3 * 3), usage: BufferUsage.DYNAMIC_DRAW });
  const perInstance = Buffer.createVertexBuffer({ context, typedArray: new Float32Array(2 * 4), usage: BufferUsage.DYNAMIC_DRAW });
  const vertexArray = new VertexArray({
    context,
    attributes: [
      { index: 0, vertexBuffer: perVertex, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, strideInBytes: 12 },
      { index: 1, vertexBuffer: perInstance, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 4, strideInBytes: 16, instanced: true, divisor: 1 },
      { index: 2, value: [0, 0, 1, 1], componentDatatype: ComponentDatatype.FLOAT },
    ],
  });

  const bindings = vertexArray.toGpuVertexBuffers();
  assert.equal(bindings.length, 3, "two buffers plus the constant's own one-element buffer");
  assert.deepEqual(bindings.map((binding) => binding.layout.stepMode), ["vertex", "instance", "vertex"]);
  assert.equal(bindings[1].layout.arrayStride, 16);
  assert.equal(vertexArray.hasInstancedAttributes, true);
  assert.equal(bindings[2].layout.arrayStride, 0, "a constant attribute is read with arrayStride 0 (WebGPU's `glVertexAttrib4fv`)");
  assert.deepEqual([...bindings[2].layout.attributes], [{ shaderLocation: 2, offset: 0, format: "float32x4" }]);
  assert.equal(bindings[2].buffer.size >= 16, true, "the constant gets its own small buffer");

  // `instanceDivisor` (upstream's internal spelling) is accepted like `divisor`.
  const viaInstanceDivisor = new VertexArray({
    context,
    attributes: [
      { index: 0, vertexBuffer: perVertex, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, strideInBytes: 12 },
      { index: 3, vertexBuffer: perInstance, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 4, strideInBytes: 16, instanceDivisor: 1 },
    ],
  });
  assert.deepEqual(viaInstanceDivisor.toGpuVertexBuffers().map((binding) => binding.layout.stepMode), ["vertex", "instance"]);
});

test("the layouts WebGPU cannot express fail loudly instead of drawing the wrong geometry", async () => {
  const { Buffer, VertexArray } = await loadModules();
  const { BufferUsage, ComponentDatatype } = await upstreamEnums();
  const context = createFakeGpuContext();
  const buffer = Buffer.createVertexBuffer({ context, typedArray: new Float32Array(16), usage: BufferUsage.DYNAMIC_DRAW });
  /** The layouts are computed lazily, so the failure surfaces on the first `toGpuVertexBuffers()`. */
  const layoutOf = (attributes) => new VertexArray({ context, attributes }).toGpuVertexBuffers();

  assert.throws(
    () =>
      layoutOf([
        { index: 0, vertexBuffer: buffer, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, strideInBytes: 12 },
        { index: 5, vertexBuffer: buffer, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, strideInBytes: 16 },
      ]),
    (error) => {
      assertDiagnostic(error, "internal", "one buffer, two strides");
      assert.match(error.message, /arrayStride/);
      return true;
    },
  );
  assert.throws(
    () =>
      layoutOf([
        { index: 0, vertexBuffer: buffer, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, strideInBytes: 12 },
        { index: 1, vertexBuffer: buffer, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, strideInBytes: 12, instanceDivisor: 1 },
        { index: 2, vertexBuffer: buffer, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, strideInBytes: 12 },
      ]),
    (error) => assertDiagnostic(error, "internal", "one buffer, two step modes"),
  );
  assert.throws(
    () => layoutOf([{ index: 1, vertexBuffer: buffer, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, strideInBytes: 12, divisor: 2 }]),
    (error) => {
      assertDiagnostic(error, "not-implemented", "divisor > 1");
      assert.match(error.message, /stepMode/);
      return true;
    },
  );
  assert.throws(() => new VertexArray({ context, attributes: [{ index: 0 }] }), (error) => assertDiagnostic(error, "internal", "attribute with neither buffer nor value"));
  assert.throws(
    () => new VertexArray({ context, attributes: [{ index: 0, vertexBuffer: buffer, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 5, strideInBytes: 20 }] }),
    (error) => assertDiagnostic(error, "internal", "componentsPerAttribute > 4"),
  );
  assert.throws(
    () =>
      new VertexArray({
        context,
        attributes: [
          { index: 0, vertexBuffer: buffer, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, strideInBytes: 12 },
          { index: 0, vertexBuffer: buffer, componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, strideInBytes: 12 },
        ],
      }),
    (error) => assertDiagnostic(error, "internal", "duplicate attribute index"),
  );
});

test("fromGeometry builds buffers and the index type from the geometry (upstream's rule)", async () => {
  const { Buffer, VertexArray } = await loadModules();
  const { ComponentDatatype } = await upstreamEnums();
  const context = createFakeGpuContext();
  void Buffer;

  const vertexArray = VertexArray.fromGeometry({
    context,
    geometry: {
      attributes: {
        position: { componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
        normal: { componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
        batch: { componentDatatype: ComponentDatatype.FLOAT, value: [1, 2] },
      },
      indices: [0, 1, 2],
    },
    attributeLocations: { position: 0, normal: 1, batch: 2 },
    bufferUsage: 0x88e8,
  });

  assert.equal(vertexArray.numberOfVertices, 3);
  const bindings = vertexArray.toGpuVertexBuffers();
  const shaderLocations = bindings.flatMap((binding) => binding.layout.attributes.map((attribute) => attribute.shaderLocation)).sort();
  assert.deepEqual(shaderLocations, [0, 1, 2], "the attributeLocations mapping decides the shader locations");
  assert.equal(vertexArray.toGpuIndexBuffer().format, "uint16", "a small geometry uses Uint16 indices");

  const largeGeometry = VertexArray.fromGeometry({
    context: createFakeGpuContext({ capabilities: { elementIndexUint: true } }),
    geometry: {
      attributes: { position: { componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: [0, 0, 0] } },
      indices: [0, 70000, 1],
    },
    attributeLocations: { position: 0 },
  });
  assert.equal(largeGeometry.toGpuIndexBuffer().format, "uint32", "indices above 65535 select Uint32");

  assert.throws(() => VertexArray.fromGeometry({}), (error) => assertDiagnostic(error, "internal", "fromGeometry without a context"));
});
