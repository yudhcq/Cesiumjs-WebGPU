#!/usr/bin/env node
/**
 * T035 — interface-consistency manifest generator (data-model §1.4, research §10).
 *
 * For every module the patch layer replaces or adapts, the generator records what the
 * **logic layer** actually consumes from it:
 *
 *   InterfaceEntry = {
 *     module,                                  // "Renderer/Context.js"
 *     exportedSymbols[],                       // the module's exposed member surface (class
 *                                              // members, accessors, instance fields, exports)
 *     consumedMembers: { name, kind, arity? }[],
 *     consumedBy: string[]                     // logic-layer files, static scan
 *   }
 *
 * Upgrade maintenance: `--check` recomputes the manifest and fails when it drifted from the
 * committed baseline — the diff is the "adaptation list" of an upstream upgrade (contract §6).
 *
 * Usage:
 *   node tools/gen-interface-manifest.mjs            # (re)generate upstream/interface-manifest.json
 *   node tools/gen-interface-manifest.mjs --check    # fail on drift (offline, CI)
 *   node tools/gen-interface-manifest.mjs --print    # print without writing
 *   node tools/gen-interface-manifest.mjs --check --manifest <file>   # compare against another baseline
 *
 * Exit codes: 0 ok, 1 drift (`--check`), 2 misconfiguration.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  INTERFACE_MANIFEST_PATH,
  MANIFEST_PATH,
  REPO_ROOT,
  hashText,
  listEngineModules,
  readJsonFile,
  readPatchManifest,
  resolveEngineRoot,
  toPosix,
} from "./lib/patch-layer.mjs";

/**
 * Receiver identifiers through which the logic layer reaches each module's members.
 *
 * The scan is `(?<receiver>)\.(?<member>)` intersected with the module's own member surface, so
 * a name collision on an unrelated object cannot enter the record. The default-exported class
 * name is always included as a receiver (static use, e.g. `ContextLimits.maximumTextureSize`,
 * measured in research §1.3); the entries below are the variable names the logic layer uses.
 */
const RECEIVER_HINTS = {
  "Renderer/Context.js": ["context", "frameState.context", "scene.context", "view.context", "this._context"],
  "Renderer/ContextLimits.js": [],
  "Renderer/ShaderProgram.js": ["shaderProgram", "sp", "program"],
  "Renderer/ShaderSource.js": ["shaderSource", "source"],
  "Renderer/ShaderCache.js": ["shaderCache"],
  "Renderer/RenderState.js": ["renderState", "rs"],
  "Renderer/Buffer.js": ["buffer", "vertexBuffer", "indexBuffer", "pixelBuffer"],
  "Renderer/Texture.js": ["texture", "defaultTexture", "depthTexture"],
  "Renderer/Texture3D.js": ["texture3D"],
  "Renderer/TextureAtlas.js": ["textureAtlas"],
  "Renderer/TextureCache.js": ["textureCache"],
  "Renderer/CubeMap.js": ["cubeMap", "defaultCubeMap"],
  "Renderer/CubeMapFace.js": ["cubeMapFace", "face"],
  "Renderer/VertexArray.js": ["vertexArray"],
  "Renderer/Framebuffer.js": ["framebuffer"],
  "Renderer/Renderbuffer.js": ["renderbuffer"],
  "Renderer/MultisampleFramebuffer.js": ["multisampleFramebuffer"],
  "Renderer/FramebufferManager.js": ["framebufferManager"],
  "Renderer/ComputeEngine.js": ["computeEngine"],
  "Renderer/SharedContext.js": ["sharedContext"],
  "Renderer/Sync.js": ["sync"],
  "Renderer/createUniform.js": [],
  "Renderer/createUniformArray.js": [],
  "Renderer/loadCubeMap.js": ["loadCubeMap"],
};

const LOGIC_LAYER_EXCLUDED_PREFIXES = ["Renderer/"];

/** Member surface of one upstream module: class members, accessors, instance fields, exports. */
export function readMemberSurface(source) {
  const members = new Map();
  const add = (name, kind) => {
    if (typeof name !== "string" || name.length === 0) return;
    if (!members.has(name)) members.set(name, kind);
  };

  // The default export identifies the module's subject (class, frozen object or factory function).
  // It is recorded separately: `exportedSymbols` describes the *members*, not the module name.
  const defaultExport =
    /export default class ([A-Za-z_$][\w$]*)/.exec(source)?.[1] ??
    /^export default ([A-Za-z_$][\w$]*)\s*;/m.exec(source)?.[1] ??
    null;
  // Upstream declares the subject either as a class (`export default class Context`) or — the
  // dominant style in `Renderer/**` — as a constructor function with prototype members
  // (`function Context(options) { … }` … `Context.prototype.draw = function …`).
  const declaredClasses = [...source.matchAll(/^(?:export default )?class ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
  const declaredFactories = [...source.matchAll(/^function ([A-Za-z_$][\w$]*)\s*\(/gm)].map((match) => match[1]);
  const className = declaredClasses.find((name) => name === defaultExport) ?? declaredClasses[0] ?? null;
  const classLike = className ?? (defaultExport !== null && declaredFactories.includes(defaultExport) ? defaultExport : null);

  for (const match of source.matchAll(/^export (?:async )?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) add(match[1], "export");
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && name.length > 0) add(name, "export");
    }
  }
  for (const name of declaredFactories) add(name, "factory");

  if (classLike !== null) {
    for (const match of source.matchAll(new RegExp(`${classLike}\\.prototype\\.([A-Za-z_$][\\w$]*)\\s*=`, "g"))) add(match[1], "method");
    for (const match of source.matchAll(new RegExp(`${classLike}\\.prototype\\.([A-Za-z_$][\\w$]*)\\s*\\(`, "g"))) add(match[1], "method");
    for (const match of source.matchAll(new RegExp(`${classLike}\\.([A-Za-z_$][\\w$]*)\\s*=`, "g"))) add(match[1], "static");
    // Members declared with class-field syntax inside a real class body (`name(` at 2 spaces).
    const classBody = source.indexOf(`class ${classLike}`);
    if (classBody >= 0) {
      for (const match of source.slice(classBody).matchAll(/^ {2}(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) add(match[1], "method");
    }
  }

  // `Object.defineProperties(<Subject>.prototype | <Subject>, { name: { … } })` — accessor blocks
  // and plain properties at 2 spaces, the same shape the upstream module files use throughout.
  // Upstream keeps its internal backing fields on the same indentation with a leading underscore
  // (measured for ContextLimits: 23 `_maximum…`/`_highp…` backers next to 23 public accessors), so
  // the underscore form is treated as internal and stays out of the public member surface.
  for (const match of source.matchAll(/^ {2}([A-Za-z_$][\w$]*):\s*\{\s*$/gm)) if (!match[1].startsWith("_")) add(match[1], "accessor");
  for (const match of source.matchAll(/^ {2}([A-Za-z_$][\w$]*):\s*(?!\{\s*$)[^\n]*,$/gm)) if (!match[1].startsWith("_")) add(match[1], "property");

  // Instance fields (`this._attributeLocations = …`) — part of the read surface the contract
  // pins for ShaderProgram (contract §5 R2).
  for (const match of source.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) add(match[1], "field");

  return { members, className, defaultExport };
}

/**
 * Modules covered by the interface manifest: the patch surface (every replacement manifest
 * entry) plus every upstream internal module this repository declares in
 * `packages/cesium-webgpu/types/engine-internal.d.ts`. Both halves are machine-derived — the
 * declaration file is the "what we consume" checklist, the manifest is the "what we replace" list.
 */
export function listInterfaceModules({ root = REPO_ROOT, manifestPath } = {}) {
  const manifest = readPatchManifest(root, manifestPath ?? path.join(root, ...MANIFEST_PATH.split("/")));
  const modules = new Map();
  for (const entry of manifest?.entries ?? []) modules.set(entry.upstreamModule, { module: entry.upstreamModule, inManifest: true, kind: entry.kind });
  const dtsPath = path.join(root, "packages", "cesium-webgpu", "types", "engine-internal.d.ts");
  if (fs.existsSync(dtsPath)) {
    const text = fs.readFileSync(dtsPath, "utf8");
    for (const match of text.matchAll(/declare module "@cesium\/engine\/Source\/(Renderer\/[A-Za-z0-9_]+\.js)"/g)) {
      const module_ = match[1];
      const existing = modules.get(module_);
      if (existing === undefined) modules.set(module_, { module: module_, inManifest: false, kind: "kept-consumed" });
      else existing.declared = true;
    }
  }
  return [...modules.values()].sort((a, b) => (a.module < b.module ? -1 : 1));
}

/** Logic-layer modules (`Source/**` outside `Source/Renderer/**`) and their text. */
export function readLogicLayer(engineRoot) {
  const engine = resolveEngineRoot(engineRoot);
  const files = listEngineModules(engine).filter((module_) => !LOGIC_LAYER_EXCLUDED_PREFIXES.some((prefix) => module_.startsWith(prefix)));
  return files.map((module_) => ({ module: module_, text: fs.readFileSync(path.join(engine, "Source", ...module_.split("/")), "utf8") }));
}

function countArity(line, member) {
  const tail = line.slice(line.indexOf(`.${member}`) + member.length + 1).trimStart();
  if (!tail.startsWith("(")) return null;
  let depth = 0;
  let args = 0;
  let sawContent = false;
  for (let i = 0; i < tail.length; i += 1) {
    const ch = tail[i];
    if (ch === "(") {
      depth += 1;
      if (depth === 1) continue;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return sawContent ? args + 1 : 0;
    } else if (ch === "," && depth === 1) {
      args += 1;
    }
    if (depth >= 1 && !/\s/.test(ch)) sawContent = true;
  }
  return null;
}

/** Build the `InterfaceEntry[]` for the patch surface of the replacement manifest. */
export function buildInterfaceEntries({ root = REPO_ROOT, engineRoot, manifestPath } = {}) {
  const engine = resolveEngineRoot(engineRoot ?? path.join(root, "node_modules", "@cesium", "engine"));
  const modules = listInterfaceModules({ root, ...(manifestPath ? { manifestPath } : {}) });
  const logicLayer = readLogicLayer(engine);

  return modules
    .map((descriptor) => {
      const module_ = descriptor.module;
      const absolute = path.join(engine, "Source", ...module_.split("/"));
      if (!fs.existsSync(absolute)) throw new Error(`upstream module not installed: ${module_}`);
      const source = fs.readFileSync(absolute, "utf8");
      const { members, defaultExport } = readMemberSurface(source);
      const memberKind = Object.fromEntries(members);

      const receivers = [...new Set([...(defaultExport === null ? [] : [defaultExport]), ...(RECEIVER_HINTS[module_] ?? [])])]
        .map((receiver) => receiver.replace(/[.$]/g, "\\$&"))
        .sort((a, b) => b.length - a.length);
      const consumed = new Map();
      const consumedBy = new Set();
      if (receivers.length > 0) {
        // One precompiled pattern per module: `<receiver>.<member>` for any declared receiver.
        const pattern = new RegExp(`(?:^|[^\\w$])(?:${receivers.join("|")})\\.([A-Za-z_$][\\w$]*)`, "g");
        for (const file of logicLayer) {
          for (const line of file.text.split(/\r?\n/)) {
            if (!line.includes(".")) continue;
            pattern.lastIndex = 0;
            let match;
            let hit = false;
            while ((match = pattern.exec(line)) !== null) {
              const member = match[1];
              if (!members.has(member)) continue;
              hit = true;
              const arity = countArity(line, member);
              const previous = consumed.get(member);
              const record = { name: member, kind: memberKind[member], ...(arity === null ? {} : { arity }) };
              if (previous === undefined) consumed.set(member, record);
              else if (record.arity !== undefined) previous.arity = record.arity;
            }
            if (hit) consumedBy.add(file.module);
          }
        }
      }

      const exportedSymbols = [...members.keys()].sort();
      const consumedMembers = [...consumed.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
      const entryRecord = {
        module: module_,
        exportedSymbols,
        consumedMembers,
        consumedBy: [...consumedBy].sort(),
      };
      return {
        ...entryRecord,
        defaultExport,
        namedExports: [...members.entries()].filter(([, kind]) => kind === "export").map(([name]) => name).sort(),
        kind: descriptor.kind,
        inManifest: descriptor.inManifest === true,
        ...(descriptor.declared === true ? { declaredInTypes: true } : {}),
        digest: hashText(JSON.stringify(entryRecord)),
      };
    })
    .sort((a, b) => (a.module < b.module ? -1 : 1));
}

/** Build the full `InterfaceManifest` document. */
export function buildInterfaceManifest(options = {}) {
  const root = options.root ? path.resolve(options.root) : REPO_ROOT;
  const baseline = readJsonFile(path.join(root, "upstream", "engine-26.3.0.lock.json"));
  const entries = buildInterfaceEntries({ ...options, root });
  const document = {
    baselineVersion: baseline.version,
    cesiumVersion: baseline.cesiumVersion,
    generatedAt: new Date().toISOString(),
    generator: "tools/gen-interface-manifest.mjs",
    method:
      "Static scan of the installed upstream sources. `exportedSymbols` = the module's exposed member surface " +
      "(prototype methods, Object.defineProperties accessors, instance fields, static members, named exports). " +
      "`consumedMembers` = members of that surface reached from logic-layer files (Source/** outside Source/Renderer/**) " +
      "through the receiver identifiers declared in the generator (RECEIVER_HINTS + the default-exported class name). " +
      "`consumedBy` lists those logic-layer files. `digest` folds module, surface, consumed members and consumers.",
    entries,
    digest: hashText(JSON.stringify(entries.map((entry) => [entry.module, entry.digest]))),
    notes:
      "Upgrade drill input (contract §6 step 2): a version bump regenerates this file and the diff is the adaptation list. " +
      "`--check` fails when the committed baseline no longer matches the installed package.",
  };
  return document;
}

/** Compare a generated manifest with the committed baseline (drift = upgrade work). */
export function compareInterfaceManifests(baseline, generated) {
  const baseEntries = new Map((baseline?.entries ?? []).map((entry) => [entry.module, entry]));
  const newEntries = new Map((generated?.entries ?? []).map((entry) => [entry.module, entry]));
  // Compare the contract fields themselves (not just the recorded digest), so a caller that
  // perturbs an entry without recomputing its digest is still reported as drift.
  const shape = (entry) =>
    JSON.stringify({
      module: entry?.module,
      exportedSymbols: entry?.exportedSymbols ?? [],
      consumedMembers: entry?.consumedMembers ?? [],
      consumedBy: entry?.consumedBy ?? [],
    });
  const changedModules = [];
  for (const [module_, entry] of newEntries) {
    const base = baseEntries.get(module_);
    if (base === undefined || shape(base) !== shape(entry)) changedModules.push(module_);
  }
  const addedModules = [...newEntries.keys()].filter((module_) => !baseEntries.has(module_));
  const removedModules = [...baseEntries.keys()].filter((module_) => !newEntries.has(module_));
  const breakingConsumedMembers = [];
  for (const [module_, entry] of newEntries) {
    const base = baseEntries.get(module_);
    if (base === undefined) continue;
    const baseMembers = new Set((base.consumedMembers ?? []).map((member) => member.name));
    for (const member of entry.consumedMembers ?? []) {
      if (!baseMembers.has(member.name)) breakingConsumedMembers.push({ module: module_, member: member.name });
    }
  }
  return {
    fromVersion: baseline?.baselineVersion ?? null,
    toVersion: generated?.baselineVersion ?? null,
    changedRenderModules: changedModules.sort(),
    addedModules,
    removedModules,
    breakingConsumedMembers,
    digestChanged: baseline?.digest !== generated?.digest,
    drifted: changedModules.length > 0 || addedModules.length > 0 || removedModules.length > 0,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const print = argv.includes("--print");
  const manifestIndex = argv.findIndex((arg) => arg === "--manifest" || arg.startsWith("--manifest="));
  let manifestTarget = null;
  if (manifestIndex >= 0) {
    const arg = argv[manifestIndex];
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[manifestIndex + 1];
    if (value === undefined) {
      console.error("gen-interface-manifest: --manifest requires a path");
      return 2;
    }
    manifestTarget = path.resolve(value);
    argv.splice(manifestIndex, arg.includes("=") ? 1 : 2);
  }
  const unknown = argv.filter((arg) => !["--check", "--print"].includes(arg));
  if (unknown.length > 0) {
    console.error(`gen-interface-manifest: unknown argument "${unknown[0]}"`);
    return 2;
  }
  if (check && print) {
    console.error("gen-interface-manifest: --check and --print are mutually exclusive");
    return 2;
  }

  const target = manifestTarget ?? path.join(REPO_ROOT, ...INTERFACE_MANIFEST_PATH.split("/"));
  const generated = buildInterfaceManifest();

  if (print) {
    console.log(JSON.stringify(generated, null, 2));
    return 0;
  }

  if (check) {
    if (!fs.existsSync(target)) {
      console.error(`gen-interface-manifest: ${toPosix(path.relative(REPO_ROOT, target))} is missing; generate it first`);
      return 1;
    }
    const baseline = readJsonFile(target);
    const diff = compareInterfaceManifests(baseline, generated);
    if (!diff.drifted && diff.changedRenderModules.length === 0 && diff.addedModules.length === 0 && diff.removedModules.length === 0) {
      console.log(`no drift (${generated.entries.length} module(s), ${generated.digest})`);
      return 0;
    }
    console.error("gen-interface-manifest: interface drift detected");
    for (const module_ of diff.changedRenderModules) console.error(`  changed: ${module_}`);
    for (const module_ of diff.addedModules) console.error(`  added: ${module_}`);
    for (const module_ of diff.removedModules) console.error(`  removed: ${module_}`);
    for (const item of diff.breakingConsumedMembers) console.error(`  new consumed member: ${item.module} -> ${item.member}`);
    console.error(`  digest ${baseline.digest} -> ${generated.digest}`);
    return 1;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(generated, null, 2)}\n`, "utf8");
  const consumed = generated.entries.reduce((sum, entry) => sum + entry.consumedMembers.length, 0);
  console.log(
    `gen-interface-manifest: ${generated.entries.length} module(s), ${consumed} consumed member(s), digest ${generated.digest} -> ` +
      `${toPosix(path.relative(REPO_ROOT, target))}`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = main();
}

export { main };
