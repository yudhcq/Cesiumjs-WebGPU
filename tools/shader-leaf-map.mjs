#!/usr/bin/env node
/**
 * `tools/shader-leaf-map.mjs` — the **upgrade drift detector** of the terrain WGSL leaf library
 * (tasks.md **T070**, the SH-3 gate; contract fork-patch-layer §5 rules **R3** and **R7**;
 * data-model §11 rule **A11**).
 *
 *   node tools/shader-leaf-map.mjs --update [--out <file>] [--report <file>]
 *   node tools/shader-leaf-map.mjs --check  [--map <file>] [--report <file>]
 *
 * Why the map exists (R3): the WGSL the terrain path renders with lives **in the backend layer**
 * (`backend-webgpu/webgpu/wgsl/**`, `backend-webgpu/webgpu/wgsl-prelude/**`) and the upstream
 * `Source/Shaders/**` tree is never modified or written to. That leaves one question a reader (and
 * the architecture scanner) has to be able to answer mechanically: *which upstream leaf does this
 * WGSL file correspond to, and is it still the leaf it was translated from?* The map is that answer —
 * it pairs the **hash of the upstream GLSL text** with the WGSL file, so a silent upstream upgrade
 * cannot leave a stale port behind (R7).
 *
 * Why the hash is over the leaf *text* and not the `.js` file (R7, tasks.md T070): upstream ships
 * each shader as a module whose default export is the GLSL string (`Source/Shaders/GlobeVS.js`).
 * Hashing the module file would also trip on formatting, copyright years and re-exports; hashing the
 * GLSL text is what "the leaf changed" actually means for a port.
 *
 * Why both `upstreamLeafHash` **and** `wgslFileHash`: the first catches an upstream upgrade, the
 * second catches a hand edit of the `.wgsl` file (which the generators would otherwise only notice in
 * `generated-library.ts`). `--check` fails on either, and prints, per drifted entry, the line the task
 * asks for: the leaf **must be re-converted**.
 *
 * `verifiedOnRealGpu` is *evidence-gated on purpose*. It is `true` only for a leaf whose emitted WGSL
 * the real-device harness actually validated (T078 / SH-2); the tool recomputes it from
 * `artifacts/shader-verify/*.json` when a `verdict === "pass"` is present, records the evidence it
 * found, and writes `false` (saying so, loudly) otherwise. A map that claimed `true` without that
 * evidence would turn rule A11 — the one gate whose whole subject is "was this really verified on a
 * GPU" — into a rubber stamp.
 *
 * Zero dependencies, Node-only, cross-platform, no shell, no absolute machine paths.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// This tool lives in `tools/`, not `tools/scripts/` — so the repository root is one level up.
export const REPO_ROOT = path.resolve(HERE, "..");

/** The map path rule A11 reads (fixed by the architecture scanner; `--map` overrides it for tests). */
export const DEFAULT_MAP_PATH = path.join(REPO_ROOT, "packages", "cesium-webgpu", "backend-webgpu", "webgpu", "shader-leaf-map.json");

/** Where the real-device harness writes its reports (T078 / G-5). */
export const HARNESS_REPORT_FILES = ["artifacts/shader-verify/globe-mvp.json", "artifacts/shader-verify/globe-all-reachable.json"];

const UPSTREAM_SHADERS = "node_modules/@cesium/engine/Source/Shaders";

/**
 * One row of the map's declaration table: which WGSL file the backend layer ships, which upstream
 * GLSL source(s) it was translated from, and how it was produced.
 *
 * `upstreamLeaves` is a **list** because the port is not always 1:1: the `czm_` prelude is a port of
 * the `Source/Shaders/Builtin/**` tree (every `.glsl` under it — the aggregate hash is what drifts),
 * and `GlobeFS` + `AtmosphereCommon` share one helper leaf. A `glob` entry is expanded against the
 * installed tree; a `literal` entry is a single repo-relative file.
 */
const LEAF_TABLE = [
  {
    name: "czm-prelude.wgsl",
    upstream: { kind: "glob", dir: `${UPSTREAM_SHADERS}/Builtin`, extensions: [".glsl", ".js"], exclude: ["CzmBuiltins"], read: "text" },
    upstreamLeaf: `${UPSTREAM_SHADERS}/Builtin/**/*.{glsl,js}`,
    wgslFile: "wgsl-prelude/czm-prelude.wgsl",
    notes:
      "The terrain `czm_` prelude (T068): the ~40 built-ins the terrain closure references, ported from the " +
      "upstream `Source/Shaders/Builtin/**` tree, plus the two backend-layer depth-range helpers " +
      "`czms_remapClipDepth`/`czms_unprojectDepth` (T074), which have no upstream leaf and are registered as " +
      "such in `wgsl-prelude/catalog.json`. The upstream hash is the aggregate over every installed " +
      "`Builtin/{Constants,Functions,Structs}/**/*.{glsl,js}` leaf (`Builtin` itself is no `czm_` leaf — it is " +
      "the *set* of leaves the prelude ports, so the set's aggregate is what drifts; the aggregator module " +
      "`Builtin/CzmBuiltins.js` is not a leaf and is excluded).",
  },
  {
    name: "GlobeVS",
    upstream: { kind: "literal", file: `${UPSTREAM_SHADERS}/GlobeVS.js` },
    upstreamLeaf: `${UPSTREAM_SHADERS}/GlobeVS.js`,
    wgslFile: "wgsl/leaves/globe-vertex.wgsl",
    notes:
      "Terrain vertex leaf: the whole `GlobeVS` closure (attribute decoding, RTC/2D/Columbus position assembly, " +
      "day-night and fog varyings) plus the runtime-pushed `getPosition`/`get2DYPositionFraction` pair that " +
      "upstream generates in `Scene/GlobeSurfaceShaderSet.js:474-475,529-568` (T071 mirror).",
  },
  {
    name: "GlobeFS+AtmosphereCommon",
    upstream: { kind: "literals", files: [`${UPSTREAM_SHADERS}/GlobeFS.js`, `${UPSTREAM_SHADERS}/AtmosphereCommon.js`] },
    upstreamLeaf: `${UPSTREAM_SHADERS}/GlobeFS.js`,
    wgslFile: "wgsl/leaves/globe-fragment-library.wgsl",
    notes:
      "Fragment helper leaf shared by both fragment-side families: `GlobeFS`'s imagery blend chain " +
      "(`sampleAndBlend`, `computeEllipsoidPosition`, water colour) together with `AtmosphereCommon`'s " +
      "distance fades. The upstream hash is the aggregate over both leaf texts, so a change to either one " +
      "drifts the row.",
  },
  {
    name: "GlobeFS",
    upstream: { kind: "literal", file: `${UPSTREAM_SHADERS}/GlobeFS.js` },
    upstreamLeaf: `${UPSTREAM_SHADERS}/GlobeFS.js`,
    wgslFile: "wgsl/leaves/globe-fragment-main.wgsl",
    notes:
      "Terrain fragment entry-point leaf: `GlobeFS`'s `main()` (imagery blend loop, day-night shading, fog, " +
      "`czm_out_FragColor`). The runtime-generated `computeDayColor()` it calls is mirrored by " +
      "`webgpu/generated-fragments.ts` (T071), not by this file.",
  },
  {
    name: "GroundAtmosphere",
    upstream: { kind: "literal", file: `${UPSTREAM_SHADERS}/GroundAtmosphere.js` },
    upstreamLeaf: `${UPSTREAM_SHADERS}/GroundAtmosphere.js`,
    wgslFile: "wgsl-prelude/czm-prelude.wgsl",
    notes:
      "Ground-atmosphere leaf. It is **not** a separate WGSL file: G-5 finding F-1 proved the scattering " +
      "helpers must be callable from *both* stages (`GlobeVS` calls `computeAtmosphereScattering` under " +
      "`GROUND_ATMOSPHERE && !PER_FRAGMENT_GROUND_ATMOSPHERE`), so they live in the shared prelude. The row is " +
      "kept so the family is mapped even though its WGSL home is shared — the architecture rule A11 reads every " +
      "row's `wgslFile`, and an unmapped family would be invisible to the drift check.",
  },
];

/** `sha256-<hex>` — the encoding `webgpu/wgsl/index.ts:leafTextHash` uses for `leafHash`. */
export function sha256(text) {
  return `sha256-${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function repoRelative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

function toAbsolute(root, relative) {
  return path.join(root, ...relative.split("/"));
}

function walk(tree, extension, out = []) {
  if (!fs.existsSync(tree)) return out;
  for (const entry of fs.readdirSync(tree, { withFileTypes: true })) {
    const child = path.join(tree, entry.name);
    if (entry.isDirectory()) walk(child, extension, out);
    else if (entry.isFile() && child.endsWith(extension)) out.push(child);
  }
  return out;
}

/**
 * The upstream GLSL text of one leaf, read the way the installed tree carries it.
 *
 * Two shapes exist upstream and the map records which one each row was hashed from:
 *
 *   - `module` — upstream's shader modules default-export the GLSL string (`Source/Shaders/GlobeVS.js`).
 *     The **text** is what R7 tracks; the module file's own bytes would also trip on formatting and
 *     re-exports. (`read: "module"`)
 *   - `text` — the `Source/Shaders/Builtin/**` leaves are stored as a raw `.glsl` file plus a wrapper
 *     `.js` whose default export is the same text as an escaped string literal; Node cannot import a
 *     raw `.glsl` and the wrapper modules of the tree are not all importable (the `Builtin/CzmBuiltins.js`
 *     aggregator has a different shape). Those leaves are hashed from the file's bytes, which is the leaf
 *     text as the installed tree carries it. (`read: "text"`)
 */
export async function readUpstreamLeafText(root, relative, read = "module") {
  const absolute = toAbsolute(root, relative);
  if (!fs.existsSync(absolute)) throw new Error(`upstream leaf not found: ${relative} (the installed @cesium/engine tree is the baseline)`);
  if (read === "text" || !absolute.endsWith(".js")) {
    const text = fs.readFileSync(absolute, "utf8");
    if (text.length === 0) throw new Error(`upstream leaf ${relative} is empty — R7 lost its subject`);
    return text;
  }
  const module_ = await import(pathToFileURL(absolute).href);
  const text = module_?.default;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error(`upstream leaf ${relative} does not default-export a GLSL string (the leaf-text convention changed — R7 lost its subject)`);
  }
  return text;
}

/** Expand a declaration to the sorted repo-relative list of upstream leaves it covers. */
export function resolveUpstreamLeaves(upstream, root = REPO_ROOT) {
  if (upstream.kind === "literal") return [upstream.file];
  if (upstream.kind === "literals") return [...upstream.files].sort();
  const dir = toAbsolute(root, upstream.dir);
  const extensions = upstream.extensions ?? [upstream.extension];
  const excluded = new Set(upstream.exclude ?? []);
  const found = new Map();
  for (const extension of extensions) {
    for (const file of walk(dir, extension)) {
      const key = file.slice(0, file.length - extension.length);
      if (excluded.has(path.basename(key))) continue;
      // A leaf that exists as a raw `.glsl` **and** as a wrapper `.js` is one leaf: the first
      // extension in the list wins, so the aggregate cannot double-count it.
      if (!found.has(key)) found.set(key, file);
    }
  }
  const files = [...found.values()].map((file) => repoRelative(file)).sort();
  if (files.length === 0) throw new Error(`no ${extensions.join("/")} file under ${upstream.dir} — the glob's subject disappeared`);
  return files;
}

/**
 * The aggregate hash of a list of upstream leaves.
 *
 * For a single leaf this **is** the hash of its GLSL text (what tasks.md T070 specifies). For a row
 * that ports several leaves it is the hash of the domain-separated concatenation of every
 * `<path>\0<text>` pair in sorted-path order, so it is stable across machines and platforms and no
 * two different leaf sets can collide by re-ordering text.
 */
export async function hashUpstreamLeaves(root, leaves, read = "module") {
  if (leaves.length === 1) return sha256(await readUpstreamLeafText(root, leaves[0], read));
  const parts = [];
  for (const leaf of leaves) parts.push(`${leaf}\u0000${await readUpstreamLeafText(root, leaf, read)}`);
  return sha256(parts.join("\u0001"));
}

/** Everything the map records about one WGSL file, recomputed from the installed trees. */
async function buildEntry(declaration, root) {
  const read = declaration.upstream.read ?? "module";
  const leaves = resolveUpstreamLeaves(declaration.upstream, root);
  const wgslAbsolute = toAbsolute(root, `packages/cesium-webgpu/backend-webgpu/webgpu/${declaration.wgslFile}`);
  if (!fs.existsSync(wgslAbsolute)) throw new Error(`the WGSL library file ${declaration.wgslFile} does not exist — the map cannot point at nothing (A11)`);
  const upstreamLeafHash = await hashUpstreamLeaves(root, leaves, read);
  return {
    name: declaration.name,
    upstreamLeaf: declaration.upstreamLeaf,
    upstreamLeaves: leaves,
    upstreamLeafHash,
    // Rule A11 reads `leafHash` (or `hash`); it is the same value as `upstreamLeafHash`, spelled with
    // the name the architecture scanner and `webgpu/wgsl/index.ts:leafTextHash` use.
    leafHash: upstreamLeafHash,
    wgslFile: declaration.wgslFile,
    wgslFileHash: sha256(fs.readFileSync(wgslAbsolute, "utf8")),
    convertedBy: "path-a-draft+path-b-final",
    verifiedOnRealGpu: false,
    notes: declaration.notes,
  };
}

/**
 * Read the real-device harness reports and decide what they are evidence *for*.
 *
 * `verifiedOnRealGpu: true` is a claim that the emitted WGSL of the production library went through
 * `createRenderPipeline` on a hardware adapter. The reports this tool can read are produced by
 * `tools/shader-verify.mjs`, which today emits through the **spike-side** seam
 * (`experiments/gates/g5-shader/wgsl-emitter.mjs`); no report names
 * `backend-webgpu/webgpu/wgsl-emitter.ts`. Until one does, a `verdict === "pass"` is recorded as
 * *evidence found* (`productionEmitter: false`) and **not** as a device verdict on this library —
 * claiming otherwise would be exactly the "true without evidence" the task forbids.
 */
export function collectDeviceEvidence(root = REPO_ROOT) {
  const examined = [];
  for (const relative of HARNESS_REPORT_FILES) {
    const absolute = toAbsolute(root, relative);
    if (!fs.existsSync(absolute)) {
      examined.push({ path: relative, exists: false, verdict: null, recordedAt: null, productionEmitter: false });
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
    } catch (error) {
      examined.push({ path: relative, exists: true, verdict: null, recordedAt: null, productionEmitter: false, parseError: String(error.message ?? error) });
      continue;
    }
    const text = JSON.stringify(parsed);
    examined.push({
      path: relative,
      exists: true,
      verdict: typeof parsed.verdict === "string" ? parsed.verdict : null,
      recordedAt: typeof parsed.recordedAt === "string" ? parsed.recordedAt : null,
      // Does the report claim to have validated the *production* emitter's output? (It must say so in
      // its own text — an inference from "a report exists" would be an assumption, not evidence.)
      productionEmitter: text.includes("backend-webgpu/webgpu/wgsl-emitter.ts") || text.includes("webgpu/wgsl-emitter.js"),
    });
  }
  const passing = examined.filter((entry) => entry.verdict === "pass");
  const forProductionLibrary = passing.filter((entry) => entry.productionEmitter === true);
  return {
    reportsExamined: examined,
    passingReports: passing.map((entry) => entry.path),
    /** `true` only when a passing report names the production emitter. */
    verifiedOnRealGpu: forProductionLibrary.length > 0,
    evidenceForProductionLibrary: forProductionLibrary.map((entry) => entry.path),
  };
}

/** The record written to `shader-leaf-map.json` (schemaVersion 1, `{ leaves: [...] }`, rule A11). */
export async function buildLeafMap({ root = REPO_ROOT } = {}) {
  const device = collectDeviceEvidence(root);
  const leaves = [];
  for (const declaration of LEAF_TABLE) {
    const entry = await buildEntry(declaration, root);
    entry.verifiedOnRealGpu = device.verifiedOnRealGpu === true;
    leaves.push(entry);
  }
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    note:
      "shader-leaf-map.json — the R3/R7 association between the upstream GLSL leaf texts the terrain shader " +
      "closure was translated from and the WGSL files this backend layer ships. R3: the WGSL library lives in " +
      "backend-webgpu/webgpu/wgsl/** and backend-webgpu/webgpu/wgsl-prelude/**, `Source/Shaders/**` is never " +
      "written to, and this map is the *only* carrier of the association between the two. R7: when an upstream " +
      "leaf's GLSL text changes, the recorded `upstreamLeafHash` stops matching and CI fails with a " +
      '"must be re-converted" list — an upstream upgrade cannot leave a stale port behind unnoticed. ' +
      "`wgslFileHash` additionally catches a hand edit of a ported `.wgsl` file. `verifiedOnRealGpu` is " +
      "evidence-gated: it is true only for a leaf whose emitted WGSL the real-device pipeline harness " +
      "(tools/shader-verify.mjs, T078/SH-2) actually validated on a hardware adapter, and false — with the " +
      "reason spelled out in `deviceEvidence` — otherwise. Regenerate with `node tools/shader-leaf-map.mjs --update`.",
    deviceEvidence: {
      policy:
        "verifiedOnRealGpu === true requires a harness report under artifacts/shader-verify/ whose verdict is " +
        '"pass" AND whose own text names the production emitter (backend-webgpu/webgpu/wgsl-emitter.ts). ' +
        "A passing report from another emitter is recorded under `passingReports` but does not set the field.",
      reportsExamined: device.reportsExamined,
      passingReports: device.passingReports,
      evidenceForProductionLibrary: device.evidenceForProductionLibrary,
      verdict: device.verifiedOnRealGpu,
      verdictReason: device.verifiedOnRealGpu
        ? `a passing report names the production emitter: ${device.evidenceForProductionLibrary.join(", ")} (its own notes record the configuration it rendered — the golden MVP selection; the prewarm-plan variants outside it are covered by the naga module check (SH-7), not by this report)`
        : "no harness report names the production emitter (backend-webgpu/webgpu/wgsl-emitter.ts): the reports " +
          `under artifacts/shader-verify/ (${device.passingReports.join(", ") || "none passing"}) were produced by the ` +
          "spike-side seam (experiments/gates/g5-shader/wgsl-emitter.mjs). The production library has therefore NOT " +
          "been verified on a real device yet — run `node tools/shader-verify.mjs --family=globe --variants=mvp` " +
          "(T078) and re-run `--update`.",
      // The production seam's own guard is recorded here so a reader can see the subject did not vanish.
      productionEmitterFiles: ["packages/cesium-webgpu/backend-webgpu/webgpu/wgsl-emitter.ts"],
    },
    leaves,
  };
}

/** Stable serialisation: the file `--update` writes and `--check` compares against. */
export function renderLeafMap(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * The `--check` verdict: compares the map on disk with what the installed trees say, and reports every
 * entry that must be re-converted.
 *
 * Two different things are compared, and both matter:
 *   - **per entry** — its own `upstreamLeafHash` and `wgslFileHash` against what is installed on disk.
 *     Rows legitimately share a WGSL file (`czm-prelude.wgsl` carries both the `Builtin/**` set and the
 *     `GroundAtmosphere` leaf), so the tool's declaration is resolved **per entry**, never by file;
 *   - **per declaration** — every WGSL library file the emitter consumes MUST appear in the map
 *     (a missing row is `missing-map-entry`, not a silent pass), and rule A11's three conditions are
 *     re-asserted here so a `--check` failure names them directly instead of only through the scanner.
 *
 * @returns {{ok: boolean, map: object, entries: object[], drifted: object[], missing: string|null, device: object, acceptance: object}}
 */
export async function checkLeafMap({ mapPath = DEFAULT_MAP_PATH, root = REPO_ROOT } = {}) {
  if (!fs.existsSync(mapPath)) {
    // A missing map is a failure, never a silent pass (the SH-3 gate would otherwise be vacuous).
    return { ok: false, missing: repoRelative(mapPath), map: null, entries: [], drifted: [], device: null, acceptance: null };
  }
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const entries = Array.isArray(map) ? map : (map.leaves ?? []);
  const drifted = [];
  const claimed = new Set();

  for (const entry of entries) {
    const wgslFile = typeof entry?.wgslFile === "string" ? entry.wgslFile : "";
    const name = entry?.name ?? entry?.upstreamLeaf ?? wgslFile ?? "(unnamed entry)";
    const resolved = LEAF_TABLE.find((candidate) => candidate.name === entry?.name);
    if (resolved === undefined) {
      drifted.push({ name, wgslFile, reason: "unmapped-entry", detail: `${name} is in the map but the tool's declaration table does not claim it (R3: every ported WGSL file is mapped)` });
      continue;
    }
    claimed.add(resolved.wgslFile);
    const recomputed = await buildEntry(resolved, root);
    if (entry.upstreamLeafHash !== recomputed.upstreamLeafHash) {
      drifted.push({
        name,
        wgslFile,
        reason: "upstream-leaf-hash-drift",
        recorded: entry.upstreamLeafHash ?? null,
        expected: recomputed.upstreamLeafHash,
        upstreamLeaves: recomputed.upstreamLeaves,
      });
    }
    if (entry.wgslFileHash !== recomputed.wgslFileHash) {
      drifted.push({ name, wgslFile, reason: "wgsl-file-hash-drift", recorded: entry.wgslFileHash ?? null, expected: recomputed.wgslFileHash });
    }
    // A11's three conditions, re-asserted so a failure names them directly.
    const hash = entry.leafHash ?? entry.hash ?? entry.upstreamLeafHash;
    if (typeof hash !== "string" || hash.length === 0) drifted.push({ name, wgslFile, reason: "missing-leaf-hash", detail: "rule A11: every entry MUST carry a non-empty leaf text hash (`leafHash` or `hash`)" });
    const wgslAbsolute = toAbsolute(root, `packages/cesium-webgpu/backend-webgpu/webgpu/${wgslFile}`);
    if (!fs.existsSync(wgslAbsolute)) drifted.push({ name, wgslFile, reason: "missing-wgsl-file", detail: "rule A11: `wgslFile` MUST exist relative to the directory containing the map" });
  }
  for (const declaration of LEAF_TABLE) {
    if (claimed.has(declaration.wgslFile)) continue;
    drifted.push({ name: declaration.name, wgslFile: declaration.wgslFile, reason: "missing-map-entry", detail: "a WGSL library file the emitter consumes has no map entry (rule A11/R7)" });
  }

  const device = collectDeviceEvidence(root);
  const acceptance = acceptFromEntries(entries);
  return { ok: drifted.length === 0, missing: null, map, entries, drifted, device, acceptance };
}

// ------------------------------------------------------------------------------------------------
// the acceptance path (the half of T070 that A11 states as `verifiedOnRealGpu === true`)
// ------------------------------------------------------------------------------------------------

function acceptFromEntries(entries) {
  const accepted = [];
  const rejected = [];
  for (const entry of entries) {
    const label = `${entry?.name ?? entry?.wgslFile ?? "(unnamed entry)"} [${entry?.wgslFile ?? "no wgslFile"}]`;
    if (entry?.verifiedOnRealGpu === true) accepted.push(label);
    else rejected.push({ label, value: entry?.verifiedOnRealGpu ?? null, reason: "verifiedOnRealGpu !== true: no real-device pipeline report covers this leaf (SH-3/FR-011)" });
  }
  return { accepted, rejected };
}

/**
 * The **acceptance-path** leaves: those whose `verifiedOnRealGpu === true`.
 *
 * SH-3 reads "every upstream leaf the acceptance path uses is in `shader-leaf-map.json` **and**
 * `verifiedOnRealGpu === true`". This predicate is that sentence as code: it returns the accepted
 * leaves and, separately, every leaf that must **not** enter the acceptance path yet — so a caller
 * that is about to claim a verified shader library gets a list of the leaves that would make the
 * claim false, instead of a boolean it can ignore.
 */
export function acceptancePathLeaves(mapOrEntries) {
  const entries = Array.isArray(mapOrEntries) ? mapOrEntries : (mapOrEntries?.leaves ?? []);
  return { ok: entries.length > 0 && entries.every((entry) => entry?.verifiedOnRealGpu === true), ...acceptFromEntries(entries) };
}

/** `acceptancePathLeaves` for the map on disk (throws when there is no map — an absent map MUST fail). */
export function acceptancePathLeavesFromDisk(mapPath = DEFAULT_MAP_PATH) {
  if (!fs.existsSync(mapPath)) throw new Error(`acceptancePathLeaves: no leaf map at ${mapPath} — the acceptance path MUST have one (SH-3/A11)`);
  return acceptancePathLeaves(JSON.parse(fs.readFileSync(mapPath, "utf8")));
}

// ------------------------------------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------------------------------------

function parseArgv(argv) {
  const options = { mode: null, mapPath: DEFAULT_MAP_PATH, report: null, quiet: false };
  const takesValue = new Set(["--map", "--out", "--report"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(0, eq) : token;
    let value = eq >= 0 ? token.slice(eq + 1) : undefined;
    if (key === "--update" || key === "--check" || key === "--quiet") {
      if (key === "--quiet") options.quiet = true;
      else options.mode = options.mode ?? key.slice(2);
      continue;
    }
    if (!takesValue.has(key)) throw new Error(`unknown argument "${token}"`);
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined) throw new Error(`missing value for "${key}"`);
      index += 1;
    }
    if (key === "--report") options.report = path.resolve(value);
    else options.mapPath = path.resolve(value);
  }
  if (options.mode === null) throw new Error("expected one of --update or --check");
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    process.stderr.write(`shader-leaf-map: ${error.message}\n`);
    return 2;
  }

  if (options.mode === "update") {
    const record = await buildLeafMap();
    fs.mkdirSync(path.dirname(options.mapPath), { recursive: true });
    fs.writeFileSync(options.mapPath, renderLeafMap(record), "utf8");
    const verified = record.leaves.filter((entry) => entry.verifiedOnRealGpu === true).length;
    process.stdout.write(`shader-leaf-map: wrote ${repoRelative(options.mapPath)} (${record.leaves.length} leaves, verifiedOnRealGpu: ${verified}/${record.leaves.length})\n`);
    if (verified < record.leaves.length) {
      // The honest state, said out loud: the field is false for a reason, and the reason is in the file.
      process.stdout.write(`shader-leaf-map: ${record.leaves.length - verified} leaf/leaves are NOT verified on a real GPU — ${record.deviceEvidence.verdictReason}\n`);
    }
    for (const entry of record.leaves) {
      process.stdout.write(`shader-leaf-map:   ${entry.name} <- ${entry.upstreamLeaves.length} upstream leaf text(s), upstreamLeafHash=${entry.upstreamLeafHash}, wgslFile=${entry.wgslFile}, verifiedOnRealGpu=${entry.verifiedOnRealGpu}\n`);
    }
    return 0;
  }

  const result = await checkLeafMap({ mapPath: options.mapPath });
  if (options.report !== null) {
    fs.mkdirSync(path.dirname(options.report), { recursive: true });
    fs.writeFileSync(options.report, `${JSON.stringify({ tool: "shader-leaf-map", mode: "check", ok: result.ok, missing: result.missing ?? null, drifted: result.drifted, deviceEvidence: result.device }, null, 2)}\n`, "utf8");
  }
  if (result.missing !== null) {
    process.stderr.write(`shader-leaf-map: ${result.missing} does not exist — a missing leaf map is a failure, never a silent pass (SH-3, rule A11)\n`);
    return 1;
  }
  if (result.ok) {
    process.stdout.write(`shader-leaf-map: ${result.entries.length} leaf/leaf(ves) in sync with the installed upstream GLSL texts and on-disk WGSL files (R7: no drift)\n`);
    const acceptance = acceptancePathLeaves(result.map);
    if (!acceptance.ok) {
      process.stdout.write(`shader-leaf-map: warning — ${acceptance.rejected.length} leaf/leaf(ves) must NOT enter the acceptance path (verifiedOnRealGpu !== true):\n`);
      for (const rejected of acceptance.rejected) process.stdout.write(`shader-leaf-map:   - ${rejected.label}\n`);
    }
    return 0;
  }

  for (const drift of result.drifted) {
    process.stdout.write(`shader-leaf-map: ${drift.name} (${drift.wgslFile}) — ${drift.reason}: the upstream leaf changed and the WGSL MUST BE RE-CONVERTED\n`);
    if (drift.reason === "upstream-leaf-hash-drift") {
      process.stdout.write(`shader-leaf-map:   recorded ${drift.recorded ?? "(none)"}\n`);
      process.stdout.write(`shader-leaf-map:   expected ${drift.expected ?? "(none)"} over ${(drift.upstreamLeaves ?? []).join(", ")}\n`);
    }
  }
  process.stdout.write(`shader-leaf-map: ${result.drifted.length} drift(s) — "must be re-converted" list above; run \`node tools/shader-leaf-map.mjs --update\` after re-doing the conversion (R7)\n`);
  return 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`shader-leaf-map: unexpected failure: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    });
}
