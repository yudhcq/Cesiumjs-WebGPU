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
import Context from "@cesium/engine/Source/Renderer/Context.js";
import ContextLimits from "@cesium/engine/Source/Renderer/ContextLimits.js";
import Scene from "@cesium/engine/Source/Scene/Scene.js";

import * as capability from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/capability.js";
import * as defaultResources from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/default-resources.js";
import * as deviceHandoff from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/device-handoff.js";
import * as errorScope from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/error-scope.js";
import * as notImplemented from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/not-implemented.js";
import * as passEncoder from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/pass-encoder.js";
import * as pipelineCache from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/pipeline-cache.js";
import * as swapchain from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/swapchain.js";
import * as wholeSwitch from "../../../packages/cesium-webgpu/backend-webgpu/webgpu/whole-switch.js";
import * as contextModule from "../../../packages/cesium-webgpu/backend-webgpu/Renderer/Context.js";
import * as renderStateModule from "../../../packages/cesium-webgpu/backend-webgpu/Renderer/RenderState.js";
import * as sceneOptions from "../../../packages/cesium-webgpu/src/scene-options.js";

export {
  Context,
  ContextLimits,
  Scene,
  capability,
  contextModule,
  defaultResources,
  deviceHandoff,
  errorScope,
  notImplemented,
  passEncoder,
  pipelineCache,
  renderStateModule,
  sceneOptions,
  swapchain,
  wholeSwitch,
};

/** Pipeline-cache counters of the module instance the replacement `Context` uses (T048 evidence). */
export const pipelineCacheStats = contextModule.pipelineCacheStats;
