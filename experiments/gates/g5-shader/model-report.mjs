#!/usr/bin/env node
/**
 * G-5 gate — build the full MVP-reachable model and report the shape of the define space.
 *
 *   node experiments/gates/g5-shader/model-report.mjs [--out <file>] [--quiet]
 *
 * Emits `experiments/gates/out/g5-model.json`: one row per enumerated define set with its derived
 * varying set, its emitted module-pair hash and the group it belongs to. The device half
 * (`tools/shader-verify.mjs --variants=all-reachable`) creates one pipeline per **distinct module
 * pair** and every enumerated define set is tied to a verified pipeline by byte-identity of its
 * emitted modules — so the coverage claim is exact rather than sampled.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT, OUT_DIR, buildGateModel } from "./model.mjs";

function parseArgv(argv) {
  const options = { out: path.join(OUT_DIR, "g5-model.json"), quiet: argv.includes("--quiet") };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(0, eq) : token;
    if (key === "--out") options.out = path.resolve(eq >= 0 ? token.slice(eq + 1) : argv[++index]);
  }
  return options;
}

function sha256(text) {
  return `sha256-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

export function buildModelReport({ quiet = false, write = true, out = null } = {}) {
  const log = (line) => {
    if (!quiet) process.stdout.write(`[g5-model] ${line}\n`);
  };
  const started = Date.now();
  const groups = new Map();
  const rows = [];
  let rejected = 0;

  // The full matrix is ~1.4 GB of WGSL text, so the report is built from a streaming callback: only
  // one representative module per distinct pair is retained.
  const model = buildGateModel({
    onEmission: (entry, emission) => {
      if (!emission.ok) {
        rejected += 1;
        rows.push({ id: entry.variant.id, defines: entry.variant.defines, rejected: true, unsupported: emission.unsupported, diagnostics: emission.diagnostics });
        return;
      }
      const vertexHash = sha256(emission.vertexWgsl);
      const fragmentHash = sha256(emission.fragmentWgsl);
      const groupKey = `${vertexHash}/${fragmentHash}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, { key: groupKey, vertexHash, fragmentHash, members: [], vertexWgsl: emission.vertexWgsl, fragmentWgsl: emission.fragmentWgsl, first: entry.variant.id });
      }
      groups.get(groupKey).members.push(entry.variant.id);
      rows.push({
        id: entry.variant.id,
        defines: entry.variant.defines,
        paired: emission.structure.paired,
        attributes: emission.structure.attributes,
        vertexHash,
        fragmentHash,
        group: groupKey,
        rejected: false,
      });
    },
  });
  log(`enumerated ${model.stats.defineCombinations} define combination(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  log(`emitted ${rows.length - rejected}/${rows.length}; distinct module pair(s) = ${groups.size}; rejected = ${rejected}`);

  const varyingSetHistogram = new Map();
  for (const row of rows) {
    if (row.rejected) continue;
    const key = row.paired.join(",") || "(none)";
    varyingSetHistogram.set(key, (varyingSetHistogram.get(key) ?? 0) + 1);
  }

  const report = {
    tool: "g5-shader/model-report",
    recordedAt: new Date().toISOString(),
    node: process.version,
    defineSpace: model.defineSpace,
    stats: {
      ...model.stats,
      distinctModulePairs: groups.size,
      varyingSetHistogram: [...varyingSetHistogram.entries()].map(([paired, count]) => ({ paired: paired === "(none)" ? [] : paired.split(","), count })).sort((a, b) => b.count - a.count),
      elapsedMs: Date.now() - started,
    },
    layout: {
      structName: model.layout.structName,
      structSize: model.layout.structSize,
      memberCount: model.layout.members.length,
      samplers: model.layout.samplers,
      members: model.layout.members.map((member) => ({ name: member.name, glslType: member.glslType, wgslType: member.wgslType, byteOffset: member.byteOffset, byteSize: member.byteSize, arrayStride: member.arrayStride })),
    },
    unionUniforms: model.unionUniforms,
    groups: [...groups.values()].map((group) => ({
      key: group.key,
      vertexHash: group.vertexHash,
      fragmentHash: group.fragmentHash,
      representative: group.first,
      memberCount: group.members.length,
      members: group.members.slice(0, 8),
      vertexBytes: group.vertexWgsl.length,
      fragmentBytes: group.fragmentWgsl.length,
    })),
    rows,
  };

  if (write) {
    const target = out ?? path.join(OUT_DIR, "g5-model.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log(`wrote ${path.relative(REPO_ROOT, target).split(path.sep).join("/")} (${(fs.statSync(target).size / 1e6).toFixed(1)} MB)`);
  }
  return report;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parseArgv(process.argv.slice(2));
  const report = buildModelReport({ quiet: options.quiet, out: options.out });
  process.stdout.write(`[g5-model] define combinations=${report.stats.defineCombinations} distinct module pairs=${report.stats.distinctModulePairs} varying sets=${report.stats.varyingSetHistogram.length}\n`);
}
