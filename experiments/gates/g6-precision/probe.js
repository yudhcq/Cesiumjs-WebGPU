// ============================================================================================
// G-6 gate — in-page precision probe (tasks.md T026, hypothesis H-7).
//
// **One backend per run** (principle II / arch rule A7): `tools`-style runner passes
// `backend: "webgpu"` or `backend: "webgl2"`, never both. The same fixed scene
// (`experiments/gates/shared/terrain-scene.mjs`) is rendered by:
//
//   webgpu — the WGSL emitted by `experiments/gates/g5-shader/wgsl-emitter.mjs`
//   webgl2 — the **real upstream assembled GLSL** (`assembleGlslForVariant`, i.e. what the GL driver
//            receives from Cesium itself), linked through a real WebGL2 context
//
// Three passes per run:
//   `color`        the shaded frame → pixel diff (compare.mjs, offline)
//   `elevation`    the *emitted/upstream vertex stage* with an elevation-encoding fragment stage,
//                  so the elevation comparison goes through the same vertex transform in both
//                  backends (only the fragment stage differs, and it is the same formula)
//   `texel-probe`  a full-screen quad sampling the imagery texture at the four corners, which makes
//                  the texture-origin convention directly observable per backend
//
// Results are published on `globalThis.__g6p`.
// ============================================================================================

const report = {
  ready: false,
  backend: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  adapter: null,
  errors: [],
  passes: {},
  pages: [],
};

globalThis.__g6p = report;
const note = (message) => report.pages.push(`${new Date().toISOString()} ${message}`);

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url} -> HTTP ${response.status}`);
  return await response.json();
}

const VERTEX_FORMAT_SIZE = { float32: 4, float32x2: 8, float32x3: 12, float32x4: 16 };
const GL_COMPONENTS = { float32: 1, float32x2: 2, float32x3: 3, float32x4: 4 };

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  return btoa(binary);
}

/** Frame statistics shared by both backends, so the comparison sees identical shapes. */
function frameStats(pixels, bytesPerRow, width, height) {
  let nonBlack = 0;
  const histogram = new Map();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      const key = `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`;
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
      if (pixels[offset] !== 0 || pixels[offset + 1] !== 0 || pixels[offset + 2] !== 0) nonBlack += 1;
    }
  }
  const corner = (x, y) => {
    const offset = y * bytesPerRow + x * 4;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
  };
  return {
    width,
    height,
    bytesPerRow,
    nonBlackPixels: nonBlack,
    totalPixels: width * height,
    uniqueColors: histogram.size,
    corners: { topLeft: corner(0, 0), topRight: corner(width - 1, 0), bottomLeft: corner(0, height - 1), bottomRight: corner(width - 1, height - 1), center: corner(width >> 1, height >> 1) },
    rgbaBase64: bytesToBase64(pixels),
  };
}

// ------------------------------------------------------------------------------------------------
// WebGPU
// ------------------------------------------------------------------------------------------------

async function runWebgpu(input) {
  const adapter = await globalThis.navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error("requestAdapter() returned null");
  const info = adapter.info ?? {};
  report.adapter = { vendor: info.vendor ?? null, architecture: info.architecture ?? null, hasInfo: typeof info.vendor === "string" && info.vendor.length > 0 };
  const device = await adapter.requestDevice();
  const format = globalThis.navigator.gpu.getPreferredCanvasFormat();
  report.preferredFormat = format;
  const scene = input.scene;

  const vertexBuffer = device.createBuffer({ size: scene.vertexBytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vertexBuffer, 0, new Uint8Array(scene.vertexBytesArray));
  const indexBuffer = device.createBuffer({ size: scene.indexBytes, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(indexBuffer, 0, new Uint8Array(scene.indexBytesArray));
  const uniformBuffer = device.createBuffer({ size: scene.uniformBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(uniformBuffer, 0, new Uint8Array(scene.uniformBytesArray));

  // Texture upload — the **Texture mapping layer's flip policy**, applied explicitly.
  //
  // GL reaches the "image as authored" orientation with `UNPACK_FLIP_Y_WEBGL = true` (Cesium's
  // `Texture.flipY` default, `Renderer/Texture.js:27`), which makes `texture(u, v)` return the image
  // measured **from its last row**: `v = 0` ↔ the image's bottom row. WebGPU has no unpack flag and
  // its texture origin is the top-left, so `v = 0` would return the image's *first* row. The row
  // order is therefore reversed on upload, which is exactly equivalent to GL's flip.
  //
  // (The texel probe compares *screen* positions, so it uses a screen-consistent `uv` — see
  // `texelProbeGlsl`: `gl_FragCoord.y` is bottom-up while WGSL's is top-down.)
  const imagery = new Uint8Array(scene.imagery.rgba);
  const flipped = new Uint8Array(imagery.length);
  const rowBytes = scene.imagery.width * 4;
  for (let row = 0; row < scene.imagery.height; row += 1) {
    flipped.set(imagery.subarray(row * rowBytes, (row + 1) * rowBytes), (scene.imagery.height - 1 - row) * rowBytes);
  }
  const paddedRow = Math.max(256, rowBytes);

  const bindGroupEntries = [{ binding: 0, resource: { buffer: uniformBuffer } }];
  const layoutEntries = [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }];
  for (const sampler of scene.samplers) {
    const texture = device.createTexture({ size: [scene.imagery.width, scene.imagery.height], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const padded = new Uint8Array(paddedRow * scene.imagery.height);
    for (let row = 0; row < scene.imagery.height; row += 1) padded.set(flipped.subarray(row * rowBytes, (row + 1) * rowBytes), row * paddedRow);
    device.queue.writeTexture({ texture }, padded, { bytesPerRow: paddedRow }, { width: scene.imagery.width, height: scene.imagery.height });
    const samplerObject = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    layoutEntries.push({ binding: sampler.textureBinding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } });
    layoutEntries.push({ binding: sampler.samplerBinding, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } });
    bindGroupEntries.push({ binding: sampler.textureBinding, resource: texture.createView() });
    bindGroupEntries.push({ binding: sampler.samplerBinding, resource: samplerObject });
  }
  const bindGroupLayout = device.createBindGroupLayout({ entries: layoutEntries });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const bindGroup = device.createBindGroup({ layout: bindGroupLayout, entries: bindGroupEntries });
  const { width, height } = scene.viewport;
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;

  for (const pass of input.passes) {
    const vertexCode = await (await fetch(pass.vertexUrl)).text();
    const fragmentCode = await (await fetch(pass.fragmentUrl)).text();
    device.pushErrorScope("validation");
    const vertexModule = device.createShaderModule({ code: vertexCode });
    const fragmentModule = device.createShaderModule({ code: fragmentCode });
    const pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: vertexModule, entryPoint: "vs_main", buffers: pass.attributes.length === 0 ? [] : [{ arrayStride: pass.attributes[0].stride, attributes: pass.attributes.map((attribute) => ({ shaderLocation: attribute.location, offset: attribute.offset, format: attribute.format })) }], ...(pass.vertexConstants === undefined || pass.vertexConstants === null ? {} : { constants: pass.vertexConstants }) },
      // `constants` are per stage, and every key MUST be declared by that stage's module (G-6/T025:
      // the emitted terrain modules declare the two pipeline overrides, replacement probe modules do not).
      fragment: { module: fragmentModule, entryPoint: "fs_main", targets: [{ format }], ...(pass.fragmentConstants === undefined || pass.fragmentConstants === null ? {} : { constants: pass.fragmentConstants }) },
      primitive: { topology: "triangle-list" },
    });
    const target = device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const readback = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    const renderPass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
    renderPass.setPipeline(pipeline);
    renderPass.setBindGroup(0, bindGroup);
    if (pass.attributes.length > 0) {
      renderPass.setVertexBuffer(0, vertexBuffer);
      renderPass.setIndexBuffer(indexBuffer, "uint32");
      renderPass.drawIndexed(scene.indexCount);
    } else {
      renderPass.draw(3);
    }
    renderPass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, { width, height });
    device.queue.submit([encoder.finish()]);
    const scopeError = await device.popErrorScope();
    await device.queue.onSubmittedWorkDone();
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(readback.getMappedRange().slice(0));
    readback.unmap();
    // `getPreferredCanvasFormat()` is `bgra8unorm` on this machine, so the raw readback bytes are
    // B,G,R,A while `gl.readPixels(RGBA)` gives R,G,B,A. Normalising here (declared as the
    // `swapchain-channel-order` difference) keeps every downstream consumer — statistics, corner
    // values, stored frame — in one channel order.
    if (format === "bgra8unorm") {
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const blue = pixels[offset];
        pixels[offset] = pixels[offset + 2];
        pixels[offset + 2] = blue;
      }
    }
    report.passes[pass.id] = { ...frameStats(pixels, bytesPerRow, width, height), channelOrder: `target format ${format}; normalised to RGBA for storage`, validationError: scopeError === null ? null : scopeError.message };
    // The texel probe also reports the raw corner texels of the *uploaded* texture.
    if (pass.id === "texel-probe") {
      report.passes[pass.id].expectedTexels = scene.imagery.corners;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ------------------------------------------------------------------------------------------------
// WebGL2 (the upstream GLSL baseline)
// ------------------------------------------------------------------------------------------------

function compileGlsl(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return { shader, log: gl.getShaderInfoLog(shader) ?? "", ok: gl.getShaderParameter(shader, gl.COMPILE_STATUS) === true };
}

function setUniform(gl, program, name, entry, textureUnits) {
  const glslType = entry.glslType;
  const location = gl.getUniformLocation(program, entry.size > 1 ? `${name}[0]` : name);
  if (location === null) return false;
  const scalar = { float: gl.uniform1f, int: gl.uniform1i, bool: gl.uniform1i };
  const scalarArray = { float: gl.uniform1fv, int: gl.uniform1iv, bool: gl.uniform1iv };
  const vectors = { vec2: gl.uniform2fv, vec3: gl.uniform3fv, vec4: gl.uniform4fv, ivec2: gl.uniform2iv, ivec3: gl.uniform3iv, ivec4: gl.uniform4iv };
  const matrix = { mat2: gl.uniformMatrix2fv, mat3: gl.uniformMatrix3fv, mat4: gl.uniformMatrix4fv };
  if (scalar[glslType] !== undefined) {
    const elements = entry.elements ?? [entry.value];
    if (entry.size > 1) {
      // An array uniform needs the *vector* setter (`uniform1fv`), not `uniform1f` — passing a typed
      // array to `uniform1f` is GL_INVALID_VALUE and leaves the uniform at 0.
      scalarArray[glslType].call(gl, location, glslType === "float" ? new Float32Array(elements.map(Number)) : new Int32Array(elements.map((value) => (value ? 1 : 0))));
    } else {
      scalar[glslType].call(gl, location, glslType === "float" ? Number(entry.value) : entry.value ? 1 : 0);
    }
    return true;
  }
  if (vectors[glslType] !== undefined) {
    const components = Number(glslType.slice(-1));
    const elements = entry.size > 1 ? entry.elements : [entry.value];
    const flat = [];
    for (const element of elements) for (let component = 0; component < components; component += 1) flat.push(Number(element[component] ?? 0));
    vectors[glslType].call(gl, location, glslType.startsWith("i") ? new Int32Array(flat) : new Float32Array(flat));
    return true;
  }
  if (matrix[glslType] !== undefined) {
    matrix[glslType].call(gl, location, false, new Float32Array(entry.value));
    return true;
  }
  if (glslType.startsWith("sampler")) {
    const unit = textureUnits.get(name) ?? 0;
    gl.uniform1i(location, unit);
    return true;
  }
  throw new Error(`g6p: unsupported uniform type ${glslType} for ${name}`);
}

async function runWebgl2(input) {
  const canvas = document.createElement("canvas");
  canvas.width = input.scene.viewport.width;
  canvas.height = input.scene.viewport.height;
  const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true, alpha: false });
  if (gl === null) throw new Error("WebGL2 context unavailable");
  report.adapter = { renderer: gl.getParameter(gl.RENDERER), vendor: gl.getParameter(gl.VENDOR), version: gl.getParameter(gl.VERSION), hasInfo: true };
  const scene = input.scene;

  const vertexArray = gl.createVertexArray();
  gl.bindVertexArray(vertexArray);
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(scene.vertexBytesArray), gl.STATIC_DRAW);
  const stride = input.attributes[0].stride;
  for (const attribute of input.attributes) {
    gl.enableVertexAttribArray(attribute.location);
    gl.vertexAttribPointer(attribute.location, GL_COMPONENTS[attribute.format], gl.FLOAT, false, stride, attribute.offset);
  }
  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint8Array(scene.indexBytesArray), gl.STATIC_DRAW);

  // Texture upload with `UNPACK_FLIP_Y_WEBGL = true` — Cesium's `Texture.flipY` default
  // (`Renderer/Texture.js:27`), i.e. the GL half of the mapping-layer flip policy.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  const textureUnits = new Map();
  let unit = 0;
  for (const sampler of scene.samplers) {
    textureUnits.set(sampler.glslName, unit);
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, scene.imagery.width, scene.imagery.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(scene.imagery.rgba));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    unit += 1;
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

  const { width, height } = scene.viewport;
  const bytesPerRow = width * 4;
  for (const pass of input.passes) {
    const vertexSource = await (await fetch(pass.vertexUrl)).text();
    const fragmentSource = await (await fetch(pass.fragmentUrl)).text();
    const vertex = compileGlsl(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compileGlsl(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertex.shader);
    gl.attachShader(program, fragment.shader);
    // Bind the attribute locations BEFORE linking — exactly what upstream's `ShaderProgram` does with
    // the tile's `terrainEncoding.getAttributeLocations()`; without it the linker is free to choose.
    for (const attribute of input.attributes) {
      if (attribute.name !== undefined) gl.bindAttribLocation(program, attribute.location, attribute.name);
    }
    gl.linkProgram(program);
    const linked = gl.getProgramParameter(program, gl.LINK_STATUS) === true;
    const linkLog = gl.getProgramInfoLog(program) ?? "";
    if (!linked) {
      report.passes[pass.id] = { linked: false, vertexLog: vertex.log, fragmentLog: fragment.log, linkLog, validationError: "link failed" };
      continue;
    }
    gl.useProgram(program);
    const unset = [];
    const uniformErrors = [];
    for (const entry of input.uniforms) {
      const before = gl.getError();
      if (!setUniform(gl, program, entry.name, entry, textureUnits)) unset.push(entry.name);
      const after = gl.getError();
      if (after !== 0 && after !== before) uniformErrors.push(`${entry.name}(${entry.glslType}[${entry.size}]): ${after}`);
    }
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(vertexArray);
    const beforeDraw = gl.getError();
    if (pass.attributes.length > 0) gl.drawElements(gl.TRIANGLES, scene.indexCount, gl.UNSIGNED_INT, 0);
    else gl.drawArrays(gl.TRIANGLES, 0, 3);
    const drawError = gl.getError();
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const error = gl.getError();
    report.passes[pass.id] = {
      ...frameStats(pixels, bytesPerRow, width, height),
      /** `true`: the frame is bottom-up (GL's window origin), the comparison aligns it. */
      rowsBottomUp: true,
      validationError: error === 0 ? null : `gl.getError() = ${error}`,
      errorPath: { beforeDraw, drawError, afterReadPixels: error, uniformErrors: uniformErrors.slice(0, 6) },
      attributeLocations: input.attributes.map((attribute) => ({ name: attribute.name, requested: attribute.location, actual: gl.getAttribLocation(program, attribute.name) })),
      unsetUniforms: unset.slice(0, 12),
      vertexLog: vertex.log.trim().length === 0 ? null : vertex.log,
      fragmentLog: fragment.log.trim().length === 0 ? null : fragment.log,
      linkLog: linkLog.trim().length === 0 ? null : linkLog,
    };
    if (pass.id === "texel-probe") report.passes[pass.id].expectedTexels = scene.imagery.corners;
    gl.deleteProgram(program);
    gl.deleteShader(vertex.shader);
    gl.deleteShader(fragment.shader);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function main() {
  try {
    const inputUrl = new URLSearchParams(globalThis.location.search).get("input");
    const input = await fetchJson(inputUrl);
    report.backend = input.backend;
    note(`input mode=${input.backend}`);
    if (input.backend === "webgpu") await runWebgpu(input);
    else if (input.backend === "webgl2") await runWebgl2(input);
    else throw new Error(`unknown backend "${input.backend}" (one backend per run — principle II / A7)`);
  } catch (error) {
    report.errors.push({ fatal: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`, stack: error?.stack ?? null });
  } finally {
    report.finishedAt = new Date().toISOString();
    report.ready = true;
  }
}

main();
