/**
 * G-5 gate — the **parameterised shader assembly seam** (`emit: "glsl" | "wgsl"`) and the
 * byte-identity evidence for the compliance requirement of
 * `contracts/fork-patch-layer.md` R1:
 *
 *   > `ShaderSource.js` 进入清单，`kind: "adapt-shader"`；改动 MUST 限于
 *   > "增加 WGSL 发射通道 + 导出装配所需内部件"，**GLSL 视图与预处理语义 MUST 不变**.
 *
 * How the seam is built here (Phase 2 — the fork itself is Phase 3/T037+, so nothing under
 * `packages/**` may be touched yet):
 *
 *   `installShaderEmissionSeam(ShaderSource)` returns a **subclass of the upstream class** that
 *   overrides nothing about GLSL: every GLSL method delegates to the *upstream prototype* held by
 *   reference, so the GLSL view is byte-identical **by construction** — and the gate *measures*
 *   that, over the whole MVP-reachable define matrix, by hashing both channels' output
 *   (`compareGlslChannels`). The WGSL channel is additive: `emitWgsl()` consumes exactly the
 *   upstream assembly inputs (`sources`, `defines`, `includeBuiltIns`, `pickColorQualifier`,
 *   `ShaderDestination`) and never rewrites them.
 *
 * The production change (Phase 3) is the same edit applied in place inside
 * `backend-webgpu/Renderer/ShaderSource.js`; the gate deliberately proves the property with the
 * smallest edit that can express it, so the evidence is about the *property*, not about a
 * particular diff shape.
 */
import { emitTerrainWgsl, emitterDefinesFor } from "./wgsl-emitter.mjs";
import { deriveVaryingPairs } from "./varying-pairing.mjs";
import { assembleGlslForVariant, BASE_SOURCES } from "./define-matrix.mjs";

/** Upstream assembly inputs the seam forwards unchanged (the "装配所需内部件" of R1). */
export function assemblyInputsOf(shaderSource) {
  return {
    sources: shaderSource.sources,
    defines: shaderSource.defines,
    includeBuiltIns: shaderSource.includeBuiltIns,
    pickColorQualifier: shaderSource.pickColorQualifier,
    destination: shaderSource.destination,
  };
}

/**
 * Install the emission channel on a `ShaderSource` class.
 *
 * @param {Function} ShaderSource the upstream class (`@cesium/engine/Source/Renderer/ShaderSource.js`)
 * @returns {{ParameterisedShaderSource: Function, upstreamPrototype: object}}
 */
export function installShaderEmissionSeam(ShaderSource) {
  const upstreamPrototype = {
    createCombinedVertexShader: ShaderSource.prototype.createCombinedVertexShader,
    createCombinedFragmentShader: ShaderSource.prototype.createCombinedFragmentShader,
    clone: ShaderSource.prototype.clone,
  };

  class ParameterisedShaderSource extends ShaderSource {
    /**
     * The WGSL channel. `emit` defaults to `"glsl"`, which is what every existing call site gets —
     * the parameterisation never changes default behaviour.
     */
    emitWgsl({ layout, fragmentSource, vertexSource, derivation = null } = {}) {
      if (this.emit !== "wgsl") throw new Error('g5: emitWgsl() requires `emit: "wgsl"` (the GLSL view stays the default)');
      const vertex = vertexSource ?? upstreamPrototype.createCombinedVertexShader.call(this, this._context ?? { webgl2: true });
      const fragment = fragmentSource ?? upstreamPrototype.createCombinedFragmentShader.call(this, this._context ?? { webgl2: true });
      const pairing = derivation ?? deriveVaryingPairs({ vertexSource: vertex, fragmentSource: fragment, defines: this.defines });
      return emitTerrainWgsl({ variant: { id: this.id ?? "ad-hoc", defines: this.defines, sceneMode: this.sceneMode ?? "SCENE3D" }, glsl: { vertexSource: vertex, fragmentSource: fragment }, derivation: pairing, layout });
    }
  }

  // The GLSL view is *the upstream function itself* — held by reference, not reimplemented.
  ParameterisedShaderSource.prototype.createCombinedVertexShader = function createCombinedVertexShader(context) {
    if (this.emit === "wgsl" && this.wgslOnly === true) throw new Error("g5: wgslOnly sources have no GLSL view (the logic layer must never see one)");
    return upstreamPrototype.createCombinedVertexShader.call(this, context);
  };
  ParameterisedShaderSource.prototype.createCombinedFragmentShader = function createCombinedFragmentShader(context) {
    if (this.emit === "wgsl" && this.wgslOnly === true) throw new Error("g5: wgslOnly sources have no GLSL view (the logic layer must never see one)");
    return upstreamPrototype.createCombinedFragmentShader.call(this, context);
  };
  ParameterisedShaderSource.prototype.clone = function clone() {
    const copy = upstreamPrototype.clone.call(this);
    copy.emit = this.emit ?? "glsl";
    copy.id = this.id;
    copy.sceneMode = this.sceneMode;
    copy.wgslOnly = this.wgslOnly === true;
    return copy;
  };

  return { ParameterisedShaderSource, upstreamPrototype };
}

/**
 * Byte-identity of the GLSL channel over the whole matrix.
 *
 * For each enumerated variant the GLSL is produced twice — once by a plain upstream `ShaderSource`
 * instance and once by the **parameterised** class — through the exact same define pushes
 * (`assembleGlslForVariant` with `ShaderSourceClass`), and the two texts are compared byte for
 * byte. Any difference is reported with the first differing line, so "identical" is never an
 * assertion without a witness.
 *
 * @param {{ShaderSource: Function, variants: object[], seam: object, hash?: (text: string) => string}} input
 */
export function compareGlslChannels({ ShaderSource, variants, seam, hash = null }) {
  const { ParameterisedShaderSource } = seam;
  const rows = [];
  let identical = 0;
  const differences = [];
  for (const variant of variants) {
    const upstream = assembleGlslForVariant(variant, { ShaderSourceClass: ShaderSource });
    const parameterised = assembleGlslForVariant(variant, { ShaderSourceClass: ParameterisedShaderSource, emit: "glsl" });
    const vertexEqual = upstream.vertexSource === parameterised.vertexSource;
    const fragmentEqual = upstream.fragmentSource === parameterised.fragmentSource;
    if (vertexEqual && fragmentEqual) identical += 1;
    else {
      differences.push({
        variant: variant.id,
        vertexEqual,
        fragmentEqual,
        firstDivergence: firstDivergence(parameterised.vertexSource, upstream.vertexSource) ?? firstDivergence(parameterised.fragmentSource, upstream.fragmentSource),
      });
    }
    rows.push({
      id: variant.id,
      vertexEqual,
      fragmentEqual,
      vertexBytes: upstream.vertexSource.length,
      fragmentBytes: upstream.fragmentSource.length,
      // The non-default channel must be reachable but must never be the default.
      defaultEmit: new ShaderSource({ sources: [], defines: [] }).emit ?? "glsl",
      ...(hash === null ? {} : { upstreamVertexHash: hash(upstream.vertexSource), parameterisedVertexHash: hash(parameterised.vertexSource), upstreamFragmentHash: hash(upstream.fragmentSource), parameterisedFragmentHash: hash(parameterised.fragmentSource) }),
    });
  }
  return { identical, total: variants.length, differences, rows };
}

/** First line at which two texts diverge (a witness for "not identical"). */
export function firstDivergence(a, b) {
  if (a === b) return null;
  const left = a.split("\n");
  const right = b.split("\n");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return { line: index + 1, seam: left[index] ?? "<eof>", upstream: right[index] ?? "<eof>" };
  }
  return { line: 0, seam: `<equal lines, ${a.length} vs ${b.length} bytes>`, upstream: "" };
}

/** The defines the emitter adds on top of the upstream list (all internal to the WGSL channel). */
export function internalDefinesOf(variant, derivation) {
  return emitterDefinesFor(variant, derivation);
}
