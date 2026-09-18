/**
 * Loader for the repository's TypeScript sources inside Node tests.
 *
 * The patch layer is written in TypeScript, but `node --test` cannot import `.ts` directly and
 * the build emits declarations only. Rather than asserting the skeleton behaviour by pattern
 * matching its source, this helper runs **the real modules**: each entry is compiled with the
 * TypeScript compiler API and bundled by Rollup (both are pinned devDependencies), then imported
 * from a data URL. Relative imports between patch-layer modules are resolved as usual, so a
 * skeleton is exercised exactly as the build chain would see it.
 *
 * Usage: `const { exports } = await loadTypeScriptModule(repoPath("…/Context.ts"))`.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { rollup } from "rollup";

const cache = new Map();

/** Compile one `.ts` file and rewrite nothing: the bundler resolves `.js` specifiers to `.ts`. */
function compileTypeScript(source, fileName) {
  const result = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
      isolatedModules: true,
    },
  });
  return result.outputText;
}

const STUB_PREFIX = "\0test-stub:";

/**
 * Serve `externals` (a specifier → ES-module-source map) and resolve the patch layer's `.ts` imports.
 *
 * `externals` exists because the patch layer consumes **kept upstream modules** through bare deep
 * specifiers (`@cesium/engine/Source/Renderer/ContextLimits.js`, …). In the real build the alias
 * plugin resolves them to the installed package; inside `node --test` a bare specifier cannot be
 * resolved from a `data:` URL at all. Tests therefore inject a stub for exactly the collaborators a
 * case needs, which also keeps the unit layer free of the upstream module graph (and of a GPU).
 */
function typescriptPlugin(externals) {
  const keys = Object.keys(externals);
  return {
    name: "test-typescript",
    resolveId(source, importer) {
      if (keys.includes(source)) return `${STUB_PREFIX}${source}`;
      if (!source.startsWith(".") || importer === undefined) return null;
      if (importer.startsWith("data:") || importer.startsWith(STUB_PREFIX)) return null;
      const base = path.resolve(path.dirname(importer), source);
      const candidates = [base.replace(/\.js$/, ".ts"), base, `${base}.ts`];
      return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
    },
    load(id) {
      if (id.startsWith(STUB_PREFIX)) return externals[id.slice(STUB_PREFIX.length)];
      if (!id.endsWith(".ts")) return null;
      return compileTypeScript(fs.readFileSync(id, "utf8"), id);
    },
  };
}

/**
 * Compile + bundle one TypeScript entry and import it as an ES module.
 *
 * @param {string} absoluteEntry absolute path of the `.ts` entry
 * @param {{externals?: Record<string, string>}} [options] `externals` maps a bare specifier the entry
 *   (or one of its dependencies) imports to the ES-module source that should stand in for it.
 * @returns {Promise<Record<string, unknown>>} the module namespace
 */
export async function loadTypeScriptModule(absoluteEntry, options = {}) {
  const entry = path.resolve(absoluteEntry);
  const externals = options.externals ?? {};
  const cacheKey = `${entry}::${Object.keys(externals).sort().join(",")}::${Object.values(externals).join("\u0000")}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  if (!fs.existsSync(entry)) throw new Error(`TypeScript entry not found: ${entry}`);

  const bundle = await rollup({ input: entry, plugins: [typescriptPlugin(externals)], logLevel: "silent" });
  try {
    const { output } = await bundle.generate({ format: "es" });
    const chunk = output.find((item) => item.type === "chunk");
    if (chunk === undefined) throw new Error(`no chunk produced for ${entry}`);
    const url = `data:text/javascript;base64,${Buffer.from(chunk.code, "utf8").toString("base64")}`;
    const module_ = await import(url);
    cache.set(cacheKey, module_);
    return module_;
  } finally {
    await bundle.close();
  }
}

/** Load several entries in one call (order preserved). */
export async function loadTypeScriptModules(entries) {
  return Promise.all(entries.map((entry) => loadTypeScriptModule(entry)));
}
