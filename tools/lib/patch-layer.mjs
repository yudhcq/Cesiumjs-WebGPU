#!/usr/bin/env node
/**
 * Shared helpers for the controlled-fork patch layer (contract fork-patch-layer.md).
 *
 * Node-only, cross-platform, zero dependencies: every self-check in this repository runs
 * through `node …` (global convention 1 in tasks.md, enforced by
 * `tools/scripts/check-tools-portable.mjs`). Nothing here writes to `node_modules`.
 *
 * The upstream `@cesium/engine` package is consumed **as installed**: this module only reads
 * it (hashing, listing, counting). Module-level replacement happens at build time through
 * `tools/rollup-plugin-engine-patch.mjs`.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Baseline record for the pinned upstream release (version + integrity + source snapshot). */
export const BASELINE_PATH = "upstream/engine-26.3.0.lock.json";
export const MANIFEST_PATH = "packages/cesium-webgpu/backend-webgpu/manifest.json";
export const INTERFACE_MANIFEST_PATH = "upstream/interface-manifest.json";
export const PATCH_LAYER_PATH = "packages/cesium-webgpu/backend-webgpu";
export const BUILD_PROVENANCE_DIR = "artifacts";

/** The four `kind` values of contract fork-patch-layer.md §2 rule 3. */
export const KINDS = ["replace", "adapt", "adapt-shader", "stub-not-implemented"];

/**
 * Slice-C boundary (tasks.md T053): declared but delivered as explicit-failure stubs only.
 * `glCallSites > 0` is asserted for `replace` entries ONLY (contract §2 rule 3).
 */
export const STUB_MODULES = [
  "Renderer/Texture3D.js",
  "Renderer/CubeMap.js",
  "Renderer/CubeMapFace.js",
  "Renderer/TextureAtlas.js",
  "Renderer/Sync.js",
];

/** The 11 modules whose WebGL call sites are reimplemented on the new backend. */
export const REPLACE_MODULES = [
  "Renderer/Context.js",
  "Renderer/Texture.js",
  "Renderer/ShaderProgram.js",
  "Renderer/RenderState.js",
  "Renderer/Buffer.js",
  "Renderer/createUniform.js",
  "Renderer/createUniformArray.js",
  "Renderer/VertexArray.js",
  "Renderer/Framebuffer.js",
  "Renderer/Renderbuffer.js",
  "Renderer/MultisampleFramebuffer.js",
];

/** The adaptation entries (semantics bound to GL resources or to the compile target). */
export const ADAPT_MODULES = [
  "Renderer/ShaderSource.js",
  "Renderer/ShaderCache.js",
  "Renderer/FramebufferManager.js",
  "Renderer/ComputeEngine.js",
  "Renderer/SharedContext.js",
  "Renderer/TextureCache.js",
  "Renderer/loadCubeMap.js",
];

export const UPSTREAM_MODULE_PATTERN = /^Renderer\/[A-Za-z0-9_]+\.js$/;

/** Replacements are TypeScript/JavaScript modules with the upstream module's basename. */
export const REPLACEMENT_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"];

export function repoPath(relativePath) {
  return path.join(REPO_ROOT, ...String(relativePath).split("/"));
}

/** Installed upstream package root; `--engine-root` overrides it (used by fixture-based tests). */
export function resolveEngineRoot(engineRoot) {
  return engineRoot ? path.resolve(engineRoot) : path.join(REPO_ROOT, "node_modules", "@cesium", "engine");
}

export function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function hashFile(absolutePath) {
  return `sha256-${sha256Hex(fs.readFileSync(absolutePath))}`;
}

export function hashText(text) {
  return `sha256-${sha256Hex(Buffer.from(text, "utf8"))}`;
}

/** Recursively list files below `dir` (sorted, POSIX separators relative to `base`). */
export function walkFiles(dir, { extensions = null, base = dir } = {}) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(child, { extensions, base }));
    else if (entry.isFile() && (extensions === null || extensions.some((extension) => child.endsWith(extension)))) {
      out.push(toPosix(path.relative(base, child)));
    }
  }
  return out.sort();
}

/**
 * List every module of the installed upstream engine, repository-relative to `Source/`
 * (e.g. `Renderer/Context.js`, `Scene/Scene.js`) — the same addressing the alias plugin uses.
 */
export function listEngineModules(engineRoot) {
  const sourceRoot = path.join(resolveEngineRoot(engineRoot), "Source");
  if (!fs.existsSync(sourceRoot)) return [];
  return walkFiles(sourceRoot, { extensions: [".js"], base: sourceRoot });
}

/** Every module under `Source/Renderer/**` (the patch boundary). */
export function listRendererModules(engineRoot) {
  return listEngineModules(engineRoot).filter((module_) => UPSTREAM_MODULE_PATTERN.test(module_));
}

/**
 * **WebGL call sites** of one upstream module — the metric of research §1.1.
 *
 * Definition (reproducible, no comment stripping): the number of occurrences of a call
 * expression whose receiver is the GL context (`gl`, `_gl`, `this._gl`, `context._gl`,
 * `context.gl`). Measured on the installed 26.3.0 sources this reproduces the recorded
 * per-file vector of research §1.1 exactly, for the 16 modules that touch WebGL
 * (`Context.js` 46, `Texture.js` 58, … `Sync.js` 3; total 348).
 */
export function countGlCallSites(source) {
  const matches = source.match(/(?:\bgl\b|_gl|context\.gl)\.[A-Za-z_]\w*\s*\(/g);
  return matches === null ? 0 : matches.length;
}

export function readGlCallSites(engineRoot, modulePath) {
  const absolute = path.join(resolveEngineRoot(engineRoot), "Source", ...modulePath.split("/"));
  if (!fs.existsSync(absolute)) return null;
  return countGlCallSites(fs.readFileSync(absolute, "utf8"));
}

/**
 * Content snapshot of `Source/**`: per-file hashes are folded into one aggregate hash so a
 * single flipped byte anywhere is detected (T030's "postinstall tampering" assertion).
 *
 * @param {string} [engineRoot]
 * @param {object} [options]
 * @param {Map<string, Buffer>} [options.overrides] replace the bytes of a module when hashing
 *   (used by the tamper-detection counterexample so a real tree can be perturbed in memory,
 *   without ever writing to `node_modules`)
 */
export function snapshotEngineSource(engineRoot, { overrides = new Map() } = {}) {
  const engine = resolveEngineRoot(engineRoot);
  const sourceRoot = path.join(engine, "Source");
  const files = walkFiles(sourceRoot, { base: engine });
  const lines = [];
  let totalBytes = 0;
  for (const relative of files) {
    const absolute = path.join(engine, ...relative.split("/"));
    const override = overrides.get(relative);
    if (override !== undefined) {
      totalBytes += override.length;
      lines.push(`${relative}\u0000sha256-${sha256Hex(override)}`);
      continue;
    }
    totalBytes += fs.statSync(absolute).size;
    lines.push(`${relative}\u0000${hashFile(absolute)}`);
  }
  return {
    algorithm: "sha256",
    aggregate: hashText(lines.join("\n")),
    fileCount: files.length,
    totalBytes,
  };
}

export function readJsonFile(absolutePath) {
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

export function readBaseline(root = REPO_ROOT) {
  return readJsonFile(path.join(root, ...BASELINE_PATH.split("/")));
}

/** Load the replacement manifest without normalising it (audits need the raw entries). */
export function readPatchManifest(root = REPO_ROOT, manifestPath = MANIFEST_PATH) {
  const absolute = path.isAbsolute(manifestPath) ? manifestPath : path.join(root, ...manifestPath.split("/"));
  if (!fs.existsSync(absolute)) return null;
  return readJsonFile(absolute);
}

/** Absolute path of a manifest entry's local replacement file (first existing candidate). */
export function localFileCandidates(entry, localRoot) {
  const candidates = [];
  if (typeof entry?.localFile === "string" && entry.localFile.length > 0) {
    candidates.push(path.resolve(localRoot, entry.localFile));
  }
  for (const source of [entry?.localFile, entry?.upstreamModule]) {
    if (typeof source !== "string") continue;
    const absolute = path.resolve(localRoot, source);
    const withoutExtension = absolute.slice(0, absolute.length - path.extname(absolute).length);
    for (const extension of REPLACEMENT_EXTENSIONS) candidates.push(`${withoutExtension}${extension}`);
  }
  return [...new Set(candidates)];
}

export function resolveLocalFile(entry, localRoot) {
  return localFileCandidates(entry, localRoot).find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * Manifest-level rules (contract §2): path boundary, non-empty `requirementRef`/`reason`,
 * four-valued `kind`, `glCallSites > 0` for `replace` only, stub reason + stub-set equality.
 *
 * Every violation carries a `rule` tag (`boundary`, `kind`, `requirementRef`, `reason`,
 * `glCallSites`, `stubSet`, `localFile`, `duplicate`) so callers can assert on the *kind* of
 * failure without pattern-matching the message.
 */
export function validatePatchManifest(manifest, { engineRoot, localRoot, enforceStubSet = true } = {}) {
  const violations = [];
  const push = (entry, rule, detail) => violations.push({ entry: entry?.upstreamModule ?? "-", rule, detail });
  if (manifest === null) {
    return { ok: false, violations: [{ entry: "-", rule: "manifest", detail: "replacement manifest is missing" }] };
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    return { ok: false, violations: [{ entry: "-", rule: "manifest", detail: "manifest.entries MUST be a non-empty array" }] };
  }

  const seen = new Set();
  for (const entry of manifest.entries) {
    const module_ = entry?.upstreamModule;
    if (typeof module_ !== "string" || !UPSTREAM_MODULE_PATTERN.test(module_)) {
      push(entry, "boundary", `upstreamModule ${JSON.stringify(module_)} MUST match ${UPSTREAM_MODULE_PATTERN} (patch boundary, principle I)`);
      continue;
    }
    if (seen.has(module_)) push(entry, "duplicate", `duplicate manifest entry for ${module_}`);
    seen.add(module_);
    if (!KINDS.includes(entry.kind)) {
      push(entry, "kind", `kind ${JSON.stringify(entry.kind)} MUST be one of ${KINDS.join(" / ")}`);
    }
    if (!Array.isArray(entry.requirementRef) || entry.requirementRef.length === 0 || entry.requirementRef.some((ref) => typeof ref !== "string" || ref.length === 0)) {
      push(entry, "requirementRef", "requirementRef MUST be a non-empty array of non-empty strings (patch minimality, principle I)");
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      push(entry, "reason", "reason MUST be a non-empty string");
    }
    if (entry.kind === "replace") {
      const measured = readGlCallSites(engineRoot, module_);
      if (measured === null) push(entry, "glCallSites", `upstream module ${module_} is not installed (run npm ci)`);
      else if (!(typeof entry.glCallSites === "number" && entry.glCallSites > 0)) {
        push(entry, "glCallSites", "replace entries MUST carry glCallSites > 0");
      } else if (entry.glCallSites !== measured) {
        push(entry, "glCallSites", `glCallSites ${entry.glCallSites} does not match the measured count ${measured} for ${module_}`);
      }
    }
    if (entry.kind === "stub-not-implemented" && (typeof entry.reason !== "string" || entry.reason.trim().length === 0)) {
      push(entry, "reason", "stub-not-implemented entries MUST document why the slice stops there");
    }
    if (localRoot !== undefined) {
      const resolved = resolveLocalFile(entry, path.resolve(localRoot));
      if (resolved === null) push(entry, "localFile", `no local replacement file for ${module_} under ${toPosix(path.relative(REPO_ROOT, path.resolve(localRoot)))}`);
      else if (!toPosix(path.relative(path.resolve(localRoot), resolved)).startsWith("Renderer/")) {
        push(entry, "localFile", `local replacement for ${module_} MUST live under Renderer/ (patch boundary)`);
      }
    }
  }

  if (enforceStubSet) {
    const declaredStubs = manifest.entries.filter((entry) => entry?.kind === "stub-not-implemented").map((entry) => entry.upstreamModule).sort();
    const expected = [...STUB_MODULES].sort();
    if (declaredStubs.join(",") !== expected.join(",")) {
      violations.push({
        entry: "-",
        rule: "stubSet",
        detail: `stub-not-implemented set MUST equal the slice-C stub list (T053): expected ${expected.join(", ")}, got ${declaredStubs.join(", ") || "(none)"}`,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * `keptModulesHash` (contract §2 rule 4): content hashes of every `Renderer/**` module that is
 * NOT listed in the manifest — "upstream silently changed a file we still depend on".
 */
export function computeKeptModules(engineRoot, manifest) {
  const listed = new Set((manifest?.entries ?? []).map((entry) => entry?.upstreamModule).filter((module_) => typeof module_ === "string"));
  const modules = listRendererModules(engineRoot).filter((module_) => !listed.has(module_));
  const engine = resolveEngineRoot(engineRoot);
  const hashes = {};
  const lines = [];
  for (const module_ of modules) {
    const hash = hashFile(path.join(engine, "Source", ...module_.split("/")));
    hashes[module_] = hash;
    lines.push(`${module_}\u0000${hash}`);
  }
  return { modules, hashes, aggregate: hashText(lines.join("\n")), algorithm: "sha256" };
}

/**
 * Compare a manifest's recorded kept set with a freshly computed one.
 *
 * The aggregate is re-derived from `computed.hashes` (never taken on trust), so a caller that
 * perturbs a single hash — the drift counterexample — is compared on equal terms.
 */
export function compareKeptModules(recorded, computed) {
  const recordedModules = Object.keys(recorded?.keptModules ?? {});
  const modules = computed?.modules ?? [];
  const hashes = computed?.hashes ?? {};
  const aggregate = hashText(modules.map((module_) => `${module_}\u0000${hashes[module_] ?? ""}`).join("\n"));
  const drifted = modules.filter((module_) => recorded.keptModules?.[module_] !== undefined && recorded.keptModules[module_] !== hashes[module_]);
  return {
    unchanged: recorded?.keptModulesHash === aggregate && drifted.length === 0 && recordedModules.length === modules.length,
    recordedAggregate: recorded?.keptModulesHash ?? null,
    computedAggregate: aggregate,
    drifted,
    modulesAdded: modules.filter((module_) => !recordedModules.includes(module_)),
    modulesRemoved: recordedModules.filter((module_) => !modules.includes(module_)),
  };
}
