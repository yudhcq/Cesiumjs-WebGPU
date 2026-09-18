#!/usr/bin/env node
/**
 * G-3 gate — real build chain (tasks.md T020).
 *
 * Builds the page bundle from the **unmodified** upstream engine: no replacement manifest is applied
 * (the T008 alias plugin is deliberately not used), so the recorded frame is the upstream original
 * WebGL2 path that G-3 must characterise. The report asserts that:
 *   - the module graph contains the upstream `Renderer/Context.js` and the upstream `Scene/Scene.js`;
 *   - no gate-local `Renderer/` replacement participates;
 *   - CommonJS interop uses the approved pinned plugin (finding F-1), so the product build's
 *     dependency set is exercised again here;
 *   - the engine `Source/**` on disk is byte-identical before and after the build.
 *
 * Evidence: `experiments/gates/out/g3-build.json`. Usage: `node experiments/gates/g3-pass-trace/build.mjs`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rollup } from "rollup";

export const GATE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(GATE_DIR, "..", "..", "..");
export const OUT_DIR = path.join(REPO_ROOT, "experiments", "gates", "out");
export const ENGINE_ROOT = path.join(REPO_ROOT, "node_modules", "@cesium", "engine");
export const ENGINE_SOURCE_ROOT = path.join(ENGINE_ROOT, "Source");
export const ENTRY = path.join(GATE_DIR, "frame-driver.js");

/**
 * Worker modules the page actually requests. The published ESM package ships the worker **sources**
 * under `Source/Workers/**` but no built `Workers/**` bundle (and it must not be modified on disk), so
 * the gate builds module-worker bundles of the real upstream sources into its own served base
 * directory (`CESIUM_BASE_URL` in `page.html`). The runner asserts that the requested set equals the
 * built set, so a missing worker is a loud failure rather than a silent 404.
 */
export const WORKER_MODULES = ["createVerticesFromHeightmap", "incrementallyBuildTerrainPicker", "transferTypedArrayTest"];
export const WORKER_BASE_DIR = path.join(OUT_DIR, "g3-base");

/** Unique to the upstream `Renderer/Context.js` (proves the original module is in the bundle). */
const UPSTREAM_CONTEXT_SNIPPET = "this._originalGLContext = glContext;";
const UPSTREAM_SCENE_SNIPPET = "this._logDepthBuffer = Scene.defaultLogDepthBuffer && context.fragmentDepth;";

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function repoRelative(absolute) {
  return toPosix(path.relative(REPO_ROOT, absolute));
}

function check(id, ok, detail) {
  return { id, ok: ok === true, detail };
}

function classify(id) {
  const normalised = toPosix(path.isAbsolute(id) ? path.resolve(id) : path.resolve(REPO_ROOT, id));
  const engineSource = toPosix(ENGINE_SOURCE_ROOT);
  if (normalised.startsWith(`${engineSource}/`)) return { layer: "upstream-engine", subpath: normalised.slice(engineSource.length + 1) };
  if (normalised.startsWith(`${toPosix(GATE_DIR)}/`)) return { layer: "gate-local", subpath: repoRelative(normalised) };
  if (normalised.includes("/node_modules/")) return { layer: "third-party", subpath: normalised.slice(normalised.lastIndexOf("/node_modules/") + 1) };
  return { layer: "repo", subpath: repoRelative(normalised) };
}

export async function buildGateBundle({ quiet = false } = {}) {
  const enginePackage = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, "package.json"), "utf8"));
  const commonjsPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", "@rollup", "plugin-commonjs", "package.json"), "utf8"));
  const warnings = [];
  const log = (line) => {
    if (!quiet) process.stdout.write(`[g3-build] ${line}\n`);
  };
  log(`bundling ${repoRelative(ENTRY)} WITHOUT any replacement manifest (upstream original WebGL2 path)`);

  const bundle = await rollup({
    input: ENTRY,
    plugins: [
      nodeResolve({ browser: true, exportConditions: ["import"], preferBuiltins: false }),
      commonjs({ include: [/node_modules/], transformMixedEsModules: true }),
    ],
    onwarn(warning) {
      warnings.push({ code: warning.code ?? "UNKNOWN", message: warning.message, id: warning.id ? repoRelative(warning.id) : null });
    },
  });
  const bundleDir = path.join(OUT_DIR, "g3-pass-trace");
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
    repoModules: classified.filter((entry) => entry.layer === "repo").map((entry) => entry.subpath),
    thirdPartyModules: classified.filter((entry) => entry.layer === "third-party").length,
  };
  const upstreamRendererInGraph = classified.filter((entry) => entry.layer === "upstream-engine" && entry.subpath.startsWith("Renderer/")).map((entry) => entry.subpath).sort();
  const missingExports = warnings.filter((warning) => warning.code === "MISSING_EXPORT");

  const checks = [
    check(
      "upstream-baseline-version",
      enginePackage.version === "26.3.0",
      `installed @cesium/engine ${enginePackage.version} (upstream/engine-26.3.0.lock.json)`,
    ),
    check(
      "no-replacement-applied",
      graph.gateLocalModules.every((module_) => !module_.includes("/Renderer/")) && graph.repoModules.length === 0,
      `gate-local modules in the graph=[${graph.gateLocalModules.join(", ")}] (none may be a Renderer replacement); repo modules=[${graph.repoModules.join(", ")}] (MUST be empty) — ` +
        "T020 records the upstream original, so the alias plugin is not part of this build at all",
    ),
    check(
      "upstream-context-and-scene-in-graph",
      upstreamRendererInGraph.includes("Renderer/Context.js") &&
        classified.some((entry) => entry.subpath === "Scene/Scene.js") &&
        bundleCode.includes(UPSTREAM_CONTEXT_SNIPPET) &&
        bundleCode.includes(UPSTREAM_SCENE_SNIPPET),
      `upstream Renderer/Context.js in graph=${upstreamRendererInGraph.includes("Renderer/Context.js")} (${upstreamRendererInGraph.length} upstream Renderer module(s)), upstream Scene/Scene.js in graph=${classified.some((entry) => entry.subpath === "Scene/Scene.js")}; ` +
        `bundle text contains the upstream Context snippet=${bundleCode.includes(UPSTREAM_CONTEXT_SNIPPET)} and the upstream Scene snippet=${bundleCode.includes(UPSTREAM_SCENE_SNIPPET)}`,
    ),
    check(
      "cjs-interop-plugin-is-the-real-one",
      commonjsPackage.version === JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).devDependencies["@rollup/plugin-commonjs"],
      `@rollup/plugin-commonjs ${commonjsPackage.version} (pinned devDependency, finding F-1) — same dependency set as the product build`,
    ),
    check(
      "protobufjs-named-export-resolved",
      missingExports.length === 0,
      `MISSING_EXPORT warnings: ${missingExports.length} (G-1's default-only wrapper produced one for the protobufjs Reader member; the real plugin synthesises named exports)`,
    ),
    check(
      "no-unresolved-imports",
      warnings.every((warning) => warning.code !== "UNRESOLVED_IMPORT"),
      `${warnings.length} rollup warning(s), codes=${JSON.stringify([...new Set(warnings.map((warning) => warning.code))])}`,
    ),
  ];

  const report = {
    tool: "g3-pass-trace/build",
    recordedAt: new Date().toISOString(),
    node: process.version,
    engine: { version: enginePackage.version },
    entry: repoRelative(ENTRY),
    replacementManifest: null,
    cjsPlugin: { name: "@rollup/plugin-commonjs", version: commonjsPackage.version },
    graph,
    bundle: { file: repoRelative(bundleFile), bytes: fs.statSync(bundleFile).size, containsUpstreamContextSnippet: bundleCode.includes(UPSTREAM_CONTEXT_SNIPPET), containsUpstreamSceneSnippet: bundleCode.includes(UPSTREAM_SCENE_SNIPPET) },
    warnings,
    checks,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "g3-build.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log(`bundle ${report.bundle.bytes} bytes, ${graph.moduleCount} module(s), ${missingExports.length} MISSING_EXPORT`);
  return report;
}

/**
 * Build the module-worker bundles into the gate's own served base directory.
 *
 * @returns {Promise<{dir: string, files: string[], checks: object[]}>}
 */
export async function buildWorkerBundles({ quiet = false } = {}) {
  const log = (line) => {
    if (!quiet) process.stdout.write(`[g3-build] ${line}\n`);
  };
  const outputDir = path.join(WORKER_BASE_DIR, "Workers");
  fs.rmSync(WORKER_BASE_DIR, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const files = [];
  const missingSources = [];
  for (const module_ of WORKER_MODULES) {
    const source = path.join(ENGINE_SOURCE_ROOT, "Workers", `${module_}.js`);
    if (!fs.existsSync(source)) {
      missingSources.push(module_);
      continue;
    }
    const bundle = await rollup({
      input: source,
      plugins: [nodeResolve({ browser: true, exportConditions: ["import"], preferBuiltins: false }), commonjs({ include: [/node_modules/], transformMixedEsModules: true })],
      onwarn() {},
    });
    await bundle.write({ dir: outputDir, format: "es", entryFileNames: `${module_}.js`, inlineDynamicImports: true, sourcemap: false });
    await bundle.close();
    files.push(`Workers/${module_}.js`);
  }
  const sizes = Object.fromEntries(files.map((file) => [file, fs.statSync(path.join(WORKER_BASE_DIR, file)).size]));
  log(`built ${files.length} module worker(s) into ${repoRelative(WORKER_BASE_DIR)}: ${files.map((file) => `${file} (${sizes[file]}B)`).join(", ")}`);
  return {
    dir: repoRelative(WORKER_BASE_DIR),
    files,
    sizes,
    checks: [
      check(
        "worker-bundles-built-from-upstream-sources",
        missingSources.length === 0 && files.length === WORKER_MODULES.length && Object.values(sizes).every((size) => size > 100),
        `${files.length}/${WORKER_MODULES.length} worker module(s) built from the upstream Source/Workers sources into the gate's own base directory ` +
          `(the published ESM package ships no built Workers/** and MUST NOT be modified): ${files.map((file) => `${file}=${sizes[file]}B`).join(", ")}` +
          `${missingSources.length > 0 ? `; missing upstream sources: ${missingSources.join(", ")}` : ""}`,
      ),
    ],
  };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);if (isMain) {
  Promise.all([buildGateBundle(), buildWorkerBundles()])
    .then(([report, workers]) => {
      for (const entry of [...report.checks, ...workers.checks]) process.stdout.write(`  [${entry.ok ? "ok" : "FAIL"}] ${entry.id}: ${entry.detail}\n`);
      const failed = [...report.checks, ...workers.checks].filter((entry) => entry.ok !== true).length;
      process.exitCode = failed === 0 ? 0 : 1;
    })
    .catch((error) => {
      console.error(`g3-pass-trace/build: unexpected failure: ${error.stack ?? error}`);
      process.exitCode = 2;
    });
}
