/**
 * Real build chain for the contract suites (`层=契约`) — tasks.md T043/T044/T047/T050/T051.
 *
 * The unit layer loads the patch layer with stubbed upstream modules; the contract layer MUST NOT: it
 * has to run **the same graph that ships**, in a real browser, with the real `@cesium/engine` and the
 * real alias plugin. This module therefore builds two bundles with the production plugin
 * (`tools/rollup-plugin-engine-patch.mjs`):
 *
 *   - `webgpu` — the real `manifest.json` (every replaced module comes from the patch layer);
 *   - `webgl2` — an **empty** manifest plus an empty local root, so the *upstream* `Renderer/Context.js`
 *     serves the page (the same technique G-2 used; it is what makes the two runs genuinely different
 *     builds rather than one build with a runtime switch).
 *
 * One run builds one bundle; nothing here can enable two backends (principle II).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { rollup } from "rollup";

import { createEnginePatchPlugin } from "../../tools/rollup-plugin-engine-patch.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MANIFEST_PATH = path.join(REPO_ROOT, "packages", "cesium-webgpu", "backend-webgpu", "manifest.json");
export const BACKEND_ROOT = path.join(REPO_ROOT, "packages", "cesium-webgpu", "backend-webgpu");
export const ENGINE_ROOT = path.join(REPO_ROOT, "node_modules", "@cesium", "engine");
export const ENTRY = path.join(REPO_ROOT, "tests", "contract", "page", "entry.js");
export const OUT_ROOT = path.join(REPO_ROOT, "artifacts", "contract");
export const TSCONFIG = path.join(REPO_ROOT, "packages", "cesium-webgpu", "tsconfig.json");

const UPSTREAM_CONTEXT_SNIPPET = "this._originalGLContext = glContext;";

function repoRelative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

/** Write the empty manifest + empty local root the WebGL2 run consumes. */
function prepareWebgl2Inputs() {
  const localRoot = path.join(OUT_ROOT, "webgl2-root");
  fs.rmSync(localRoot, { recursive: true, force: true });
  fs.mkdirSync(localRoot, { recursive: true });
  const manifestPath = path.join(OUT_ROOT, "webgl2-manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        note:
          "WebGL2 contract run: EMPTY manifest plus an empty local root, so the alias plugin rewrites nothing and the upstream " +
          "Renderer/Context.js serves the page. One run enables exactly one backend (principle II).",
        baseline: { packageName: "@cesium/engine", version: "26.3.0", cesiumVersion: "1.145.0" },
        entries: [],
        keptModulesHash: null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { manifestPath, localRoot };
}

async function buildOne({ backend }) {
  const webgl2 = backend === "webgl2";
  const inputs = webgl2 ? prepareWebgl2Inputs() : { manifestPath: MANIFEST_PATH, localRoot: BACKEND_ROOT };
  const bundleDir = path.join(OUT_ROOT, backend);
  const warnings = [];
  fs.mkdirSync(bundleDir, { recursive: true });

  const bundle = await rollup({
    input: ENTRY,
    plugins: [
      createEnginePatchPlugin({ manifestPath: inputs.manifestPath, localRoot: inputs.localRoot, engineRoot: ENGINE_ROOT, quiet: true }),
      nodeResolve({ browser: true, exportConditions: ["import"], preferBuiltins: false }),
      commonjs({ include: [/node_modules/], transformMixedEsModules: true }),
      typescript({ tsconfig: TSCONFIG, outDir: bundleDir, declaration: false, declarationMap: false, noEmitOnError: true }),
    ],
    onwarn(warning) {
      warnings.push({ code: warning.code ?? "UNKNOWN", message: warning.message });
    },
  });
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  await bundle.write({ dir: bundleDir, format: "es", entryFileNames: "bundle.js", chunkFileNames: "chunk-[name]-[hash].js", sourcemap: false });
  const watchFiles = bundle.watchFiles.map((file) => path.resolve(file));
  await bundle.close();

  const bundleFile = path.join(bundleDir, "bundle.js");
  const code = fs.readFileSync(bundleFile, "utf8");
  const engineRendererRoot = path.join(ENGINE_ROOT, "Source", "Renderer") + path.sep;
  const upstreamRendererModules = watchFiles.filter((file) => file.startsWith(engineRendererRoot)).map((file) => path.basename(file)).sort();
  const report = {
    tool: "tests/support/backend-build.mjs",
    backend,
    recordedAt: new Date().toISOString(),
    manifest: repoRelative(inputs.manifestPath),
    localRoot: repoRelative(inputs.localRoot),
    bundle: repoRelative(bundleFile),
    bytes: code.length,
    moduleCount: watchFiles.length,
    upstreamRendererModules,
    /**
     * `true` when the *upstream* `Renderer/Context.js` is in the graph. Resolved by path, not by text:
     * the patch layer legitimately carries a vendored COPY of that file for the D2-a delegation, so the
     * upstream file's text appears in the WebGPU bundle as well.
     */
    upstreamContextInGraph: watchFiles.some((file) => file === path.join(engineRendererRoot, "Context.js")),
    /** `true` when the patch layer's own replacement is in the graph. */
    replacementContextInGraph: watchFiles.some((file) => file.endsWith(path.join("backend-webgpu", "Renderer", "Context.ts"))),
    containsUpstreamContextSnippet: code.includes(UPSTREAM_CONTEXT_SNIPPET),
    warnings: [...new Set(warnings.map((warning) => warning.code))],
  };
  fs.writeFileSync(path.join(bundleDir, "build.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

/**
 * Newest modification time under `dir` (recursively), or 0 when it does not exist.
 *
 * Used to decide whether a cached bundle is still valid: comparing only against the manifest would
 * silently keep a bundle built from an older source tree.
 */
function newestMtime(dir, extensions = [".ts", ".js"]) {
  if (!fs.existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(child, extensions));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) newest = Math.max(newest, fs.statSync(child).mtimeMs);
  }
  return newest;
}

/**
 * Build the bundle for `backend` unless a fresh one exists.
 *
 * @param {{backend: "webgpu"|"webgl2", force?: boolean}} options
 */
export async function ensureBundle({ backend, force = false }) {
  const bundleFile = path.join(OUT_ROOT, backend, "bundle.js");
  const reportFile = path.join(OUT_ROOT, backend, "build.json");
  if (!force && fs.existsSync(bundleFile) && fs.existsSync(reportFile)) {
    const inputs = [
      backend === "webgl2" ? path.join(OUT_ROOT, "webgl2-manifest.json") : MANIFEST_PATH,
      ENTRY,
      path.join(REPO_ROOT, "tests", "contract", "page"),
      BACKEND_ROOT,
    ];
    const newestInput = Math.max(...inputs.map((input) => (fs.statSync(input).isDirectory() ? newestMtime(input) : fs.statSync(input).mtimeMs)));
    if (fs.statSync(bundleFile).mtimeMs > newestInput) return JSON.parse(fs.readFileSync(reportFile, "utf8"));
  }
  return buildOne({ backend });
}

/** Repository-relative path of the built bundle (what the page loads). */
export function bundleRelativePath(backend) {
  return repoRelative(path.join(OUT_ROOT, backend, "bundle.js"));
}
