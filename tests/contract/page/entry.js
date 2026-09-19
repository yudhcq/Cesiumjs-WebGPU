/**
 * Contract-suite bundle entry (tasks.md T043/T044/T047/T050/T051).
 *
 * Everything here is imported through the **production specifiers**, so the alias plugin decides which
 * implementation the page gets:
 *   - `@cesium/engine/Source/Renderer/Context.js` — rewritten to the patch layer under the real
 *     manifest, left upstream under the empty (WebGL2) manifest;
 *   - `@cesium/engine/Source/Scene/Scene.js` — always upstream (the logic layer is never touched);
 *   - the `backend-webgpu/webgpu/**` helpers — always the patch layer (they are our own modules).
 *
 * The page reads this namespace as `module`.
 */
import Buffer from "@cesium/engine/Source/Renderer/Buffer.js";
import BufferUsage from "@cesium/engine/Source/Renderer/BufferUsage.js";
import Context from "@cesium/engine/Source/Renderer/Context.js";
import ContextLimits from "@cesium/engine/Source/Renderer/ContextLimits.js";
import Cartesian3 from "@cesium/engine/Source/Core/Cartesian3.js";
import CustomHeightmapTerrainProvider from "@cesium/engine/Source/Core/CustomHeightmapTerrainProvider.js";
import EllipsoidTerrainProvider from "@cesium/engine/Source/Core/EllipsoidTerrainProvider.js";
import GeographicTilingScheme from "@cesium/engine/Source/Core/GeographicTilingScheme.js";
import Globe from "@cesium/engine/Source/Scene/Globe.js";
import HeightmapTerrainData from "@cesium/engine/Source/Core/HeightmapTerrainData.js";
import IndexDatatype from "@cesium/engine/Source/Core/IndexDatatype.js";
import JulianDate from "@cesium/engine/Source/Core/JulianDate.js";
import Math from "@cesium/engine/Source/Core/Math.js";
import MultisampleFramebuffer from "@cesium/engine/Source/Renderer/MultisampleFramebuffer.js";
import PixelDatatype from "@cesium/engine/Source/Renderer/PixelDatatype.js";
import PixelFormat from "@cesium/engine/Source/Core/PixelFormat.js";
import Renderbuffer from "@cesium/engine/Source/Renderer/Renderbuffer.js";
import RenderbufferFormat from "@cesium/engine/Source/Renderer/RenderbufferFormat.js";
import Sampler from "@cesium/engine/Source/Renderer/Sampler.js";
import Scene from "@cesium/engine/Source/Scene/Scene.js";
import Texture from "@cesium/engine/Source/Renderer/Texture.js";
import TextureWrap from "@cesium/engine/Source/Renderer/TextureWrap.js";
import VertexArray from "@cesium/engine/Source/Renderer/VertexArray.js";
import CesiumWidget from "@cesium/engine/Source/Widget/CesiumWidget.js";

import * as capability from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/capability.js";
import * as defaultResources from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/default-resources.js";
import * as deviceHandoff from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/device-handoff.js";
import * as errorScope from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/error-scope.js";
import * as formatMap from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/format-map.js";
import * as gpuResourceRegistry from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/gpu-resource-registry.js";
import * as notImplemented from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/not-implemented.js";
import * as passEncoder from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/pass-encoder.js";
import * as pipelineCache from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/pipeline-cache.js";
import * as samplerMap from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/sampler-map.js";
import * as swapchain from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/swapchain.js";
import * as textureUpload from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/texture-upload.js";
import * as wholeSwitch from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/whole-switch.js";
import * as uniformWriter from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/uniform-writer.js";
import * as wgslEmitter from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/wgsl-emitter.js";
import * as contextModule from "../../../packages/cesium-webgpu/backend-webgpu/Renderer/Context.js";
import * as framebufferManagerModule from "../../../packages/cesium-webgpu/backend-webgpu/Renderer/FramebufferManager.js";
import * as renderStateModule from "../../../packages/cesium-webgpu/backend-webgpu/Renderer/RenderState.js";
import * as vertexArrayModule from "../../../packages/cesium-webgpu/backend-webgpu/Renderer/VertexArray.js";
import * as sceneOptions from "../../../packages/cesium-webgpu/src/scene-options.js";
// The package entry itself (T089's `createTerrainScene`). Bundled through the same TypeScript plugin as
// the rest of `src/`, so a page scenario can drive the **public** API rather than re-assembling a scene
// by hand. Importing it is what makes "the acceptance suite exercises the shipped entry point" true.
import * as terrainScene from "../../../packages/cesium-webgpu/src/index.ts";
// The terrain adapter itself (T086). The contract suites need the **product** adapter rather than a
// hand-rolled provider, so that "missing tile / fetch failure / timeout" is exercised through the code
// that ships: an injectable `readTile` is how a suite simulates a failure without a broken server.
import * as terrainSource from "../../../packages/cesium-webgpu/src/terrain/source.ts";

export {
  Buffer,
  BufferUsage,
  Cartesian3,
  CesiumWidget,
  Context,
  ContextLimits,
  CustomHeightmapTerrainProvider,
  EllipsoidTerrainProvider,
  GeographicTilingScheme,
  Globe,
  HeightmapTerrainData,
  IndexDatatype,
  JulianDate,
  Math,
  MultisampleFramebuffer,
  PixelDatatype,
  PixelFormat,
  Renderbuffer,
  RenderbufferFormat,
  Sampler,
  Scene,
  Texture,
  TextureWrap,
  VertexArray,
  capability,
  contextModule,
  defaultResources,
  deviceHandoff,
  errorScope,
  formatMap,
  framebufferManagerModule,
  gpuResourceRegistry,
  notImplemented,
  passEncoder,
  pipelineCache,
  renderStateModule,
  samplerMap,
  sceneOptions,
  swapchain,
  terrainScene,
  terrainSource,
  textureUpload,
  uniformWriter,
  vertexArrayModule,
  wgslEmitter,
  wholeSwitch,
};

/** Pipeline-cache counters of the module instance the replacement `Context` uses (T048 evidence). */
export const pipelineCacheStats = contextModule.pipelineCacheStats;
