/**
 * Recording fake of the WebGPU surface used by the patch layer's unit tests (`层=单元`).
 *
 * The W2 backend is a *command recorder*: what has to be asserted is the descriptor/call sequence it
 * produces (`sampleCount: 4` always paired with `resolveTarget`, `setViewport`/`setScissorRect` before
 * the draw, a pipeline cache hit on the second identical draw, …). A real device cannot be inspected
 * that way and is not available in `node --test`, so the unit tests drive this fake and the real
 * device is exercised by the contract suites (`tests/contract/**`, `层=契约`) in a real browser.
 *
 * The fake implements only what the backend touches, and every method records its arguments, so a
 * test can assert both the calls made and the objects created.
 */
import assert from "node:assert/strict";

/** WebGPU enum values the backend uses (mirrors the spec's `GPUTextureUsage`). */
export const TEXTURE_USAGE = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};

/** Install the WebGPU global enums the backend reads (`GPUTextureUsage`) if they are missing. */
export function installWebgpuGlobals() {
  if (globalThis.GPUTextureUsage === undefined) {
    globalThis.GPUTextureUsage = TEXTURE_USAGE;
  }
  if (globalThis.GPUBufferUsage === undefined) {
    globalThis.GPUBufferUsage = { MAP_READ: 0x01, MAP_WRITE: 0x02, COPY_SRC: 0x04, COPY_DST: 0x08, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100, QUERY_RESOLVE: 0x200 };
  }
}

/** Realistic adapter limits (the measured values from G-2 on headless Chrome 153 / lovelace). */
export const FAKE_LIMITS = {
  maxTextureDimension1D: 16384,
  maxTextureDimension2D: 16384,
  maxTextureDimension3D: 2048,
  maxTextureArrayLayers: 256,
  maxBindGroups: 4,
  maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8,
  maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 48,
  maxSamplersPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728,
  minUniformBufferOffsetAlignment: 256,
  minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8,
  maxBufferSize: 268435456,
  maxVertexAttributes: 30,
  maxVertexBufferArrayStride: 2048,
  maxInterStageShaderVariables: 28,
  maxColorAttachments: 8,
  maxColorAttachmentBytesPerSample: 32,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupsPerDimension: 65535,
};

/** A fake `GPUAdapter` (also usable where the code reads `adapter.limits/features/info`). */
export function createFakeAdapter({ limits = FAKE_LIMITS, features = ["float32-filterable", "float32-blendable"], info = { vendor: "nvidia", architecture: "lovelace" } } = {}) {
  const device = createFakeDevice({ limits, features });
  return {
    info,
    limits: { ...limits },
    features: new Set(features),
    isFallbackAdapter: false,
    device,
    requestDevice: async () => device,
  };
}

/** A fake `GPUDevice` recording every call it receives. */
export function createFakeDevice({ limits = FAKE_LIMITS, features = ["float32-filterable", "float32-blendable"], label = "fake-device" } = {}) {
  const calls = [];
  const created = { textures: [], samplers: [], buffers: [], pipelines: [], bindGroups: [], encoders: [] };
  const errorQueue = [];
  let lostResolve;
  const lost = new Promise((resolve) => {
    lostResolve = resolve;
  });

  const record = (name, args) => calls.push({ name, args });

  const device = {
    label,
    limits: { ...limits },
    features: new Set(features),
    lost,
    onuncapturederror: null,
    __calls: calls,
    __created: created,
    __pushError: (error) => errorQueue.push(error),
    __lose: (reason = "destroyed", message = "device destroyed by the test") => lostResolve({ reason, message }),

    createTexture(descriptor) {
      record("createTexture", [descriptor]);
      let destroyed = false;
      const texture = {
        label: descriptor?.label ?? null,
        descriptor,
        __views: [],
        get __destroyed() {
          return destroyed;
        },
        createView(viewDescriptor) {
          const view = { label: descriptor?.label ?? null, __texture: texture, descriptor: viewDescriptor ?? null };
          texture.__views.push(view);
          return view;
        },
        destroy() {
          record("texture.destroy", [descriptor?.label ?? null]);
          destroyed = true;
        },
      };
      created.textures.push(texture);
      return texture;
    },

    createSampler(descriptor) {
      record("createSampler", [descriptor]);
      const sampler = { descriptor };
      created.samplers.push(sampler);
      return sampler;
    },

    createBuffer(descriptor) {
      record("createBuffer", [descriptor]);
      const buffer = { descriptor, size: descriptor?.size ?? 0, destroy: () => record("buffer.destroy", [descriptor?.label ?? null]) };
      created.buffers.push(buffer);
      return buffer;
    },

    createBindGroup(descriptor) {
      record("createBindGroup", [descriptor]);
      const group = { descriptor };
      created.bindGroups.push(group);
      return group;
    },

    createRenderPipeline(descriptor) {
      record("createRenderPipeline", [descriptor]);
      const pipeline = { descriptor };
      created.pipelines.push(pipeline);
      return pipeline;
    },

    createRenderPipelineAsync: async (descriptor) => device.createRenderPipeline(descriptor),

    createCommandEncoder(descriptor) {
      record("createCommandEncoder", [descriptor]);
      const encoderCalls = [];
      const passes = [];
      const encoder = {
        label: descriptor?.label ?? null,
        __calls: encoderCalls,
        __passes: passes,
        beginRenderPass(passDescriptor) {
          encoderCalls.push({ name: "beginRenderPass", args: [passDescriptor] });
          const passCalls = [];
          const pass = {
            __descriptor: passDescriptor,
            __calls: passCalls,
            __ended: false,
            setPipeline: (pipeline) => passCalls.push({ name: "setPipeline", args: [pipeline] }),
            setBindGroup: (index, group, offsets) => passCalls.push({ name: "setBindGroup", args: [index, group, offsets] }),
            setVertexBuffer: (...args) => passCalls.push({ name: "setVertexBuffer", args }),
            setIndexBuffer: (...args) => passCalls.push({ name: "setIndexBuffer", args }),
            setViewport: (...args) => passCalls.push({ name: "setViewport", args }),
            setScissorRect: (...args) => passCalls.push({ name: "setScissorRect", args }),
            setStencilReference: (reference) => passCalls.push({ name: "setStencilReference", args: [reference] }),
            setBlendConstant: (color) => passCalls.push({ name: "setBlendConstant", args: [color] }),
            draw: (...args) => passCalls.push({ name: "draw", args }),
            drawIndexed: (...args) => passCalls.push({ name: "drawIndexed", args }),
            end: () => {
              pass.__ended = true;
              passCalls.push({ name: "end", args: [] });
            },
          };
          passes.push(pass);
          return pass;
        },
        copyTextureToBuffer: (...args) => encoderCalls.push({ name: "copyTextureToBuffer", args }),
        copyBufferToBuffer: (...args) => encoderCalls.push({ name: "copyBufferToBuffer", args }),
        copyTextureToTexture: (...args) => encoderCalls.push({ name: "copyTextureToTexture", args }),
        clearBuffer: (...args) => encoderCalls.push({ name: "clearBuffer", args }),
        finish: () => {
          encoderCalls.push({ name: "finish", args: [] });
          return { __encoder: encoder, label: descriptor?.label ?? null };
        },
      };
      created.encoders.push(encoder);
      return encoder;
    },

    queue: {
      submitted: [],
      writeTexture(...args) {
        record("queue.writeTexture", args);
      },
      writeBuffer(...args) {
        record("queue.writeBuffer", args);
      },
      copyExternalImageToTexture(...args) {
        record("queue.copyExternalImageToTexture", args);
      },
      submit(commandBuffers) {
        record("queue.submit", [commandBuffers]);
        device.queue.submitted.push(...commandBuffers);
      },
    },

    pushErrorScope(filter) {
      record("pushErrorScope", [filter]);
    },
    async popErrorScope() {
      record("popErrorScope", []);
      return errorQueue.length === 0 ? null : (errorQueue.shift() ?? null);
    },
    destroy() {
      record("destroy", []);
    },
  };
  return device;
}

/** A fake canvas + `GPUCanvasContext` recording `configure` and handing out swap-chain textures. */
export function createFakeCanvas({ clientWidth = 300, clientHeight = 150, width = 300, height = 150, hasWebgpu = true } = {}) {
  const configureCalls = [];
  const currentTextures = [];
  let pendingTexture = null;
  const canvas = {
    width,
    height,
    clientWidth,
    clientHeight,
    getContext(contextId) {
      if (contextId !== "webgpu" || !hasWebgpu) return null;
      return canvasContext;
    },
  };
  const canvasContext = {
    __configureCalls: configureCalls,
    __currentTextures: currentTextures,
    configure(descriptor) {
      configureCalls.push(descriptor);
    },
    unconfigure() {
      configureCalls.push({ __unconfigure: true });
    },
    getCurrentTexture() {
      const texture = {
        label: `swapchain-${currentTextures.length}`,
        __views: [],
        createView(viewDescriptor) {
          const view = { label: `swapchain-view-${currentTextures.length}`, descriptor: viewDescriptor ?? null };
          texture.__views.push(view);
          return view;
        },
        destroy() {},
      };
      currentTextures.push(texture);
      pendingTexture = texture;
      return texture;
    },
    get __pendingTexture() {
      return pendingTexture;
    },
  };
  return canvas;
}

/** Assert that an object is a diagnosable `DiagnosticError` with the given category. */
export function assertDiagnostic(error, category, where = "diagnostic") {
  assert.ok(error instanceof Error, `${where} MUST throw an Error, got ${String(error)}`);
  assert.equal(error.name, "DiagnosticError", `${where} MUST throw a DiagnosticError (${error.message})`);
  if (category !== undefined) assert.equal(error.category, category, `${where} MUST use category "${category}" (got "${error.category}")`);
  assert.ok(typeof error.message === "string" && error.message.length > 20, `${where} MUST carry an explanatory message`);
  return true;
}

/**
 * A double of the replacement `Context` surface the **replaced resource classes** read (W3).
 *
 * Deliberately not a `Context`: the resource classes must depend only on the members listed here
 * (`device`, `id`, the capability flags, the two `ContextLimits` maxima they validate against, and the
 * render-target registration used by `Framebuffer`). A double that is narrower than the real thing is
 * what keeps that dependency honest — a resource class that reaches for anything else fails here.
 */
export function createFakeGpuContext({ device = createFakeDevice(), capabilities = {}, limits = {}, label = "unit-context" } = {}) {
  const registered = new Map();
  return {
    device,
    id: label,
    msaa: true,
    depthTexture: false,
    fragmentDepth: true,
    instancedArrays: true,
    elementIndexUint: true,
    colorBufferFloat: true,
    colorBufferHalfFloat: true,
    floatingPointTexture: true,
    halfFloatingPointTexture: true,
    textureFilterAnisotropic: false,
    drawingBufferWidth: 300,
    drawingBufferHeight: 150,
    contextLimits: { maximumTextureSize: 16384, maximumRenderbufferSize: 16384, maximumColorAttachments: 8, ...limits },
    ...capabilities,
    __registeredTargets: registered,
    registerTarget(target) {
      registered.set(target.id, target);
    },
    unregisterTarget(id) {
      registered.delete(id);
    },
    isDestroyed: () => false,
  };
}
