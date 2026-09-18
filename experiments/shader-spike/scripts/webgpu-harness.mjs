/**
 * Spike S7 driver — serve the harness page + drive headless Chrome 153 over CDP,
 * with NO browser flags beyond --headless (the hardware WebGPU adapter is available
 * without any flags on this machine).
 *
 * Usage: node webgpu-harness.mjs
 * Writes: ../logs/webgpu-verify.json  and  ../logs/harness-page-console.txt
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPIKE = path.resolve(HERE, "..");
const LOGS = path.join(SPIKE, "logs");
const TMP = process.env.SPIKE_TOOLCHAIN ?? path.join(os.tmpdir(), "shader-spike");
const CHROME =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 8791;
const CDP_PORT = 9333;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".wgsl": "text/plain", ".glsl": "text/plain", ".json": "application/json",
  ".wasm": "application/wasm", ".txt": "text/plain", ".pp": "text/plain",
};

// ---------------------------------------------------------------- static server
const ROOTS = [
  ["/spike/", SPIKE],
  ["/pp/", path.join(TMP, "pp")],
  ["/tool/", path.join(TMP, "node_modules")],
];
const page = fs.readFileSync(path.join(HERE, "harness-page.html"), "utf8");
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/" || url.pathname === "/page") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page);
  }
  for (const [prefix, root] of ROOTS) {
    if (url.pathname.startsWith(prefix)) {
      const rel = decodeURIComponent(url.pathname.slice(prefix.length));
      const file = path.join(root, rel);
      if (!path.resolve(file).startsWith(path.resolve(root)) || !fs.existsSync(file)) {
        res.writeHead(404); return res.end("nf");
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      return fs.createReadStream(file).pipe(res);
    }
  }
  res.writeHead(404); res.end("nf");
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// ---------------------------------------------------------------- launch chrome
const profile = path.join(TMP, "chrome-profile");
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    `http://127.0.0.1:${PORT}/page`,
  ],
  { stdio: "ignore", detached: false },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    return await r.json();
  } catch { return null; }
}
let pageTarget = null;
for (let i = 0; i < 60 && !pageTarget; i++) {
  await sleep(500);
  const t = await targets();
  pageTarget = t?.find((x) => x.type === "page" && x.url.includes(`:${PORT}/page`));
}
if (!pageTarget) { chrome.kill(); server.close(); throw new Error("chrome page target not found"); }
console.log(`chrome target: ${pageTarget.url}`);
console.log(`browser: ${chrome.spawnargs.includes("--headless=new") ? "headless=new" : "?"}`);

// ---------------------------------------------------------------- CDP over ws
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const consoleLines = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled") {
    consoleLines.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  }
  if (m.method === "Runtime.exceptionThrown") {
    consoleLines.push("[exception] " + (m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails)));
  }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Runtime.enable");
await send("Page.enable");
await send("Log.enable").catch(() => {});

let result = null;
for (let i = 0; i < 180; i++) {
  const r = await send("Runtime.evaluate", {
    expression: "JSON.stringify({done: !!window.__DONE, res: window.__RESULT ?? null})",
    returnByValue: true,
  });
  const val = r.result?.result?.value;
  if (val) {
    const parsed = JSON.parse(val);
    if (parsed.done) { result = parsed.res; break; }
  }
  await sleep(500);
}

const browserVersion = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
fs.mkdirSync(LOGS, { recursive: true });
const payload = { chrome: browserVersion.Browser, userAgent: browserVersion["User-Agent"], result };
fs.writeFileSync(path.join(LOGS, "webgpu-verify.json"), JSON.stringify(payload, null, 2));
fs.writeFileSync(path.join(LOGS, "harness-page-console.txt"), consoleLines.join("\n"));

console.log("\n--- page console ---");
console.log(consoleLines.join("\n") || "(none)");

ws.close();
chrome.kill();
server.close();
if (!result) { console.error("NO RESULT from page"); process.exit(1); }
