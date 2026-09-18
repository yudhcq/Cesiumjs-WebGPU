/**
 * G-1 gate bundle entry.
 *
 * The two bare deep imports below are resolved by the T008 alias plugin
 * (`tools/rollup-plugin-engine-patch.mjs`) against the gate-local manifest
 * (`manifest.gate.json`): `Renderer/Context.js` is rewritten to this directory's implementation,
 * everything else (including `Scene/Scene.js` and the kept module `Renderer/ContextLimits.js`)
 * keeps coming from the installed upstream package.
 *
 * `Scene` is imported so that the *upstream* module graph — including its own relative
 * `import Context from "../Renderer/Context.js"` (`Scene/Scene.js:40`) — is part of the same
 * real build; the page then constructs that `Scene` with no context injected, so the only way
 * the scene can obtain a context is through the rewritten module.
 */
import Context from "@cesium/engine/Source/Renderer/Context.js";
import Scene from "@cesium/engine/Source/Scene/Scene.js";
import ContextLimits from "@cesium/engine/Source/Renderer/ContextLimits.js";
import LocalContext, { G1_STUB_IMPLEMENTATION, G1_STUB_MARKER, gateDiagnostics } from "./Renderer/Context.js";

/**
 * `true` when the deep bare import (`@cesium/engine/Source/Renderer/Context.js`) and the gate-local
 * file resolve to the *same* module instance — i.e. the alias rewrite and the local file agree.
 */
export const contextIdentity = Context === LocalContext;

export { Context, ContextLimits, G1_STUB_IMPLEMENTATION, G1_STUB_MARKER, LocalContext, Scene, gateDiagnostics };
