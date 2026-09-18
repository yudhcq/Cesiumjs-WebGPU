/**
 * T011 — the demo page must be a pure caller: no render-path branching, no concrete backend
 * reference (data-model §11 A5, contract render-path-api.md §5 C-5).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { exists, readText } from "../support/repo.mjs";

const DEMO_SOURCES = ["apps/demo/index.html", "apps/demo/src/main.ts"];

test("the demo entry imports only the package entry point", () => {
  const main = readText("apps/demo/src/main.ts");
  const specifiers = [...main.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(specifiers.length > 0, "the demo MUST import the package entry");
  for (const specifier of specifiers) {
    assert.equal(specifier, "cesium-webgpu", `the demo MUST only import the package entry, found "${specifier}"`);
  }
});

test("the demo source contains no render-path branch", () => {
  const forbidden = [
    { pattern: /preference\s*===?/, message: "preference comparison" },
    { pattern: /===\s*["']webgpu["']/, message: '"webgpu" comparison' },
    { pattern: /===\s*["']webgl2["']/, message: '"webgl2" comparison' },
  ];
  for (const file of DEMO_SOURCES) {
    assert.ok(exists(file), `${file} MUST exist`);
    const lines = readText(file).split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { pattern, message } of forbidden) {
        assert.ok(
          !pattern.test(line),
          `${file}:${index + 1} MUST NOT branch on the render path (${message}): ${line.trim()}`,
        );
      }
    });
  }
});

test("the demo skeleton exposes the status, attribution and progress containers plus the device-loss entry", () => {
  const html = readText("apps/demo/index.html");
  for (const marker of [
    "data-demo-status",
    "data-demo-progress",
    "data-demo-attribution",
    "data-demo-container",
    "data-action=\"simulate-device-loss\"",
  ]) {
    assert.ok(html.includes(marker), `index.html MUST contain the ${marker} container`);
  }
  assert.match(html, /<script type="module" src="\.\/dist\/main\.js"><\/script>/, "the page MUST load the built demo entry");
});

test("the demo package is a workspace member that depends on the delivery package", () => {
  const manifest = JSON.parse(readText("apps/demo/package.json"));
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  assert.equal(manifest.dependencies?.["cesium-webgpu"], "0.1.0");
});
