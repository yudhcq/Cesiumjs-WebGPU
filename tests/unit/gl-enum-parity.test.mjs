/**
 * Enum parity guard for the W3 resource layer (`层=单元`).
 *
 * The replaced resource classes consume the upstream GL enums through the bare deep specifiers
 * (`@cesium/engine/Source/Renderer/BufferUsage.js`, …). The **unit** layer cannot resolve those
 * specifiers from a `data:` URL, so it injects faithful stubs
 * (`tests/support/upstream-stubs.mjs`); in the real build the alias plugin resolves them to the
 * installed package.
 *
 * A stub that drifts from the installed upstream would make a unit test pass while the browser
 * behaves differently — the exact failure mode the stub header warns about. This suite closes that
 * gap: it loads the **real** upstream modules in Node and compares every fact the backend relies on
 * against the stub it is tested with.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { upstreamStubs } from "../support/upstream-stubs.mjs";

/** Import an ES-module source string as a module (the same trick `ts-module-loader` uses). */
async function importSource(source) {
  return import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`);
}

const stubs = upstreamStubs();

/** The upstream modules the W3 mapping tables read, with the stub that stands in for them. */
const MODULES = [
  ["@cesium/engine/Source/Core/PixelFormat.js", "@cesium/engine/Source/Core/PixelFormat.js"],
  ["@cesium/engine/Source/Renderer/PixelDatatype.js", "@cesium/engine/Source/Renderer/PixelDatatype.js"],
  ["@cesium/engine/Source/Renderer/RenderbufferFormat.js", "@cesium/engine/Source/Renderer/RenderbufferFormat.js"],
  ["@cesium/engine/Source/Renderer/BufferUsage.js", "@cesium/engine/Source/Renderer/BufferUsage.js"],
  ["@cesium/engine/Source/Renderer/TextureWrap.js", "@cesium/engine/Source/Renderer/TextureWrap.js"],
  ["@cesium/engine/Source/Renderer/TextureMinificationFilter.js", "@cesium/engine/Source/Renderer/TextureMinificationFilter.js"],
  ["@cesium/engine/Source/Renderer/TextureMagnificationFilter.js", "@cesium/engine/Source/Renderer/TextureMagnificationFilter.js"],
];

test("every stubbed enum module agrees with the installed upstream, member for member", async () => {
  for (const [specifier] of MODULES) {
    const real = (await import(specifier)).default;
    const stub = (await importSource(stubs[specifier])).default;
    const realMembers = Object.entries(real).filter(([, value]) => typeof value === "number");
    assert.ok(realMembers.length > 0, `${specifier} MUST expose numeric enum members`);
    for (const [name, value] of realMembers) {
      assert.equal(stub[name], value, `${specifier} stub MUST agree with upstream on ${name} (${value})`);
    }
  }
});

test("the stub predicates answer exactly like upstream for every member", async () => {
  const { default: realPixelFormat } = await import("@cesium/engine/Source/Core/PixelFormat.js");
  const { default: stubPixelFormat } = await importSource(stubs["@cesium/engine/Source/Core/PixelFormat.js"]);
  const { default: realPixelDatatype } = await import("@cesium/engine/Source/Renderer/PixelDatatype.js");
  const { default: stubPixelDatatype } = await importSource(stubs["@cesium/engine/Source/Renderer/PixelDatatype.js"]);

  for (const [name, value] of Object.entries(realPixelFormat).filter(([, candidate]) => typeof candidate === "number")) {
    assert.equal(stubPixelFormat.validate(value), realPixelFormat.validate(value), `PixelFormat.validate(${name})`);
    assert.equal(stubPixelFormat.isColorFormat(value), realPixelFormat.isColorFormat(value), `PixelFormat.isColorFormat(${name})`);
    assert.equal(stubPixelFormat.isDepthFormat(value), realPixelFormat.isDepthFormat(value), `PixelFormat.isDepthFormat(${name})`);
    assert.equal(stubPixelFormat.isCompressedFormat(value), realPixelFormat.isCompressedFormat(value), `PixelFormat.isCompressedFormat(${name})`);
    assert.equal(stubPixelFormat.componentsLength(value), realPixelFormat.componentsLength(value), `PixelFormat.componentsLength(${name})`);
  }
  for (const [name, value] of Object.entries(realPixelDatatype).filter(([, candidate]) => typeof candidate === "number")) {
    assert.equal(stubPixelDatatype.validate(value), realPixelDatatype.validate(value), `PixelDatatype.validate(${name})`);
    assert.equal(stubPixelDatatype.isPacked(value), realPixelDatatype.isPacked(value), `PixelDatatype.isPacked(${name})`);
    assert.equal(stubPixelDatatype.sizeInBytes(value), realPixelDatatype.sizeInBytes(value), `PixelDatatype.sizeInBytes(${name})`);
  }

  // The arithmetic the format table reproduces (`bytesPerPixel`) is upstream's `textureSizeInBytes`
  // divided by the texel count — checked over a small matrix of the pairs the MVP can produce.
  for (const [pixelFormat, pixelDatatype] of [
    [realPixelFormat.RGBA, realPixelDatatype.UNSIGNED_BYTE],
    [realPixelFormat.RGB, realPixelDatatype.UNSIGNED_BYTE],
    [realPixelFormat.LUMINANCE, realPixelDatatype.UNSIGNED_BYTE],
    [realPixelFormat.RGBA, realPixelDatatype.FLOAT],
    [realPixelFormat.RGBA, realPixelDatatype.UNSIGNED_SHORT_4_4_4_4],
  ]) {
    assert.equal(
      stubPixelFormat.textureSizeInBytes(pixelFormat, pixelDatatype, 3, 5),
      realPixelFormat.textureSizeInBytes(pixelFormat, pixelDatatype, 3, 5),
      `textureSizeInBytes(${pixelFormat}, ${pixelDatatype})`,
    );
  }
});

test("the stub Sampler mirrors upstream's six values, its equals() and NEAREST", async () => {
  const { default: RealSampler } = await import("@cesium/engine/Source/Renderer/Sampler.js");
  const { default: StubSampler } = await importSource(stubs["@cesium/engine/Source/Renderer/Sampler.js"]);
  const { default: TextureWrap } = await import("@cesium/engine/Source/Renderer/TextureWrap.js");
  const { default: TextureMinificationFilter } = await import("@cesium/engine/Source/Renderer/TextureMinificationFilter.js");
  const { default: TextureMagnificationFilter } = await import("@cesium/engine/Source/Renderer/TextureMagnificationFilter.js");

  const fields = ["wrapR", "wrapS", "wrapT", "minificationFilter", "magnificationFilter", "maximumAnisotropy"];
  const real = new RealSampler({});
  const stub = new StubSampler({});
  for (const field of fields) {
    assert.equal(stub[field], real[field], `the default Sampler.${field} MUST match upstream`);
  }
  assert.equal(real.wrapS, TextureWrap.CLAMP_TO_EDGE);
  assert.equal(real.minificationFilter, TextureMinificationFilter.LINEAR);
  assert.equal(real.magnificationFilter, TextureMagnificationFilter.LINEAR);
  assert.equal(real.maximumAnisotropy, 1.0, "the backend assumes the default anisotropy is 1 (no WebGPU counterpart)");

  const options = { wrapS: TextureWrap.REPEAT, wrapT: TextureWrap.MIRRORED_REPEAT, minificationFilter: TextureMinificationFilter.NEAREST_MIPMAP_LINEAR, magnificationFilter: TextureMagnificationFilter.NEAREST, maximumAnisotropy: 4 };
  const realCustom = new RealSampler(options);
  const stubCustom = new StubSampler(options);
  for (const field of fields) assert.equal(stubCustom[field], realCustom[field], `Sampler.${field} MUST follow the option bag`);

  assert.equal(StubSampler.NEAREST.magnificationFilter, RealSampler.NEAREST.magnificationFilter);
  assert.equal(StubSampler.NEAREST.minificationFilter, RealSampler.NEAREST.minificationFilter);
  assert.equal(StubSampler.equals(stubCustom, stubCustom), RealSampler.equals(realCustom, realCustom));
  assert.equal(StubSampler.equals(stubCustom, stub), RealSampler.equals(realCustom, real));
  assert.equal(StubSampler.equals(stub, new StubSampler({})), RealSampler.equals(real, new RealSampler({})));
  assert.equal(StubSampler.equals(undefined, undefined), RealSampler.equals(undefined, undefined));
});

test("the stubbed modules exist in the installed upstream package (no invented modules)", async () => {
  for (const [specifier] of MODULES) {
    const module_ = await import(specifier);
    assert.equal(typeof module_.default, "object", `${specifier} MUST be importable from the installed package`);
  }
});
