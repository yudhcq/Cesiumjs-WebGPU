/**
 * T005 — self-maintained upstream internal type declarations.
 *
 * Two independent obligations are asserted:
 *   1. every symbol on the consumption checklist (research §1.3, plan Complexity Tracking)
 *      is declared in `packages/cesium-webgpu/types/engine-internal.d.ts`;
 *   2. every declared member actually exists in the installed upstream 26.3.0 source —
 *      declarations must not drift away from the pinned baseline.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, readText, repoPath } from "../support/repo.mjs";

const DTS_PATH = "packages/cesium-webgpu/types/engine-internal.d.ts";
const ENGINE_SOURCE = path.join(REPO_ROOT, "node_modules", "@cesium", "engine", "Source");
const RENDERER = path.join(ENGINE_SOURCE, "Renderer");

const dts = readText(DTS_PATH);

/** Split the ambient declaration file into `declare module "<id>" { … }` blocks. */
function moduleBlocks(source) {
  const blocks = new Map();
  const re = /declare module "([^"]+)"\s*\{/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const open = source.indexOf("{", match.index + match[0].length - 1);
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.ok(end > open, `unterminated declare module block for ${match[1]}`);
    blocks.set(match[1], source.slice(open + 1, end));
  }
  return blocks;
}

/** Member names declared at class/interface member indentation (4 spaces). */
function declaredMembers(block) {
  const names = new Set();
  for (const m of block.matchAll(/^ {4}(?:readonly\s+|static\s+readonly\s+|static\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[?:(]/gm)) {
    names.add(m[1]);
  }
  return names;
}

/** Body of a `declare module` block's `export default class <Name> { … }`, if present. */
function classBody(block, className) {
  const marker = `export default class ${className}`;
  const start = block.indexOf(marker);
  if (start < 0) return null;
  const open = block.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < block.length; i += 1) {
    const ch = block[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return block.slice(open + 1, i);
    }
  }
  return null;
}

const blocks = moduleBlocks(dts);
const upstreamFiles = fs.existsSync(RENDERER) ? fs.readdirSync(RENDERER) : [];

function upstream(relativeFile) {
  const file = path.join(RENDERER, relativeFile);
  assert.ok(fs.existsSync(file), `upstream ${relativeFile} MUST be installed (run npm ci first)`);
  return fs.readFileSync(file, "utf8");
}

/** Members defined through `Object.defineProperties(X.prototype, { … })`. */
function definedProperties(source) {
  const start = source.indexOf("Object.defineProperties(");
  if (start < 0) return new Set();
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(open + 1, end);
  const names = new Set();
  let localDepth = 0;
  for (const line of body.split(/\r?\n/)) {
    if (localDepth === 0) {
      const m = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_]*): \{/);
      if (m) names.add(m[1]);
    }
    for (const ch of line) {
      if (ch === "{") localDepth += 1;
      else if (ch === "}") localDepth -= 1;
    }
  }
  return names;
}

test("the declaration file exists and declares the internal modules the patch layer consumes", () => {
  assert.ok(fs.existsSync(repoPath(DTS_PATH)), `${DTS_PATH} MUST exist`);
  const requiredModules = [
    "Context.js",
    "ContextLimits.js",
    "RenderState.js",
    "ShaderProgram.js",
    "ShaderSource.js",
    "ShaderCache.js",
    "Buffer.js",
    "Texture.js",
    "Sampler.js",
    "VertexArray.js",
    "Framebuffer.js",
    "Renderbuffer.js",
    "MultisampleFramebuffer.js",
    "FramebufferManager.js",
    "Texture3D.js",
    "CubeMap.js",
    "CubeMapFace.js",
    "TextureAtlas.js",
    "Sync.js",
    "createUniform.js",
    "createUniformArray.js",
    "PixelDatatype.js",
    "BufferUsage.js",
    "PassState.js",
    "DrawCommand.js",
    "ClearCommand.js",
    "ComputeCommand.js",
    "VertexArrayFacade.js",
    "ShaderBuilder.js",
    "loadCubeMap.js",
  ];
  for (const name of requiredModules) {
    assert.ok(blocks.has(`@cesium/engine/Source/Renderer/${name}`), `missing declare module for Renderer/${name}`);
  }
});

test("Context declarations cover the whole measured logic-layer consumption surface (>= 30 members)", () => {
  const block = blocks.get("@cesium/engine/Source/Renderer/Context.js");
  assert.ok(block, "Context module block MUST exist");
  const body = classBody(block, "Context");
  assert.ok(body, "Context module block MUST declare `export default class Context`");
  const declared = declaredMembers(body);

  // research.md §1.3 consumption table (external reference counts in parentheses).
  const required = [
    "uniformState",
    "defaultTexture",
    "shaderCache",
    "drawingBufferHeight",
    "drawingBufferWidth",
    "depthTexture",
    "createViewportQuadCommand",
    "cache",
    "webgl2",
    "createPickId",
    "halfFloatingPointTexture",
    "stencilBuffer",
    "fragmentDepth",
    "colorBufferFloat",
    "endFrame",
    "readPixels",
    "readPixelsToPBO",
    "id",
    "floatingPointTexture",
    "colorBufferHalfFloat",
    "instancedArrays",
    "textureCache",
    "drawBuffers",
    "elementIndexUint",
    "getObjectByPickColor",
    "destroy",
    "beginFrame",
    "msaa",
    "floatBlend",
    "supportsTextureLod",
    "supportsBasis",
    "defaultCubeMap",
    "s3tc",
    "pvrtc",
    "astc",
    "etc",
    "etc1",
    "bc7",
    // members the backend itself must provide (command seam / identity / lifecycle)
    "clear",
    "draw",
    "isDestroyed",
    "canvas",
    "getViewportQuadVertexArray",
  ];
  for (const name of required) {
    assert.ok(declared.has(name), `Context declaration MUST include member "${name}"`);
  }
  assert.ok(declared.size >= 30, `Context declaration MUST cover at least 30 members, got ${declared.size}`);

  // Anti-drift: every declared member exists in the pinned upstream source.
  const contextSource = upstream("Context.js");
  const upstreamMembers = new Set([
    ...definedProperties(contextSource),
    ...[...contextSource.matchAll(/Context\.prototype\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]),
    ...[...contextSource.matchAll(/this\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]),
  ]);
  for (const name of declared) {
    if (name === "constructor") continue;
    assert.ok(upstreamMembers.has(name), `declared Context member "${name}" does not exist in upstream 26.3.0`);
  }
});

test("ContextLimits declarations match the members present upstream (>= 10)", () => {
  const declared = declaredMembers(blocks.get("@cesium/engine/Source/Renderer/ContextLimits.js"));
  const source = upstream("ContextLimits.js");
  // Upstream exposes every public member as a 2-space-indented accessor object (`name: {`).
  // NOTE: an earlier revision matched only `maximum*`/`minimum*` names, which silently dropped
  // the `highp*Supported` flags and made a correct declaration look like an upstream mismatch.
  // Matching the accessor form covers the whole public surface (measured 23 members in 26.3.0).
  const upstreamMembers = new Set(
    [...source.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*\{\s*$/gm)].map((m) => m[1]),
  );
  assert.ok(upstreamMembers.size >= 20, `upstream ContextLimits MUST expose at least 20 public members, got ${upstreamMembers.size}`);
  assert.ok(declared.size >= 10, `ContextLimits declaration MUST cover at least 10 members, got ${declared.size}`);
  for (const name of declared) {
    assert.ok(upstreamMembers.has(name), `declared ContextLimits member "${name}" does not exist upstream`);
  }
  // Members the logic layer reads directly (research §1.3) MUST be part of the declared set.
  for (const name of ["maximumTextureSize", "maximumCubeMapSize", "maximumVertexTextureImageUnits"]) {
    assert.ok(declared.has(name), `ContextLimits declaration MUST include "${name}" (logic-layer consumer)`);
  }
  // High-precision flags are consumed by the reimplemented ShaderProgram; they must stay declared.
  for (const name of ["highpFloatSupported", "highpIntSupported"]) {
    assert.ok(declared.has(name), `ContextLimits declaration MUST include "${name}" (patch-layer consumer)`);
  }
});

test("ShaderProgram read surface declares the GLSL view and _attributeLocations", () => {
  const block = blocks.get("@cesium/engine/Source/Renderer/ShaderProgram.js");
  const body = classBody(block, "ShaderProgram");
  assert.ok(body, "ShaderProgram module block MUST declare `export default class ShaderProgram`");
  const declared = declaredMembers(body);
  for (const name of [
    "vertexShaderSource",
    "fragmentShaderSource",
    "_attributeLocations",
    "vertexAttributes",
    "numberOfVertexAttributes",
    "allUniforms",
    "fromCache",
  ]) {
    assert.ok(declared.has(name), `ShaderProgram declaration MUST include "${name}"`);
  }
  const source = upstream("ShaderProgram.js");
  assert.match(source, /this\._attributeLocations = options\.attributeLocations/, "upstream ShaderProgram MUST still expose _attributeLocations");
});

test("RenderState option declarations match the option keys read upstream", () => {
  const block = blocks.get("@cesium/engine/Source/Renderer/RenderState.js");
  const declared = declaredMembers(block);
  const source = upstream("RenderState.js");
  const consumedKeys = new Set([
    ...[...source.matchAll(/\brs\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
  ]);
  assert.ok(consumedKeys.size >= 10, `expected the upstream RenderState to read >= 10 option keys, got ${consumedKeys.size}`);
  for (const key of consumedKeys) {
    assert.ok(declared.has(key), `RenderStateOptions MUST declare consumed option key "${key}"`);
  }
});

test("all declared internal modules exist in the installed upstream source tree", () => {
  assert.ok(upstreamFiles.length > 0, "upstream Source/Renderer MUST be installed");
  // Declarations are not limited to `Renderer/**`: the replacement caches consume the GL-free Core
  // helpers (`Core/defined.js`, `Core/destroyObject.js`) exactly like their upstream originals do, so
  // every declared module id is resolved against `Source/**` and MUST exist there.
  const sourceRoot = path.resolve(RENDERER, "..");
  for (const id of blocks.keys()) {
    const relative = id.replace("@cesium/engine/Source/", "");
    assert.ok(fs.existsSync(path.join(sourceRoot, ...relative.split("/"))), `declared module Source/${relative} does not exist upstream`);
    if (relative.startsWith("Renderer/")) {
      assert.ok(upstreamFiles.includes(relative.replace("Renderer/", "")), `declared module Renderer/${relative.replace("Renderer/", "")} does not exist upstream`);
    }
  }
});
