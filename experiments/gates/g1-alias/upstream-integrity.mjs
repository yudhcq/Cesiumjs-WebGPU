/**
 * Upstream integrity helper for the G-1 gate (`@cesium/engine` on disk MUST stay untouched).
 *
 * Contract: [contracts/fork-patch-layer.md](../../../specs/001-webgpu-terrain-mvp/contracts/fork-patch-layer.md) §1 —
 * "上游包**原样安装、磁盘上零改动**；构建期由别名插件把清单内的模块替换为本仓库实现".
 * The full registry-integrity audit (`integrity` vs the published tarball, `Source/**` hash vs a
 * recorded baseline) is T030/T033; this gate proves the *narrower but decisive* claim: running the
 * whole build + browser chain of G-1 leaves every byte under `node_modules/@cesium/engine` identical.
 *
 * Node-only, cross-platform.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** `Source/**` plus the files that make up the package entry surface. */
const TOP_LEVEL_FILES = ["index.js", "index.d.ts", "package.json", "README.md", "LICENSE.md"];

function sha256(text) {
  return `sha256-${createHash("sha256").update(text).digest("hex")}`;
}

/** Content hash of one file (`sha256-<hex>`). */
export function hashFile(file) {
  return sha256(fs.readFileSync(file));
}

function walkFiles(dir, extensions, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(child, extensions, out);
    else if (entry.isFile() && (extensions === null || extensions.some((ext) => child.endsWith(ext)))) out.push(child);
  }
  return out;
}

function toPosix(relative) {
  return relative.split(path.sep).join("/");
}

/** Repository-relative paths of every upstream file covered by the integrity claim. */
export function listUpstreamFiles(engineRoot) {
  const sourceRoot = path.join(engineRoot, "Source");
  const files = walkFiles(sourceRoot, null).map((file) => path.relative(engineRoot, file));
  for (const name of TOP_LEVEL_FILES) {
    const file = path.join(engineRoot, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) files.push(name);
  }
  return files.map(toPosix).sort();
}

/**
 * Snapshot the whole upstream package.
 *
 * @param {string} engineRoot installed `@cesium/engine` root
 * @param {object} [options]
 * @param {string[]} [options.detailPrefixes] extra prefixes whose per-file hashes are kept in the
 *   returned `details` map (used as human-readable evidence; the aggregate always covers everything)
 */
export function snapshotUpstream(engineRoot, { detailPrefixes = ["Source/Renderer/", "Source/Scene/Scene.js"] } = {}) {
  const files = listUpstreamFiles(engineRoot);
  const details = {};
  const lines = [];
  let totalBytes = 0;
  for (const relative of files) {
    const absolute = path.join(engineRoot, ...relative.split("/"));
    const bytes = fs.statSync(absolute).size;
    totalBytes += bytes;
    const hash = hashFile(absolute);
    lines.push(`${relative}\u0000${hash}`);
    if (detailPrefixes.some((prefix) => relative.startsWith(prefix))) details[relative] = hash;
  }
  return {
    engineRoot: toPosix(engineRoot),
    fileCount: files.length,
    totalBytes,
    aggregateHash: sha256(lines.join("\n")),
    details,
  };
}

/** Compare two snapshots; `unchanged` is the gate assertion. */
export function compareSnapshots(before, after) {
  const beforeKeys = Object.keys(before.details);
  const afterKeys = Object.keys(after.details);
  const changedDetails = beforeKeys.filter((key) => key in after.details && before.details[key] !== after.details[key]);
  return {
    unchanged: before.aggregateHash === after.aggregateHash && before.fileCount === after.fileCount && after.totalBytes === before.totalBytes,
    aggregateBefore: before.aggregateHash,
    aggregateAfter: after.aggregateHash,
    fileCountBefore: before.fileCount,
    fileCountAfter: after.fileCount,
    changedDetails,
    detailsAdded: afterKeys.filter((key) => !beforeKeys.includes(key)),
    detailsRemoved: beforeKeys.filter((key) => !afterKeys.includes(key)),
  };
}
