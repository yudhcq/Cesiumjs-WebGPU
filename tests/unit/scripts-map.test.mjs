/**
 * T010 — script orchestration (`tools/scripts/run.mjs`, `tools/scripts/serve.mjs`, `.env.example`).
 *
 * The runner is exercised for real: the "no tests yet" contract, the unknown-command path and
 * the static server (HTTP responses, MIME type, 404, path-traversal refusal).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT, exists, readJson, readText, repoPath } from "../support/repo.mjs";
import { createStaticServer } from "../../tools/scripts/serve.mjs";

const RUNNER = repoPath("tools/scripts/run.mjs");

function runRunner(args) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], { encoding: "utf8", cwd: REPO_ROOT });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Send a raw request line (no client-side URL normalisation) and report the status code. */
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("every root npm script routes through tools/scripts/run.mjs with a known command", () => {
  const pkg = readJson("package.json");
  const runner = readText("tools/scripts/run.mjs");
  const commands = [...runner.matchAll(/^\s{2}"([a-z:]+)",$/gm)].map((match) => match[1]);
  assert.ok(commands.length >= 9, `expected the command table to list every command, got ${commands.length}`);
  for (const [name, command] of Object.entries(pkg.scripts)) {
    assert.equal(command, `node tools/scripts/run.mjs ${name}`, `script "${name}" MUST call the unified runner`);
    assert.ok(commands.includes(name), `run.mjs MUST implement the "${name}" command`);
  }
});

test("the orchestration helpers exist and the env template is committed", () => {
  for (const file of ["tools/scripts/run.mjs", "tools/scripts/serve.mjs", ".env.example"]) {
    assert.ok(exists(file), `${file} MUST exist`);
  }
  const gitignore = readText(".gitignore");
  assert.ok(gitignore.includes("!.env.example"), ".env.example MUST stay tracked while .env stays ignored");
});

test("test:unit prints 'no tests yet' and exits 0 when the discovery root is empty", (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "run-empty-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));

  const { code, stdout } = runRunner(["test:unit", `--dir=${empty}`]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /no tests yet/);
});

test("an unknown command is rejected with usage output", () => {
  const { code, stdout, stderr } = runRunner(["nonsense"]);
  assert.equal(code, 2);
  assert.match(stderr, /unknown command/);
  assert.match(stdout, /usage: node tools\/scripts\/run\.mjs/);
});

test("a backend-specific suite refuses to run without exactly one backend", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-suite-"));
  fs.writeFileSync(path.join(dir, "fake.spec.mjs"), "// placeholder suite\n", "utf8");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { code, stderr } = runRunner(["test:contract", `--dir=${dir}`]);
  assert.equal(code, 1);
  assert.match(stderr, /requires --backend=<webgpu\|webgl2>/);
});

test("the static server serves the demo page and refuses traversal", async (t) => {
  const server = createStaticServer({ root: REPO_ROOT });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const page = await fetch(`${base}/apps/demo/index.html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await page.text(), /data-demo-container/);

  const directory = await fetch(`${base}/apps/demo/`);
  assert.equal(directory.status, 200, "a directory request MUST fall back to index.html");

  const missing = await fetch(`${base}/does-not-exist.txt`);
  assert.equal(missing.status, 404);

  // `fetch` normalises percent-encoded dot segments away, so the traversal cases are sent
  // through a raw socket-level request to make sure the server itself refuses them.
  for (const rawPath of ["/../../package.json", "/..%2f..%2fpackage.json"]) {
    const traversal = await rawGet(port, rawPath);
    assert.equal(traversal.status, 404, `path traversal "${rawPath}" outside the served root MUST be refused`);
  }
});
