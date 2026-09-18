/**
 * Throwaway repository fixture for the patch-scope and build-layer audits.
 *
 * Builds the smallest tree the audits actually read: an installed `@cesium/engine` with a
 * `Source/Renderer/**` and a logic layer, the baseline record (with its `Source/**` snapshot),
 * a lockfile that agrees with it, the workspace package and the replacement manifest — plus the
 * files the caller wants to place (local replacements, kept-module hashes, bundle provenance).
 *
 * Everything is derived from the fixture's own content, so each counterexample differs from the
 * passing case in exactly the dimension under test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { snapshotEngineSource } from "../../tools/lib/patch-layer.mjs";

const INTEGRITY = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

/** Default engine source: three renderer modules (two with GL call sites) and a logic layer. */
const DEFAULT_ENGINE = {
  "Source/Renderer/Context.js": [
    "export default function Context(options) {",
    "  const gl = options.gl;",
    "  gl.clear(gl.COLOR_BUFFER_BIT);",
    "  gl.viewport(0, 0, 1, 1);",
    "}",
    "",
  ].join("\n"),
  "Source/Renderer/Texture.js": ["export default function Texture(options) {", "  options.gl.bindTexture(1, 2);", "}", ""].join("\n"),
  "Source/Renderer/Sampler.js": ["export default function Sampler(options) {", "  return options;", "}", ""].join("\n"),
  "Source/Renderer/UniformState.js": ["export default function UniformState() {", "  this.dirty = true;", "}", ""].join("\n"),
  "Source/Scene/Scene.js": ["export const Scene = () => 'scene';", ""].join("\n"),
  "Source/Core/defined.js": ["export default function defined(value) {", "  return value !== undefined && value !== null;", "}", ""].join("\n"),
};

/**
 * @param {object} [options]
 * @param {object[]} [options.entries] manifest entries
 * @param {Record<string, string>} [options.localFiles] path → content, relative to `backend-webgpu/`
 * @param {Record<string, string>} [options.engineFiles] extra/replacement upstream files
 * @param {Record<string, string>} [options.files] extra files, relative to the fixture root
 * @param {object} [options.manifest] extra manifest fields (e.g. tampered kept hashes)
 * @param {object|null} [options.provenance] bundle provenance artifact to drop into `artifacts/`
 * @param {string[]} [options.removeLocalFiles] localFiles entries to delete after writing
 */
export function makePatchFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "patch-scope-"));
  const engine = path.join(root, "node_modules", "@cesium", "engine");
  const backend = path.join(root, "packages", "cesium-webgpu", "backend-webgpu");

  const write = (absolute, content) => {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  };

  write(path.join(engine, "package.json"), `${JSON.stringify({ name: "@cesium/engine", version: "26.3.0", license: "Apache-2.0" }, null, 2)}\n`);
  write(path.join(engine, "index.js"), 'const CESIUM_VERSION = "1.145.0";\nexport { CESIUM_VERSION };\n');
  const engineFiles = { ...DEFAULT_ENGINE, ...(options.engineFiles ?? {}) };
  for (const [relative, content] of Object.entries(engineFiles)) write(path.join(engine, ...relative.split("/")), content);

  const entries = options.entries ?? [
    {
      upstreamModule: "Renderer/Context.js",
      localFile: "Renderer/Context.js",
      kind: "replace",
      requirementRef: ["FR-030"],
      reason: "fixture: the context seam is reimplemented",
      glCallSites: 2,
    },
    {
      upstreamModule: "Renderer/Sampler.js",
      localFile: "Renderer/Sampler.js",
      kind: "adapt",
      requirementRef: ["FR-030"],
      reason: "fixture: the sampler semantics are adapted",
      glCallSites: 0,
    },
  ];

  const manifest = {
    schemaVersion: 1,
    baseline: {
      packageName: "@cesium/engine",
      version: "26.3.0",
      cesiumVersion: "1.145.0",
      integrity: INTEGRITY,
      license: "Apache-2.0",
      recordedIn: "upstream/engine-26.3.0.lock.json",
    },
    entries,
    keptModulesHash: null,
    keptModules: {},
    ...(options.manifest ?? {}),
  };
  write(path.join(backend, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const localFiles = {
    "Renderer/Context.ts": "export default class Context {}\n",
    "Renderer/Sampler.ts": "export default function Sampler() {}\n",
    ...(options.localFiles ?? {}),
  };
  for (const [relative, content] of Object.entries(localFiles)) write(path.join(backend, ...relative.split("/")), content);
  for (const relative of options.removeLocalFiles ?? []) fs.rmSync(path.join(backend, ...relative.split("/")), { force: true });

  const snapshot = snapshotEngineSource(engine);
  write(
    path.join(root, "upstream", "engine-26.3.0.lock.json"),
    `${JSON.stringify(
      {
        packageName: "@cesium/engine",
        version: "26.3.0",
        cesiumVersion: "1.145.0",
        integrity: INTEGRITY,
        license: "Apache-2.0",
        recordedAt: "2026-09-19T01:34:07+08:00",
        notes: "fixture baseline: only Source/Renderer/** modules are replaced by the alias plugin",
        sourceSnapshot: { ...snapshot, recordedAt: "2026-09-19T01:34:07+08:00", notes: "fixture snapshot" },
        toolchain: {
          glslang: { version: "16.6.0" },
          "naga-cli": { version: "30.0.1", installCommand: "cargo install naga-cli --version 30.0.1 --locked" },
          "@webgpu/glslang": { version: "0.0.15", entry: "dist/web-devel-onefile" },
        },
      },
      null,
      2,
    )}\n`,
  );
  write(
    path.join(root, "package-lock.json"),
    `${JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/@cesium/engine": { version: "26.3.0", integrity: INTEGRITY } } }, null, 2)}\n`,
  );
  write(
    path.join(root, "packages", "cesium-webgpu", "package.json"),
    `${JSON.stringify({ name: "cesium-webgpu", version: "0.1.0", dependencies: { "@cesium/engine": "26.3.0" } }, null, 2)}\n`,
  );

  if (options.provenance !== null && options.provenance !== undefined) {
    write(path.join(root, "artifacts", "build-provenance.fixture.json"), `${JSON.stringify(options.provenance, null, 2)}\n`);
  }
  for (const [relative, content] of Object.entries(options.files ?? {})) write(path.join(root, ...relative.split("/")), content);

  return { root, engine, backend, manifest, entries, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A provenance artifact shaped like the one `tools/rollup-plugin-build-provenance.mjs` writes. */
export function makeProvenance({ repoModules = [], patchLayerModules = [], engineModuleCount = 12 } = {}) {
  return {
    tool: "rollup-plugin-build-provenance",
    label: "fixture",
    generatedAt: new Date().toISOString(),
    moduleCount: repoModules.length + patchLayerModules.length + engineModuleCount,
    counts: { "engine-source": engineModuleCount, "patch-layer": patchLayerModules.length, repo: repoModules.length, dependency: 0, virtual: 0, other: 0 },
    repoModules,
    patchLayerModules,
    engineModuleCount,
    engineModulesSample: ["Renderer/Context.js", "Scene/Scene.js"],
    outputs: ["dist/index.js"],
  };
}
