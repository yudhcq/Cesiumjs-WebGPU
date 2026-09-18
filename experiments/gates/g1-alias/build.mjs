#!/usr/bin/env node
/**
 * G-1 gate — real build chain (tasks.md T015).
 *
 * Runs **Rollup with the production alias plugin** (`tools/rollup-plugin-engine-patch.mjs`,
 * T008) over an entry that imports the upstream `Scene/Scene.js` and the upstream
 * `Renderer/Context.js` deep path, with the gate-local manifest (`manifest.gate.json`) listing
 * exactly one replacement: `Renderer/Context.js`.
 *
 * What it proves, with evidence written to `experiments/gates/out/g1-build.json`:
 *   a. the module graph contains the **upstream** `Scene/Scene.js` and **not** the upstream
 *      `Renderer/Context.js`;
 *   b. `Scene.js`'s own relative import `../Renderer/Context.js` (`Scene/Scene.js:40`) resolves to
 *      this directory's implementation (per-resolution trace from a real Rollup run);
 *   c. the alias whitelist is exhaustive (`whitelistExhaustiveCheck`);
 *   d. every logic-layer module in the graph still comes from `node_modules/@cesium/engine/Source/**`
 *      (`logicLayerOverrides === 0`), so the logic layer is not touched by the patch;
 *   e. no unresolved import survives, so the bundle is loadable as-is.
 *
 * Usage: `node experiments/gates/g1-alias/build.mjs [--quiet]`
 * Exported for the runner and for tests: `buildGateBundle()`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rollup } from "rollup";

import { createEnginePatchPlugin, whitelistExhaustiveCheck } from "../../../tools/rollup-plugin-engine-patch.mjs";
import { createCjsInteropPlugin } from "./cjs-interop.mjs";

export const GATE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(GATE_DIR, "..", "..", "..");
export const OUT_DIR = path.join(REPO_ROOT, "experiments", "gates", "out");
export const BUNDLE_DIR = path.join(OUT_DIR, "g1-alias");
export const ENGINE_ROOT = path.join(REPO_ROOT, "node_modules", "@cesium", "engine");
export const ENGINE_SOURCE_ROOT = path.join(ENGINE_ROOT, "Source");
export const MANIFEST_PATH = path.join(GATE_DIR, "manifest.gate.json");
export const ENTRY = path.join(GATE_DIR, "entry.js");

/** Unique to the upstream `Renderer/Context.js`: if this text is in the bundle, that module is. */
const UPSTREAM_CONTEXT_SNIPPET = "this._originalGLContext = glContext;";
/** Positive control: unique to the upstream `Scene/Scene.js`, which MUST be in the bundle. */
const UPSTREAM_SCENE_SNIPPET = "this._logDepthBuffer = Scene.defaultLogDepthBuffer && context.fragmentDepth;";

const LOGIC_LAYER_PREFIXES = ["Scene/", "Core/", "DataSources/", "Widget/", "Workers/", "ThirdParty/", "Shaders/"];

/**
 * CommonJS-only dependencies the upstream engine imports (finding F-1). Detection is
 * content-based inside `cjs-interop.mjs`; only the upstream engine itself is excluded.
 */
const CJS_EXCLUDED_PREFIXES = [ENGINE_ROOT];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function repoRelative(absolute) {
  return toPosix(path.relative(REPO_ROOT, absolute));
}

function check(id, ok, detail) {
  return { id, ok, detail };
}

/** Classify one resolved module id (absolute, or repository-relative) by where it lives. */
function classify(id) {
  const normalised = toPosix(path.isAbsolute(id) ? path.resolve(id) : path.resolve(REPO_ROOT, id));
  const engineSource = toPosix(ENGINE_SOURCE_ROOT);
  if (normalised === engineSource || normalised.startsWith(`${engineSource}/`)) {
    const subpath = normalised.slice(engineSource.length + 1);
    return { layer: "upstream-engine", subpath, logicLayer: LOGIC_LAYER_PREFIXES.some((prefix) => subpath.startsWith(prefix)) };
  }
  if (normalised.startsWith(`${toPosix(GATE_DIR)}/`)) return { layer: "gate-local", subpath: toPosix(path.relative(REPO_ROOT, normalised)), logicLayer: false };
  if (normalised.includes("/node_modules/")) return { layer: "third-party", subpath: normalised.slice(normalised.lastIndexOf("/node_modules/") + 1), logicLayer: false };
  return { layer: "repo", subpath: toPosix(path.relative(REPO_ROOT, normalised)), logicLayer: false };
}

/** Record every resolution the build performs, including the alias rewrite. */
function tracePlugin(records) {
  return {
    name: "g1-resolution-trace",
    async resolveId(source, importer) {
      if (typeof source !== "string") return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      records.push({
        source,
        importer: importer === undefined || importer === null ? null : repoRelative(importer),
        resolved: resolved === null ? null : repoRelative(resolved.id),
        external: resolved === null ? null : resolved.external === true,
      });
      return null;
    },
  };
}

/** The repository's own implementation path (MUST NOT consume upstream private members). */
function implementationPathPrivateMemberScan() {
  const roots = [
    path.join(REPO_ROOT, "packages", "cesium-webgpu", "src"),
    path.join(REPO_ROOT, "packages", "cesium-webgpu", "backend-webgpu"),
  ];
  const hits = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      const text = fs.readFileSync(child, "utf8");
      text.split(/\r?\n/).forEach((line, index) => {
        if (/\b_context\b/.test(line)) hits.push({ file: repoRelative(child), line: index + 1 });
      });
    }
  };
  for (const root of roots) walk(root);
  return hits;
}

export async function buildGateBundle(options = {}) {
  const {
    quiet = false,
    manifestPath = MANIFEST_PATH,
    bundleDir = BUNDLE_DIR,
    artifactPath = path.join(OUT_DIR, "g1-build.json"),
  } = options;
  const log = (line) => {
    if (!quiet) process.stdout.write(`[g1-build] ${line}\n`);
  };

  const enginePackage = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "upstream", "engine-26.3.0.lock.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const upstreamContextFile = path.join(ENGINE_SOURCE_ROOT, "Renderer", "Context.js");
  const upstreamSceneFile = path.join(ENGINE_SOURCE_ROOT, "Scene", "Scene.js");
  const upstreamContextText = fs.readFileSync(upstreamContextFile, "utf8");
  const upstreamSceneText = fs.readFileSync(upstreamSceneFile, "utf8");

  // Self-check the two detector literals: each MUST be unique to the file it is claimed to detect,
  // otherwise the presence/absence assertions below would be meaningless.
  const countOccurrences = (text, needle) => text.split(needle).length - 1;
  const detector = {
    contextSnippet: UPSTREAM_CONTEXT_SNIPPET,
    contextSnippetOccurrencesInUpstreamContext: countOccurrences(upstreamContextText, UPSTREAM_CONTEXT_SNIPPET),
    sceneSnippet: UPSTREAM_SCENE_SNIPPET,
    sceneSnippetOccurrencesInUpstreamScene: countOccurrences(upstreamSceneText, UPSTREAM_SCENE_SNIPPET),
  };

  const records = [];
  const warnings = [];
  const patchPlugin = createEnginePatchPlugin({ manifestPath, localRoot: GATE_DIR, engineRoot: ENGINE_ROOT, quiet: true });

  // Direct (build-independent) rewrite evidence for the exact import T015 names.
  const sceneImporter = upstreamSceneFile;
  const directRewrite = {
    upstreamModule: "Renderer/Context.js",
    shouldRewriteUpstreamContext: patchPlugin.api.shouldRewrite(upstreamContextFile) !== null,
    relativeFromScene: patchPlugin.resolveId("../Renderer/Context.js", sceneImporter),
    bareDeepImport: patchPlugin.resolveId("@cesium/engine/Source/Renderer/Context.js", undefined),
    keptModuleUnaffected: patchPlugin.resolveId("@cesium/engine/Source/Renderer/ContextLimits.js", undefined),
    upstreamSceneUnaffected: patchPlugin.resolveId("@cesium/engine/Source/Scene/Scene.js", undefined),
  };

  log(`bundling ${repoRelative(ENTRY)} with the T008 alias plugin (manifest ${repoRelative(manifestPath)})`);
  const cjsWrapped = [];
  const bundle = await rollup({
    input: ENTRY,
    plugins: [
      tracePlugin(records),
      patchPlugin,
      nodeResolve({ browser: true, exportConditions: ["import"], preferBuiltins: false }),
      // Finding F-1: the upstream engine imports CommonJS-only packages and the approved
      // dependency set (T004) has no CJS interop plugin. The wrapper is build-time only and
      // runs the real package code; it is recorded in the gate artefact.
      createCjsInteropPlugin({
        excludePrefixes: CJS_EXCLUDED_PREFIXES,
        onWrap: (record) => cjsWrapped.push(record),
      }),
    ],
    onwarn(warning) {
      warnings.push({ code: warning.code ?? "UNKNOWN", message: warning.message, id: warning.id ? repoRelative(warning.id) : null });
    },
  });

  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  await bundle.write({
    dir: bundleDir,
    format: "es",
    entryFileNames: "bundle.js",
    chunkFileNames: "chunk-[name]-[hash].js",
    sourcemap: false,
  });
  const watchFiles = bundle.watchFiles.map((file) => path.resolve(file));
  await bundle.close();

  const bundleFile = path.join(bundleDir, "bundle.js");
  const bundleCode = fs.readFileSync(bundleFile, "utf8");

  // ---- module-graph classification ------------------------------------------------------------
  const classified = watchFiles.map((id) => ({ id, ...classify(id) }));
  const graph = {
    moduleCount: classified.length,
    upstreamEngineModules: classified.filter((entry) => entry.layer === "upstream-engine").length,
    gateLocalModules: classified.filter((entry) => entry.layer === "gate-local").map((entry) => entry.subpath).sort(),
    upstreamLogicLayerModules: classified.filter((entry) => entry.layer === "upstream-engine" && entry.logicLayer).length,
    thirdPartyModules: classified.filter((entry) => entry.layer === "third-party").length,
    otherModules: classified.filter((entry) => entry.layer === "repo").map((entry) => entry.subpath),
  };
  // "Logic-layer override" = a logic-layer module whose code does NOT come from the installed
  // upstream package. The patch boundary (principle I / SC-010) allows zero of those.
  const logicLayerOverrides = graph.otherModules.length;
  const upstreamContextInGraph = classified.some((entry) => entry.layer === "upstream-engine" && entry.subpath === "Renderer/Context.js");
  const localContextInGraph = graph.gateLocalModules.includes("experiments/gates/g1-alias/Renderer/Context.js");
  const upstreamSceneInGraph = classified.some((entry) => entry.layer === "upstream-engine" && entry.subpath === "Scene/Scene.js");
  const upstreamRendererInGraph = classified
    .filter((entry) => entry.layer === "upstream-engine" && entry.subpath.startsWith("Renderer/"))
    .map((entry) => entry.subpath)
    .sort();

  // ---- whitelist exhaustiveness ---------------------------------------------------------------
  const engineSourceFiles = [];
  const walkEngine = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walkEngine(child);
      else if (entry.name.endsWith(".js")) engineSourceFiles.push(toPosix(path.relative(ENGINE_SOURCE_ROOT, child)));
    }
  };
  walkEngine(ENGINE_SOURCE_ROOT);
  const whitelist = whitelistExhaustiveCheck(engineSourceFiles, { manifestPath, localRoot: GATE_DIR, engineRoot: ENGINE_ROOT, quiet: true });

  // ---- resolution trace (deduplicated, bounded) ------------------------------------------------
  // Rollup re-resolves the same specifier many times (binding, tree-shaking, absolute-path
  // re-resolution), so 18k+ raw calls collapse to a few hundred unique ones. Only the records that
  // matter for the patch boundary are stored; the raw count is kept for completeness.
  const uniqueRecords = [...new Map(records.map((record) => [`${record.source}|${record.importer}|${record.resolved}`, record])).values()];
  const boundaryImporters = [
    "node_modules/@cesium/engine/Source/Scene/Scene.js",
    "node_modules/@cesium/engine/index.js",
    "node_modules/@cesium/engine/Source/Renderer/SharedContext.js",
  ];
  const relevantRecords = uniqueRecords.filter(
    (record) =>
      // Absolute-path records are Rollup's internal re-resolution of an id a plugin already
      // returned; the originating specifier record for the same edge is stored instead.
      !path.isAbsolute(record.source) &&
      ((record.resolved !== null && classify(record.resolved).layer === "gate-local") ||
        /Context(?:Limits)?\.js$/.test(record.source) ||
        /Scene\/Scene\.js$/.test(record.source) ||
        boundaryImporters.includes(record.importer ?? "")),
  );
  const rewriteRecords = uniqueRecords.filter((record) => record.resolved !== null && classify(record.resolved).layer === "gate-local");
  const relativeRewrite = rewriteRecords.find((record) => record.source === "../Renderer/Context.js" && record.importer === "node_modules/@cesium/engine/Source/Scene/Scene.js");
  const bareRewrite = rewriteRecords.find((record) => record.source === "@cesium/engine/Source/Renderer/Context.js");

  // ---- checks ---------------------------------------------------------------------------------
  const checks = [
    check(
      "upstream-baseline-version",
      enginePackage.version === "26.3.0" && lock.version === "26.3.0" && enginePackage.version === lock.version,
      `installed @cesium/engine ${enginePackage.version}; upstream/engine-26.3.0.lock.json ${lock.version} (cesium ${lock.cesiumVersion})`,
    ),
    check(
      "detector-literals-unique",
      detector.contextSnippetOccurrencesInUpstreamContext === 1 && detector.sceneSnippetOccurrencesInUpstreamScene === 1,
      `"${UPSTREAM_CONTEXT_SNIPPET}" x${detector.contextSnippetOccurrencesInUpstreamContext} in upstream Context.js; ` +
        `"${UPSTREAM_SCENE_SNIPPET}" x${detector.sceneSnippetOccurrencesInUpstreamScene} in upstream Scene.js (the presence/absence probes below depend on this)`,
    ),
    check(
      "build-rewrite-scene-relative-import",
      relativeRewrite !== undefined && directRewrite.relativeFromScene === path.join(GATE_DIR, "Renderer", "Context.js"),
      `Scene/Scene.js:40 \`import Context from "../Renderer/Context.js"\` resolved to "${relativeRewrite ? relativeRewrite.resolved : "NOT REWRITTEN"}" during the real Rollup run`,
    ),
    check(
      "build-rewrite-bare-deep-import",
      bareRewrite !== undefined && bareRewrite.resolved === "experiments/gates/g1-alias/Renderer/Context.js",
      `bare deep import "@cesium/engine/Source/Renderer/Context.js" resolved to "${bareRewrite ? bareRewrite.resolved : "NOT REWRITTEN"}"`,
    ),
    check(
      "build-upstream-context-absent-from-graph",
      !upstreamContextInGraph && localContextInGraph && upstreamSceneInGraph,
      `graph: upstream Renderer/Context.js present=${upstreamContextInGraph}, gate-local Renderer/Context.js present=${localContextInGraph}, upstream Scene/Scene.js present=${upstreamSceneInGraph}`,
    ),
    check(
      "build-bundle-text-probe",
      bundleCode.includes(UPSTREAM_SCENE_SNIPPET) && !bundleCode.includes(UPSTREAM_CONTEXT_SNIPPET) && bundleCode.includes("G1-ALIAS-CONTEXT-STUB-v1"),
      `bundle contains the upstream Scene.js control snippet=${bundleCode.includes(UPSTREAM_SCENE_SNIPPET)}, ` +
        `contains upstream Context.js snippet=${bundleCode.includes(UPSTREAM_CONTEXT_SNIPPET)}, contains the gate stub marker=${bundleCode.includes("G1-ALIAS-CONTEXT-STUB-v1")}`,
    ),
    check(
      "whitelist-exhaustive",
      whitelist.ok === true,
      `rewritten set == manifest set: missing=[${whitelist.missing.join(", ")}] extra=[${whitelist.extra.join(", ")}] (manifest ${whitelist.manifestModules.length}, rewritten ${whitelist.rewritten.length})`,
    ),
    check(
      "logic-layer-overrides-zero",
      logicLayerOverrides === 0 &&
        graph.gateLocalModules.length === 2 &&
        graph.gateLocalModules.includes("experiments/gates/g1-alias/entry.js") &&
        graph.gateLocalModules.includes("experiments/gates/g1-alias/Renderer/Context.js"),
      `logicLayerOverrides=${logicLayerOverrides}; repo-local modules in the graph=[${graph.gateLocalModules.join(", ")}]; ` +
        `upstream logic-layer modules bundled=${graph.upstreamLogicLayerModules}`,
    ),
    check(
      "no-unresolved-imports",
      warnings.every((warning) => warning.code !== "UNRESOLVED_IMPORT"),
      `${warnings.length} rollup warning(s), codes=${JSON.stringify([...new Set(warnings.map((warning) => warning.code))])}; UNRESOLVED_IMPORT entries=` +
        `${warnings.filter((warning) => warning.code === "UNRESOLVED_IMPORT").length} (an unresolved import would survive into the browser bundle)`,
    ),
    check(
      "missing-exports-attributable-to-cjs-interop",
      warnings.filter((warning) => warning.code === "MISSING_EXPORT").every((warning) => cjsWrapped.some((record) => warning.message.includes(repoRelative(record.id)))),
      `MISSING_EXPORT warning(s): ${warnings.filter((warning) => warning.code === "MISSING_EXPORT").length}; each one MUST be attributable to the F-1 CommonJS wrapper ` +
        `(${cjsWrapped.map((record) => record.id.split("/node_modules/").pop()).join(", ") || "none wrapped"}). ` +
        `Detail: ${warnings.filter((warning) => warning.code === "MISSING_EXPORT").map((warning) => warning.message).join(" | ") || "none"}`,
    ),
    check(
      "kept-modules-stay-upstream",
      directRewrite.keptModuleUnaffected === null && directRewrite.upstreamSceneUnaffected === null && upstreamRendererInGraph.includes("Renderer/ContextLimits.js"),
      `not-in-manifest modules are never rewritten (ContextLimits -> ${directRewrite.keptModuleUnaffected ?? "upstream"}, Scene -> ${directRewrite.upstreamSceneUnaffected ?? "upstream"}); ` +
        `${upstreamRendererInGraph.length} upstream Renderer module(s) bundled, Context.js excluded=[${!upstreamRendererInGraph.includes("Renderer/Context.js")}]`,
    ),
    check(
      "third-party-cjs-interop-recorded",
      cjsWrapped.length > 0,
      `${cjsWrapped.length} CommonJS/UMD module(s) wrapped at build time (finding F-1: no CJS plugin in the approved dependency set): ` +
        `${cjsWrapped.map((record) => `${record.id.split("/node_modules/").pop()} [${record.requires.join(" ") || "-"}]`).join("; ")}`,
    ),
  ];

  const privateMemberHits = implementationPathPrivateMemberScan();
  checks.push(
    check(
      "private-members-confined-to-gate-assertions",
      privateMemberHits.length === 0,
      `"_context" occurrences under packages/cesium-webgpu/{src,backend-webgpu} (implementation path, .d.ts excluded): ${privateMemberHits.length}` +
        (privateMemberHits.length > 0 ? ` -> ${privateMemberHits.map((hit) => `${hit.file}:${hit.line}`).join(", ")}` : ""),
    ),
  );

  const report = {
    tool: "g1-alias/build",
    recordedAt: new Date().toISOString(),
    node: process.version,
    engine: { root: repoRelative(ENGINE_ROOT), version: enginePackage.version, cesiumVersion: lock.cesiumVersion, lock: "upstream/engine-26.3.0.lock.json" },
    manifest: { path: repoRelative(manifestPath), entries: manifest.entries.map((entry) => ({ upstreamModule: entry.upstreamModule, localFile: entry.localFile, kind: entry.kind })) },
    plugin: { path: "tools/rollup-plugin-engine-patch.mjs", name: patchPlugin.name },
    entry: repoRelative(ENTRY),
    directRewrite: Object.fromEntries(Object.entries(directRewrite).map(([key, value]) => [key, typeof value === "string" ? repoRelative(value) : value])),
    detector,
    graph,
    logicLayerOverrides,
    rewriteRecords,
    resolutionRecords: relevantRecords,
    resolutionRecordCount: records.length,
    resolutionRecordNote:
      `${records.length} resolveId calls collapsed to ${uniqueRecords.length} unique (source, importer, resolved) triples; ` +
      `${relevantRecords.length} boundary-relevant records are stored below (gate-local rewrites, Context/ContextLimits/Scene imports, Scene.js/index.js/SharedContext.js importers)`,
    whitelist,
    bundle: {
      file: repoRelative(bundleFile),
      bytes: fs.statSync(bundleFile).size,
      chunks: fs.readdirSync(bundleDir).sort(),
      containsStubMarker: bundleCode.includes("G1-ALIAS-CONTEXT-STUB-v1"),
      containsUpstreamSceneSnippet: bundleCode.includes(UPSTREAM_SCENE_SNIPPET),
      containsUpstreamContextSnippet: bundleCode.includes(UPSTREAM_CONTEXT_SNIPPET),
    },
    cjsInterop: { excludedPrefixes: CJS_EXCLUDED_PREFIXES.map(repoRelative), wrapped: cjsWrapped },
    warnings,
    checks,
  };

  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log(`bundle ${report.bundle.bytes} bytes, ${graph.moduleCount} module(s) in the graph, ${rewriteRecords.length} rewrite(s) -> ${report.bundle.file}`);
  return report;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  buildGateBundle()
    .then((report) => {
      const failed = report.checks.filter((entry) => entry.ok !== true);
      for (const entry of report.checks) process.stdout.write(`  [${entry.ok ? "ok" : "FAIL"}] ${entry.id}: ${entry.detail}\n`);
      process.exitCode = failed.length === 0 ? 0 : 1;
    })
    .catch((error) => {
      console.error(`g1-alias/build: unexpected failure: ${error.stack ?? error}`);
      process.exitCode = 2;
    });
}
