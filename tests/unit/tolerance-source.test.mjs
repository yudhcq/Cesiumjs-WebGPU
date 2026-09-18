/**
 * G-6 / T027 — 差异来源与容差的可追溯性（`docs/gate-g6-conclusion.md` + `compare.mjs`）。
 *
 * FR-014 requires every difference to be declared **by its source**, and forbids relaxing the
 * judgement to "any difference passes". That is a property of the artefacts, so it is asserted here
 * rather than left to review:
 *
 *   1. the comparison's declared-difference table covers exactly the sources T027 names
 *      (亚像素边缘 / MSAA 解析 / sRGB / 深度表示 / WGSL 无精度修饰符 / 纹理 Y 翻转处理) —
 *      plus the two alignment steps the measurements made necessary (窗口原点、交换链通道顺序);
 *   2. every declared source carries a non-empty `basis` (the *reason* its tolerance is what it is);
 *   3. the conclusion document contains no "any difference passes" style statement — the forbidden
 *      phrasings are matched as text, and the document must name a bounded tolerance per source.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { DECLARED_DIFFERENCES } from "../../experiments/gates/g6-precision/compare.mjs";
import { REPO_ROOT } from "../../experiments/gates/g5-shader/model.mjs";

const CONCLUSION = path.join(REPO_ROOT, "docs", "gate-g6-conclusion.md");

/** The sources tasks.md T027 names explicitly. */
const REQUIRED_SOURCES = ["edge", "msaa", "srgb", "depth", "precision", "flip"];

/** Statements that would mean "any difference passes" (FR-014 forbids them). */
const FORBIDDEN_PHRASES = [
  "任意差异",
  "任何差异均",
  "差异均可接受",
  "不设容差",
  "容差无限",
  "any difference passes",
  "differences are always acceptable",
  "no tolerance needed",
];

test("G-6 conclusion document exists and is not a placeholder", () => {
  assert.ok(fs.existsSync(CONCLUSION), `${path.relative(REPO_ROOT, CONCLUSION)} MUST exist (T027)`);
  const text = fs.readFileSync(CONCLUSION, "utf8");
  assert.ok(text.length > 2000, "the conclusion MUST state what was measured and what it means");
  assert.match(text, /verdict = `(pass|fail|partial)`/, "the conclusion MUST state the verdict on its first screen");
  assert.doesNotMatch(text, /\[FEATURE NAME\]|\$ARGUMENTS|TODO|待填/, "no placeholders");
});

test("the conclusion does not relax the judgement to 'any difference passes' (FR-014)", () => {
  const text = fs.readFileSync(CONCLUSION, "utf8");
  // A forbidden phrase is only a violation when it is *asserted*; naming it inside a prohibition
  // ("MUST NOT 放宽为「任意差异通过」") is exactly what FR-014 asks the document to say.
  const NEGATIONS = ["MUST NOT", "不得", "禁止", "不允许", "not ", "而非", "不是"];
  const violations = [];
  for (const line of text.split("\n")) {
    for (const phrase of FORBIDDEN_PHRASES) {
      if (!line.includes(phrase)) continue;
      if (NEGATIONS.some((negation) => line.includes(negation))) continue;
      violations.push(`${phrase} :: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(violations, [], `forbidden "any difference passes" assertion(s): ${violations.join(" | ")}`);
  // A bounded tolerance (a number, an LSB or an explicit "not applicable"/"alignment" marker) MUST
  // be stated for every declared source row.
  const rows = text.split("\n").filter((line) => /^\|\s*\d+\s*\|/.test(line));
  assert.ok(rows.length >= 6, `the per-source tolerance table MUST list every declared source (found ${rows.length} row(s))`);
  for (const row of rows) {
    assert.ok(/LSB|不适用|对齐|0|一致|处理/.test(row), `row without a bounded tolerance or an explicit marker: ${row}`);
  }
});

test("every declared difference source names its basis and the T027 sources are covered", () => {
  assert.ok(DECLARED_DIFFERENCES.length >= 7, "the declared-difference table MUST cover the T027 sources plus the measured alignment steps");
  for (const entry of DECLARED_DIFFERENCES) {
    assert.ok(typeof entry.id === "string" && entry.id.length > 0, "every declared difference MUST have an id");
    assert.ok(typeof entry.what === "string" && entry.what.length > 8, `${entry.id}: MUST say what the difference is`);
    assert.ok(typeof entry.basis === "string" && entry.basis.length > 20, `${entry.id}: MUST state the basis of its tolerance`);
    assert.ok(entry.tolerance !== null && typeof entry.tolerance === "object", `${entry.id}: MUST carry a tolerance object`);
  }
  const ids = DECLARED_DIFFERENCES.map((entry) => entry.id).join(" ").toLowerCase();
  for (const required of REQUIRED_SOURCES) {
    assert.ok(ids.includes(required), `the T027-named source matching "${required}" is missing from the declared differences`);
  }
  // No source may declare an unbounded tolerance.
  for (const entry of DECLARED_DIFFERENCES) {
    const values = Object.values(entry.tolerance).filter((value) => typeof value === "number");
    assert.ok(values.every((value) => Number.isFinite(value) && value < 1e6), `${entry.id}: tolerance values MUST be finite and bounded`);
  }
});
