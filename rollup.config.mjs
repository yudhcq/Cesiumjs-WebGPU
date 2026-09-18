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

import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { dts } from "rollup-plugin-dts";

import { createEnginePatchPlugin } from "./tools/rollup-plugin-engine-patch.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(ROOT, "packages", "cesium-webgpu");
const DEMO_ROOT = path.join(ROOT, "apps", "demo");
const DECLARATIONS = path.join(PACKAGE_ROOT, "dist", "types", "src");

const enginePatch = () => createEnginePatchPlugin({ quiet: true });

/** The demo imports the package entry by name; resolve it to the package source entry. */
const demoEntryAlias = () => ({
  name: "demo-package-entry-alias",
  resolveId(source) {
    return source === "cesium-webgpu" ? path.join(PACKAGE_ROOT, "src", "index.ts") : null;
  },
});

const packagePlugins = () => [
  enginePatch(),
  nodeResolve({ exportConditions: ["import"] }),
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
      demoEntryAlias(),
      nodeResolve({ exportConditions: ["import"] }),
      typescript({
        tsconfig: path.join(DEMO_ROOT, "tsconfig.json"),
        declaration: false,
        declarationMap: false,
        noEmitOnError: true,
      }),
    ],
  },
];
