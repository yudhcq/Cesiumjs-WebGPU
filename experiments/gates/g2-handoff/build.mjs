#!/usr/bin/env node
/**
 * G-2 gate — real build chain (tasks.md T016).
 *
 * Builds **two** bundles with the production alias plugin (`tools/rollup-plugin-engine-patch.mjs`, T008):
 *
 *   1. `gate`    — the gate-local manifest replaces `Renderer/Context.js` (the WebGPU run);
 *   2. `webgl2`  — an **empty** manifest with an empty local root, so the upstream
 *                  `Renderer/Context.js` serves the scene (the WebGL2 fallback run, research §3 step 4).
 *
 * CommonJS interop is now a **real dependency** (`@rollup/plugin-commonjs`, pinned devDependency,
 * finding F-1): the upstream `Source/**` imports `mersenne-twister` / `urijs` / `grapheme-splitter` /
 * `bitmap-sdf` / `lerc` / `protobufjs` (browserify build) — CJS-only packages. G-1 had to wrap them
 * with a gate-local plugin that only exposes a `default` export, which is exactly why Rollup reported
 * one `MISSING_EXPORT` for `Reader` (the namespace member access `protobuf.Reader.create(...)` in
 * `Scene/GoogleEarthEnterpriseImageryProvider.js:482`) — the symbol was bound to `undefined`.
 * This build asserts the real plugin removes that warning (F-1 condition 5).
 *
 * Evidence: `experiments/gates/out/g2-build.json` (gate bundle) and `out/g2-webgl2-build.json`.
 * Usage: `node experiments/gates/g2-handoff/build.mjs [--quiet]`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rollup } from "rollup";

import { createEnginePatchPlugin, whitelistExhaustiveCheck } from "../../../tools/rollup-plugin-engine-patch.mjs";

export const GATE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(GATE_DIR, "..", "..", "..");
export const OUT_DIR = path.join(REPO_ROOT, "experiments", "gates", "out");
export const ENGINE_ROOT = path.join(REPO_ROOT, "node_modules", "@cesium", "engine");
export const ENGINE_SOURCE_ROOT = path.join(ENGINE_ROOT, "Source");
export const GATE_MANIFEST_PATH = path.join(GATE_DIR, "manifest.gate.json");
export const WEBGL2_MANIFEST_PATH = path.join(OUT_DIR, "g2-webgl2-manifest.json");
export const WEBGL2_LOCAL_ROOT = path.join(OUT_DIR, "g2-webgl2-root");
export const ENTRY = path.join(GATE_DIR, "entry.js");

/** Unique to the upstream `Renderer/Context.js`: if this text is in the bundle, that module is. */
const UPSTREAM_CONTEXT_SNIPPET = "this._originalGLContext = glContext;";
/** Positive control: unique to the upstream `Scene/Scene.js`, which MUST be in both bundles. */
const UPSTREAM_SCENE_SNIPPET = "this._logDepthBuffer = Scene.defaultLogDepthBuffer && context.fragmentDepth;";

const LOGIC_LAYER_PREFIXES = ["Scene/", "Core/", "DataSources/", "Widget/", "Workers/", "ThirdParty/", "Shaders/"];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function repoRelative(absolute) {
  return toPosix(path.relative(REPO_ROOT, absolute));
}

function check(id, ok, detail) {
  return { id, ok: ok === true, detail };
}

/** Classify one resolved module id (absolute, or repository-relative) by where it lives. */
function classify(id) {
  const normalised = toPosix(path.isAbsolute(id) ? path.resolve(id) : path.resolve(REPO_ROOT, id));
  const engineSource = toPosix(ENGINE_SOURCE_ROOT);
  if (normalised === engineSource || normalised.startsWith(`${engineSource}/`)) {
    const subpath = normalised.slice(engineSource.length + 1);
    return { layer: "upstream-engine", subpath, logicLayer: LOGIC_LAYER_PREFIXES.some((prefix) => subpath.startsWith(prefix)) };
  }
  if (normalised.startsWith(`${toPosix(GATE_DIR)}/`)) return { layer: "gate-local", subpath: repoRelative(normalised), logicLayer: false };
  if (normalised.includes("/node_modules/")) return { layer: "third-party", subpath: normalised.slice(normalised.lastIndexOf("/node_modules/") + 1), logicLayer: false };
  return { layer: "repo", subpath: repoRelative(normalised), logicLayer: false };
}

/** Record every resolution the build performs, including the alias rewrite. */
function tracePlugin(records) {
  return {
    name: "g2-resolution-trace",
    async resolveId(source, importer) {
      if (typeof source !== "string") return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      records.push({
        source,
        importer: importer === undefined || importer === null ? null : repoRelative(importer),
        resolved: resolved === null ? null : repoRelative(resolved.id),
      });
      return null;
    },
  };
}

/** The repository's own implementation path (MUST NOT consume upstream private members). */
function implementationPathPrivateMemberScan() {
  const roots = [path.join(REPO_ROOT, "packages", "cesium-webgpu", "src"), path.join(REPO_ROOT, "packages", "cesium-webgpu", "backend-webgpu")];
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
      fs.readFileSync(child, "utf8")
        .split(/\r?\n/)
        .forEach((line, index) => {
          if (/\b_context\b/.test(line)) hits.push({ file: repoRelative(child), line: index + 1 });
        });
    }
  };
  for (const root of roots) walk(root);
  return hits;
}

/** Engine `Source` JavaScript module list (for the whitelist exhaustiveness check). */
function listEngineSourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".js")) files.push(toPosix(path.relative(ENGINE_SOURCE_ROOT, child)));
    }
  };
  walk(ENGINE_SOURCE_ROOT);
  return files;
}

/** Write the empty manifest + empty local root used by the WebGL2 run. */
export function prepareWebgl2Inputs() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(WEBGL2_LOCAL_ROOT, { recursive: true, force: true });
  fs.mkdirSync(WEBGL2_LOCAL_ROOT, { recursive: true });
  fs.writeFileSync(
    WEBGL2_MANIFEST_PATH,
    `${JSON.stringify(
      {
        gateNote:
          "G-2 WebGL2-run manifest: EMPTY on purpose (plus an empty local root). With no entry the T008 alias plugin rewrites nothing, so the *upstream* Renderer/Context.js serves the Scene — this is the second backend run required by T016 (a).",
        baseline: { packageName: "@cesium/engine", version: "26.3.0", cesiumVersion: "1.145.0" },
        entries: [],
        keptModulesHash: null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { manifestPath: WEBGL2_MANIFEST_PATH, localRoot: WEBGL2_LOCAL_ROOT };
}

/**
 * Build one bundle.
 *
 * @param {object} options
 * @param {"gate"|"webgl2"} options.label
 * @param {string} options.manifestPath
 * @param {string} options.localRoot
 * @param {string} options.bundleDir
 * @param {string} options.artifactPath
 * @param {boolean} [options.quiet]
 * @param {boolean} [options.expectReplacement]
 */
export async function buildBundle(options) {
  const { label, manifestPath, localRoot, bundleDir, artifactPath, quiet = false, expectReplacement = true } = options;
  const log = (line) => {
    if (!quiet) process.stdout.write(`[g2-build:${label}] ${line}\n`);
  };

  const enginePackage = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "upstream", "engine-26.3.0.lock.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const commonjsPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", "@rollup", "plugin-commonjs", "package.json"), "utf8"));

  const upstreamContextFile = path.join(ENGINE_SOURCE_ROOT, "Renderer", "Context.js");
  const upstreamSceneText = fs.readFileSync(path.join(ENGINE_SOURCE_ROOT, "Scene", "Scene.js"), "utf8");
  const detector = {
    contextSnippet: UPSTREAM_CONTEXT_SNIPPET,
    contextSnippetOccurrencesInUpstreamContext: fs.readFileSync(upstreamContextFile, "utf8").split(UPSTREAM_CONTEXT_SNIPPET).length - 1,
    sceneSnippet: UPSTREAM_SCENE_SNIPPET,
    sceneSnippetOccurrencesInUpstreamScene: upstreamSceneText.split(UPSTREAM_SCENE_SNIPPET).length - 1,
  };

  const records = [];
  const warnings = [];
  const cjsTransformed = [];
  const patchPlugin = createEnginePatchPlugin({ manifestPath, localRoot, engineRoot: ENGINE_ROOT, quiet: true });

  const directRewrite = {
    upstreamModule: "Renderer/Context.js",
    relativeFromScene: patchPlugin.resolveId("../Renderer/Context.js", path.join(ENGINE_SOURCE_ROOT, "Scene", "Scene.js")),
    bareDeepImport: patchPlugin.resolveId("@cesium/engine/Source/Renderer/Context.js", undefined),
    keptModuleUnaffected: patchPlugin.resolveId("@cesium/engine/Source/Renderer/ContextLimits.js", undefined),
    upstreamSceneUnaffected: patchPlugin.resolveId("@cesium/engine/Source/Scene/Scene.js", undefined),
  };

  log(`bundling ${repoRelative(ENTRY)} (manifest ${repoRelative(manifestPath)}, label=${label})`);
  const bundle = await rollup({
    input: ENTRY,
    plugins: [
      tracePlugin(records),
      patchPlugin,
      nodeResolve({ browser: true, exportConditions: ["import"], preferBuiltins: false }),
      commonjs({
        // F-1: the real CJS interop plugin, now an approved pinned devDependency.
        include: [/node_modules/],
        transformMixedEsModules: true,
      }),
      {
        // Evidence hook: record which third-party modules the CJS plugin actually converted.
        name: "g2-cjs-evidence",
        transform(code, id) {
          const normalised = toPosix(id);
          if (normalised.includes("/node_modules/") && /\.(?:js|cjs)$/.test(normalised) && /\bmodule\.exports\b|\bexports\.[A-Za-z_$]|\bdefine\(/.test(code)) {
            cjsTransformed.push(normalised.split("/node_modules/").pop());
          }
          return null;
        },
      },
    ],
    onwarn(warning) {
      warnings.push({ code: warning.code ?? "UNKNOWN", message: warning.message, id: warning.id ? repoRelative(warning.id) : null });
    },
  });

  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  await bundle.write({ dir: bundleDir, format: "es", entryFileNames: "bundle.js", chunkFileNames: "chunk-[name]-[hash].js", sourcemap: false });
  const watchFiles = bundle.watchFiles.map((file) => path.resolve(file));
  await bundle.close();

  const bundleFile = path.join(bundleDir, "bundle.js");
  const bundleCode = fs.readFileSync(bundleFile, "utf8");

  const classified = watchFiles.map((id) => ({ id, ...classify(id) }));
  const graph = {
    moduleCount: classified.length,
    upstreamEngineModules: classified.filter((entry) => entry.layer === "upstream-engine").length,
    gateLocalModules: classified.filter((entry) => entry.layer === "gate-local").map((entry) => entry.subpath).sort(),
    upstreamLogicLayerModules: classified.filter((entry) => entry.layer === "upstream-engine" && entry.logicLayer).length,
    repoModules: classified.filter((entry) => entry.layer === "repo").map((entry) => entry.subpath),
    thirdPartyModules: classified.filter((entry) => entry.layer === "third-party").length,
  };
  const logicLayerOverrides = graph.repoModules.length;
  const upstreamContextInGraph = classified.some((entry) => entry.layer === "upstream-engine" && entry.subpath === "Renderer/Context.js");
  const localContextInGraph = graph.gateLocalModules.includes("experiments/gates/g2-handoff/Renderer/Context.js");
  const upstreamSceneInGraph = classified.some((entry) => entry.layer === "upstream-engine" && entry.subpath === "Scene/Scene.js");
  const upstreamRendererInGraph = classified
    .filter((entry) => entry.layer === "upstream-engine" && entry.subpath.startsWith("Renderer/"))
    .map((entry) => entry.subpath)
    .sort();

  const whitelist = whitelistExhaustiveCheck(listEngineSourceFiles(), { manifestPath, localRoot, engineRoot: ENGINE_ROOT, quiet: true });

  const uniqueRecords = [...new Map(records.map((record) => [`${record.source}|${record.importer}|${record.resolved}`, record])).values()];
  // A *rewrite* is an edge that the alias plugin redirected **out of the upstream package into this
  // gate directory**. The gate's own files importing each other (`./Renderer/Context.js`,
  // `./device-handoff.mjs`, …) are not rewrites, so edges whose importer already lives in the gate
  // directory are excluded.
  const rewriteRecords = uniqueRecords.filter(
    (record) =>
      // Absolute-path records are Rollup's internal re-resolution of an id a plugin already
      // returned (including the entry file itself); the originating specifier record is kept.
      !path.isAbsolute(record.source) &&
      record.resolved !== null &&
      classify(record.resolved).layer === "gate-local" &&
      !(record.importer !== null && classify(record.importer).layer === "gate-local"),
  );
  const missingExports = warnings.filter((warning) => warning.code === "MISSING_EXPORT");
  const protobufMissingExports = missingExports.filter((warning) => warning.message.includes("protobufjs"));

  const checks = [
    check(
      "upstream-baseline-version",
      enginePackage.version === "26.3.0" && lock.version === "26.3.0" && enginePackage.version === lock.version,
      `installed @cesium/engine ${enginePackage.version}; lock ${lock.version} (cesium ${lock.cesiumVersion})`,
    ),
    check(
      "detector-literals-unique",
      detector.contextSnippetOccurrencesInUpstreamContext === 1 && detector.sceneSnippetOccurrencesInUpstreamScene === 1,
      `"${UPSTREAM_CONTEXT_SNIPPET}" x${detector.contextSnippetOccurrencesInUpstreamContext} in upstream Context.js; ` +
        `"${UPSTREAM_SCENE_SNIPPET}" x${detector.sceneSnippetOccurrencesInUpstreamScene} in upstream Scene.js`,
    ),
    check(
      expectReplacement ? "build-rewrite-scene-relative-import" : "build-no-rewrite-in-webgl2-run",
      expectReplacement
        ? directRewrite.relativeFromScene === path.join(GATE_DIR, "Renderer", "Context.js") && rewriteRecords.length > 0
        : directRewrite.relativeFromScene === null && rewriteRecords.length === 0,
      `Scene/Scene.js:40 "../Renderer/Context.js" → ${directRewrite.relativeFromScene === null ? "upstream (no rewrite)" : repoRelative(directRewrite.relativeFromScene)}; ` +
        `${rewriteRecords.length} gate-local rewrite record(s) during the real Rollup run`,
    ),
    check(
      expectReplacement ? "build-upstream-context-replaced" : "build-upstream-context-kept",
      expectReplacement
        ? !upstreamContextInGraph && localContextInGraph && upstreamSceneInGraph && !bundleCode.includes(UPSTREAM_CONTEXT_SNIPPET) && bundleCode.includes("G2-HANDOFF-CONTEXT-STUB-v1")
        : upstreamContextInGraph && upstreamSceneInGraph && bundleCode.includes(UPSTREAM_CONTEXT_SNIPPET) && rewriteRecords.length === 0,
      expectReplacement
        ? `graph: upstream Context.js=${upstreamContextInGraph}, gate-local Context.js=${localContextInGraph}, upstream Scene.js=${upstreamSceneInGraph}; ` +
          `bundle contains upstream Context snippet=${bundleCode.includes(UPSTREAM_CONTEXT_SNIPPET)}, contains gate stub marker=${bundleCode.includes("G2-HANDOFF-CONTEXT-STUB-v1")}`
        : `WebGL2 run (empty manifest): the upstream Renderer/Context.js IS in the graph=${upstreamContextInGraph}, the upstream Scene.js is too=${upstreamSceneInGraph}, ` +
          `${rewriteRecords.length} rewrite(s) happened; the entry still imports the gate stub explicitly (for the identity probe), so provenance is asserted at runtime by ` +
          `\`scene.context\` being the upstream class and NOT the stub (build-level module presence alone cannot distinguish them).`,
    ),
    check(
      "whitelist-exhaustive",
      whitelist.ok === true,
      `rewritten set == manifest set: missing=[${whitelist.missing.join(", ")}] extra=[${whitelist.extra.join(", ")}] (manifest ${whitelist.manifestModules.length}, rewritten ${whitelist.rewritten.length})`,
    ),
    check(
      "logic-layer-overrides-zero",
      logicLayerOverrides === 0,
      `logicLayerOverrides=${logicLayerOverrides}; repo-local modules in the graph=[${graph.repoModules.join(", ")}] (MUST be empty: the patch boundary is package-level only)`,
    ),
    check(
      "no-unresolved-imports",
      warnings.every((warning) => warning.code !== "UNRESOLVED_IMPORT"),
      `${warnings.length} rollup warning(s), codes=${JSON.stringify([...new Set(warnings.map((warning) => warning.code))])}`,
    ),
    // F-1 condition 5: the protobufjs named-export loss MUST be gone with the real CJS plugin.
    check(
      "protobufjs-named-export-resolved",
      missingExports.length === 0 && protobufMissingExports.length === 0,
      `MISSING_EXPORT warnings in this build: ${missingExports.length} (protobufjs-related: ${protobufMissingExports.length}). ` +
        `G-1's gate-local wrapper exposed only a default export, so Rollup's namespace-member access ` +
        `(\`protobuf.Reader.create(data)\`) degraded to a named import that did not exist → 1 MISSING_EXPORT at ` +
        `Scene/GoogleEarthEnterpriseImageryProvider.js:482 and \`Reader\` bound to undefined. ` +
        `@rollup/plugin-commonjs ${commonjsPackage.version} synthesises the named exports instead. ` +
        `Detail: ${missingExports.map((warning) => warning.message).join(" | ") || "none"}`,
    ),
    check(
      "cjs-interop-plugin-is-the-real-one",
      commonjsPackage.version === JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).devDependencies["@rollup/plugin-commonjs"] &&
        cjsTransformed.length > 0,
      `@rollup/plugin-commonjs ${commonjsPackage.version} (pinned devDependency, F-1) converted ${cjsTransformed.length} CommonJS module(s): ${cjsTransformed.sort().join(", ")}`,
    ),
    check(
      "kept-modules-stay-upstream",
      directRewrite.keptModuleUnaffected === null && directRewrite.upstreamSceneUnaffected === null && upstreamRendererInGraph.includes("Renderer/ContextLimits.js"),
      `not-in-manifest modules are never rewritten (ContextLimits → ${directRewrite.keptModuleUnaffected === null ? "upstream" : "REWRITTEN"}, Scene → ${directRewrite.upstreamSceneUnaffected === null ? "upstream" : "REWRITTEN"}); ` +
        `${upstreamRendererInGraph.length} upstream Renderer module(s) bundled, Context.js ${upstreamRendererInGraph.includes("Renderer/Context.js") ? "INCLUDED" : "excluded"}`,
    ),
  ];

  const privateMemberHits = implementationPathPrivateMemberScan();
  checks.push(
    check(
      "private-members-confined-to-gate-assertions",
      privateMemberHits.length === 0,
      `"_context" occurrences under packages/cesium-webgpu/{src,backend-webgpu} (implementation path, .d.ts excluded): ${privateMemberHits.length}` +
        (privateMemberHits.length > 0 ? ` → ${privateMemberHits.map((hit) => `${hit.file}:${hit.line}`).join(", ")}` : ""),
    ),
  );

  const report = {
    tool: "g2-handoff/build",
    label,
    recordedAt: new Date().toISOString(),
    node: process.version,
    engine: { version: enginePackage.version, cesiumVersion: lock.cesiumVersion },
    manifest: { path: repoRelative(manifestPath), entries: manifest.entries.map((entry) => ({ upstreamModule: entry.upstreamModule, localFile: entry.localFile, kind: entry.kind })) },
    localRoot: repoRelative(localRoot),
    cjsPlugin: { name: "@rollup/plugin-commonjs", version: commonjsPackage.version, license: commonjsPackage.license, converted: cjsTransformed.sort() },
    plugin: { path: "tools/rollup-plugin-engine-patch.mjs", name: patchPlugin.name },
    entry: repoRelative(ENTRY),
    directRewrite: Object.fromEntries(Object.entries(directRewrite).map(([key, value]) => [key, typeof value === "string" ? repoRelative(value) : value])),
    detector,
    graph,
    logicLayerOverrides,
    rewriteRecords,
    whitelist,
    bundle: {
      file: repoRelative(bundleFile),
      bytes: fs.statSync(bundleFile).size,
      containsUpstreamContextSnippet: bundleCode.includes(UPSTREAM_CONTEXT_SNIPPET),
      containsUpstreamSceneSnippet: bundleCode.includes(UPSTREAM_SCENE_SNIPPET),
      containsGateStubMarker: bundleCode.includes("G2-HANDOFF-CONTEXT-STUB-v1"),
    },
    warnings,
    checks,
  };

  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log(`bundle ${report.bundle.bytes} bytes, ${graph.moduleCount} module(s), ${rewriteRecords.length} rewrite(s), ${missingExports.length} MISSING_EXPORT → ${repoRelative(artifactPath)}`);
  return report;
}

/** Build both bundles (gate + WebGL2 run) and return their reports. */
export async function buildBoth({ quiet = false } = {}) {
  const gate = await buildBundle({
    label: "gate",
    manifestPath: GATE_MANIFEST_PATH,
    localRoot: GATE_DIR,
    bundleDir: path.join(OUT_DIR, "g2-handoff"),
    artifactPath: path.join(OUT_DIR, "g2-build.json"),
    quiet,
    expectReplacement: true,
  });
  const webgl2Inputs = prepareWebgl2Inputs();
  const webgl2 = await buildBundle({
    label: "webgl2",
    manifestPath: webgl2Inputs.manifestPath,
    localRoot: webgl2Inputs.localRoot,
    bundleDir: path.join(OUT_DIR, "g2-webgl2"),
    artifactPath: path.join(OUT_DIR, "g2-webgl2-build.json"),
    quiet,
    expectReplacement: false,
  });
  return { gate, webgl2 };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  buildBoth({ quiet: process.argv.includes("--quiet") })
    .then((reports) => {
      let failed = 0;
      for (const report of Object.values(reports)) {
        for (const entry of report.checks) {
          if (entry.ok !== true) failed += 1;
          process.stdout.write(`  [${entry.ok ? "ok" : "FAIL"}] ${report.label}/${entry.id}: ${entry.detail}\n`);
        }
      }
      process.exitCode = failed === 0 ? 0 : 1;
    })
    .catch((error) => {
      console.error(`g2-handoff/build: unexpected failure: ${error.stack ?? error}`);
      process.exitCode = 2;
    });
}
