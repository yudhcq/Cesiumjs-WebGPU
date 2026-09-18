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
import IndexDatatype from "@cesium/engine/Source/Core/IndexDatatype.js";
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
import * as contextModule from "../../../packages/cesium-webgpu/backend-webgpu/Renderer/Context.js";
import * as renderStateModule from "../../../packages/cesium-webgpu/backend-webgpu/Renderer/RenderState.js";
import * as vertexArrayModule from "../../../packages/cesium-webgpu/backend-webgpu/Renderer/VertexArray.js";
import * as sceneOptions from "../../../packages/cesium-webgpu/src/scene-options.js";

export {
  Buffer,
  BufferUsage,
  Context,
  ContextLimits,
  IndexDatatype,
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
  gpuResourceRegistry,
  notImplemented,
  passEncoder,
  pipelineCache,
  renderStateModule,
  samplerMap,
  sceneOptions,
  swapchain,
  textureUpload,
  vertexArrayModule,
  wholeSwitch,
};

/** Pipeline-cache counters of the module instance the replacement `Context` uses (T048 evidence). */
export const pipelineCacheStats = contextModule.pipelineCacheStats;
