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

const ENGINE_ROOT = path.join(DEFAULT_ROOT, "node_modules", "@cesium", "engine");

/**
 * Upstream engine runtime assets, served from the installed package.
 *
 * The terrain logic layer generates its meshes inside a `TaskProcessor` **worker**
 * (`Core/HeightmapTerrainData.js:236` → `Core/createVerticesFromHeightmap.js`: "Workers/" +
 * `createVerticesFromHeightmap.js`), and `Transforms`/`CreditDisplay` fetch `Assets/**`
 * (`Assets/IAU2006_XYS/IAU2006_XYS_<n>.json`, `Assets/Images/ion-credit.png`). All of those resolve
 * through `buildModuleUrl`, i.e. against `CESIUM_BASE_URL` / the importing module's URL.
 *
 * Measured in the W5 opening probe: without these routes every one of them 404s, the task processor
 * never settles, and the globe keeps its root tiles in `_tileLoadQueueHigh` forever — the scene
 * renders (1447 passes) but draws **nothing**. Serving them keeps the whole verification run
 * same-origin (T087 asserts "zero *external* requests", which stays exactly true) and lets the
 * upstream scheduling code run unmodified.
 *
 * `Build/Workers/**` is the packaged worker bundle (the `Source/Workers/**` files are unbundled ESM
 * that a classic-or-module worker cannot resolve); `Source/Assets/**` is the only place the assets
 * ship in `@cesium/engine`.
 */
export const DEFAULT_ALIASES = [
  { prefix: "/engine/Workers/", directory: path.join(ENGINE_ROOT, "Build", "Workers") },
  { prefix: "/engine/Assets/", directory: path.join(ENGINE_ROOT, "Source", "Assets") },
];

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

/** Resolve one request against the alias table; `null` when no alias matches. */
export function resolveAliasPath(aliases, requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  for (const alias of aliases) {
    if (!decoded.startsWith(alias.prefix)) continue;
    const rest = decoded.slice(alias.prefix.length);
    if (rest.length === 0) return null;
    const candidate = path.resolve(alias.directory, rest);
    const normalised = path.resolve(alias.directory);
    if (candidate !== normalised && !candidate.startsWith(normalised + path.sep)) return null;
    return candidate;
  }
  return null;
}

export function createStaticServer({ root = DEFAULT_ROOT, onRequest = null, aliases = DEFAULT_ALIASES } = {}) {
  return http.createServer((request, response) => {
    if (onRequest) onRequest(request);
    const aliased = resolveAliasPath(aliases, request.url ?? "/");
    const target = aliased ?? resolveRequestPath(root, request.url ?? "/");
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
