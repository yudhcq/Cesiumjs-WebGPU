#!/usr/bin/env node
/**
 * Build-provenance recorder (T034 support).
 *
 * The delivered bundles are the only place where "the logic layer still comes from the
 * installed upstream package" can be observed: every module that Rollup puts into the graph is
 * classified by owner (upstream engine / patch layer / this repository / other dependency).
 *
 * The recorder writes one small JSON artifact per bundle; `tools/scripts/check-build-layer-source.mjs`
 * consumes them and asserts that no repository-owned module shadows an upstream module outside
 * `Renderer/**` (`logicLayerOverrides === 0`, SC-010). Nothing is written into the split packages.
 */
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT, toPosix } from "./lib/patch-layer.mjs";

export const PROVENANCE_DIR = path.join(REPO_ROOT, "artifacts");

/**
 * @param {object} [options]
 * @param {string} [options.label] artifact label (bundle name), e.g. `cesium-webgpu-package`
 * @param {string} [options.repoRoot]
 * @param {string} [options.engineRoot]
 * @param {string} [options.outDir] where `build-provenance.<label>.json` is written
 */
export function createBuildProvenancePlugin(options = {}) {
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : REPO_ROOT;
  const engineRoot = options.engineRoot ? path.resolve(options.engineRoot) : path.join(repoRoot, "node_modules", "@cesium", "engine");
  const localRoot = path.join(repoRoot, "packages", "cesium-webgpu", "backend-webgpu");
  const outDir = options.outDir ? path.resolve(options.outDir) : path.join(repoRoot, "artifacts");
  const label = options.label ?? "bundle";
  const engineSourceRoot = path.join(engineRoot, "Source");

  const classify = (id) => {
    if (typeof id !== "string" || id.length === 0) return "other";
    if (id.startsWith("\u0000")) return "virtual";
    const absolute = path.resolve(id);
    if (absolute === engineSourceRoot || absolute.startsWith(`${engineSourceRoot}${path.sep}`)) return "engine-source";
    if (absolute === localRoot || absolute.startsWith(`${localRoot}${path.sep}`)) return "patch-layer";
    if (absolute.startsWith(path.join(repoRoot, "node_modules") + path.sep)) return "dependency";
    if (absolute === repoRoot || absolute.startsWith(`${repoRoot}${path.sep}`)) return "repo";
    return "other";
  };

  const report = (ids, outputFiles) => {
    const moduleIds = [...new Set(ids)].filter((id) => typeof id === "string");
    const classes = { "engine-source": [], "patch-layer": [], repo: [], dependency: [], virtual: [], other: [] };
    for (const id of moduleIds) classes[classify(id)].push(id);

    const rel = (id) => (path.isAbsolute(id) ? toPosix(path.relative(repoRoot, id)) : id);
    const engineModules = classes["engine-source"].map((id) => toPosix(path.relative(engineSourceRoot, id))).sort();
    const artifact = {
      tool: "rollup-plugin-build-provenance",
      label,
      generatedAt: new Date().toISOString(),
      repoRoot: toPosix(repoRoot),
      moduleCount: moduleIds.length,
      counts: Object.fromEntries(Object.entries(classes).map(([name, list]) => [name, list.length])),
      // Repository-owned modules the bundle actually contains (small; the audit needs the paths).
      repoModules: classes.repo.map(rel).sort(),
      patchLayerModules: classes["patch-layer"].map(rel).sort(),
      engineModuleCount: engineModules.length,
      engineModulesSample: engineModules.slice(0, 20),
      outputs: (outputFiles ?? []).map((file) => toPosix(path.relative(repoRoot, path.resolve(file)))),
    };
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `build-provenance.${label}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return outPath;
  };

  return {
    name: "cesium-webgpu-build-provenance",
    generateBundle(_outputOptions, bundle) {
      const ids = [...this.getModuleIds()];
      const files = Object.values(bundle).map((entry) => entry.fileName);
      const outPath = report(ids, files);
      if (!options.quiet) this.info(`build provenance (${label}): ${ids.length} module(s) -> ${toPosix(path.relative(repoRoot, outPath))}`);
    },
  };
}

export default createBuildProvenancePlugin;
