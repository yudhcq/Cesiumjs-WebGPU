#!/usr/bin/env node
/**
 * G-1 gate — zero-dependency static server.
 *
 * Serves the gate directory at `/` and a published CesiumJS distribution at `/cesium/`:
 *
 *     node experiments/gates/serve-g1.mjs --port 8125 --cesium-dir <path to Build/Cesium>
 *
 * `--cesium-dir` has no default on purpose: the published artifact lives outside the repository
 * (the workspace has no dependencies before tasks.md T008/T011), so the path is always supplied
 * by the caller and is never baked into a tracked file.
 *
 * Node built-ins only (`node:http`, `node:fs`, `node:path`). No PowerShell, no shell.
 */

import { createServer } from "node:http";
import { createReadStream, statSync, existsSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".f32": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ktx2": "image/ktx2",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function parseArgs(argv) {
  const args = { port: 8125, cesiumDir: null, root: HERE };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--port") {
      args.port = Number(argv[++i]);
    } else if (token === "--cesium-dir") {
      args.cesiumDir = argv[++i];
    } else if (token === "--root") {
      args.root = resolve(argv[++i]);
    } else if (token === "--help" || token === "-h") {
      console.log(
        "usage: node serve-g1.mjs [--port 8125] --cesium-dir <Build/Cesium directory> [--root <dir>]",
      );
      process.exit(0);
    }
  }
  return args;
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const normalized = normalize(decoded).replace(/^([/\\])+/, "");
  const full = join(root, normalized);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(rootWithSep)) {
    return null;
  }
  return full;
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function serveFile(res, filePath) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    send(res, 404, `not found: ${filePath}`);
    return;
  }
  if (stat.isDirectory()) {
    serveFile(res, join(filePath, "index.html"));
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "no-store",
    // Required so the page can use SharedArrayBuffer-free paths; harmless otherwise.
    "cross-origin-resource-policy": "cross-origin",
  });
  createReadStream(filePath).pipe(res);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cesiumDir) {
    console.error("error: --cesium-dir <path to published Build/Cesium> is required");
    process.exit(2);
  }
  const cesiumDir = resolve(args.cesiumDir);
  if (!existsSync(join(cesiumDir, "index.js"))) {
    console.error(`error: ${cesiumDir} does not look like a published Build/Cesium (no index.js)`);
    process.exit(2);
  }

  const server = createServer((req, res) => {
    const urlPath = req.url ?? "/";
    if (urlPath === "/healthz") {
      send(res, 200, "ok");
      return;
    }
    if (urlPath === "/" || urlPath.startsWith("/?") || urlPath.startsWith("/index.html")) {
      serveFile(res, join(args.root, "g1-layering.html"));
      return;
    }
    if (urlPath.startsWith("/cesium/")) {
      const target = safeJoin(cesiumDir, urlPath.slice("/cesium/".length));
      if (!target) {
        send(res, 403, "forbidden");
        return;
      }
      serveFile(res, target);
      return;
    }
    const target = safeJoin(args.root, urlPath);
    if (!target) {
      send(res, 403, "forbidden");
      return;
    }
    serveFile(res, target);
  });

  server.listen(args.port, "127.0.0.1", () => {
    console.log(`[serve-g1] root       = ${args.root}`);
    console.log(`[serve-g1] cesium     = ${cesiumDir}`);
    console.log(`[serve-g1] listening  = http://127.0.0.1:${args.port}/g1-layering.html`);
  });
}

main();
