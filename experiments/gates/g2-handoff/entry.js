/**
 * G-2 gate bundle entry (tasks.md T016).
 *
 * The bare deep import of `Renderer/Context.js` is rewritten by the T008 alias plugin against the
 * gate-local manifest, so `Scene/Scene.js`'s own relative `import Context from "../Renderer/Context.js"`
 * resolves to `experiments/gates/g2-handoff/Renderer/Context.js`. Everything else — including the kept
 * modules `Renderer/ContextLimits.js`, `Renderer/ShaderCache.js`, `Renderer/TextureCache.js`,
 * `Renderer/UniformState.js` — keeps coming from the installed upstream package.
 *
 * `Scene` is imported so that the *upstream* module graph (and its real construction path) is part of
 * the same real build; the page then constructs it with no context injected.
 */
import Context from "@cesium/engine/Source/Renderer/Context.js";
import ContextLimits from "@cesium/engine/Source/Renderer/ContextLimits.js";
import Scene from "@cesium/engine/Source/Scene/Scene.js";
// F-1 condition 5 evidence: the upstream engine reaches protobufjs through a *namespace* import and
// then uses `protobuf.Reader.create(...)` (Scene/GoogleEarthEnterpriseImageryProvider.js:482). With
// G-1's default-only wrapper that member degraded to a missing named export; with the real
// `@rollup/plugin-commonjs` the named export must exist at runtime. Exported so the gate page can
// assert it (rather than inferring it from the build log).
import * as protobuf from "protobufjs/dist/minimal/protobuf.js";

import LocalContext, {
  G2_STUB_IMPLEMENTATION,
  G2_STUB_MARKER,
  g2Diagnostics,
  gateClock,
} from "./Renderer/Context.js";
import {
  HANDOFF_CATEGORY,
  HANDOFF_KEY,
  clearHandoff,
  handoffAudit,
  installHandoff,
  peekHandoff,
  resetHandoff,
  takeHandoff,
} from "./device-handoff.mjs";
import { FLAG_TABLE, LIMIT_TABLE, MVP_SLICE, composeCapabilities } from "./capability-map.mjs";

/**
 * `true` when the deep bare import and the gate-local file resolve to the *same* module instance,
 * i.e. the alias rewrite and the local file agree.
 */
export const contextIdentity = Context === LocalContext;

/** `true` when the bundle came from a build whose manifest replaces `Renderer/Context.js`. */
export const contextIsReplaced = Context !== undefined && Context.__g2GateStub === true;

/**
 * F-1 condition 5, verified at runtime: the protobufjs namespace member the upstream engine uses must
 * be a real constructor with the static `create` factory (G-1 measured it as `undefined`).
 */
export const protobufReaderProbe = {
  readerType: typeof protobuf.Reader,
  createIsFunction: typeof protobuf.Reader?.create === "function",
  rootType: typeof protobuf.Root,
  keys: Object.keys(protobuf).slice(0, 20),
};

export {
  Context,
  ContextLimits,
  FLAG_TABLE,
  G2_STUB_IMPLEMENTATION,
  G2_STUB_MARKER,
  HANDOFF_CATEGORY,
  HANDOFF_KEY,
  LIMIT_TABLE,
  LocalContext,
  MVP_SLICE,
  Scene,
  clearHandoff,
  composeCapabilities,
  g2Diagnostics,
  gateClock,
  handoffAudit,
  installHandoff,
  peekHandoff,
  resetHandoff,
  takeHandoff,
};
