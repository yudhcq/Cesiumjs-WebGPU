/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: module-level replacement of `Source/Renderer/ShaderSource.js`
 * (kind: "adapt-shader") in the cesium-webgpu patch layer.
 * Upstream baseline: @cesium/engine 26.3.0 — see upstream/engine-26.3.0.lock.json and
 * packages/cesium-webgpu/backend-webgpu/manifest.json.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT THIS FILE ADDS, AND WHAT IT MUST NOT CHANGE (contract fork-patch-layer §5 R1/R2, tasks T067)
 * ------------------------------------------------------------------------------------------------
 * The GLSL assembly below is a **faithful port** of the upstream module: `removeComments`, the
 * `czm_` dependency graph, the topological sort, `combineShader` and every static helper are the
 * upstream algorithms, in the upstream order, producing the upstream bytes. The
 * `tests/unit/shader-source-dual-emit.test.mjs` suite asserts that over the whole MVP-reachable
 * define matrix by comparing this module's output with the **installed upstream module's** output,
 * byte for byte (768/768, the G-5 assertion re-run against the production seam).
 *
 * What is added, and nothing else:
 *   1. `emit: "glsl" | "wgsl"` (default `"glsl"`) — the compile-target parameterisation. The GLSL
 *      entry points read it only to refuse an impossible request; for `"glsl"` they are the upstream
 *      algorithm verbatim. `"wgsl"` never reaches the GLSL channel.
 *   2. `emitWgsl(...)` — the additive WGSL channel. It consumes the *same* `sources` + `defines` and
 *      never rewrites them (`webgpu/shader-emit.ts`, `webgpu/wgsl-emitter.ts`).
 *   3. `id` / `sceneMode` / `wgslOnly` — internal labels for the WGSL channel; `clone()` carries them.
 *   4. `ShaderSource.internalAssembly(inputs)` — the "导出装配所需内部件" R1 permits: the WGSL channel
 *      needs the same five inputs `combineShader` reads, forwarded by reference.
 *
 * The logic layer keeps reading `shaderProgram.vertexShaderSource` / `fragmentShaderSource` (R2) —
 * those stay the **original GLSL**; the WGSL text never enters them (contract §9 MUST NOT).
 */
import Frozen from "@cesium/engine/Source/Core/Frozen.js";
import defined from "@cesium/engine/Source/Core/defined.js";
import DeveloperError from "@cesium/engine/Source/Core/DeveloperError.js";
import CzmBuiltins from "@cesium/engine/Source/Shaders/Builtin/CzmBuiltins.js";
import AutomaticUniforms from "@cesium/engine/Source/Renderer/AutomaticUniforms.js";
import demodernizeShader from "@cesium/engine/Source/Renderer/demodernizeShader.js";

import type { ShaderEmitTarget } from "../webgpu/shader-emit.js";

/** The `Context` surface `combineShader` reads (upstream `Context.js:86-140`). */
interface ShaderContext {
  webgl2?: boolean;
  textureFloatLinear?: boolean;
  floatingPointTexture?: boolean;
  fragmentDepth?: boolean;
}

interface ShaderSourceOptions {
  sources?: string[];
  defines?: string[];
  pickColorQualifier?: string | undefined;
  includeBuiltIns?: boolean;
  /** WebGPU backend addition: the emission target. Defaults to `"glsl"`, upstream behaviour. */
  emit?: ShaderEmitTarget;
  /** WebGPU backend addition: internal label used by the WGSL channel's diagnostics. */
  id?: string;
  /** WebGPU backend addition: scene mode the runtime-generated position functions are chosen by. */
  sceneMode?: string;
  /** WebGPU backend addition: a source that exists only for the WGSL channel. */
  wgslOnly?: boolean;
}

interface DependencyNode {
  name: string;
  glslSource: string;
  dependsOn: DependencyNode[];
  requiredBy: DependencyNode[];
  evaluated: boolean;
}

type CzmBuiltinTable = Record<string, string>;

function removeComments(source: string): string {
  // remove inline comments
  source = source.replace(/\/\/.*/g, "");
  // remove multiline comment block
  return source.replace(/\/\*\*[\s\S]*?\*\//gm, function (match) {
    // preserve the number of lines in the comment block so the line numbers will be correct when debugging shaders
    const numberOfLines = (match.match(/\n/gm) ?? []).length;
    let replacement = "";
    for (let lineNumber = 0; lineNumber < numberOfLines; ++lineNumber) {
      replacement += "\n";
    }
    return replacement;
  });
}

function getDependencyNode(name: string, glslSource: string, nodes: DependencyNode[]): DependencyNode {
  let dependencyNode: DependencyNode | undefined;

  // check if already loaded
  for (let i = 0; i < nodes.length; ++i) {
    if ((nodes[i] as DependencyNode).name === name) {
      dependencyNode = nodes[i];
    }
  }

  if (dependencyNode === undefined) {
    // strip doc comments so we don't accidentally try to determine a dependency for something found
    // in a comment
    glslSource = removeComments(glslSource);

    // create new node
    dependencyNode = {
      name: name,
      glslSource: glslSource,
      dependsOn: [],
      requiredBy: [],
      evaluated: false,
    };
    nodes.push(dependencyNode);
  }

  return dependencyNode;
}

function generateDependencies(currentNode: DependencyNode, dependencyNodes: DependencyNode[]): void {
  if (currentNode.evaluated) {
    return;
  }

  currentNode.evaluated = true;

  // identify all dependencies that are referenced from this glsl source code
  let czmMatches: string[] | null = currentNode.glslSource.match(/\bczm_[a-zA-Z0-9_]*/g);
  if (defined(czmMatches) && czmMatches !== null) {
    // remove duplicates
    czmMatches = czmMatches.filter(function (elem, pos) {
      return (czmMatches as string[]).indexOf(elem) === pos;
    });

    czmMatches.forEach(function (element) {
      if (element !== currentNode.name && Object.prototype.hasOwnProperty.call(ShaderSource._czmBuiltinsAndUniforms, element)) {
        const referencedNode = getDependencyNode(element, ShaderSource._czmBuiltinsAndUniforms[element] as string, dependencyNodes);
        currentNode.dependsOn.push(referencedNode);
        referencedNode.requiredBy.push(currentNode);

        // recursive call to find any dependencies of the new node
        generateDependencies(referencedNode, dependencyNodes);
      }
    });
  }
}

function sortDependencies(dependencyNodes: DependencyNode[]): void {
  const nodesWithoutIncomingEdges: DependencyNode[] = [];
  const allNodes: DependencyNode[] = [];

  while (dependencyNodes.length > 0) {
    const node = dependencyNodes.pop() as DependencyNode;
    allNodes.push(node);

    if (node.requiredBy.length === 0) {
      nodesWithoutIncomingEdges.push(node);
    }
  }

  while (nodesWithoutIncomingEdges.length > 0) {
    const currentNode = nodesWithoutIncomingEdges.shift() as DependencyNode;

    dependencyNodes.push(currentNode);

    for (let i = 0; i < currentNode.dependsOn.length; ++i) {
      // remove the edge from the graph
      const referencedNode = currentNode.dependsOn[i] as DependencyNode;
      const index = referencedNode.requiredBy.indexOf(currentNode);
      referencedNode.requiredBy.splice(index, 1);

      // if referenced node has no more incoming edges, add to list
      if (referencedNode.requiredBy.length === 0) {
        nodesWithoutIncomingEdges.push(referencedNode);
      }
    }
  }

  // if there are any nodes left with incoming edges, then there was a circular dependency somewhere in the graph
  const badNodes: DependencyNode[] = [];
  for (let j = 0; j < allNodes.length; ++j) {
    if ((allNodes[j] as DependencyNode).requiredBy.length !== 0) {
      badNodes.push(allNodes[j] as DependencyNode);
    }
  }

  if (badNodes.length !== 0) {
    let message = "A circular dependency was found in the following built-in functions/structs/constants: \n";
    for (let k = 0; k < badNodes.length; ++k) {
      message = `${message + (badNodes[k] as DependencyNode).name}\n`;
    }
    throw new DeveloperError(message);
  }
}

function getBuiltinsAndAutomaticUniforms(shaderSource: string): string {
  // generate a dependency graph for builtin functions
  const dependencyNodes: DependencyNode[] = [];
  const root = getDependencyNode("main", shaderSource, dependencyNodes);
  generateDependencies(root, dependencyNodes);
  sortDependencies(dependencyNodes);

  // Concatenate the source code for the function dependencies.
  // Iterate in reverse so that dependent items are declared before they are used.
  let builtinsSource = "";
  for (let i = dependencyNodes.length - 1; i >= 0; --i) {
    builtinsSource = `${builtinsSource + (dependencyNodes[i] as DependencyNode).glslSource}\n`;
  }

  return builtinsSource.replace(root.glslSource, "");
}

function combineShader(shaderSource: ShaderSource, isFragmentShader: boolean, context: ShaderContext): string {
  // Combine shader sources, generally for pseudo-polymorphism, e.g., czm_getMaterial.
  let combinedSources = "";
  const sources = shaderSource.sources;
  if (defined(sources)) {
    for (let i = 0; i < sources.length; ++i) {
      // #line needs to be on its own line.
      combinedSources += `\n#line 0\n${sources[i] as string}`;
    }
  }

  combinedSources = removeComments(combinedSources);

  // Extract existing shader version from sources
  let version: string | undefined;
  combinedSources = combinedSources.replace(/#version\s+(.*?)\n/gm, function (match, group1: string) {
    if (defined(version) && version !== group1) {
      throw new DeveloperError(`inconsistent versions found: ${String(version)} and ${group1}`);
    }

    // Extract #version to put at the top
    version = group1;

    // Replace original #version directive with a new line so the line numbers
    // are not off by one.  There can be only one #version directive
    // and it must appear at the top of the source, only preceded by
    // whitespace and comments.
    return "\n";
  });

  // Extract shader extensions from sources
  const extensions: string[] = [];
  combinedSources = combinedSources.replace(/#extension.*\n/gm, function (match) {
    // Extract extension to put at the top
    extensions.push(match);

    // Replace original #extension directive with a new line so the line numbers
    // are not off by one.
    return "\n";
  });

  // Remove precision qualifier
  combinedSources = combinedSources.replace(/precision\s(lowp|mediump|highp)\s(float|int);/, "");

  // Replace main() for picked if desired.
  const pickColorQualifier = shaderSource.pickColorQualifier;
  if (defined(pickColorQualifier)) {
    combinedSources = ShaderSource.createPickFragmentShaderSource(combinedSources, pickColorQualifier as string);
  }

  // combine into single string
  let result = "";

  const extensionsLength = extensions.length;
  for (let i = 0; i < extensionsLength; i++) {
    result += extensions[i] as string;
  }

  if (isFragmentShader) {
    // If high precision isn't supported, replace occurrences of highp with mediump.
    // The highp keyword is not always available on older mobile devices.
    // See https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices#In_WebGL_1_highp_float_support_is_optional_in_fragment_shaders
    result += `
#ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    precision highp int;
#else
    precision mediump float;
    precision mediump int;
    #define highp mediump
#endif
`;
  }

  if (context.webgl2 === true) {
    result += `precision highp sampler3D;\n\n`;
  }

  // Prepend #defines for uber-shaders
  const defines = shaderSource.defines;
  if (defined(defines)) {
    for (let i = 0, length = defines.length; i < length; ++i) {
      const define = defines[i] as string;
      if (define.length !== 0) {
        result += `#define ${define}\n`;
      }
    }
  }

  // Define a constant for the OES_texture_float_linear extension since WebGL does not.
  if (context.textureFloatLinear === true) {
    result += "#define OES_texture_float_linear\n\n";
  }

  // Define a constant for the OES_texture_float extension since WebGL does not.
  if (context.floatingPointTexture === true) {
    result += "#define OES_texture_float\n\n";
  }

  // append built-ins
  let builtinSources = "";
  if (shaderSource.includeBuiltIns) {
    builtinSources = getBuiltinsAndAutomaticUniforms(combinedSources);
  }

  // reset line number
  result += "\n#line 0\n";

  // append actual source
  const combinedShader = builtinSources + combinedSources;
  if (
    context.webgl2 === true &&
    isFragmentShader &&
    !/layout\s*\(location\s*=\s*0\)\s*out\s+vec4\s+out_FragColor;/g.test(combinedShader) &&
    !/czm_out_FragColor/g.test(combinedShader) &&
    /out_FragColor/g.test(combinedShader)
  ) {
    result += "layout(location = 0) out vec4 out_FragColor;\n\n";
  }

  result += builtinSources;
  result += combinedSources;

  // modernize the source
  if (context.webgl2 !== true) {
    result = demodernizeShader(result, isFragmentShader);
  } else {
    result = `#version 300 es\n${result}`;
  }

  return result;
}

/**
 * An object containing various inputs that will be combined to form a final GLSL shader string.
 *
 * @param [options] Object with the following properties:
 * @param [options.sources] An array of strings to combine containing GLSL code for the shader.
 * @param [options.defines] An array of strings containing GLSL identifiers to `#define`.
 * @param [options.pickColorQualifier] The GLSL qualifier, `uniform` or `in`, for the input `czm_pickColor`.  When defined, a pick fragment shader is generated.
 * @param [options.includeBuiltIns=true] If true, referenced built-in functions will be included with the combined shader.  Set to false if this shader will become a source in another shader, to avoid duplicating functions.
 *
 * @exception {DeveloperError} options.pickColorQualifier must be 'uniform' or 'in'.
 */
export default class ShaderSource {
  defines: string[];
  sources: string[];
  pickColorQualifier: string | undefined;
  includeBuiltIns: boolean;

  /**
   * Compile-target parameterisation (contract §5 R1). `"glsl"` is the default and is what every
   * existing call site gets: the parameterisation never changes default behaviour.
   */
  emit: ShaderEmitTarget;

  /** Internal label for the WGSL channel's diagnostics (not part of the upstream surface). */
  id: string | undefined;

  /** Scene mode the runtime-generated position functions are chosen by (`POSITION_MODE_*`). */
  sceneMode: string | undefined;

  /** Internal: a source that exists only for the WGSL channel (no GLSL view exists for it). */
  wgslOnly: boolean;

  constructor(options?: ShaderSourceOptions) {
    const resolved: ShaderSourceOptions = options ?? (Frozen.EMPTY_OBJECT as ShaderSourceOptions);
    const pickColorQualifier = resolved.pickColorQualifier;

    if (defined(pickColorQualifier) && pickColorQualifier !== "uniform" && pickColorQualifier !== "in") {
      throw new DeveloperError("options.pickColorQualifier must be 'uniform' or 'in'.");
    }

    this.defines = defined(resolved.defines) ? (resolved.defines as string[]).slice(0) : [];
    this.sources = defined(resolved.sources) ? (resolved.sources as string[]).slice(0) : [];
    this.pickColorQualifier = pickColorQualifier;
    this.includeBuiltIns = resolved.includeBuiltIns ?? true;
    this.emit = resolved.emit ?? "glsl";
    this.id = resolved.id;
    this.sceneMode = resolved.sceneMode;
    this.wgslOnly = resolved.wgslOnly === true;
  }

  clone(): ShaderSource {
    // `exactOptionalPropertyTypes` forbids passing an explicit `undefined` to an optional property, so
    // the optional fields are only added when they are actually present. Upstream's `clone()` passes
    // `pickColorQualifier` through unconditionally; the observable behaviour is identical.
    const options: ShaderSourceOptions = {
      sources: this.sources,
      defines: this.defines,
      includeBuiltIns: this.includeBuiltIns,
      emit: this.emit,
      wgslOnly: this.wgslOnly,
    };
    if (this.pickColorQualifier !== undefined) options.pickColorQualifier = this.pickColorQualifier;
    if (this.id !== undefined) options.id = this.id;
    if (this.sceneMode !== undefined) options.sceneMode = this.sceneMode;
    return new ShaderSource(options);
  }

  static replaceMain(source: string, renamedMain: string): string {
    renamedMain = `void ${renamedMain}()`;
    return source.replace(/void\s+main\s*\(\s*(?:void)?\s*\)/g, renamedMain);
  }

  /**
   * Since {@link ShaderSource#createCombinedVertexShader} and
   * {@link ShaderSource#createCombinedFragmentShader} are both expensive to
   * compute, create a simpler string key for lookups in the {@link ShaderCache}.
   *
   * @returns A key for identifying this shader
   */
  getCacheKey(): string {
    // Sort defines to make the key comparison deterministic
    const sortedDefines = this.defines.slice().sort();
    const definesKey = sortedDefines.join(",");
    const pickKey = this.pickColorQualifier;
    const builtinsKey = this.includeBuiltIns;
    const sourcesKey = this.sources.join("\n");

    return `${definesKey}:${pickKey}:${builtinsKey}:${sourcesKey}`;
  }

  /**
   * Create a single string containing the full, combined vertex shader with all dependencies and defines.
   *
   * @param context The current rendering context
   * @returns The combined shader string.
   */
  createCombinedVertexShader(context: ShaderContext): string {
    if (this.emit === "wgsl" && this.wgslOnly) {
      throw new DeveloperError("a wgslOnly ShaderSource has no GLSL view (the logic layer must never see one)");
    }
    return combineShader(this, false, context);
  }

  /**
   * Create a single string containing the full, combined fragment shader with all dependencies and defines.
   *
   * @param context The current rendering context
   * @returns The combined shader string.
   */
  createCombinedFragmentShader(context: ShaderContext): string {
    if (this.emit === "wgsl" && this.wgslOnly) {
      throw new DeveloperError("a wgslOnly ShaderSource has no GLSL view (the logic layer must never see one)");
    }
    return combineShader(this, true, context);
  }

  /**
   * For ShaderProgram testing
   */
  static _czmBuiltinsAndUniforms: CzmBuiltinTable = {};

  static createPickVertexShaderSource(vertexShaderSource: string): string {
    const renamedVS = ShaderSource.replaceMain(vertexShaderSource, "czm_old_main");
    const pickMain =
      "in vec4 pickColor; \n" + "out vec4 czm_pickColor; \n" + "void main() \n" + "{ \n" + "    czm_old_main(); \n" + "    czm_pickColor = pickColor; \n" + "}";

    return `${renamedVS}\n${pickMain}`;
  }

  static createPickFragmentShaderSource(fragmentShaderSource: string, pickColorQualifier: string): string {
    const renamedFS = ShaderSource.replaceMain(fragmentShaderSource, "czm_old_main");
    const pickMain =
      `${pickColorQualifier} vec4 czm_pickColor; \n` +
      `void main() \n` +
      `{ \n` +
      `    czm_old_main(); \n` +
      `    if (out_FragColor.a == 0.0) { \n` +
      `       discard; \n` +
      `    } \n` +
      `    out_FragColor = czm_pickColor; \n` +
      `}`;

    return `${renamedFS}\n${pickMain}`;
  }

  static findNormalVarying(shaderSource: ShaderSource): string | undefined {
    // Fix for Model: the shader text always has the word v_normalEC
    // wrapped in an #ifdef so instead of looking for v_normalEC look for the define
    if (containsString(shaderSource, "#ifdef HAS_NORMALS")) {
      if (containsDefine(shaderSource, "HAS_NORMALS")) {
        return "v_normalEC";
      }
      return undefined;
    }

    return findFirstString(shaderSource, normalVaryingNames);
  }

  static findPositionVarying(shaderSource: ShaderSource): string | undefined {
    return findFirstString(shaderSource, positionVaryingNames);
  }

  /**
   * The assembly inputs the WGSL channel consumes, forwarded by reference (R1's
   * "导出装配所需内部件"). Exported as a static so the seam never has to reach into private state.
   */
  static internalAssembly(inputs: { sources: readonly string[]; defines: readonly string[]; includeBuiltIns: boolean; pickColorQualifier?: string | undefined; destination?: unknown }): {
    sources: readonly string[];
    defines: readonly string[];
    includeBuiltIns: boolean;
    pickColorQualifier: string | undefined;
    destination: unknown;
  } {
    return {
      sources: inputs.sources,
      defines: inputs.defines,
      includeBuiltIns: inputs.includeBuiltIns,
      pickColorQualifier: inputs.pickColorQualifier,
      destination: inputs.destination,
    };
  }
}

// combine automatic uniforms and Cesium built-ins
for (const builtinName in CzmBuiltins) {
  if (Object.prototype.hasOwnProperty.call(CzmBuiltins, builtinName)) {
    ShaderSource._czmBuiltinsAndUniforms[builtinName] = (CzmBuiltins as CzmBuiltinTable)[builtinName] as string;
  }
}
for (const uniformName in AutomaticUniforms) {
  if (Object.prototype.hasOwnProperty.call(AutomaticUniforms, uniformName)) {
    const uniform = (AutomaticUniforms as Record<string, { getDeclaration?: (name: string) => string }>)[uniformName];
    if (typeof uniform?.getDeclaration === "function") {
      ShaderSource._czmBuiltinsAndUniforms[uniformName] = uniform.getDeclaration(uniformName);
    }
  }
}

function containsDefine(shaderSource: ShaderSource, define: string): boolean {
  const defines = shaderSource.defines;
  const definesLength = defines.length;
  for (let i = 0; i < definesLength; ++i) {
    if (defines[i] === define) {
      return true;
    }
  }
  return false;
}

function containsString(shaderSource: ShaderSource, string: string): boolean {
  const sources = shaderSource.sources;
  const sourcesLength = sources.length;
  for (let i = 0; i < sourcesLength; ++i) {
    if ((sources[i] as string).indexOf(string) !== -1) {
      return true;
    }
  }
  return false;
}

function findFirstString(shaderSource: ShaderSource, strings: readonly string[]): string | undefined {
  const stringsLength = strings.length;
  for (let i = 0; i < stringsLength; ++i) {
    const string = strings[i] as string;
    if (containsString(shaderSource, string)) {
      return string;
    }
  }
  return undefined;
}

const normalVaryingNames = ["v_normalEC", "v_normal"];
const positionVaryingNames = ["v_positionEC"];
