#!/usr/bin/env node
/**
 * Zero-dependency static file server for the demo page and for Playwright runs.
 *
 * Node-only (`node:http`), cross-platform, no external package — CI has no extra install step.
 *
 * Usage:
 *   node tools/scripts/serve.mjs [--root <dir>] [--port <n>] [--host <addr>]
 *
 * Defaults: root = repository root, port = 8080 (or $DEMO_PORT), host = 127.0.0.1.
 * Exported for tests: `createStaticServer({ root })` returns a `node:http` server.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..", "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".hgt": "application/octet-stream",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Map a request URL path to a file inside `root`, or null when it escapes the root. */
export function resolveRequestPath(root, requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(root, relative);
  const normalisedRoot = path.resolve(root);
  if (candidate !== normalisedRoot && !candidate.startsWith(normalisedRoot + path.sep)) return null;
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    const index = path.join(candidate, "index.html");
    return fs.existsSync(index) ? index : null;
  }
  return candidate;
}

export function createStaticServer({ root = DEFAULT_ROOT, onRequest = null } = {}) {
  return http.createServer((request, response) => {
    if (onRequest) onRequest(request);
    const target = resolveRequestPath(root, request.url ?? "/");
    if (target === null || !fs.existsSync(target)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end(`404 ${request.url ?? "/"}\n`);
      return;
    }
    const body = fs.readFileSync(target);
    response.writeHead(200, {
      "content-type": contentType(target),
      "content-length": body.byteLength,
      "cache-control": "no-store",
      // The demo runs a device-isolation-sensitive renderer; process isolation is not needed
      // here because everything is same-origin, but keep the header explicit for clarity.
      "cross-origin-resource-policy": "same-origin",
    });
    response.end(body);
  });
}

function parseArgv(argv) {
  const options = {
    root: DEFAULT_ROOT,
    port: Number(process.env.DEMO_PORT ?? 8080),
    host: process.env.DEMO_HOST ?? "127.0.0.1",
  };
  const takesValue = new Set(["--root", "--port", "--host"]);
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
    if (key === "--root") options.root = path.resolve(value);
    else if (key === "--port") options.port = Number(value);
    else options.host = value;
  }
  return options;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const options = parseArgv(process.argv.slice(2));
    const server = createStaticServer({ root: options.root });
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      process.stdout.write(`serving ${options.root} at http://${options.host}:${port}/\n`);
      process.stdout.write(`demo page: http://${options.host}:${port}/apps/demo/\n`);
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        server.close(() => process.exit(0));
      });
    }
  } catch (error) {
    console.error(`serve: ${error.message}`);
    process.exitCode = 2;
  }
}
