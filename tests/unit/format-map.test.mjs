/**
 * T057 — format and type mapping tables (`层=单元`, tasks.md T057; research §6.1, data-model §5.2).
 *
 * Three obligations, each of which a wrong mapping would violate silently:
 *   1. **enum coverage**: every member of the upstream `PixelFormat` / `PixelDatatype` /
 *      `RenderbufferFormat` enum set is either mapped or refused with a `not-implemented`
 *      diagnostic — a member that simply falls through would produce a plausible but wrong texture;
 *   2. **the recorded equivalences**: where WebGPU has no counterpart (`RGB8`, `LUMINANCE`, `ALPHA`,
 *      `RGBA4`) the mapping widens and *says so* (`notes`), and the widening direction is asserted
 *      (never toward fewer components);
 *   3. **fail-loud for the unsupported**: compressed formats, packed 16-bit sources and unknown enum
 *      values MUST throw a diagnosable error rather than pick a nearby format (FR-033).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repoPath } from "../support/repo.mjs";
import { loadTypeScriptModule } from "../support/ts-module-loader.mjs";
import { assertDiagnostic, installWebgpuGlobals } from "../support/fake-gpu.mjs";
import { upstreamStubs } from "../support/upstream-stubs.mjs";

installWebgpuGlobals();

const BACKEND = "packages/cesium-webgpu/backend-webgpu";

async function loadFormatMap() {
  return loadTypeScriptModule(repoPath(`${BACKEND}/webgpu/format-map.ts`), { externals: upstreamStubs() });
}

/** The upstream enum objects the mapping table consumes (via the same stubs the module uses). */
async function loadEnums() {
  const PixelFormat = (await import("@cesium/engine/Source/Core/PixelFormat.js")).default;
  const PixelDatatype = (await import("@cesium/engine/Source/Renderer/PixelDatatype.js")).default;
  const RenderbufferFormat = (await import("@cesium/engine/Source/Renderer/RenderbufferFormat.js")).default;
  const BufferUsage = (await import("@cesium/engine/Source/Renderer/BufferUsage.js")).default;
  return { PixelFormat, PixelDatatype, RenderbufferFormat, BufferUsage };
}

test("every (PixelFormat, PixelDatatype) pair is mapped or refused — silently falling through is impossible", async () => {
  const formatMap = await loadFormatMap();
  const { PixelFormat, PixelDatatype } = await loadEnums();
  const formats = Object.values(PixelFormat).filter((value) => typeof value === "number");
  const datatypes = Object.values(PixelDatatype).filter((value) => typeof value === "number");
  assert.ok(formats.length >= 20, `the upstream PixelFormat enum MUST expose its members (got ${formats.length})`);
  assert.ok(datatypes.length >= 5, `the upstream PixelDatatype enum MUST expose its members (got ${datatypes.length})`);

  let mapped = 0;
  let refused = 0;
  for (const pixelFormat of formats) {
    for (const pixelDatatype of datatypes) {
      try {
        const mapping = formatMap.mapTextureFormat(pixelFormat, pixelDatatype);
        mapped += 1;
        assert.ok(typeof mapping.format === "string" && mapping.format.length > 0, `${pixelFormat}/${pixelDatatype} MUST carry a GPUTextureFormat`);
        assert.ok(mapping.sourceComponents >= 1 && mapping.sourceComponents <= 4);
        assert.ok(mapping.gpuComponents >= mapping.sourceComponents, "a mapping MUST NOT drop components (widening only)");
        assert.ok(mapping.bytesPerComponent > 0);
        assert.ok(["identity", "widen", "unpack"].includes(mapping.uploadShape));
        if (mapping.uploadShape === "widen") {
          assert.ok(mapping.notes.length > 0, `${pixelFormat}/${pixelDatatype} widens, so it MUST record why`);
        }
      } catch (error) {
        refused += 1;
        assert.equal(error.name, "DiagnosticError", `${pixelFormat}/${pixelDatatype} MUST refuse diagnosably`);
        assert.equal(error.category, "not-implemented");
        assert.ok(error.details?.plannedPhase, "a refusal MUST name the phase/scope that owns the format");
      }
    }
  }
  assert.ok(mapped >= 30, `the MVP-relevant pairs MUST be mapped (got ${mapped})`);
  assert.ok(refused > 0, "the enum cross-product contains pairs this increment does not serve");
});

test("the terrain-relevant mappings are exact, with the equivalences recorded", async () => {
  const formatMap = await loadFormatMap();
  const { PixelFormat, PixelDatatype } = await loadEnums();

  const rgba8 = formatMap.mapTextureFormat(PixelFormat.RGBA, PixelDatatype.UNSIGNED_BYTE);
  assert.equal(rgba8.format, "rgba8unorm");
  assert.equal(rgba8.bytesPerPixel, 4);
  assert.equal(rgba8.uploadShape, "identity");
  assert.deepEqual([...rgba8.notes], [], "the RGBA8 mapping is exact and MUST NOT claim an approximation");

  const rgba8Srgb = formatMap.mapTextureFormat(PixelFormat.RGBA, PixelDatatype.UNSIGNED_BYTE, { srgb: true });
  assert.equal(rgba8Srgb.format, "rgba8unorm-srgb", "the sRGB target MUST be an explicit choice");
  assert.equal(rgba8Srgb.srgb, true);

  const rgb8 = formatMap.mapTextureFormat(PixelFormat.RGB, PixelDatatype.UNSIGNED_BYTE);
  assert.equal(rgb8.format, "rgba8unorm", "WebGPU has no RGB8: the mapping widens");
  assert.equal(rgb8.sourceComponents, 3);
  assert.equal(rgb8.gpuComponents, 4);
  assert.equal(rgb8.uploadShape, "widen");
  assert.ok(rgb8.notes.some((note) => /widened/i.test(note)), "the widening MUST be recorded (FR-023)");

  const luminance = formatMap.mapTextureFormat(PixelFormat.LUMINANCE, PixelDatatype.UNSIGNED_BYTE);
  assert.equal(luminance.gpuComponents, 4);
  assert.ok(luminance.notes.length > 0);

  const alpha = formatMap.mapTextureFormat(PixelFormat.ALPHA, PixelDatatype.UNSIGNED_BYTE);
  assert.equal(alpha.gpuComponents, 4);
  assert.ok(alpha.notes.length > 0);

  const red8 = formatMap.mapTextureFormat(PixelFormat.RED, PixelDatatype.UNSIGNED_BYTE);
  assert.equal(red8.format, "r8unorm", "RED maps to a real single-channel format (no widening needed)");
  assert.equal(red8.uploadShape, "identity");

  const rgba16f = formatMap.mapTextureFormat(PixelFormat.RGBA, PixelDatatype.HALF_FLOAT);
  assert.equal(rgba16f.format, "rgba16float");

  const rgba32f = formatMap.mapTextureFormat(PixelFormat.RGBA, PixelDatatype.FLOAT);
  assert.equal(rgba32f.format, "rgba32float");
  assert.equal(rgba32f.sampleType, "unfilterable-float", "core WebGPU cannot filter float32 textures");
  assert.ok(rgba32f.notes.length > 0);

  const depth16 = formatMap.mapTextureFormat(PixelFormat.DEPTH_COMPONENT, PixelDatatype.UNSIGNED_SHORT);
  assert.equal(depth16.format, "depth16unorm");
  const depth24 = formatMap.mapTextureFormat(PixelFormat.DEPTH_COMPONENT, PixelDatatype.UNSIGNED_INT);
  assert.equal(depth24.format, "depth24plus", "DEPTH_COMPONENT24 keeps its >=24-bit guarantee as a minimum");
  assert.ok(depth24.notes.some((note) => /depth24plus/.test(note)));
  const depthStencil = formatMap.mapTextureFormat(PixelFormat.DEPTH_STENCIL, PixelDatatype.UNSIGNED_INT_24_8);
  assert.equal(depthStencil.format, "depth24plus-stencil8");
});

test("unmappable inputs fail loudly instead of picking a nearby format", async () => {
  const formatMap = await loadFormatMap();
  const { PixelFormat, PixelDatatype } = await loadEnums();

  for (const compressed of [PixelFormat.RGB_DXT1, PixelFormat.RGBA_ASTC, PixelFormat.RGBA_BC7, PixelFormat.RGB8_ETC2]) {
    assert.throws(() => formatMap.mapTextureFormat(compressed, PixelDatatype.UNSIGNED_BYTE), (error) => {
      assertDiagnostic(error, "not-implemented", "compressed format");
      assert.match(error.message, /compressed/i);
      return true;
    });
  }
  assert.throws(() => formatMap.mapTextureFormat(PixelFormat.DEPTH_COMPONENT, PixelDatatype.FLOAT), (error) => assertDiagnostic(error, "not-implemented", "depth datatype"));
  assert.throws(() => formatMap.mapTextureFormat(0xdead, PixelDatatype.UNSIGNED_BYTE), (error) => assertDiagnostic(error, "not-implemented", "unknown pixel format"));
  assert.throws(() => formatMap.mapTextureFormat(PixelFormat.RED, PixelDatatype.UNSIGNED_BYTE, { srgb: true }), (error) => assertDiagnostic(error, "internal", "sRGB on a non-colour format"));
});

test("RenderbufferFormat covers all ten members and records the RGBA4-class equivalences", async () => {
  const formatMap = await loadFormatMap();
  const { RenderbufferFormat } = await loadEnums();
  const members = Object.values(RenderbufferFormat).filter((value) => typeof value === "number");
  assert.equal(members.length, 10, "the upstream RenderbufferFormat enum has ten members");

  const byFormat = new Map();
  for (const member of members) {
    const mapping = formatMap.mapRenderbufferFormat(member);
    byFormat.set(member, mapping);
    assert.ok(typeof mapping.format === "string");
    assert.ok(["color", "depth", "depth-stencil", "stencil"].includes(mapping.kind));
  }
  assert.equal(byFormat.get(RenderbufferFormat.RGBA8).format, "rgba8unorm");
  assert.equal(byFormat.get(RenderbufferFormat.RGBA16F).format, "rgba16float");
  assert.equal(byFormat.get(RenderbufferFormat.RGBA32F).format, "rgba32float");
  assert.equal(byFormat.get(RenderbufferFormat.DEPTH_COMPONENT16).format, "depth16unorm");
  assert.equal(byFormat.get(RenderbufferFormat.DEPTH24_STENCIL8).format, "depth24plus-stencil8");
  assert.equal(byFormat.get(RenderbufferFormat.DEPTH_STENCIL).format, "depth24plus-stencil8");
  assert.equal(byFormat.get(RenderbufferFormat.STENCIL_INDEX8).format, "stencil8");
  for (const member of [RenderbufferFormat.RGBA4, RenderbufferFormat.RGB5_A1, RenderbufferFormat.RGB565]) {
    const mapping = byFormat.get(member);
    assert.equal(mapping.format, "rgba8unorm");
    assert.ok(mapping.notes.length > 0, "a 4/5/6-bit attachment is an equivalence and MUST be recorded");
  }
  assert.throws(() => formatMap.mapRenderbufferFormat(0x1234), (error) => assertDiagnostic(error, "internal", "unknown RenderbufferFormat"));
});

test("buffer usage maps by role, always keeping COPY_DST (upstream may write at any time)", async () => {
  const formatMap = await loadFormatMap();
  const { BufferUsage } = await loadEnums();
  const vertex = formatMap.bufferUsageToGpu(BufferUsage.STATIC_DRAW, "vertex");
  assert.equal(vertex & GPUBufferUsage.VERTEX, GPUBufferUsage.VERTEX, "a vertex buffer MUST be usable as a vertex buffer");
  assert.equal(vertex & GPUBufferUsage.COPY_DST, GPUBufferUsage.COPY_DST, "copyFromArrayView may run at any time");
  assert.equal(vertex & GPUBufferUsage.INDEX, 0, "a vertex buffer MUST NOT claim INDEX usage");

  const index = formatMap.bufferUsageToGpu(BufferUsage.DYNAMIC_DRAW, "index");
  assert.equal(index & GPUBufferUsage.INDEX, GPUBufferUsage.INDEX);
  assert.equal(index & GPUBufferUsage.VERTEX, 0);

  const pixel = formatMap.bufferUsageToGpu(BufferUsage.DYNAMIC_READ, "pixel");
  assert.equal(pixel & GPUBufferUsage.MAP_READ, GPUBufferUsage.MAP_READ, "a pixel buffer exists to be read back");
  assert.equal(pixel & GPUBufferUsage.VERTEX, 0);

  assert.throws(() => formatMap.bufferUsageToGpu(0x9999, "vertex"), (error) => assertDiagnostic(error, "internal", "invalid usage"));
});

test("vertex formats cover the terrain layout and record the 1/3-component widenings", async () => {
  const formatMap = await loadFormatMap();
  const { ComponentDatatype } = formatMap;

  // research §1.6: every `TerrainEncoding` attribute is FLOAT and non-normalized.
  for (const components of [1, 2, 3, 4]) {
    const mapping = formatMap.vertexFormatFor(ComponentDatatype.FLOAT, components, false);
    assert.equal(mapping.format, `float32${components === 1 ? "" : `x${components}`}`);
    assert.equal(mapping.components, components);
  }
  const normalized = formatMap.vertexFormatFor(ComponentDatatype.UNSIGNED_BYTE, 4, true);
  assert.equal(normalized.format, "unorm8x4");
  const nonNormalized = formatMap.vertexFormatFor(ComponentDatatype.UNSIGNED_BYTE, 4, false);
  assert.equal(nonNormalized.format, "uint8x4");

  // WebGPU has no 1- or 3-component 8/16-bit format: the widening is recorded, never silent.
  const scalar = formatMap.vertexFormatFor(ComponentDatatype.UNSIGNED_BYTE, 1, true);
  assert.equal(scalar.format, "unorm8x2");
  assert.equal(scalar.components, 2);
  assert.ok(scalar.notes.length > 0);
  const threeComponent = formatMap.vertexFormatFor(ComponentDatatype.UNSIGNED_SHORT, 3, false);
  assert.equal(threeComponent.format, "uint16x4");
  assert.ok(threeComponent.notes.length > 0);

  assert.throws(() => formatMap.vertexFormatFor(ComponentDatatype.FLOAT, 5, false), (error) => assertDiagnostic(error, "internal", "componentsPerAttribute > 4"));
  assert.throws(() => formatMap.vertexFormatFor(ComponentDatatype.DOUBLE, 3, false), (error) => assertDiagnostic(error, "not-implemented", "DOUBLE attributes"));
  assert.throws(() => formatMap.vertexFormatFor(ComponentDatatype.FLOAT, 3, true), (error) => assertDiagnostic(error, "not-implemented", "normalized float"));
});

test("the size helpers agree with upstream's arithmetic", async () => {
  const formatMap = await loadFormatMap();
  const { PixelFormat, PixelDatatype } = await loadEnums();
  const PixelFormatUpstream = (await import("@cesium/engine/Source/Core/PixelFormat.js")).default;

  const cases = [
    [PixelFormat.RGBA, PixelDatatype.UNSIGNED_BYTE, 2, 2],
    [PixelFormat.RGB, PixelDatatype.UNSIGNED_BYTE, 3, 1],
    [PixelFormat.LUMINANCE, PixelDatatype.UNSIGNED_BYTE, 4, 4],
    [PixelFormat.RGBA, PixelDatatype.FLOAT, 2, 2],
    [PixelFormat.RGBA, PixelDatatype.UNSIGNED_SHORT_4_4_4_4, 4, 4],
  ];
  for (const [pixelFormat, pixelDatatype, width, height] of cases) {
    const mapping = formatMap.mapTextureFormat(pixelFormat, pixelDatatype);
    const upstream = PixelFormatUpstream.textureSizeInBytes(pixelFormat, pixelDatatype, width, height);
    assert.equal(mapping.bytesPerPixel * width * height, upstream, `bytesPerPixel MUST reproduce upstream's ${pixelFormat}/${pixelDatatype} arithmetic`);
  }
  assert.equal(formatMap.componentDatatypeSizeInBytes(ComponentDatatypeOf(formatMap).FLOAT), 4);
  assert.equal(formatMap.componentDatatypeSizeInBytes(ComponentDatatypeOf(formatMap).HALF_FLOAT), 2);
  assert.equal(formatMap.componentDatatypeSizeInBytes(ComponentDatatypeOf(formatMap).UNSIGNED_SHORT), 2);
});

function ComponentDatatypeOf(formatMap) {
  return formatMap.ComponentDatatype;
}
