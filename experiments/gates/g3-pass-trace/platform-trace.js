/**
 * G-3 gate — platform-level WebGL2 tracer (tasks.md T020).
 *
 * Tasks.md T020 requires recording the **upstream, unmodified WebGL2** `clear`/`draw`/target-switch
 * sequence of one complete frame "通过**包装平台 API**（`WebGL2RenderingContext.prototype.bindFramebuffer/
 * drawElements/drawArrays/viewport/scissor` 等）采集，**MUST NOT** 修改上游实现、MUST NOT 依赖 `@private` 语义改写".
 *
 * This module does exactly that and nothing else:
 *   - it wraps **platform prototype methods** (never an upstream module, never a Cesium object);
 *   - it maintains a **shadow registry** of render targets (framebuffer → colour/depth attachments,
 *     sample counts, viewport/scissor state) built *only* from the same platform calls
 *     (`createFramebuffer`, `framebufferTexture2D`, `framebufferRenderbuffer`,
 *     `renderbufferStorageMultisample`, …), so no `@private` Cesium member is ever read;
 *   - every recorded operation carries a monotonic sequence number, the *derived* current target
 *     identity and — where applicable — the topology/count/program, which is what T021 partitions on.
 *
 * The tracer adds no behaviour: every wrapper calls the original method with the original arguments
 * and returns its result unchanged.
 */

/** Operations that describe a render target switch or a draw/clear, i.e. the T020 trace surface. */
export const TRACED_METHODS = [
  // target management
  "bindFramebuffer",
  "bindRenderbuffer",
  "createFramebuffer",
  "deleteFramebuffer",
  "createRenderbuffer",
  "deleteRenderbuffer",
  "renderbufferStorageMultisample",
  "renderbufferStorage",
  "framebufferTexture2D",
  "framebufferRenderbuffer",
  "blitFramebuffer",
  // frame state that belongs to the pass identity
  "viewport",
  "scissor",
  "enable",
  "disable",
  // work
  "clear",
  "clearBufferfv",
  "clearBufferiv",
  "clearBufferfi",
  "drawElements",
  "drawArrays",
  "drawElementsInstanced",
  "drawArraysInstanced",
  "useProgram",
];

const DRAW_METHODS = new Set(["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]);
const CLEAR_METHODS = new Set(["clear", "clearBufferfv", "clearBufferiv", "clearBufferfi"]);

/** Attachment registry keyed by the *platform objects themselves* (a WeakMap, no id leaks). */
function createTargetRegistry() {
  return {
    framebuffers: new WeakMap(),
    renderbuffers: new WeakMap(),
    textures: new WeakMap(),
    nextId: 1,
  };
}

function describeFramebuffer(registry, gl, framebuffer) {
  if (framebuffer === null) return { id: "default", kind: "default-framebuffer", color: ["canvas"], depthStencil: "canvas", sampleCount: 1 };
  const record = registry.framebuffers.get(framebuffer);
  if (record === undefined) return { id: `fb-unknown-${registry.nextId}`, kind: "unknown", color: [], depthStencil: null, sampleCount: 1 };
  return {
    id: record.id,
    kind: record.sampleCount > 1 ? "multisample-framebuffer" : "framebuffer",
    color: record.colorAttachments.map((attachment) => attachment.description),
    depthStencil: record.depthStencil === null ? null : record.depthStencil.description,
    sampleCount: record.sampleCount,
  };
}

/**
 * Install the tracer.
 *
 * @param {{target?: object, proto?: object, start?: boolean}} [options]
 * @returns {{ops: object[], start(): void, stop(): void, uninstall(): void, state(): object, summary(): object}}
 */
export function installPlatformTracer(options = {}) {
  const scope = options.target ?? globalThis;
  const proto = options.proto ?? scope.WebGL2RenderingContext?.prototype;
  if (proto === undefined || proto === null) throw new Error("G-3 tracer: WebGL2RenderingContext is unavailable");
  const registry = createTargetRegistry();
  const ops = [];
  const originals = new Map();
  let recording = false;
  let sequence = 0;
  let currentDrawFramebuffer = null;
  let currentReadFramebuffer = null;
  let currentViewport = null;
  let currentScissor = null;
  let scissorEnabled = false;

  const push = (op) => {
    if (!recording) return;
    sequence += 1;
    ops.push({ seq: sequence, ...op });
  };

  const identityOf = () => {
    const draw = describeFramebuffer(registry, proto, currentDrawFramebuffer);
    return {
      colorTargets: draw.color,
      depthStencilTarget: draw.depthStencil,
      sampleCount: draw.sampleCount,
      viewport: currentViewport === null ? null : { ...currentViewport },
      scissorRect: scissorEnabled ? (currentScissor === null ? null : { ...currentScissor }) : null,
      targetId: draw.id,
      targetKind: draw.kind,
    };
  };

  const wrap = (method) => {
    const original = proto[method];
    if (typeof original !== "function") return;
    originals.set(method, original);
    proto[method] = function traced(...args) {
      const result = original.apply(this, args);
      try {
        const gl = this;
        switch (method) {
          case "bindFramebuffer": {
            const [target, framebuffer] = args;
            const previousDraw = currentDrawFramebuffer;
            const previousRead = currentReadFramebuffer;
            const affectsDraw = target === gl.DRAW_FRAMEBUFFER || target === gl.FRAMEBUFFER;
            const affectsRead = target === gl.READ_FRAMEBUFFER || target === gl.FRAMEBUFFER;
            if (affectsDraw) currentDrawFramebuffer = framebuffer;
            if (affectsRead) currentReadFramebuffer = framebuffer;
            const changed = (affectsDraw && previousDraw !== framebuffer) || (affectsRead && previousRead !== framebuffer);
            push({
              op: method,
              target: target === gl.FRAMEBUFFER ? "FRAMEBUFFER" : target === gl.DRAW_FRAMEBUFFER ? "DRAW_FRAMEBUFFER" : "READ_FRAMEBUFFER",
              targetId: describeFramebuffer(registry, gl, framebuffer).id,
              previousTargetId: describeFramebuffer(registry, gl, previousDraw).id,
              changed,
              identity: identityOf(),
            });
            break;
          }
          case "bindRenderbuffer":
            push({ op: method, renderbufferId: registry.renderbuffers.get(args[1])?.id ?? null });
            break;
          case "createFramebuffer": {
            const record = { id: `fb-${registry.nextId++}`, colorAttachments: [], depthStencil: null, sampleCount: 1 };
            registry.framebuffers.set(result, record);
            push({ op: method, targetId: record.id });
            break;
          }
          case "deleteFramebuffer":
            push({ op: method, targetId: registry.framebuffers.get(args[0])?.id ?? null });
            break;
          case "createRenderbuffer": {
            const record = { id: `rb-${registry.nextId++}`, sampleCount: 1, description: null };
            registry.renderbuffers.set(result, record);
            push({ op: method, renderbufferId: record.id });
            break;
          }
          case "deleteRenderbuffer":
            push({ op: method, renderbufferId: registry.renderbuffers.get(args[0])?.id ?? null });
            break;
          case "renderbufferStorage":
          case "renderbufferStorageMultisample": {
            const record = registry.renderbuffers.get(args[0]);
            const sampleCount = method === "renderbufferStorageMultisample" ? args[1] : 1;
            if (record !== undefined) {
              record.sampleCount = sampleCount;
              record.description = `${record.id}(${sampleCount}x)`;
            }
            push({ op: method, renderbufferId: record?.id ?? null, sampleCount });
            break;
          }
          case "framebufferTexture2D": {
            const [target, attachment, textarget, texture] = args;
            const record = registry.framebuffers.get(currentDrawFramebuffer);
            const description = `texture(${registry.textures.get(texture)?.id ?? "untracked"})`;
            if (record !== undefined) {
              if (attachment === gl.DEPTH_ATTACHMENT || attachment === gl.DEPTH_STENCIL_ATTACHMENT) record.depthStencil = { description };
              else record.colorAttachments.push({ attachment, description });
            }
            push({ op: method, attachment, textarget, description, framebufferId: record?.id ?? null });
            break;
          }
          case "framebufferRenderbuffer": {
            const [target, attachment, renderbufferTarget, renderbuffer] = args;
            const record = registry.framebuffers.get(currentDrawFramebuffer);
            const rb = registry.renderbuffers.get(renderbuffer);
            const description = rb?.description ?? `renderbuffer(${rb?.id ?? "untracked"})`;
            if (record !== undefined) {
              if (attachment === gl.DEPTH_ATTACHMENT || attachment === gl.DEPTH_STENCIL_ATTACHMENT) {
                record.depthStencil = { description };
                record.sampleCount = rb?.sampleCount ?? 1;
              } else record.colorAttachments.push({ attachment, description });
            }
            push({ op: method, attachment, description, framebufferId: record?.id ?? null, sampleCount: rb?.sampleCount ?? 1 });
            break;
          }
          case "blitFramebuffer": {
            const [srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1, dstY1, mask, filter] = args;
            push({
              op: method,
              source: describeFramebuffer(registry, gl, currentReadFramebuffer),
              destination: describeFramebuffer(registry, gl, currentDrawFramebuffer),
              rect: { src: [srcX0, srcY0, srcX1, srcY1], dst: [dstX0, dstY0, dstX1, dstY1] },
              mask,
              filter,
              identity: identityOf(),
            });
            break;
          }
          case "viewport": {
            const [x, y, width, height] = args;
            currentViewport = { x, y, width, height };
            push({ op: method, viewport: { ...currentViewport }, identity: identityOf() });
            break;
          }
          case "scissor": {
            const [x, y, width, height] = args;
            currentScissor = { x, y, width, height };
            push({ op: method, scissorRect: { ...currentScissor }, identity: identityOf() });
            break;
          }
          case "enable":
          case "disable": {
            if (args[0] === gl.SCISSOR_TEST) {
              scissorEnabled = method === "enable";
              push({ op: method, capability: "SCISSOR_TEST", identity: identityOf() });
            } else {
              push({ op: method, capability: args[0] });
            }
            break;
          }
          case "clear": {
            push({ op: method, mask: args[0], identity: identityOf() });
            break;
          }
          case "clearBufferfv":
          case "clearBufferiv": {
            push({ op: method, buffer: args[0], drawbuffer: args[1], identity: identityOf() });
            break;
          }
          case "clearBufferfi": {
            push({ op: method, buffer: args[0], drawbuffer: args[1], identity: identityOf() });
            break;
          }
          case "useProgram": {
            push({ op: method, program: registry.textures.get(args[0])?.id ?? null });
            break;
          }
          default: {
            // draw calls
            const isIndexed = method.startsWith("drawElements");
            const isInstanced = method.endsWith("Instanced");
            push({
              op: method,
              kind: "draw",
              mode: args[0],
              count: args[1],
              type: isIndexed ? args[2] : null,
              offset: isIndexed ? args[3] : null,
              instanceCount: isInstanced ? args[4] : 1,
              identity: identityOf(),
            });
          }
        }
      } catch (error) {
        // Tracing must never break the frame being observed.
        ops.push({ seq: sequence, op: "trace-error", method, message: error?.message ?? String(error) });
      }
      return result;
    };
  };

  for (const method of TRACED_METHODS) wrap(method);

  return {
    ops,
    start() {
      recording = true;
      push({ op: "trace-start", identity: identityOf() });
    },
    stop() {
      push({ op: "trace-stop", identity: identityOf() });
      recording = false;
    },
    uninstall() {
      for (const [method, original] of originals) proto[method] = original;
    },
    state() {
      return { sequence, drawFramebuffer: describeFramebuffer(registry, proto, currentDrawFramebuffer), readFramebuffer: describeFramebuffer(registry, proto, currentReadFramebuffer), viewport: currentViewport, scissorRect: currentScissor, scissorEnabled };
    },
    summary() {
      const draws = ops.filter((op) => DRAW_METHODS.has(op.op));
      const clears = ops.filter((op) => CLEAR_METHODS.has(op.op));
      return {
        operationCount: ops.length,
        drawCount: draws.length,
        clearCount: clears.length,
        blitCount: ops.filter((op) => op.op === "blitFramebuffer").length,
        bindFramebufferCount: ops.filter((op) => op.op === "bindFramebuffer").length,
        viewportCount: ops.filter((op) => op.op === "viewport").length,
        scissorCount: ops.filter((op) => op.op === "scissor").length,
        triangleCount: draws.reduce((total, op) => total + (op.mode === 4 ? Math.floor(op.count / 3) * (op.instanceCount ?? 1) : 0), 0),
        targets: [...new Set(ops.map((op) => op.identity?.targetId).filter((id) => typeof id === "string"))],
        programs: [...new Set(ops.filter((op) => op.op === "useProgram").map((op) => op.program).filter(Boolean))].length,
      };
    },
    isDraw: (op) => DRAW_METHODS.has(op.op),
    isClear: (op) => CLEAR_METHODS.has(op.op),
  };
}
