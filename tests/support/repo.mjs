/**
 * Shared, dependency-free helpers for repository-level unit tests.
 *
 * Everything here is intentionally Node-only and cross-platform: no shell, no
 * PowerShell, no absolute machine paths (CI target is Linux + bash).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root (two levels above `tests/support/`). */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** Resolve a repository-relative path to an absolute one. */
export function repoPath(relativePath) {
  return path.join(REPO_ROOT, ...relativePath.split("/"));
}

export function exists(relativePath) {
  return fs.existsSync(repoPath(relativePath));
}

export function readText(relativePath) {
  return fs.readFileSync(repoPath(relativePath), "utf8");
}

export function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

/** Recursively list files under a repository-relative directory (sorted, POSIX separators). */
export function listFiles(relativePath, { extensions = null, skipDirs = ["node_modules", ".git", "dist"] } = {}) {
  const absolute = repoPath(relativePath);
  if (!fs.existsSync(absolute)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
        out.push(path.relative(REPO_ROOT, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    }
  };
  walk(absolute);
  return out.sort();
}
