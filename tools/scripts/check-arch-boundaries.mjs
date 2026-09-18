#!/usr/bin/env node
/**
 * Architecture boundary scanner (data-model.md §11, rules A1–A11).
 *
 * Zero runtime dependencies, Node-only, cross-platform: the CI target is Linux + bash and
 * every self-check in this repository MUST run through `node …`.
 *
 * Usage:
 *   node tools/scripts/check-arch-boundaries.mjs                     # all rules, strict
 *   node tools/scripts/check-arch-boundaries.mjs --rules A1,A7
 *   node tools/scripts/check-arch-boundaries.mjs --rules auto        # skip rules whose
 *                                                                    # target does not exist yet
 *   node tools/scripts/check-arch-boundaries.mjs --root <dir> --out <file>
 *
 * Exit codes:
 *   0  no violations ("no match" is printed)
 *   1  at least one rule matched (violation)
 *   2  a rule's required scan target is missing, or the invocation is invalid
 *
 * Every rule declares the paths it requires. A missing required path is an error, never a
 * silent pass — that is the same discipline as `grep` reporting a missing file.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..", "..");

const RULE_IDS = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11"];
const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".html"];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const options = { rules: "all", root: DEFAULT_ROOT, out: null, engineRoot: null };
  const takesValue = new Set(["--rules", "--root", "--out", "--engine-root"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    let value = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (!takesValue.has(key)) throw new Error(`unknown argument "${arg}"`);
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for "${key}"`);
      i += 1;
    }
    if (key === "--rules") options.rules = value;
    else if (key === "--root") options.root = path.resolve(value);
    else if (key === "--out") options.out = value;
    else if (key === "--engine-root") options.engineRoot = path.resolve(value);
  }
  options.engineRoot ??= path.join(options.root, "node_modules", "@cesium", "engine");
  return options;
}

function exists(target) {
  return fs.existsSync(target);
}

function walkFiles(target, extensions, out = []) {
  if (!exists(target)) return out;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (extensions.some((ext) => target.endsWith(ext))) out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) walkFiles(child, extensions, out);
    else if (entry.isFile() && extensions.some((ext) => child.endsWith(ext))) out.push(child);
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Scan a file line by line; returns one violation per matching line/pattern. */
function scanPatterns(root, file, patterns) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const violations = [];
  for (const { id, regex, message } of patterns) {
    lines.forEach((line, index) => {
      if (regex.test(line)) {
        violations.push({ rule: id, file: relative, line: index + 1, detail: message, snippet: line.trim().slice(0, 160) });
      }
    });
  }
  return violations;
}

/** Collect the value of `${key}: value` pairs (whitespace tolerant) from a text blob. */
function optionValues(text, key) {
  const values = [];
  const re = new RegExp(`\\b${key}\\s*:\\s*([A-Za-z_$][\\w$.-]*)`, "g");
  let match;
  while ((match = re.exec(text)) !== null) values.push(match[1]);
  return values;
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

const BACKEND_SYMBOLS = [
  { id: "A1", regex: /GPU[A-Z]/, message: "public API surface MUST NOT mention WebGPU handle types" },
  { id: "A1", regex: /WebGL/, message: "public API surface MUST NOT mention the GL backend" },
  { id: "A1", regex: /navigator\.gpu/, message: "public API surface MUST NOT probe the device itself" },
  { id: "A1", regex: /backend-webgpu/, message: "public API surface MUST NOT reference the patch layer" },
];

/**
 * A1 — `src/api/**`, `src/index.ts` and the built `dist/index.d.ts` stay backend agnostic.
 */
function ruleA1(root) {
  const packageRoot = path.join(root, "packages", "cesium-webgpu");
  const targets = [
    path.join(packageRoot, "src", "index.ts"),
    ...walkFiles(path.join(packageRoot, "src", "api"), SOURCE_EXTENSIONS),
    path.join(packageRoot, "dist", "index.d.ts"),
  ];
  for (const target of [path.join(packageRoot, "src", "index.ts"), path.join(packageRoot, "src", "api")]) {
    if (!exists(target)) return { missing: path.relative(root, target) };
  }
  const distTypes = path.join(packageRoot, "dist", "index.d.ts");
  if (!exists(distTypes)) return { missing: path.relative(root, distTypes) };
  const violations = targets.filter((file) => exists(file)).flatMap((file) => scanPatterns(root, file, BACKEND_SYMBOLS));
  return { violations };
}

/**
 * A2 — no module under `src/**` imports the concrete patch-layer implementation.
 */
function ruleA2(root) {
  const srcRoot = path.join(root, "packages", "cesium-webgpu", "src");
  if (!exists(srcRoot)) return { missing: path.relative(root, srcRoot) };
  const patterns = [
    {
      id: "A2",
      regex: /(?:from|import)\s*\(?\s*["'][^"']*backend-webgpu[^"']*["']/,
      message: "src/** MUST NOT import backend-webgpu/** (only the abstract interface inside src/)",
    },
  ];
  const violations = walkFiles(srcRoot, SOURCE_EXTENSIONS).flatMap((file) => scanPatterns(root, file, patterns));
  return { violations };
}

/** A3 — every replacement entry stays inside the renderer backend layer. */
function ruleA3(root) {
  const manifestPath = path.join(root, "packages", "cesium-webgpu", "backend-webgpu", "manifest.json");
  if (!exists(manifestPath)) return { missing: path.relative(root, manifestPath) };
  const manifest = readJson(manifestPath);
  const violations = [];
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    violations.push({ rule: "A3", file: "manifest.json", detail: "manifest entries MUST be a non-empty array" });
    return { violations };
  }
  for (const entry of manifest.entries) {
    const module = entry?.upstreamModule;
    if (typeof module !== "string" || !/^Renderer\/[A-Za-z0-9_]+\.js$/.test(module)) {
      violations.push({
        rule: "A3",
        file: "manifest.json",
        detail: `upstreamModule "${module}" MUST match ^Renderer/[A-Za-z0-9_]+\\.js$ (patch boundary, principle I)`,
      });
    }
  }
  return { violations };
}

/** A4 — the alias plugin rewrites exactly the manifest set (no miss, no extra). */
async function ruleA4(root, options) {
  const manifestPath = path.join(root, "packages", "cesium-webgpu", "backend-webgpu", "manifest.json");
  if (!exists(manifestPath)) return { missing: path.relative(root, manifestPath) };
  const sourceRoot = path.join(options.engineRoot, "Source");
  if (!exists(sourceRoot)) return { missing: path.relative(root, sourceRoot) };
  const pluginPath = path.join(root, "tools", "rollup-plugin-engine-patch.mjs");
  if (!exists(pluginPath)) return { missing: path.relative(root, pluginPath) };

  const module = await import(pathToFileURL(pluginPath).href);
  const sourceFiles = walkFiles(sourceRoot, [".js"]).map((file) => path.relative(sourceRoot, file).split(path.sep).join("/"));
  const result = module.whitelistExhaustiveCheck(sourceFiles, { manifestPath, localRoot: path.dirname(manifestPath) });
  const violations = [];
  for (const module_ of result.missing) {
    violations.push({ rule: "A4", file: "manifest.json", detail: `alias plugin never rewrites "${module_}" (missing rewrite)` });
  }
  for (const entry of result.extra) {
    violations.push({
      rule: "A4",
      file: "manifest.json",
      detail: `local replacement module "${entry}" under backend-webgpu/Renderer/ has no manifest entry (unregistered patch)`,
    });
  }
  return { violations, summary: { manifestModules: result.manifestModules.length, rewritten: result.rewritten.length } };
}

/** A5 — the caller (demo) contains no render-path branching. */
function ruleA5(root) {
  const demoRoot = path.join(root, "apps", "demo");
  if (!exists(demoRoot)) return { missing: path.relative(root, demoRoot) };
  const patterns = [
    { id: "A5", regex: /preference\s*===?/, message: "caller MUST NOT branch on the backend preference (FR-007 / contract C-5)" },
    { id: "A5", regex: /===\s*["']webgpu["']/, message: 'caller MUST NOT compare against "webgpu"' },
    { id: "A5", regex: /===\s*["']webgl2["']/, message: 'caller MUST NOT compare against "webgl2"' },
  ];
  const files = [
    ...walkFiles(path.join(demoRoot, "src"), SOURCE_EXTENSIONS),
    path.join(demoRoot, "index.html"),
  ].filter((file) => exists(file));
  if (files.length === 0) return { missing: path.relative(root, path.join(demoRoot, "src")) };
  const violations = files.flatMap((file) => scanPatterns(root, file, patterns));
  return { violations };
}

/**
 * A6 — the MVP scene configuration keeps the zero-compute-command guarantees.
 *
 * The subject of this rule is the scene-composition module (the code that builds the viewer /
 * scene options). While that module does not exist yet the rule reports a missing target rather
 * than a violation, so `--rules auto` stays meaningful during the setup phase.
 */
function ruleA6(root) {
  const srcRoot = path.join(root, "packages", "cesium-webgpu", "src");
  if (!exists(srcRoot)) return { missing: path.relative(root, srcRoot) };
  const sceneMarkers = /(?:^|[^\w])(baseLayer|skyBox|skyAtmosphere)\s*:|new\s+(?:CesiumWidget|Viewer|Scene)\s*\(/;
  const sceneFiles = walkFiles(srcRoot, SOURCE_EXTENSIONS).filter((file) => sceneMarkers.test(fs.readFileSync(file, "utf8")));
  if (sceneFiles.length === 0) {
    return { missing: "packages/cesium-webgpu/src (scene-composition module has not landed yet)" };
  }
  const text = sceneFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const violations = [];
  for (const flag of ["baseLayer", "skyBox", "skyAtmosphere"]) {
    if (!new RegExp(`\\b${flag}\\s*:\\s*false`).test(text)) {
      violations.push({
        rule: "A6",
        file: "packages/cesium-webgpu/src",
        detail: `MVP scene options MUST set ${flag}: false (research §1.6: keeps the ComputeCommand dispatch count at 0)`,
      });
    }
  }
  return { violations, summary: { sceneFiles: sceneFiles.map((file) => path.relative(root, file).split(path.sep).join("/")) } };
}

/**
 * A7 — verification runs enable exactly one backend.
 *
 * Scanned execution surfaces: `tests/support/**`, the suite directories, `tools/**` and the
 * root scripts. `tests/unit/**` is deliberately excluded: unit tests must be free to write the
 * forbidden forms verbatim as *invalid inputs* (that is how the runner's rejection is proven),
 * and a unit test is not an execution surface for verification runs.
 *
 * The forbidden tokens are assembled from fragments so this file stays clean under its own scan.
 */
function ruleA7(root) {
  const runnerPath = path.join(root, "tests", "support", "backend-runner.mjs");
  if (!exists(runnerPath)) return { missing: path.relative(root, runnerPath) };
  const dualEntryNames = `${"both"}Backends|${"compare"}Backends|${"dual"}Path|${"same"}Frame|${"overlay"}Backends`;
  const patterns = [
    { id: "A7", regex: new RegExp(`${"--back"}ends=`), message: "a verification run MUST NOT accept more than one backend" },
    {
      id: "A7",
      regex: new RegExp(`${"--back"}end=webgpu,webgl2|${"--back"}end=webgl2,webgpu`),
      message: "the two backends MUST NOT be enabled in one run",
    },
    { id: "A7", regex: new RegExp(`\\b(${dualEntryNames})\\b`), message: "same-session dual-path entry points are forbidden (principle II)" },
  ];
  const scanTargets = [
    path.join(root, "tests", "support"),
    path.join(root, "tests", "contract"),
    path.join(root, "tests", "visual"),
    path.join(root, "tests", "benchmark"),
  ];
  const scans = [...scanTargets.flatMap((target) => walkFiles(target, SOURCE_EXTENSIONS)), ...walkFiles(path.join(root, "tools"), SOURCE_EXTENSIONS)];
  const violations = scans.flatMap((file) => scanPatterns(root, file, patterns));
  const runner = fs.readFileSync(runnerPath, "utf8");
  if (!/--backend=/.test(runner)) {
    violations.push({ rule: "A7", file: "tests/support/backend-runner.mjs", detail: "runner MUST take --backend=<webgpu|webgl2>" });
  }
  if (!/SUITE_MAP/.test(runner)) {
    violations.push({ rule: "A7", file: "tests/support/backend-runner.mjs", detail: "runner MUST expose the documented --suite mapping table" });
  }
  return { violations, summary: { scannedFiles: scans.length } };
}

/**
 * A8 — capability consistency (static half of the runtime invariant verified by T045):
 * `sliceBComplete === true ⇒ depthTexture === true`, and every `false` capability carries notes.
 */
function ruleA8(root) {
  const backendRoot = path.join(root, "packages", "cesium-webgpu", "backend-webgpu");
  if (!exists(backendRoot)) return { missing: path.relative(root, backendRoot) };
  const files = walkFiles(backendRoot, SOURCE_EXTENSIONS);
  const violations = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (!/sliceBComplete/.test(text)) continue;
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (!optionValues(text, "depthTexture").includes("true")) {
      violations.push({
        rule: "A8",
        file: relative,
        detail: "sliceBComplete === true MUST imply depthTexture === true (data-model §11 A8)",
      });
    }
    if (!/\bnotes\b/.test(text)) {
      violations.push({ rule: "A8", file: relative, detail: "every `false` capability MUST be recorded with notes (FR-023)" });
    }
  }
  return { violations };
}

/**
 * A9 — the logic layer's shader view stays GLSL.
 *
 * Required target: the upstream GLSL probe (`Scene/Primitive.js`) must still exist, so the
 * invariant has a real subject. Optional surface: the patch layer, once present, MUST NOT
 * assign to `vertexShaderSource` / `fragmentShaderSource`, and a replaced `ShaderProgram`
 * MUST keep `_attributeLocations`.
 */
function ruleA9(root, options) {
  const probeFile = path.join(options.engineRoot, "Source", "Scene", "Primitive.js");
  if (!exists(probeFile)) return { missing: path.relative(root, probeFile) };
  const probeText = fs.readFileSync(probeFile, "utf8");
  const probes = probeText.match(/\/[^/\n]*\\s\+vec[^/\n]*\/g/g) ?? [];
  const violations = [];
  if (probes.length === 0) {
    violations.push({
      rule: "A9",
      file: "node_modules/@cesium/engine/Source/Scene/Primitive.js",
      detail: "the GLSL regular-expression probe disappeared upstream — the shader-view invariant lost its subject",
    });
  }

  const backendRoot = path.join(root, "packages", "cesium-webgpu", "backend-webgpu");
  const files = walkFiles(backendRoot, SOURCE_EXTENSIONS);
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    for (const { regex, message } of [
      { regex: /(?:^|[^.\w])vertexShaderSource\s*=(?!=)/, message: "MUST NOT overwrite the GLSL view exposed to the logic layer (contract R2)" },
      { regex: /(?:^|[^.\w])fragmentShaderSource\s*=(?!=)/, message: "MUST NOT overwrite the GLSL view exposed to the logic layer (contract R2)" },
    ]) {
      text.split(/\r?\n/).forEach((line, index) => {
        if (regex.test(line)) violations.push({ rule: "A9", file: relative, line: index + 1, detail: message, snippet: line.trim().slice(0, 160) });
      });
    }
    if (/Renderer[/\\]ShaderProgram\./.test(file) && !/_attributeLocations/.test(text)) {
      violations.push({
        rule: "A9",
        file: relative,
        detail: "the replacement ShaderProgram MUST keep _attributeLocations in sync with attributeLocations",
      });
    }
  }
  return { violations, summary: { probes: probes.length, patchLayerFiles: files.length } };
}

/**
 * A10 — varying contracts pair up per shader variant (static half; the runtime half is the
 * real-device `createRenderPipeline` gate G-5).
 *
 * FIX (W4/T083, recorded because it changes the rule's subject): the first version collected the
 * `@location` decorators by slicing the file from its first `@vertex` / `@fragment` occurrence. For a
 * complete WGSL module that is simply the wrong region — the stage's interface structs are declared
 * **before** the entry point (WGSL requires declaration before use), and a `@fragment` entry point's
 * own return type carries an **output** location that has nothing to do with varyings. The rule
 * therefore reported a false positive on the first complete module pair this repository produced
 * (`wgsl/globe-vs.wgsl` vs `wgsl/globe-fs.wgsl`, whose locations do match: VS out {0,2} / FS in {0,2}).
 *
 * The rule now reads the interface structs — `<X>In` for the vertex inputs, `<X>Out` for the vertex
 * outputs, `<X>In` for the fragment inputs — and falls back to the original slice when a file does not
 * name its structs that way, so the previous behaviour is preserved for hand-written fixtures.
 */
function ruleA10(root) {
  const wgslRoot = path.join(root, "packages", "cesium-webgpu", "backend-webgpu", "webgpu", "wgsl");
  if (!exists(wgslRoot)) return { missing: path.relative(root, wgslRoot) };
  const files = walkFiles(wgslRoot, [".wgsl"]);
  const violations = [];

  /** `@location(N)` set of the first `struct <name>` whose name matches `pattern`. */
  const structLocations = (text, pattern) => {
    const match = new RegExp(`struct\\s+([A-Za-z_]\\w*)\\s*\\{`, "g");
    let found;
    while ((found = match.exec(text)) !== null) {
      if (!pattern.test(found[1])) continue;
      const end = text.indexOf("}", found.index);
      const body = text.slice(found.index, end);
      return { name: found[1], locations: new Set([...body.matchAll(/@location\((\d+)\)/g)].map((m) => Number(m[1]))) };
    }
    return null;
  };

  /** The original heuristic, kept as the fallback for files whose structs are not named by convention. */
  const sliceLocations = (text, stage) => {
    const stageIndex = text.indexOf(`@${stage}`);
    const body = stageIndex < 0 ? "" : text.slice(stageIndex);
    return { name: `@${stage} section`, locations: new Set([...body.matchAll(/@location\((\d+)\)/g)].map((m) => Number(m[1]))) };
  };

  for (const file of files.filter((f) => /-vs\.wgsl$/.test(f))) {
    const fragment = file.replace(/-vs\.wgsl$/, "-fs.wgsl");
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (!exists(fragment)) {
      violations.push({ rule: "A10", file: relative, detail: "every vertex shader MUST have a paired fragment shader" });
      continue;
    }
    const vertexText = fs.readFileSync(file, "utf8");
    const fragmentText = fs.readFileSync(fragment, "utf8");
    const vsOutputs = structLocations(vertexText, /Out$/i) ?? sliceLocations(vertexText, "vertex");
    const fsInputs = structLocations(fragmentText, /In$/i) ?? sliceLocations(fragmentText, "fragment");
    const uncovered = [...fsInputs.locations].filter((location) => !vsOutputs.locations.has(location));
    if (uncovered.length > 0) {
      violations.push({
        rule: "A10",
        file: relative,
        detail:
          `fragment input location(s) ${uncovered.join(", ")} (read from \`${fsInputs.name}\`) have no matching vertex output ` +
          `(read from \`${vsOutputs.name}\`) — a WGSL varying mismatch is a hard pipeline failure`,
      });
    }
  }
  return { violations };
}

/** A11 — every shader leaf used by the acceptance path is mapped and verified on a real GPU. */
function ruleA11(root) {
  const mapPath = path.join(root, "packages", "cesium-webgpu", "backend-webgpu", "webgpu", "shader-leaf-map.json");
  if (!exists(mapPath)) return { missing: path.relative(root, mapPath) };
  const map = readJson(mapPath);
  const entries = Array.isArray(map) ? map : (map.leaves ?? []);
  const violations = [];
  if (entries.length === 0) {
    violations.push({ rule: "A11", file: "shader-leaf-map.json", detail: "the leaf map MUST not be empty" });
  }
  for (const entry of entries) {
    const hash = entry?.leafHash ?? entry?.hash;
    if (typeof hash !== "string" || hash.length === 0) {
      violations.push({ rule: "A11", file: "shader-leaf-map.json", detail: `entry ${JSON.stringify(entry)} MUST carry a leaf text hash` });
      continue;
    }
    if (typeof entry.wgslFile !== "string" || !exists(path.join(path.dirname(mapPath), entry.wgslFile))) {
      violations.push({ rule: "A11", file: "shader-leaf-map.json", detail: `entry ${hash} points at missing WGSL file "${entry.wgslFile}"` });
    }
    if (entry.verifiedOnRealGpu !== true) {
      violations.push({
        rule: "A11",
        file: "shader-leaf-map.json",
        detail: `entry ${hash} MUST set verifiedOnRealGpu === true for acceptance-path leaves (FR-011)`,
      });
    }
  }
  return { violations };
}

const RULES = {
  A1: { title: "public API surface stays backend agnostic", run: (root) => ruleA1(root) },
  A2: { title: "src/** does not import the concrete patch layer", run: (root) => ruleA2(root) },
  A3: { title: "manifest entries stay inside Renderer/**", run: (root) => ruleA3(root) },
  A4: { title: "alias whitelist is exhaustive", run: (root, options) => ruleA4(root, options) },
  A5: { title: "demo has no render-path branching", run: (root) => ruleA5(root) },
  A6: { title: "MVP scene configuration is pinned", run: (root) => ruleA6(root) },
  A7: { title: "one backend per verification run", run: (root) => ruleA7(root) },
  A8: { title: "capability consistency", run: (root) => ruleA8(root) },
  A9: { title: "logic-layer shader view stays GLSL", run: (root, options) => ruleA9(root, options) },
  A10: { title: "shader varyings pair up per variant", run: (root) => ruleA10(root) },
  A11: { title: "shader leaf map is complete and verified", run: (root) => ruleA11(root) },
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  let options;
  try {
    options = parseArgv(process.argv.slice(2));
  } catch (error) {
    console.error(`check-arch-boundaries: ${error.message}`);
    return 2;
  }

  const requested =
    options.rules === "all" || options.rules === "auto" ? RULE_IDS : options.rules.split(",").map((id) => id.trim()).filter(Boolean);
  const unknown = requested.filter((id) => !RULE_IDS.includes(id));
  if (unknown.length > 0) {
    console.error(`check-arch-boundaries: unknown rule(s) ${unknown.join(", ")}; known rules: ${RULE_IDS.join(", ")}`);
    return 2;
  }

  const results = [];
  let missingTargets = 0;
  for (const id of requested) {
    const { title, run } = RULES[id];
    let outcome;
    try {
      outcome = await run(options.root, options);
    } catch (error) {
      outcome = { violations: [{ rule: id, file: "-", detail: `rule execution failed: ${error.message}` }] };
    }
    if (outcome.missing) {
      const skip = options.rules === "auto";
      results.push({ rule: id, title, status: skip ? "skipped-missing-target" : "missing-target", target: outcome.missing, violations: [] });
      if (!skip) missingTargets += 1;
      continue;
    }
    const violations = outcome.violations ?? [];
    results.push({
      rule: id,
      title,
      status: violations.length > 0 ? "match" : "no-match",
      violations,
      ...(outcome.summary ? { summary: outcome.summary } : {}),
    });
  }

  const violationCount = results.reduce((total, result) => total + result.violations.length, 0);
  const verdict = violationCount === 0 && missingTargets === 0 ? "pass" : "fail";

  const report = {
    tool: "check-arch-boundaries",
    generatedAt: new Date().toISOString(),
    root: options.root,
    rulesRequested: requested,
    mode: options.rules === "all" ? "all" : options.rules,
    results,
    violationCount,
    missingTargets,
    verdict,
  };

  const outPath = options.out ? path.resolve(options.out) : path.join(options.root, "artifacts", "arch-boundaries.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  for (const result of results) {
    const detail = result.status === "missing-target" ? ` (missing target: ${result.target})` : "";
    console.log(`[${result.rule}] ${result.status}${detail}`);
    for (const violation of result.violations) {
      const where = violation.line ? `${violation.file}:${violation.line}` : violation.file;
      console.log(`    - ${where}: ${violation.detail}`);
    }
  }

  if (verdict === "pass") {
    console.log("no match");
    console.log(`arch-boundaries: ${results.length} rule(s) clean -> ${path.relative(options.root, outPath)}`);
    return 0;
  }
  if (missingTargets > 0) {
    console.error(`arch-boundaries: ${missingTargets} rule(s) could not run because their target does not exist yet`);
    return 2;
  }
  console.error(`arch-boundaries: ${violationCount} violation(s) -> ${path.relative(options.root, outPath)}`);
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`check-arch-boundaries: unexpected failure: ${error.stack ?? error}`);
    process.exitCode = 2;
  });
