/**
 * Rollup build for the delivery package and the demo page (T009).
 *
 * Three configs, executed in order by `tools/scripts/run.mjs build`:
 *   1. `cesium-webgpu` ESM bundle  (index + escape-hatch multi-entry)
 *   2. `cesium-webgpu` type bundle (rollup-plugin-dts over the declarations emitted by tsc)
 *   3. `apps/demo` ESM bundle
 *
 * The alias plugin (T008) participates in every bundle so that the module-level replacement
 * patch layer is applied to the same resolution graph that ships. Before the manifest lands
 * (Phase 3) it is inert: it rewrites nothing and never modifies the upstream package.
 *
 * Declaration emission is done by `tsc --emitDeclarationOnly` in the runner rather than by
 * `@rollup/plugin-typescript`, because rollup-plugin-dts consumes `.d.ts` files from disk.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { dts } from "rollup-plugin-dts";

import { createEnginePatchPlugin } from "./tools/rollup-plugin-engine-patch.mjs";
import { createBuildProvenancePlugin } from "./tools/rollup-plugin-build-provenance.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(ROOT, "packages", "cesium-webgpu");
const DEMO_ROOT = path.join(ROOT, "apps", "demo");
const DECLARATIONS = path.join(PACKAGE_ROOT, "dist", "types", "src");

const enginePatch = () => createEnginePatchPlugin({ quiet: true });

/** Records which repository-owned modules enter each bundle (read by the build-layer audit). */
const buildProvenance = (options) => createBuildProvenancePlugin({ quiet: true, ...options });

/** The demo imports the package entry by name; resolve it to the package source entry. */
const demoEntryAlias = () => ({
  name: "demo-package-entry-alias",
  resolveId(source) {
    return source === "cesium-webgpu" ? path.join(PACKAGE_ROOT, "src", "index.ts") : null;
  },
});

/**
 * CommonJS interop, in the same position the contract-suite bundler uses
 * (`tests/support/backend-build.mjs`: alias → nodeResolve → commonjs → typescript).
 *
 * Required as soon as **any** module in the graph reaches `@cesium/engine`: the engine's
 * `Source/Core/Math.js` does `import MersenneTwister from "mersenne-twister"`, and that dependency is
 * CommonJS, so Rollup reports `"default" is not exported by mersenne-twister` and the whole build
 * fails. `src/terrain/source.ts` (T086) is the first module to import the engine, which is why this
 * gap only surfaced then — the failure is about the engine being in the graph at all, not about that
 * particular file.
 */
const commonjsInterop = () => commonjs({ include: [/node_modules/], transformMixedEsModules: true });

const packagePlugins = () => [
  enginePatch(),
  buildProvenance({ label: "cesium-webgpu-package" }),
  nodeResolve({ exportConditions: ["import"] }),
  commonjsInterop(),
  typescript({
    tsconfig: path.join(PACKAGE_ROOT, "tsconfig.json"),
    declaration: false,
    declarationMap: false,
    noEmitOnError: true,
  }),
];

export default [
  {

    input: {
      index: path.join(PACKAGE_ROOT, "src", "index.ts"),
      "escape-hatch": path.join(PACKAGE_ROOT, "src", "escape-hatch.ts"),
    },
    output: {
      dir: path.join(PACKAGE_ROOT, "dist"),
      format: "es",
      entryFileNames: "[name].js",
      sourcemap: true,
    },
    plugins: packagePlugins(),
  },
  {

    input: {
      index: path.join(DECLARATIONS, "index.d.ts"),
      "escape-hatch": path.join(DECLARATIONS, "escape-hatch.d.ts"),
    },
    output: {
      dir: path.join(PACKAGE_ROOT, "dist"),
      format: "es",
      entryFileNames: "[name].d.ts",
    },
    plugins: [dts()],
  },
  {

    input: path.join(DEMO_ROOT, "src", "main.ts"),
    output: {
      file: path.join(DEMO_ROOT, "dist", "main.js"),
      format: "es",
      sourcemap: true,
    },
    plugins: [
      enginePatch(),
      buildProvenance({ label: "demo" }),
      demoEntryAlias(),
      nodeResolve({ exportConditions: ["import"] }),
      commonjsInterop(),
      // The patch layer is reached from `apps/demo` only through the alias plugin
      // (`@cesium/engine/Source/Renderer/*.js` → `packages/cesium-webgpu/backend-webgpu/Renderer/*.ts`).
      // `@rollup/plugin-typescript` decides whether to **transform** a module from its tsconfig's
      // `include`, and `apps/demo/tsconfig.json` only lists `src/**/*.ts` — so those aliased TypeScript
      // files arrived at Rollup untransformed ("Expected ',', got 'ident' … you need plugins to import
      // files that are not JavaScript"). `tsconfig.build.json` is the bundling-only view that also lists
      // the package's `src/**`, `backend-webgpu/**` and `types/**`; `tsc --noEmit (apps/demo)` keeps
      // using `apps/demo/tsconfig.json`, so this changes bundling only, not the typecheck gate.
      typescript({
        tsconfig: path.join(DEMO_ROOT, "tsconfig.build.json"),
        declaration: false,
        declarationMap: false,
        noEmitOnError: true,
      }),
    ],
  },
];
