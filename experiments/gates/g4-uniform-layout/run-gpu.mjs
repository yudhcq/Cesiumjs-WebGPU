#!/usr/bin/env node
/**
 * G-4 gate — real-device uniform-layout assertion (tasks.md T019 (b)).
 *
 *   node experiments/gates/g4-uniform-layout/run-gpu.mjs                       # the assertion
 *   node experiments/gates/g4-uniform-layout/run-gpu.mjs --control=shift-offsets   # negative control
 *   node experiments/gates/g4-uniform-layout/run-gpu.mjs --quiet
 *
 * Task T019 asks for "复用尖刺真机 harness 手法（identity 矩阵 + 已知纹素回读）断言**地形全部 uniform 生效**".
 * The spike's method is reused in kind (real adapter → real pipeline → readback of known texels); the scope is
 * widened from "one identity matrix" to **every** uniform of the generated layout:
 *
 *   - Node writes the uniform struct **strictly through the CPU layout table** and hands the browser an
 *     explicit byte plan (the browser never re-derives an offset);
 *   - the generated fragment shader returns one uniform slot per pixel (pixel x → slot x), so the
 *     readback is a per-field view of what the GPU actually sees;
 *   - the baseline readback MUST equal the CPU-declared expectation (catches wrong offsets/strides/padding);
 *   - a same-plan "control" render MUST report zero changed pixels (the comparison can say "no change");
 *   - a per-member perturbation matrix MUST change exactly that member's slots (proves every uniform is
 *     live at the claimed offset);
 *   - the **negative control** (`--control=shift-offsets`) shifts one member's scalars by 4 bytes in the
 *     plan and requires the same assertions to FAIL — a device assertion that cannot fail proves nothing.
 *
 * Artefacts: `out/g4-gpu-input.json`, `out/g4-gpu.json`, `out/g4-gpu-run.log` (+ the control's own files).
 * Exit codes: 0 → all checks hold; 1 → a check failed; 2 → the harness could not run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createStaticServer } from "../../../tools/scripts/serve.mjs";
import { assembleMatrix } from "./assemble-glsl.mjs";
import { emitVerificationWgsl, expectedSlotBytes, layoutUniforms, roundUp, slotIndicesForMember, writeStructBytes } from "./uniform-layout.mjs";

export const GATE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(GATE_DIR, "..", "..", "..");
export const OUT_DIR = path.join(REPO_ROOT, "experiments", "gates", "out");
const PAGE = path.join(GATE_DIR, "page.html");

function repoRelative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

function check(id, ok, detail, extra = {}) {
  return { id, ok: ok === true, detail, ...extra };
}

/** Assemble the matrix and build the union layout + all byte plans (Node side, deterministic). */
export function prepareLayout() {
  const matrix = assembleMatrix();
  const unionUniforms = matrix.union.map((entry) => {
    const sizes = matrix.variants
      .filter((variant) => variant.uniforms.some((uniform) => uniform.name === entry.name))
      .map((variant) => variant.uniforms.find((uniform) => uniform.name === entry.name).size);
    return { name: entry.name, glslType: entry.glslType, size: Math.max(...sizes) };
  });
  const layout = layoutUniforms(unionUniforms, { structName: "TerrainUniforms" });
  const wgsl = emitVerificationWgsl(layout);
  const baseline = writeStructBytes(layout, { salt: 0 });
  const expectedSlots = expectedSlotBytes(layout, baseline);
  const perturbations = layout.members.map((member) => ({
    member: member.name,
    plan: writeStructBytes(layout, { perturb: member.name, perturbSalt: 1 }),
    expectedSlots: slotIndicesForMember(layout, member.name),
  }));
  return { matrix, layout, wgsl, baseline, expectedSlots, perturbations };
}

/** Build the input document the page consumes for one assertion run. */
export function buildInput({ layout, wgsl, baseline, expectedSlots, perturbations }) {
  return {
    recordedAt: new Date().toISOString(),
    structName: layout.structName,
    structSize: layout.structSize,
    bufferBytes: roundUp(layout.structSize, 16) + 16,
    slotCount: layout.slotPlan.length,
    members: layout.members,
    samplers: layout.samplers,
    slots: layout.slotPlan,
    wgsl,
    expectedSlots,
    plans: { baseline },
    perturbations: perturbations.map((entry) => ({ member: entry.member, plan: entry.plan, expectedSlots: entry.expectedSlots })),
  };
}

/**
 * Run one real-device assertion in a fresh browser for the given input document.
 *
 * @param {{input: object, inputFile?: string, quiet?: boolean, channel?: string, headed?: boolean, timeoutMs?: number, writeWgsl?: boolean}} options
 * @returns {Promise<{checks: object[], measurements: object, environment: object, probe: object|null}>}
 */
export async function runProbeInBrowser(options) {
  const { input, quiet = false } = options;
  const log = (line) => {
    if (!quiet) process.stdout.write(`[g4-gpu] ${line}\n`);
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const inputArtifact = path.resolve(options.inputFile ?? path.join(OUT_DIR, "g4-gpu-input.json"));
  fs.writeFileSync(inputArtifact, `${JSON.stringify(input)}\n`, "utf8");
  if (options.writeWgsl !== false) {
    // Keep the human-readable artefact identical to the program that was actually compiled.
    fs.writeFileSync(path.join(OUT_DIR, "g4-uniform.wgsl"), input.wgsl, "utf8");
  }
  log(`wrote ${repoRelative(inputArtifact)} (${input.slotCount} slot(s), structSize=${input.structSize}B, ${input.perturbations.length} perturbation(s))`);

  const server = createStaticServer({ root: REPO_ROOT });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/${repoRelative(PAGE)}?input=${encodeURIComponent(`/${repoRelative(inputArtifact)}`)}`;

  let browser = null;
  const pageErrors = [];
  const consoleMessages = [];
  let probe = null;
  let runtimeError = null;
  let browserVersion = "none";
  try {
    browser = await chromium.launch({ channel: options.channel ?? process.env.GATE_BROWSER_CHANNEL ?? "chrome", headless: options.headed !== true });
    browserVersion = browser.version();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push({ name: error.name ?? "Error", message: error.message ?? String(error) }));
    page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
    log(`opening ${url} (browser ${browserVersion})`);
    await page.goto(url, { waitUntil: "load", timeout: options.timeoutMs ?? 240000 });
    await page.waitForFunction(() => globalThis.__g4 !== undefined && globalThis.__g4.ready === true, null, { timeout: options.timeoutMs ?? 240000 });
    const collected = await page.evaluate(() => ({ report: globalThis.__g4.report, error: globalThis.__g4.error }));
    probe = collected.report;
    runtimeError = collected.error;
  } catch (error) {
    runtimeError = { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack ?? null };
  } finally {
    if (browser !== null) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }

  const checks = [];
  if (probe === null) {
    checks.push(check("gpu-probe-produced-report", false, `the device page produced no report: ${runtimeError?.message ?? "unknown reason"}`, { phase: "gpu" }));
  } else {
    const compilation = probe.compilation ?? { errors: -1, warnings: -1, messages: [] };
    const baselineResult = probe.baseline ?? { mismatches: [{ slot: -1, member: "?", expected: null, actual: null }], mismatchCount: -1 };
    const control = probe.control ?? { changedSlots: ["<missing>"] };
    const perturbationResults = probe.perturbations ?? [];
    const memberCount = input.members.length;
    checks.push(
      check("gpu-probe-produced-report", probe.errors.length === 0 && runtimeError === null, `probe finished at ${probe.finishedAt}; probe-level errors=${probe.errors.length}`, { phase: "gpu" }),
      check(
        "gpu-adapter-recorded",
        probe.adapter?.vendor != null && typeof probe.preferredFormat === "string" && probe.pipeline?.validationError == null,
        `adapter.info=${JSON.stringify(probe.adapter)}, preferredFormat=${probe.preferredFormat}, device limits: ${JSON.stringify(probe.device?.limits ?? null)}`,
        { phase: "gpu" },
      ),
      check(
        "gpu-generated-wgsl-compiles",
        compilation.errors === 0 && probe.pipeline?.validationError == null && probe.pipeline?.bindGroupEntryCount > 0,
        `shader module compilation: ${compilation.errors} error(s), ${compilation.warnings} warning(s) ` +
          `${compilation.messages.length > 0 ? `→ ${compilation.messages.map((message) => `${message.type}@${message.lineNum}:${message.linePos} ${message.message}`).join(" | ")}` : ""}; ` +
          `pipeline validation error=${JSON.stringify(probe.pipeline?.validationError ?? null)}; bind group entries=${probe.pipeline?.bindGroupEntryCount}`,
        { phase: "gpu" },
      ),
      check(
        "gpu-baseline-matches-cpu-layout",
        baselineResult.mismatchCount === 0,
        `CPU layout table → GPU readback: ${baselineResult.mismatchCount} mismatching component(s) out of ${input.slotCount * 4} ` +
          `${baselineResult.mismatchCount > 0 ? `→ first: ${JSON.stringify(baselineResult.mismatches.slice(0, 6))}` : ""} ` +
          `(every slot is one uniform field/element/column; a wrong byteOffset, arrayStride, columnStride or padding would show up here)`,
        { phase: "gpu" },
      ),
      check(
        "gpu-control-reports-no-change",
        Array.isArray(control.changedSlots) && control.changedSlots.length === 0,
        `writing the SAME byte plan twice changed ${Array.isArray(control.changedSlots) ? control.changedSlots.length : "?"} slot(s) ` +
          "(must be 0 — otherwise the comparison would report differences that are not caused by the layout)",
        { phase: "gpu" },
      ),
      check(
        "gpu-every-uniform-perturbation-hits-its-slots",
        perturbationResults.length === memberCount && perturbationResults.every((entry) => entry.exact === true),
        `${perturbationResults.filter((entry) => entry.exact === true).length}/${memberCount} member perturbation(s) changed exactly their own slots; ` +
          `failures: ${JSON.stringify(perturbationResults.filter((entry) => entry.exact !== true).slice(0, 5))}`,
        { phase: "gpu" },
      ),
      check(
        "gpu-no-uncaught-page-errors",
        pageErrors.length === 0,
        `${pageErrors.length} uncaught page error(s)${pageErrors.length > 0 ? `: ${pageErrors.map((error) => error.message).join(" | ")}` : ""}; ` +
          `console errors=${consoleMessages.filter((message) => message.type === "error").length}`,
        { phase: "gpu" },
      ),
    );
  }

  return {
    probe,
    checks,
    runtimeError,
    pageErrors,
    browserVersion,
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      browser: { channel: options.channel ?? process.env.GATE_BROWSER_CHANNEL ?? "chrome", version: browserVersion, headless: options.headed !== true, launchArgs: [], note: "zero launch flags; hardware WebGPU adapter" },
      adapter: probe?.adapter ?? null,
      preferredFormat: probe?.preferredFormat ?? null,
      deviceLimits: probe?.device?.limits ?? null,
    },
    measurements: {
      inputArtifact: repoRelative(inputArtifact),
      structName: input.structName,
      structSize: input.structSize,
      memberCount: input.members.length,
      samplerBindingCount: input.samplers.length,
      slotCount: input.slotCount,
      perturbationCount: input.perturbations.length,
      compilation: probe?.compilation ?? null,
      pipeline: probe?.pipeline ?? null,
      probeErrors: probe?.errors ?? null,
      baseline: probe?.baseline ? { mismatchCount: probe.baseline.mismatchCount, mismatches: probe.baseline.mismatches.slice(0, 20) } : null,
      control: probe?.control ?? null,
      perturbations: (probe?.perturbations ?? []).map((entry) => ({ member: entry.member, expected: entry.expectedSlots.length, changed: entry.changedSlots.length, exact: entry.exact, unidentified: entry.unidentified.slice(0, 8), silent: entry.silent.slice(0, 8) })),
      consoleErrors: consoleMessages.filter((message) => message.type === "error").map((message) => message.text),
    },
  };
}

/**
 * Run the gate's real-device assertion.
 *
 * @param {{quiet?: boolean, layout?: object, wgsl?: string, channel?: string, headed?: boolean, timeoutMs?: number}} [options]
 */
export async function runGpu(options = {}) {
  const quiet = options.quiet === true;
  const prepared = options.layout !== undefined && options.wgsl !== undefined ? null : prepareLayout();
  const layout = options.layout ?? prepared.layout;
  const wgsl = options.wgsl ?? prepared.wgsl;
  const baseline = prepared?.baseline ?? writeStructBytes(layout, { salt: 0 });
  const expectedSlots = prepared?.expectedSlots ?? expectedSlotBytes(layout, baseline);
  const perturbations = prepared?.perturbations ?? layout.members.map((member) => ({ member: member.name, plan: writeStructBytes(layout, { perturb: member.name, perturbSalt: 1 }), expectedSlots: slotIndicesForMember(layout, member.name) }));
  const input = buildInput({ layout, wgsl, baseline, expectedSlots, perturbations });

  const run = await runProbeInBrowser({ input, quiet, channel: options.channel, headed: options.headed, timeoutMs: options.timeoutMs });

  const report = {
    tool: "g4-uniform-layout/run-gpu",
    recordedAt: new Date().toISOString(),
    node: process.version,
    environment: run.environment,
    checks: run.checks,
    measurements: run.measurements,
    findings: [
      {
        id: "F-1",
        title: "尖刺手法复用方式的偏离（更强而非更弱）",
        detail:
          "T019 (b) 要求「复用尖刺真机 harness 手法（identity 矩阵 + 已知纹素回读）断言地形全部 uniform 生效」。本门禁保留「真机 pipeline + 已知纹素回读」的手法，" +
          "但把范围从「一个 identity 矩阵」扩展到**生成布局中的全部 uniform**：每个 (成员, 数组元素, 矩阵列) 各占一个像素，值由 CPU 布局表写入，" +
          "并额外做**逐成员扰动矩阵**（改动某成员的值只允许改变该成员的 slot）。这比单一 identity 矩阵更强，且能逐字段定位错误。",
        followUp: ["T044/T046（uniform 上传与通道状态机）以本门禁的布局表为输入"],
      },
      {
        id: "F-2",
        title: "验证程序只证明「布局与 WGSL struct 一致」，不证明着色器发射正确",
        detail:
          "本门禁的 WGSL 是由生成器为验证目的发射的（struct + 逐 slot switch），并非地形着色器的 WGSL 移植产物 —— 后者是 G-5（T022–T024）的范围。" +
          "因此本门禁的结论边界是：**布局生成器与 WGSL 结构逐字段一致，且每个字段在真机上确实按该偏移被读取**。",
        followUp: ["G-5（T022–T024）"],
      },
      {
        id: "F-3",
        title: "真机断言抓到过三处错误的布局假设（阴性对照 `--control=shift-offsets` 是这件事的制度化）",
        detail:
          "生成器最初按教科书写法实现 uniform 规则，真机读数推翻了其中三处：① `vec3<f32>` 必须按 16 字节对齐（而非 12）；② 数组自身只按其元素对齐（不向 16 取整）；" +
          "③ 数组元素 stride = `roundUp(SizeOf(E), AlignOf(E))`（`array<f32,2>` 实测为 4 字节，而非 16）。" +
          "`--control=shift-offsets` 把「偏移写错必须被检出」变成常态检查：把某个成员的标量偏移故意后移 4 字节后，基线比对必须报出不一致。",
        followUp: ["每个目标实现上重跑本门禁（见 g4.json 的 packed-scalar-arrays-declared 风险项）"],
      },
    ],
  };

  fs.writeFileSync(path.join(OUT_DIR, "g4-gpu.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { ...report, probe: run.probe };
}

/**
 * Negative control: deliberately corrupt the CPU layout table (shift one member's scalars by 4 bytes)
 * and require the same device assertions to **detect** it. A device assertion that cannot fail proves
 * nothing; this is the G-4 counterpart of G-1's `--control=no-rewrite`.
 */
export async function runNegativeControl(options = {}) {
  const quiet = options.quiet === true;
  const { layout, wgsl, baseline, expectedSlots, perturbations } = prepareLayout();
  const shiftedMember = layout.members[0];
  const corrupted = {
    ...baseline,
    plan: baseline.plan.map((entry) => (entry.member === shiftedMember.name ? { ...entry, byteOffset: entry.byteOffset + 4 } : entry)),
  };
  const input = buildInput({ layout, wgsl, baseline: corrupted, expectedSlots, perturbations });
  const run = await runProbeInBrowser({ input, quiet, inputFile: path.join(OUT_DIR, "g4-control-shift-input.json"), writeWgsl: false, channel: options.channel, headed: options.headed, timeoutMs: options.timeoutMs });

  const mismatchCount = run.measurements.baseline?.mismatchCount ?? -1;
  const shiftedSlots = slotIndicesForMember(layout, shiftedMember.name);
  const mismatchingSlots = [...new Set((run.measurements.baseline?.mismatches ?? []).map((entry) => entry.slot))];
  const checks = [
    check("control-probe-ran", run.probe !== null && run.measurements.compilation?.errors === 0, `the control run compiled the same generated WGSL (errors=${run.measurements.compilation?.errors ?? "n/a"}) and produced a readback`),
    check(
      "control-detects-shifted-byte-offset",
      mismatchCount > 0,
      `with "${shiftedMember.name}" written 4 bytes later than the table claims, the device readback MUST disagree with the CPU expectation: mismatching component(s)=${mismatchCount}` +
        `${mismatchCount > 0 ? ` (first: ${JSON.stringify(run.measurements.baseline.mismatches.slice(0, 4))})` : " — the assertion would be vacuous"}`,
    ),
    check(
      "control-localises-the-error-to-the-shifted-member",
      mismatchingSlots.length > 0 && mismatchingSlots.every((slot) => shiftedSlots.includes(slot)),
      `the mismatching slots MUST be exactly the shifted member's slots: mismatching=${JSON.stringify(mismatchingSlots)} vs shifted member "${shiftedMember.name}" slots=${JSON.stringify(shiftedSlots)} ` +
        "(the readback comparison localises a wrong byteOffset to the affected field instead of failing globally)",
    ),
    check("control-render-is-deterministic", (run.measurements.control?.changedSlots?.length ?? -1) === 0, `re-writing the same (shifted) plan changed ${run.measurements.control?.changedSlots?.length ?? "?"} slot(s) — the comparison itself stays deterministic`),
  ];
  const verdict = checks.every((entry) => entry.ok === true) ? "pass" : "fail";
  const artifact = {
    gate: "g4-control-shift",
    task: "T019 (negative control)",
    verdict,
    recordedAt: new Date().toISOString(),
    notes:
      `G-4 阴性对照：把 CPU 布局表中 "${shiftedMember.name}" 的标量偏移**故意整体后移 4 字节**（其余不变），再跑同一套真机断言。` +
      "verdict=pass 的含义是：**判定器确实能识别偏移错误**（真机回读与 CPU 期望不一致）。若此处 mismatch=0，则 G-4 的正向结论不可信。" +
      "对照运行不写 g4-gpu.json，也不改变门禁结论。",
    environment: run.environment,
    checks,
    evidence: [
      { path: "experiments/gates/out/g4-control-shift-input.json", what: "the corrupted byte-write plan (member 0 shifted by +4 bytes) together with the uncorrupted expectation" },
      { path: "experiments/gates/out/g4-control-shift.json", what: "this artefact" },
      { path: "experiments/gates/out/g4-gpu.json", what: "the gate's real-device assertion this control underpins" },
    ].filter((entry) => fs.existsSync(path.resolve(REPO_ROOT, entry.path))),
    measurements: { shiftedMember: shiftedMember.name, shiftedSlots, mismatchingSlots, mismatchCount, control: run.measurements.control, compilation: run.measurements.compilation },
  };
  fs.writeFileSync(path.join(OUT_DIR, "g4-control-shift.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  if (!quiet) {
    for (const entry of checks) process.stdout.write(`  [${entry.ok ? "ok" : "FAIL"}] ${entry.id}: ${entry.detail}\n`);
  }
  return artifact;
}

function parseArgs(argv) {
  const options = { quiet: argv.includes("--quiet"), headed: argv.includes("--headed"), channel: undefined, timeoutMs: 240000, control: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(0, eq) : token;
    const value = eq >= 0 ? token.slice(eq + 1) : undefined;
    if (key === "--channel") options.channel = value ?? argv[++index];
    else if (key === "--timeout") options.timeoutMs = Number(value ?? argv[++index]);
    else if (key === "--control") options.control = value ?? argv[++index];
  }
  if (options.control !== null && options.control !== "shift-offsets") throw new Error(`unknown control "${options.control}" (only "shift-offsets")`);
  return options;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  const run = options.control === "shift-offsets" ? runNegativeControl(options) : runGpu(options);
  run
    .then((report) => {
      for (const entry of report.checks) process.stdout.write(`  [${entry.ok ? "ok" : "FAIL"}] ${entry.id}: ${entry.detail}\n`);
      const failed = report.checks.filter((entry) => entry.ok !== true);
      const target = options.control === "shift-offsets" ? "experiments/gates/out/g4-control-shift.json" : "experiments/gates/out/g4-gpu.json";
      process.stdout.write(`[g4-gpu] ${report.checks.length - failed.length}/${report.checks.length} checks ok -> ${target}\n`);
      process.exitCode = failed.length === 0 ? 0 : 1;
    })
    .catch((error) => {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(OUT_DIR, "g4-gpu.json"),
        `${JSON.stringify({ tool: "g4-uniform-layout/run-gpu", verdict: "fail", recordedAt: new Date().toISOString(), error: { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack ?? null }, checks: [check("gpu-harness-ran", false, `harness threw: ${error?.message ?? error}`)] }, null, 2)}\n`,
        "utf8",
      );
      process.stderr.write(`g4-run-gpu: unexpected failure: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    });
}
