/**
 * T082 — the increment's shader coverage scope, as a machine-checked statement
 * (`层=单元`; tasks.md T082; FR-026 workflow split + FR-027 口径声明).
 *
 * The document is the only place that says out loud what this increment does **not** cover, so the
 * assertions here are about the three declarations the task names — "不计入本增量", "2–4 人月",
 * "未逐家族实测" — plus the consistency claim that makes them binding: the task list itself must not
 * contain a task that pulls the 319 leaves into this increment.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { readText, repoPath } from "../support/repo.mjs";

const DOC = "docs/shader-coverage-scope.md";
const TASKS = "specs/001-webgpu-terrain-mvp/tasks.md";

test("the scope document exists and states the three required declarations", () => {
  const text = readText(DOC);
  assert.ok(text.length > 1500, `the scope document MUST be a real statement, not a stub (${text.length} bytes)`);

  assert.match(text, /不计入本增量/, 'the document MUST say the full-library translation is "不计入本增量" (FR-027)');
  assert.match(text, /2[–-]4 人月/, 'the document MUST carry the "2–4 人月" extrapolation');
  assert.match(text, /未逐家族实测/, 'the document MUST record that the extrapolation is "未逐家族实测"');

  // The coverage claim itself: the terrain closure, by name, and the numbers it is bounded by.
  for (const family of ["GlobeVS", "GlobeFS", "AtmosphereCommon", "GroundAtmosphere"]) {
    assert.match(text, new RegExp(`\\b${family}\\b`), `the document MUST name the ${family} family as covered`);
  }
  assert.match(text, /319/, "the document MUST carry the full-library leaf count (319) it excludes");
  assert.match(text, /244/, "the document MUST carry the full-library czm_ builtin count (244) it excludes");
});

test("the document states the blind spots the increment does not close", () => {
  const text = readText(DOC);
  assert.match(text, /naga --input-kind wgsl/, "the CI-side validation limit MUST be named");
  assert.match(text, /不覆盖 WebGPU 管线校验/, "the blind spot MUST be stated verbatim (FR-023)");
  assert.match(text, /ShaderBuilder/, "the ShaderBuilder boundary MUST be named (contract R9)");
  assert.match(text, /not-implemented/, "out-of-scope shader families MUST fail with `not-implemented`, not silently");
});

test("no task in the task list pulls the 319-leaf translation into this increment", () => {
  const tasks = readText(TASKS);
  const lines = tasks.split(/\r?\n/);

  // Every line that mentions the full-library scope MUST be a *statement about the boundary*
  // (`不在本增量` / `本增量之外` / `不计入` / the scope-registration task T082), never a task that
  // claims to deliver it.
  const mentions = lines.filter((line) => /\b319\b/.test(line));
  assert.ok(mentions.length > 0, "the task list MUST mention the 319-leaf full library (otherwise the boundary is not registered anywhere)");
  for (const line of mentions) {
    const isBoundaryStatement = /不在本增量|本增量之外|不计入|本增量范围声明|明确不属于|explicitly outside/.test(line);
    assert.ok(isBoundaryStatement, `every task-list mention of the 319-leaf library MUST be a boundary statement, not a delivery claim:\n  ${line.trim().slice(0, 200)}`);
  }

  // And no task may claim a full-library / 244-builtin translation as its deliverable.
  for (const [index, line] of lines.entries()) {
    if (!/^\s*-\s*\[[ x]\]\s*T\d+/.test(line)) continue;
    assert.doesNotMatch(line, /全部\s*319|319\s*个\s*`?\.glsl`?\s*叶子\s*(?:的)?\s*(?:一次性)?转译\s*\(?(?:本任务|纳入本增量)/, `task at line ${index + 1} appears to claim the full-library translation:\n  ${line.trim().slice(0, 200)}`);
  }
});

test("the scope document's coverage numbers agree with the shipped artifacts", () => {
  const text = readText(DOC);
  // The catalog size the document quotes (`92` rows) MUST be the catalog's actual size, or the
  // "coverage scope" statement would drift from what was delivered.
  const catalog = JSON.parse(fs.readFileSync(repoPath("packages/cesium-webgpu/backend-webgpu/webgpu/wgsl-prelude/catalog.json"), "utf8"));
  assert.match(text, new RegExp(`\\*\\*${catalog.entries.length}\\*\\*|\\b${catalog.entries.length}\\b`), `the document MUST quote the catalog size (${catalog.entries.length}) it delivers`);
  const kinds = catalog.entries.reduce((accumulator, entry) => {
    accumulator[entry.kind] = (accumulator[entry.kind] ?? 0) + 1;
    return accumulator;
  }, {});
  assert.equal(kinds.constant + kinds.function + kinds.struct + kinds.builtin, catalog.entries.length);

  // The four families the document names MUST be the four the library index names.
  const index = readText("packages/cesium-webgpu/backend-webgpu/webgpu/wgsl/index.ts");
  for (const family of ["GlobeVS", "GlobeFS", "AtmosphereCommon", "GroundAtmosphere"]) {
    assert.match(index, new RegExp(`family: "${family}"`), `wgsl/index.ts MUST list ${family} as a covered family`);
  }
});
