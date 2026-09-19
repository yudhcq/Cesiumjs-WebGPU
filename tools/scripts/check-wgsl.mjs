#!/usr/bin/env node
/**
 * `tools/scripts/check-wgsl.mjs` — WGSL module validation for the GPU-free CI path (tasks.md **T080**,
 * the **SH-7** gate; contract `verification-and-benchmark.md` §4 SH-7 and §8, `fork-patch-layer.md` R8).
 *
 *   node tools/scripts/check-wgsl.mjs [--dir <outDir>] [--naga <path>] [--require-naga] [--no-naga-discovery] [--quiet]
 *
 * What it validates, in order:
 *
 *   1. **the emitted modules of the terrain MVP golden configuration** and of the **prewarm plan**
 *      (`webgpu/terrain-variants.ts` → `webgpu/bind-layout.ts` → `webgpu/wgsl-emitter.ts`), written to
 *      `--dir` (default `artifacts/wgsl-check/`). The emission is the **production** pipeline, assembled
 *      in-process through `tools/shader-model.mjs` (the same loader `tools/shader-verify.mjs` uses):
 *      the GLSL comes from the replacement `Renderer/ShaderSource.ts` exactly as
 *      `GlobeSurfaceShaderSet` assembles it, and the WGSL from the production emitter. The alternative
 *      — spawning `node -e` and reading its piped stdout — is a child-process capture that several
 *      sandboxes (and the Windows harness) refuse with `EPERM`. A failure to load or run the pipeline is
 *      a **hard failure**, never a skip: a check that silently validates nothing is worse than no check.
 *   2. **every complete `.wgsl` module** under `backend-webgpu/webgpu/wgsl/*.wgsl` (top level only).
 *      `wgsl/leaves/*.wgsl` and `wgsl-prelude/*.wgsl` are **templates**: they carry the GLSL
 *      conditional directives (`#if`/`#elif`/`#else`/`#endif`/`#ifdef`) that WGSL does not have and that
 *      `webgpu/glsl-preprocess.ts` resolves per variant (contract R4). They are never handed to naga
 *      directly; they are validated **in emitted form**, which is what step 1 does — and they are
 *      listed in the report so the distinction is visible rather than implied.
 *
 * Blind spot (contract §8, verbatim): `naga WGSL 校验不覆盖 WebGPU 管线校验` — varying pairing, bind
 * layout and format compatibility are only exposed by a real `createRenderPipeline` (the G-5 findings
 * F-1/F-3 are exactly that class of defect: a cross-stage missing function and an attribute stride
 * overflow, both invisible to a module-level parser). This tool is the *degraded* CI half; the
 * real-device half is `node tools/shader-verify.mjs --family=globe --variants=mvp` (T078/SH-2).
 *
 * No `naga` executable: the tool **prints the degradation notice naming every input it could not
 * check**, states the blind spot, and then — per T080 ("无 naga 可执行文件时 MUST 打印降级说明并在 CI
 * 配置下判定失败（MUST NOT 静默通过）") — exits **0** when `CI` is unset/false and **1** when `CI` is
 * truthy. `--require-naga` forces the strict path on a developer machine.
 *
 * Exit codes: 0 pass (or the documented degradation), 1 a validation failure or a failed degradation,
 * 2 the tool could not run (unknown argument, emission pipeline unavailable, unreadable input).
 *
 * Cross-platform: `spawnSync` with an argument array and `shell` pinned to `false`, no shell pipeline,
 * no platform-specific shell host, no absolute machine paths, and `ENOENT` is handled as a value
 * (not thrown).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const WEBGPU_DIR = path.join(REPO_ROOT, "packages", "cesium-webgpu", "backend-webgpu", "webgpu");

/** The template directories: GLSL conditional directives live here, so naga never sees these files. */
const TEMPLATE_DIRS = ["wgsl/leaves", "wgsl-prelude"];

/** The shader-model entry point (the same production assembly `tools/shader-verify.mjs` uses). */
const SHADER_MODEL = path.join(REPO_ROOT, "tools", "shader-model.mjs");

/**
 * The golden MVP selection (T022/T078): one texture unit, float attributes, day-night lighting, no
 * ground atmosphere, no fog, no dynamic atmosphere lighting, no ocean, no imagery operations, no
 * cartographic limit rectangle, no geodetic surface normals.
 *
 * `dynamicAtmosphereLighting: "none"` was added in W5: `Globe.dynamicAtmosphereLighting` defaults to
 * `true` (`Globe.js:185`), so the dimension is reachable in the default MVP scene and the golden
 * selection has to name a value for it. The golden module pair itself still covers the variant the
 * T078 gate recorded (see the `// Variant:` comment in `webgpu/wgsl/globe-vs.wgsl`).
 */
const GOLDEN_SELECTION = {
  textureUnits: "1",
  quantization: "float",
  lighting: "daynight",
  groundAtmosphere: "none",
  fog: "none",
  dynamicAtmosphereLighting: "none",
  ocean: "none",
  imageryOps: "none",
  tileLimitRectangle: "none",
  geodetic: "none",
};

/** The canonical dimension order of a selection id (`terrain-variants.ts:REACHABLE_DIMENSIONS`). */
const SELECTION_ORDER = ["textureUnits", "quantization", "lighting", "groundAtmosphere", "fog", "dynamicAtmosphereLighting", "ocean", "imageryOps", "tileLimitRectangle", "geodetic"];

/** The blind spot, quoted verbatim from `contracts/verification-and-benchmark.md` §8. */
export const BLIND_SPOT = "naga WGSL 校验不覆盖 WebGPU 管线校验";

// ------------------------------------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------------------------------------

export function parseArgv(argv) {
  const options = { dir: path.join(REPO_ROOT, "artifacts", "wgsl-check"), naga: null, requireNaga: false, discoverNaga: true, quiet: false, help: false };
  const takesValue = new Set(["--dir", "--naga"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(0, eq) : token;
    let value = eq >= 0 ? token.slice(eq + 1) : undefined;
    if (key === "--require-naga") {
      options.requireNaga = true;
      continue;
    }
    if (key === "--no-naga-discovery") {
      options.discoverNaga = false;
      continue;
    }
    if (key === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (key === "--help" || key === "-h") {
      options.help = true;
      continue;
    }
    if (!takesValue.has(key)) throw new Error(`unknown argument "${token}"`);
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined) throw new Error(`missing value for "${key}"`);
      index += 1;
    }
    if (key === "--dir") options.dir = path.resolve(value);
    else options.naga = value;
  }
  return options;
}

/** `true` for the values CI systems use for a set flag; an unset or empty variable is `false`. */
export function ciIsTruthy(value = process.env.CI) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no" && normalized !== "off";
}

// ------------------------------------------------------------------------------------------------
// naga discovery
// ------------------------------------------------------------------------------------------------

/**
 * Where a `naga` executable could be. Discovery is deliberately **explicit and overridable**
 * (`--naga`, `NAGA_PATH`, `--no-naga-discovery`): the degradation branch of T080 must be reachable on
 * a machine that happens to have naga installed somewhere, or the check could never be tested.
 */
export function nagaCandidates({ explicit = null, env = process.env, discover = true } = {}) {
  const candidates = [];
  if (typeof explicit === "string" && explicit.length > 0) candidates.push(explicit);
  if (typeof env.NAGA_PATH === "string" && env.NAGA_PATH.length > 0) candidates.push(env.NAGA_PATH);
  if (discover) {
    // PATH first: "no naga on PATH" is the condition T080 talks about, so a PATH hit is a real hit.
    candidates.push("naga");
    const home = safeHomedir();
    const cargoHome = typeof env.CARGO_HOME === "string" && env.CARGO_HOME.length > 0 ? env.CARGO_HOME : home === null ? null : path.join(home, ".cargo");
    if (cargoHome !== null) {
      // `cargo install naga-cli` (contract R8 pins 30.0.1) puts the binary here on every platform.
      candidates.push(path.join(cargoHome, "bin", process.platform === "win32" ? "naga.exe" : "naga"));
    }
  }
  return [...new Set(candidates)];
}

function safeHomedir() {
  try {
    return os.homedir();
  } catch {
    return null;
  }
}

/**
 * Resolve the executable to run, or report why not.
 *
 * @returns {{ok: boolean, command: string|null, detail: string}}
 */
export function resolveNaga(options) {
  const candidates = nagaCandidates(options);
  const tried = [];
  for (const candidate of candidates) {
    // Only a candidate that looks like a path is checked on disk; a bare "naga" is left to PATH
    // resolution by spawnSync (checking `existsSync("naga")` would always be false and would make the
    // degradation branch fire even on a machine where naga IS on PATH).
    const isPath = candidate.includes("/") || candidate.includes("\\") || path.isAbsolute(candidate);
    if (isPath && !fs.existsSync(candidate)) {
      tried.push(`${candidate} (not found)`);
      continue;
    }
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", shell: false, windowsHide: true });
    if (probe.error !== undefined && probe.error !== null) {
      tried.push(`${candidate} (${probe.error.code ?? probe.error.message})`);
      continue;
    }
    const version = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim().split(/\r?\n/)[0] ?? "";
    if (probe.status === 0 || version.length > 0) return { ok: true, command: candidate, detail: version || "(no version output)" };
    tried.push(`${candidate} (exit ${probe.status})`);
  }
  return { ok: false, command: null, detail: tried.length === 0 ? "no candidate was tried" : tried.join(", ") };
}

// ------------------------------------------------------------------------------------------------
// inputs
// ------------------------------------------------------------------------------------------------

function walkFiles(tree, out = []) {
  if (!fs.existsSync(tree)) return out;
  for (const entry of fs.readdirSync(tree, { withFileTypes: true })) {
    const child = path.join(tree, entry.name);
    if (entry.isDirectory()) walkFiles(child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

const repoRelative = (absolute) => path.relative(REPO_ROOT, absolute).split(path.sep).join("/");

/** The complete, standalone `.wgsl` modules at the top level of `webgpu/wgsl/` (never the templates). */
export function completeModules() {
  const root = path.join(WEBGPU_DIR, "wgsl");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".wgsl"))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

/** Every `.wgsl` file the tool deliberately does **not** hand to naga, with the reason. */
export function templateFiles() {
  return TEMPLATE_DIRS.flatMap((relative) =>
    walkFiles(path.join(WEBGPU_DIR, ...relative.split("/")))
      .filter((file) => file.endsWith(".wgsl"))
      .map((file) => repoRelative(file)),
  ).sort();
}

/** A filesystem-safe identifier from a variant id (the id itself is far too long for a filename). */
function slug(id) {
  const readable = id
    .split("|")
    .map((part) => part.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, ""))
    .join("_");
  return readable.length <= 120 ? readable : `${readable.slice(0, 96)}_${readable.length}`;
}

// ------------------------------------------------------------------------------------------------
// emission (the production pipeline, assembled in-process)
// ------------------------------------------------------------------------------------------------

/**
 * Emit the modules to validate.
 *
 * The emission runs the **production** pipeline through `tools/shader-model.mjs`
 * (`buildProductionModel`): the GLSL is assembled by the replacement `Renderer/ShaderSource.ts` with
 * the same upstream collaborators the build resolves, the varying contract is derived from that real
 * GLSL (including the `PER_FRAGMENT_GROUND_ATMOSPHERE` **per-vertex witness**, because that dimension is
 * a pipeline-overridable constant the module must satisfy for both of its values), and the WGSL comes
 * from `webgpu/wgsl-emitter.ts`. Re-deriving any of that here would make the check validate a shader
 * nobody ships; the `czm_` inlining-before-conditionals ordering (contract R4) and the two
 * runtime-generated sources (`computeDayColor`, `getPosition`) are exactly the parts that are easy to
 * get subtly wrong.
 *
 * Two failure classes, deliberately separated, because they mean different things:
 *   - `{ok: false, fatal: true}` — the pipeline could **not be loaded or run**: the tool could not run
 *     at all, exit 2;
 *   - `{ok: false, fatal: false}` — the pipeline ran and **refused** a variant: a validation failure of
 *     the shader front end, exit 1. Never a skip.
 *
 * @returns {Promise<{ok: boolean, fatal?: boolean, reason?: string, modules: object[], templates: string[], golden: object|null}>}
 */
export async function emitModules({ outDir, quiet = false } = {}) {
  const log = (line) => {
    if (!quiet) process.stdout.write(`[check-wgsl] ${line}\n`);
  };
  let model;
  try {
    model = await import(pathToFileURL(SHADER_MODEL).href);
  } catch (error) {
    return { ok: false, fatal: true, reason: `the production shader model could not be imported (${repoRelative(SHADER_MODEL)}): ${error?.stack ?? error}`, modules: [], templates: templateFiles(), golden: null };
  }

  let runtime;
  let production;
  let base;
  let automaticUniforms;
  try {
    production = await model.loadProduction();
    base = await model.baseSources();
    automaticUniforms = await model.automaticUniformNames();
    runtime = { production, base, automaticUniforms };
  } catch (error) {
    return { ok: false, fatal: true, reason: `the production emission pipeline could not be loaded (this is a hard failure, never a skip): ${error?.stack ?? error}`, modules: [], templates: templateFiles(), golden: null };
  }

  const goldenId = SELECTION_ORDER.map((id) => `${id}=${GOLDEN_SELECTION[id]}`).join("|");
  const reachable = production.variants.enumerateReachableVariants();
  const golden = reachable.find((variant) => variant.id === goldenId);
  if (golden === undefined) {
    return { ok: false, fatal: true, reason: `the golden selection "${goldenId}" is not an MVP-reachable variant of terrain-variants.ts`, modules: [], templates: templateFiles(), golden: null };
  }
  const plan = production.variants.prewarmPlan();
  const wanted = [golden, ...plan.planned];

  let emitted;
  try {
    emitted = await model.buildProductionModel({ variants: wanted, keepWgsl: true, runtime });
  } catch (error) {
    return { ok: false, fatal: true, reason: `the production emission pipeline failed on the golden/prewarm variant set: ${error?.stack ?? error}`, modules: [], templates: templateFiles(), golden };
  }

  const refused = emitted.entries.filter((entry) => entry.emission.ok !== true);
  if (refused.length > 0) {
    const detail = refused
      .slice(0, 5)
      .map((entry) => `${entry.variant.id}: ${entry.emission.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`)
      .join(" | ");
    return { ok: false, fatal: false, reason: `the production emitter refused ${refused.length} of ${wanted.length} golden/prewarm variant(s): ${detail}`, modules: [], templates: templateFiles(), golden };
  }

  const modules = [];
  const byHash = new Set();
  for (const entry of emitted.entries) {
    for (const [stage, text] of [
      ["vs", entry.emission.vertexWgsl],
      ["fs", entry.emission.fragmentWgsl],
    ]) {
      if (typeof text !== "string" || text.length === 0 || byHash.has(`${stage}:${text}`)) continue;
      byHash.add(`${stage}:${text}`);
      modules.push({ id: `${slug(entry.variant.id)}-${stage}`, variant: entry.variant.id, stage, wgsl: text });
    }
  }
  if (modules.length === 0) {
    return { ok: false, fatal: false, reason: "the production pipeline produced no module at all — there would be nothing to validate", modules: [], templates: templateFiles(), golden };
  }

  try {
    fs.mkdirSync(outDir, { recursive: true });
    const written = [];
    for (const module_ of modules) {
      const file = path.join(outDir, `${module_.id}.wgsl`);
      fs.writeFileSync(file, module_.wgsl, "utf8");
      written.push({ ...module_, file });
    }
    fs.writeFileSync(
      path.join(outDir, "index.json"),
      `${JSON.stringify(
        {
          tool: "tools/scripts/check-wgsl.mjs",
          recordedAt: new Date().toISOString(),
          goldenVariant: golden.id,
          prewarmSize: plan.size,
          prewarmConfiguration: plan.configuration,
          emittedVariants: wanted.length,
          distinctModules: written.length,
          layoutSource: emitted.layoutSource,
          uniformMembers: emitted.layout.uniformBlock.fields.length,
          samplerBindings: emitted.layout.samplers.length,
          modules: written.map((module_) => ({ id: module_.id, variant: module_.variant, stage: module_.stage, file: repoRelative(module_.file), bytes: module_.wgsl.length })),
          templates: templateFiles(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    log(`emitted ${written.length} distinct module(s) from ${wanted.length} variant(s) (golden + prewarm plan of ${plan.size}) into ${repoRelative(outDir)} [layout: ${emitted.layoutSource}]`);
    return { ok: true, modules: written, templates: templateFiles(), golden, layout: emitted.layout };
  } catch (error) {
    return { ok: false, fatal: true, reason: `the emitted modules could not be written to ${repoRelative(outDir)}: ${error?.message ?? error}`, modules: [], templates: templateFiles(), golden };
  }
}

// ------------------------------------------------------------------------------------------------
// validation
// ------------------------------------------------------------------------------------------------

/** Run `naga --input-kind wgsl <file>`; returns a normalised result (ENOENT is a value, not a throw). */
export function runNaga(command, file) {
  const result = spawnSync(command, ["--input-kind", "wgsl", file], { encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, status: null, error: result.error.code ?? result.error.message, stdout, stderr };
  }
  return { ok: result.status === 0, status: result.status, error: null, stdout, stderr };
}

// ------------------------------------------------------------------------------------------------
// main
// ------------------------------------------------------------------------------------------------

export async function runCheckWgsl(argv = process.argv.slice(2), env = process.env) {
  const lines = [];
  const write = (line) => {
    lines.push(line);
    process.stdout.write(`${line}\n`);
  };
  const fail = (line) => {
    lines.push(line);
    process.stderr.write(`${line}\n`);
  };

  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    fail(`check-wgsl: ${error.message}`);
    return { code: 2, lines };
  }
  if (options.help) {
    write("usage: node tools/scripts/check-wgsl.mjs [--dir <outDir>] [--naga <path>] [--require-naga] [--no-naga-discovery] [--quiet]");
    return { code: 0, lines };
  }

  const templates = templateFiles();
  const complete = completeModules();
  const naga = resolveNaga({ explicit: options.naga, env, discover: options.discoverNaga });
  const strict = options.requireNaga || ciIsTruthy(env.CI);

  const emission = await emitModules({ outDir: options.dir, quiet: options.quiet });
  if (!emission.ok && emission.fatal === true) {
    fail(`check-wgsl: ${emission.reason}`);
    fail("check-wgsl: exit 2 — the tool could not run; a skipped validation MUST NOT look like a pass (T080)");
    return { code: 2, lines, emission };
  }
  if (!emission.ok) {
    fail(`check-wgsl: ${emission.reason}`);
    fail("check-wgsl: exit 1 — the shader front end could not produce the modules to validate; nothing was skipped silently (T080)");
    return { code: 1, lines, emission };
  }

  const inputs = [...complete, ...emission.modules.map((module_) => module_.file)];
  write(`check-wgsl: ${complete.length} complete module(s) under webgpu/wgsl/*.wgsl + ${emission.modules.length} emitted module(s) (golden MVP configuration + prewarm plan) = ${inputs.length} input(s)`);
  write(`check-wgsl: ${templates.length} template file(s) validated in emitted form (GLSL #if/#ifdef directives, resolved per variant by webgpu/glsl-preprocess.ts): ${templates.join(", ")}`);

  if (!naga.ok) {
    // T080: no naga ⇒ print the degradation notice naming the inputs, state the blind spot, and fail
    // under CI. Nothing here is allowed to be silent.
    write(`check-wgsl: DEGRADED — no naga executable was found (${naga.detail}); NO WGSL module was validated on this run.`);
    if (options.naga !== null) write(`check-wgsl:   --naga ${options.naga} was given but did not run`);
    write("check-wgsl:   inputs that could NOT be checked:");
    for (const input of inputs) write(`check-wgsl:     - ${repoRelative(path.resolve(input))}`);
    write(`check-wgsl:   blind spot (contracts/verification-and-benchmark.md §8, verbatim): ${BLIND_SPOT}`);
    write("check-wgsl:   the real-device half is `node tools/shader-verify.mjs --family=globe --variants=mvp` (T078/SH-2)");
    if (strict) {
      fail(`check-wgsl: CI is configured (CI=${env.CI ?? "(unset)"}${options.requireNaga ? ", --require-naga" : ""}) — a degradation MUST fail rather than pass silently (T080, SH-7)`);
      return { code: 1, lines, degraded: true, emission };
    }
    write("check-wgsl: CI is not configured — degradation is reported, not treated as a failure (exit 0)");
    return { code: 0, lines, degraded: true, emission };
  }

  write(`check-wgsl: naga ${naga.detail} (${naga.command})`);
  const failures = [];
  for (const input of inputs) {
    const result = runNaga(naga.command, input);
    const relative = repoRelative(path.resolve(input));
    if (result.ok) {
      write(`check-wgsl:   ok   ${relative}`);
      continue;
    }
    failures.push({ file: relative, ...result });
    fail(`check-wgsl:   FAIL ${relative} (exit ${result.status ?? `error ${result.error}`})`);
    for (const line of `${result.stdout}${result.stderr}`.split(/\r?\n/).filter((entry) => entry.trim().length > 0).slice(0, 12)) fail(`check-wgsl:        ${line}`);
  }
  if (failures.length > 0) {
    fail(`check-wgsl: ${failures.length}/${inputs.length} module(s) failed naga validation`);
    return { code: 1, lines, failures, emission };
  }
  write(`check-wgsl: ${inputs.length}/${inputs.length} module(s) passed \`naga --input-kind wgsl\`; blind spot (contract §8): ${BLIND_SPOT}`);
  return { code: 0, lines, emission };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCheckWgsl()
    .then((result) => {
      process.exitCode = result.code;
    })
    .catch((error) => {
      process.stderr.write(`check-wgsl: unexpected failure: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    });
}
