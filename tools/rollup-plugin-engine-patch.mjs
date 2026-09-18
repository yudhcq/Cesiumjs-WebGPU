#!/usr/bin/env node
/**
 * Rollup alias plugin: module-level replacement patch layer (contract fork-patch-layer §3).
 *
 * At build time, every import that *resolves* to
 *   <node_modules>/@cesium/engine/Source/Renderer/<X>.js
 * is rewritten to the local implementation
 *   packages/cesium-webgpu/backend-webgpu/Renderer/<X>.<ts|js|…>
 * — but only when `<X>.js` is listed in `backend-webgpu/manifest.json`.
 *
 * Because the decision is taken on the **resolved absolute path**, the rewrite applies
 * uniformly to bare deep imports, the engine's own relative imports and its `index.js`
 * re-exports. `@cesium/engine` has no `exports` map (measured on 26.3.0), so deep paths
 * resolve trivially.
 *
 * The upstream package on disk is never modified.
 *
 * Exports:
 *   default                        createEnginePatchPlugin(options)
 *   createEnginePatchPlugin        named factory
 *   loadManifest(options)          read + normalise the replacement manifest
 *   whitelistExhaustiveCheck(files, options)
 *                                  assert "rewritten set == manifest set"
 *
 * `whitelistExhaustiveCheck(sourceFiles, options)` results:
 *   manifestModules  module paths declared in the manifest (e.g. "Renderer/Context.js")
 *   rewritten        supplied engine source files whose resolved path WOULD be rewritten
 *   missing          manifest modules absent from the supplied file list (a rewrite that can
 *                    never happen — usually a typo, i.e. a silently ineffective patch)
 *   extra            local replacement modules under `backend-webgpu/Renderer/**` that have
 *                    NO manifest entry (an unregistered patch — boundary violation)
 *   ok               `missing.length === 0 && extra.length === 0`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

export const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, "packages", "cesium-webgpu", "backend-webgpu", "manifest.json");
export const DEFAULT_ENGINE_ROOT = path.join(REPO_ROOT, "node_modules", "@cesium", "engine");

const REPLACEMENT_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"];
const UPSTREAM_MODULE_PATTERN = /^Renderer\/[A-Za-z0-9_]+\.js$/;

/** Resolve plugin options with repository defaults. */
function resolveOptions(options = {}) {
  const manifestPath = options.manifestPath ? path.resolve(options.manifestPath) : DEFAULT_MANIFEST_PATH;
  const engineRoot = options.engineRoot
    ? path.resolve(options.engineRoot)
    : fs.existsSync(DEFAULT_ENGINE_ROOT)
      ? DEFAULT_ENGINE_ROOT
      : // npm may nest the dependency when the hoisted copy is absent.
        path.join(REPO_ROOT, "packages", "cesium-webgpu", "node_modules", "@cesium", "engine");
  const localRoot = options.localRoot ? path.resolve(options.localRoot) : path.dirname(manifestPath);
  return {
    manifestPath,
    localRoot,
    engineRoot,
    engineSourceRoot: path.join(engineRoot, "Source"),
    ...(options.manifest ? { manifest: options.manifest } : {}),
    quiet: options.quiet === true,
  };
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

/**
 * Read and normalise the replacement manifest. A missing manifest file yields an empty
 * entry list and a one-time warning, so the build chain works before Phase 3 lands the
 * manifest; the boundary audit (`tools/scripts/check-arch-boundaries.mjs` rule A3/A4 and
 * `tools/audit-patch-scope.mjs`) treats a missing manifest as a hard failure.
 */
export function loadManifest(options = {}) {
  const resolved = resolveOptions(options);
  if (resolved.manifest) {
    return normaliseManifest(resolved.manifest);
  }
  if (!fs.existsSync(resolved.manifestPath)) {
    if (!resolved.quiet) {
      console.warn(
        `[engine-patch] replacement manifest not found at ${path.relative(REPO_ROOT, resolved.manifestPath) || resolved.manifestPath}; ` +
          "running with an empty replacement list (no module is rewritten)",
      );
    }
    return { baseline: null, entries: [], byModule: new Map() };
  }
  return normaliseManifest(JSON.parse(fs.readFileSync(resolved.manifestPath, "utf8")));
}

function normaliseManifest(raw) {
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  const byModule = new Map();
  for (const entry of entries) {
    if (typeof entry?.upstreamModule !== "string") continue;
    if (!UPSTREAM_MODULE_PATTERN.test(entry.upstreamModule)) {
      throw new Error(
        `engine-patch: manifest entry "${entry.upstreamModule}" violates the patch boundary ` +
          "(MUST match ^Renderer/[A-Za-z0-9_]+\\.js$, principle I)",
      );
    }
    byModule.set(entry.upstreamModule, entry);
  }
  return { baseline: raw?.baseline ?? null, entries, byModule };
}

/**
 * Is this resolved absolute path a manifest-listed upstream renderer module?
 * Pure path logic — no filesystem access, so it is usable from the whitelist check.
 */
function matchManifestEntry(absolutePath, options, manifest) {
  const relative = toPosix(path.relative(options.engineSourceRoot, absolutePath));
  if (relative.startsWith("..")) return null;
  return manifest.byModule.get(relative) ?? null;
}

function localFileCandidates(entry, options) {
  const candidates = [];
  if (typeof entry.localFile === "string" && entry.localFile.length > 0) {
    candidates.push(path.resolve(options.localRoot, entry.localFile));
  }
  const baseNames = new Set();
  for (const source of [entry.localFile, entry.upstreamModule]) {
    if (typeof source !== "string") continue;
    const absolute = path.resolve(options.localRoot, source);
    const withoutExtension = absolute.slice(0, absolute.length - path.extname(absolute).length);
    baseNames.add(withoutExtension);
  }
  for (const base of baseNames) {
    for (const extension of REPLACEMENT_EXTENSIONS) candidates.push(`${base}${extension}`);
  }
  return [...new Set(candidates)];
}

function resolveLocalFile(entry, options) {
  for (const candidate of localFileCandidates(entry, options)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `engine-patch: manifest entry "${entry.upstreamModule}" has no local replacement file under ` +
      `${toPosix(path.relative(REPO_ROOT, options.localRoot)) || options.localRoot} ` +
      `(looked for ${localFileCandidates(entry, options).map((file) => toPosix(path.relative(options.localRoot, file))).join(", ")})`,
  );
}

/** Resolve an import specifier to an absolute path (without touching the filesystem). */
function resolveSpecifier(source, importer, options) {
  if (typeof source !== "string") return null;
  if (source === "@cesium/engine") return path.join(options.engineRoot, "index.js");
  if (source.startsWith("@cesium/engine/")) return path.join(options.engineRoot, source.slice("@cesium/engine/".length));
  if (path.isAbsolute(source)) return path.resolve(source);
  if (source.startsWith("./") || source.startsWith("../")) {
    if (!importer) return null;
    return path.resolve(path.dirname(importer), source);
  }
  return null;
}

/**
 * Create the alias plugin.
 *
 * @param {object} [options]
 * @param {string} [options.manifestPath] replacement manifest (default: backend-webgpu/manifest.json)
 * @param {string} [options.localRoot]    root the `localFile` paths are relative to
 * @param {string} [options.engineRoot]   installed `@cesium/engine` root
 * @param {object} [options.manifest]     pre-loaded manifest (bypasses the filesystem)
 */
export function createEnginePatchPlugin(options = {}) {
  const resolved = resolveOptions(options);
  let manifest = loadManifest(options);

  return {
    name: "cesium-webgpu-engine-patch",

    /** Exposed for tests and for the boundary audit. */
    api: {
      options: resolved,
      get manifest() {
        return manifest;
      },
      reload() {
        manifest = loadManifest(options);
        return manifest;
      },
      shouldRewrite(absolutePath) {
        return matchManifestEntry(path.resolve(absolutePath), resolved, manifest);
      },
      localFileFor(entry) {
        return resolveLocalFile(entry, resolved);
      },
    },

    resolveId(source, importer) {
      const absolutePath = resolveSpecifier(source, importer, resolved);
      if (!absolutePath) return null;
      const entry = matchManifestEntry(path.resolve(absolutePath), resolved, manifest);
      if (!entry) return null;
      return resolveLocalFile(entry, resolved);
    },
  };
}

/**
 * Whitelist exhaustiveness check (contract §3): "rewritten set == manifest set".
 *
 * @param {string[]} sourceFiles engine source module paths — repository relative
 *   ("Renderer/Context.js", "Scene/Scene.js") or absolute paths inside `<engine>/Source`.
 * @param {object} [options] see `createEnginePatchPlugin`
 */
export function whitelistExhaustiveCheck(sourceFiles, options = {}) {
  const resolved = resolveOptions(options);
  const manifest = loadManifest(options);

  const normalised = (sourceFiles ?? [])
    .filter((file) => typeof file === "string")
    .map((file) => (path.isAbsolute(file) ? toPosix(path.relative(resolved.engineSourceRoot, file)) : toPosix(file)))
    .filter((file) => !file.startsWith(".."));

  const rewritten = [...new Set(normalised.filter((file) => manifest.byModule.has(file)))].sort();
  const manifestModules = [...manifest.byModule.keys()].sort();
  const missing = manifestModules.filter((module_) => !rewritten.includes(module_));

  const rendererRoot = path.join(resolved.localRoot, "Renderer");
  const localModules = fs.existsSync(rendererRoot)
    ? fs
        .readdirSync(rendererRoot)
        .filter((name) => REPLACEMENT_EXTENSIONS.some((extension) => name.endsWith(extension)))
        .map((name) => `Renderer/${name.slice(0, name.length - path.extname(name).length)}.js`)
        .sort()
    : [];
  const extra = localModules.filter((module_) => !manifest.byModule.has(module_));

  return {
    ok: missing.length === 0 && extra.length === 0,
    manifestModules,
    rewritten,
    missing,
    extra,
  };
}

export default createEnginePatchPlugin;
