/**
 * Gate-scoped CommonJS/UMD interop for third-party dependencies of the upstream engine.
 *
 * **Why this file exists (implementation finding F-1, recorded in `out/g1.json`).**
 * `@cesium/engine@26.3.0`'s `Source/**` imports dependencies that ship **CommonJS only**
 * (`mersenne-twister`, `urijs`, `grapheme-splitter`, …). The approved dependency set
 * (tasks.md T004) contains no CJS interop plugin (`@rollup/plugin-commonjs`), so a plain Rollup
 * build of the upstream engine fails while binding a default import, e.g.:
 *
 *   RollupError: "default" is not exported by "node_modules/mersenne-twister/src/mersenne-twister.js"
 *   RollupError: "default" is not exported by "node_modules/grapheme-splitter/index.js"
 *
 * This plugin detects such modules **at transform time** (content-based, not a hand-maintained
 * package list) and wraps them: their static `require(...)` calls become ESM imports and the
 * original text is evaluated unchanged inside an IIFE, with the standard `__esModule` interop for
 * the default export. The real package code runs — no stub, no fake value. Neither the upstream
 * engine nor `node_modules` is modified: the wrapper only exists inside the generated bundle, and
 * the product build (W1) MUST solve this properly instead of inheriting this gate-local plugin.
 *
 * Node-only, cross-platform.
 */
import fs from "node:fs";
import path from "node:path";

const RESOLVE_SUFFIXES = ["", ".js", ".cjs", ".mjs", ".json", "/index.js"];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

/** Very small content classifier: ESM syntax wins; otherwise `module.exports`/`exports.x` = CJS. */
export function looksLikeCommonJs(code) {
  const hasEsm =
    /(?:^|\n)\s*export\s+(?:default|const|let|var|function|class|\{|\*)/.test(code) ||
    /(?:^|\n)\s*import\s+(?!\()/.test(code) ||
    /(?:^|\n)\s*export\s*\{/.test(code);
  const hasCjs = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]/.test(code);
  return hasCjs && !hasEsm;
}

/**
 * Strip comments before scanning for `require(...)`: browserify standalones (e.g.
 * `protobufjs/dist/minimal/protobuf.js`) document `require("./compiled.js")` inside JSDoc, and
 * those prose occurrences must not become build-time resolution attempts. Only the *scan* uses
 * the stripped text — the emitted module always contains the original code verbatim.
 */
export function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ");
}

function resolveFileLike(base) {
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Node-style resolution for `require()` targets (relative and bare), restricted to real files. */
function resolveRequire(specifier, fromFile) {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    return resolveFileLike(path.resolve(path.dirname(fromFile), specifier));
  }
  let directory = path.dirname(fromFile);
  for (;;) {
    const base = path.join(directory, "node_modules", ...specifier.split("/"));
    const direct = resolveFileLike(base);
    if (direct !== null) return direct;
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      const packageJson = path.join(base, "package.json");
      if (fs.existsSync(packageJson)) {
        const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8"));
        const entry = typeof manifest.exports === "string" ? manifest.exports : (manifest.exports?.["."] ?? null);
        const candidates = [];
        if (typeof entry === "string") candidates.push(entry);
        else if (entry !== null && typeof entry === "object") candidates.push(entry.import?.default ?? entry.import ?? entry.default ?? entry.require);
        if (typeof manifest.module === "string") candidates.push(manifest.module);
        if (typeof manifest.main === "string") candidates.push(manifest.main);
        candidates.push("index.js");
        for (const candidate of candidates) {
          if (typeof candidate !== "string") continue;
          const resolved = resolveFileLike(path.join(base, ...candidate.split("/")));
          if (resolved !== null) return resolved;
        }
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * @param {object} [options]
 * @param {string[]} [options.excludePrefixes] absolute prefixes to leave untouched (the upstream engine)
 * @param {(record: {id: string, requires: string[]}) => void} [options.onWrap] evidence hook
 */
export function createCjsInteropPlugin({ excludePrefixes = [], onWrap = null } = {}) {
  const excluded = excludePrefixes.map((prefix) => toPosix(path.resolve(prefix)));
  return {
    name: "g1-cjs-interop",
    transform(code, id) {
      const normalised = toPosix(path.resolve(id));
      if (!normalised.includes("/node_modules/")) return null;
      if (excluded.some((prefix) => normalised.startsWith(prefix))) return null;
      if (!/\.(?:js|cjs)$/.test(normalised)) return null;
      if (!looksLikeCommonJs(code)) return null;

      const scanned = stripComments(code);
      const specifiers = [...new Set([...scanned.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]))];
      const resolved = [];
      const unresolved = [];
      for (const specifier of specifiers) {
        // JSON targets are not importable by Rollup without @rollup/plugin-json (also absent from
        // the approved dependency set): they are reported and fail loudly if ever reached.
        const target = specifier.endsWith(".json") ? null : resolveRequire(specifier, id);
        if (target === null) unresolved.push(specifier);
        else resolved.push({ specifier, target: toPosix(target) });
      }

      const imports = resolved.map((entry, index) => `import __cjs_require_${index} from ${JSON.stringify(entry.target)};`);
      const requireBody = resolved
        .map((entry, index) => `  if (specifier === ${JSON.stringify(entry.specifier)}) return __cjs_require_${index};`)
        .join("\n");
      const wrapped = [
        "// [g1-cjs-interop] CommonJS wrapper generated at build time; the original module body is unmodified.",
        ...imports,
        "function __cjs_require(specifier) {",
        requireBody,
        `  throw new Error("g1-cjs-interop: require(" + specifier + ") is not resolvable from ${normalised} in this build");`,
        "}",
        "const __cjs_module = { exports: {} };",
        "(function (module, exports, require, __filename, __dirname) {",
        code,
        `})(__cjs_module, __cjs_module.exports, __cjs_require, ${JSON.stringify(normalised)}, ${JSON.stringify(toPosix(path.dirname(id)))});`,
        "const __cjs_entry = __cjs_module.exports;",
        "export default __cjs_entry && __cjs_entry.__esModule === true ? __cjs_entry.default : __cjs_entry;",
      ].join("\n");

      if (onWrap) onWrap({ id: normalised, requires: resolved.map((entry) => entry.specifier), unresolvedRequires: unresolved });
      return { code: wrapped, map: null };
    },
  };
}

export default createCjsInteropPlugin;
