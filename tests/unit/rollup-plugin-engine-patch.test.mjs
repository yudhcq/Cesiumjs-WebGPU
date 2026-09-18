/**
 * T008 — alias plugin (`tools/rollup-plugin-engine-patch.mjs`).
 *
 * Covers the three cases named in T008:
 *   1. empty manifest            -> zero rewrites;
 *   2. duplicate/exhaustive case -> rewritten set == manifest set (no miss, no extra);
 *   3. re-export from `index.js` and the engine's own relative imports are rewritten too.
 *
 * Case 3 runs a REAL Rollup build against a fixture `@cesium/engine` tree, which is the only
 * honest way to prove the rewrite happens on the resolved absolute path.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rollup } from "rollup";

import { createEnginePatchPlugin, loadManifest, whitelistExhaustiveCheck } from "../../tools/rollup-plugin-engine-patch.mjs";
import { REPO_ROOT } from "../support/repo.mjs";

const PATCHED_CONTEXT = "PATCHED-CONTEXT";
const PATCHED_TEXTURE = "PATCHED-TEXTURE";

const ENGINE_FILES = {
  "node_modules/@cesium/engine/package.json": JSON.stringify({
    name: "@cesium/engine",
    version: "26.3.0",
    type: "module",
    main: "index.js",
  }),
  "node_modules/@cesium/engine/index.js": [
    'export { default as Context } from "./Source/Renderer/Context.js";',
    'export { default as Texture } from "./Source/Renderer/Texture.js";',
    'export { Scene } from "./Source/Scene/Scene.js";',
  ].join("\n"),
  "node_modules/@cesium/engine/Source/Renderer/Context.js": 'export default "UPSTREAM-CONTEXT";\n',
  "node_modules/@cesium/engine/Source/Renderer/Texture.js": 'export default "UPSTREAM-TEXTURE";\n',
  "node_modules/@cesium/engine/Source/Renderer/Buffer.js": 'export default "UPSTREAM-BUFFER";\n',
  "node_modules/@cesium/engine/Source/Scene/Scene.js": [
    'import Context from "../Renderer/Context.js";',
    "export const Scene = () => `SCENE(${Context})`;",
  ].join("\n"),
};

const LOCAL_FILES = {
  "packages/cesium-webgpu/backend-webgpu/Renderer/Context.js": `export default "${PATCHED_CONTEXT}";\n`,
  "packages/cesium-webgpu/backend-webgpu/Renderer/Texture.js": `export default "${PATCHED_TEXTURE}";\n`,
};

const ENTRY = [
  'import Context from "@cesium/engine/Source/Renderer/Context.js";',
  'import { Scene } from "@cesium/engine/Source/Scene/Scene.js";',
  'import { Context as ReExported, Texture as ReExportedTexture } from "@cesium/engine";',
  "export const values = [Context, ReExported, ReExportedTexture, Scene()];",
].join("\n");

function makeFixture(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-patch-"));
  const files = { ...ENGINE_FILES, ...LOCAL_FILES, ...extra };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  return root;
}

function manifestFile(modules) {
  return JSON.stringify({
    baseline: { packageName: "@cesium/engine", version: "26.3.0" },
    entries: modules.map((upstreamModule) => ({
      upstreamModule,
      localFile: upstreamModule,
      kind: "replace",
      requirementRef: ["FR-030"],
      reason: "fixture",
      glCallSites: 1,
    })),
  });
}

function engineSourceFiles(root) {
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child, out);
      else if (entry.name.endsWith(".js")) out.push(child);
    }
    return out;
  };
  const sourceRoot = path.join(root, "node_modules", "@cesium", "engine", "Source");
  return walk(sourceRoot).map((file) => path.relative(sourceRoot, file).split(path.sep).join("/"));
}

test("an empty manifest produces zero rewrites", (t) => {
  const root = makeFixture({ "packages/cesium-webgpu/backend-webgpu/manifest.json": manifestFile([]) });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const plugin = createEnginePatchPlugin({
    manifestPath: path.join(root, "packages/cesium-webgpu/backend-webgpu/manifest.json"),
    engineRoot: path.join(root, "node_modules/@cesium/engine"),
    quiet: true,
  });
  const engineContext = path.join(root, "node_modules/@cesium/engine/Source/Renderer/Context.js");
  assert.equal(plugin.api.shouldRewrite(engineContext), null);
  assert.equal(plugin.resolveId("@cesium/engine/Source/Renderer/Context.js", undefined), null);
  assert.equal(plugin.resolveId("../Renderer/Context.js", path.join(root, "node_modules/@cesium/engine/Source/Scene/Scene.js")), null);

  const check = whitelistExhaustiveCheck(engineSourceFiles(root), {
    manifestPath: path.join(root, "packages/cesium-webgpu/backend-webgpu/manifest.json"),
    engineRoot: path.join(root, "node_modules/@cesium/engine"),
    localRoot: path.join(root, "packages/cesium-webgpu/backend-webgpu"),
    quiet: true,
  });
  assert.deepEqual(check.rewritten, []);
  assert.deepEqual(check.missing, []);
  // The two local replacement modules are deliberately reported as unregistered patches.
  assert.deepEqual(check.extra, ["Renderer/Context.js", "Renderer/Texture.js"]);
  assert.equal(check.ok, false);
});

test("the rewritten set equals the manifest set (no miss, no extra)", (t) => {
  const root = makeFixture({
    "packages/cesium-webgpu/backend-webgpu/manifest.json": manifestFile(["Renderer/Context.js", "Renderer/Texture.js"]),
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    manifestPath: path.join(root, "packages/cesium-webgpu/backend-webgpu/manifest.json"),
    engineRoot: path.join(root, "node_modules/@cesium/engine"),
    localRoot: path.join(root, "packages/cesium-webgpu/backend-webgpu"),
    quiet: true,
  };

  const check = whitelistExhaustiveCheck(engineSourceFiles(root), options);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.rewritten, ["Renderer/Context.js", "Renderer/Texture.js"]);
  assert.deepEqual(check.missing, []);
  assert.deepEqual(check.extra, []);

  // A manifest entry the engine no longer ships (or a typo) is reported as a missing rewrite.
  const nothingShipped = whitelistExhaustiveCheck(["Scene/Scene.js"], options);
  assert.deepEqual(nothingShipped.missing, ["Renderer/Context.js", "Renderer/Texture.js"]);
  assert.equal(nothingShipped.ok, false);
});

test("a real Rollup build rewrites deep imports, engine-internal relative imports and index.js re-exports", async (t) => {
  const root = makeFixture({
    "packages/cesium-webgpu/backend-webgpu/manifest.json": manifestFile(["Renderer/Context.js", "Renderer/Texture.js"]),
    "src/entry.js": ENTRY,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const bundle = await rollup({
    input: path.join(root, "src/entry.js"),
    plugins: [
      createEnginePatchPlugin({
        manifestPath: path.join(root, "packages/cesium-webgpu/backend-webgpu/manifest.json"),
        engineRoot: path.join(root, "node_modules/@cesium/engine"),
        localRoot: path.join(root, "packages/cesium-webgpu/backend-webgpu"),
        quiet: true,
      }),
      {
        // Minimal fixture resolver: `@cesium/engine` (and its deep paths) -> the fixture tree.
        // The real build uses @rollup/plugin-node-resolve, which is irrelevant to the rewrite
        // under test: only the alias plugin may turn an engine path into a local file.
        name: "fixture-node-resolve",
        resolveId(source, importer) {
          if (source === "@cesium/engine") return path.join(root, "node_modules/@cesium/engine/index.js");
          if (source.startsWith("@cesium/engine/")) {
            const candidate = path.join(root, "node_modules/@cesium/engine", source.slice("@cesium/engine/".length));
            if (fs.existsSync(candidate)) return candidate;
          }
          if (source.startsWith("./") || source.startsWith("../")) {
            const candidate = path.resolve(path.dirname(importer), source);
            if (fs.existsSync(candidate)) return candidate;
          }
          return null;
        },
      },
    ],
  });
  const { output } = await bundle.generate({ format: "es" });
  const code = output[0].code;

  // 1) bare deep import -> local replacement
  assert.ok(code.includes(PATCHED_CONTEXT), `deep import MUST resolve to the local replacement:\n${code}`);
  // 2) the engine's own relative import (`Scene.js` -> `../Renderer/Context.js`) is rewritten too:
  //    the identifier Scene closes over MUST be bound to the local replacement.
  const sceneMatch = code.match(/const Scene = \(\) => `SCENE\(\$\{([A-Za-z_$][\w$]*)\}\)`/);
  assert.ok(sceneMatch, `the Scene module MUST be bundled from the fixture engine:\n${code}`);
  assert.match(
    code,
    new RegExp(`(?:var|const|let)\\s+${sceneMatch[1]}\\s*=\\s*"${PATCHED_CONTEXT}"`),
    `Scene's Context binding MUST come from the local replacement:\n${code}`,
  );
  // 3) index.js re-exports are rewritten as well.
  assert.ok(code.includes(PATCHED_TEXTURE), `index.js re-exports MUST be rewritten:\n${code}`);
  // 4) no upstream renderer implementation survives in the bundle.
  assert.ok(!code.includes("UPSTREAM-CONTEXT"), "no upstream Context implementation may survive in the bundle");
  assert.ok(!code.includes("UPSTREAM-TEXTURE"), "no upstream Texture implementation may survive in the bundle");

  // The upstream package on disk is never modified.
  const upstreamContext = fs.readFileSync(path.join(root, "node_modules/@cesium/engine/Source/Renderer/Context.js"), "utf8");
  assert.match(upstreamContext, /UPSTREAM-CONTEXT/);
});

test("a manifest entry pointing outside Renderer/** is rejected at load time", (t) => {
  const root = makeFixture({
    "packages/cesium-webgpu/backend-webgpu/manifest.json": manifestFile(["Scene/Scene.js"]),
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () =>
      loadManifest({
        manifestPath: path.join(root, "packages/cesium-webgpu/backend-webgpu/manifest.json"),
        quiet: true,
      }),
    /patch boundary/,
  );
});

test("a manifest entry without a local replacement file fails loudly at build time", (t) => {
  const root = makeFixture({
    "packages/cesium-webgpu/backend-webgpu/manifest.json": manifestFile(["Renderer/Context.js", "Renderer/Buffer.js"]),
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const plugin = createEnginePatchPlugin({
    manifestPath: path.join(root, "packages/cesium-webgpu/backend-webgpu/manifest.json"),
    engineRoot: path.join(root, "node_modules/@cesium/engine"),
    localRoot: path.join(root, "packages/cesium-webgpu/backend-webgpu"),
    quiet: true,
  });
  assert.throws(() => plugin.resolveId("@cesium/engine/Source/Renderer/Buffer.js", undefined), /no local replacement file/);
});

test("the repository's replacement manifest is live and the plugin rewrites exactly that set", () => {
  // Phase 1 ran with no `backend-webgpu/manifest.json` at all (the plugin was inert). T031 has
  // since landed the manifest, so the same probe MUST now report the real patch boundary:
  // Renderer/** modules are rewritten, every other upstream module is left untouched.
  const plugin = createEnginePatchPlugin({ quiet: true });
  assert.equal(plugin.api.manifest.entries.length, 23, "T031 lands 16 replacement + 7 adaptation entries");
  const upstreamContext = path.join(REPO_ROOT, "node_modules/@cesium/engine/Source/Renderer/Context.js");
  assert.ok(fs.existsSync(upstreamContext), "the pinned upstream module MUST be installed");
  assert.equal(plugin.api.shouldRewrite(upstreamContext)?.upstreamModule, "Renderer/Context.js");
  const upstreamScene = path.join(REPO_ROOT, "node_modules/@cesium/engine/Source/Scene/Scene.js");
  assert.equal(plugin.api.shouldRewrite(upstreamScene), null, "the logic layer MUST NOT be rewritten");
});
