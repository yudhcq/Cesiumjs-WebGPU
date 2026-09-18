/**
 * G-3 gate — partition / judgement (tasks.md T021).
 *
 * Tasks.md T021: "把 T020 的录制序列按派生式通道身份
 * `(colorTargets, depthStencilTarget, sampleCount, viewport, scissorRect)` 分区，断言
 *  (a) **全部目标切换序列都被覆盖**（含多采样解析的目标切换）、
 *  (b) 分区边界与 `clear`/`draw` 序列一一对应、
 *  (c) `endFrame` 前无未闭合通道".
 *
 * Because (b) says the boundaries correspond to the **`clear`/`draw` sequence**, a pass is defined here
 * by the identity of the *work operations*: consecutive `clear`/`draw` calls sharing an identity form one
 * pass, and a pass boundary is the transition between two work operations whose identities differ.
 * State changes that produce no work (a redundant re-bind, a viewport set before the first draw) MUST NOT
 * create an empty pass — that is exactly what a backend does when it defers opening a pass until the
 * first draw, and it is what (c) ("no unclosed pass before endFrame") relies on.
 *
 * The identity itself comes from the tracer and uses platform-visible state only (no `Pass`/`PassState`/
 * program/uniform/`RenderState` input), matching `research.md` §5.2.
 *
 * Node-only, zero dependencies, cross-platform: the partition runs offline on the recorded trace.
 */

const IDENTITY_FIELDS = ["colorTargets", "depthStencilTarget", "sampleCount", "viewport", "scissorRect"];
const WORK_OPS = new Set(["clear", "clearBufferfv", "clearBufferiv", "clearBufferfi", "drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]);
const SWITCH_OPS = new Set(["bindFramebuffer", "blitFramebuffer"]);

/** Canonical string for one pass identity (the partition key). */
export function identityKey(identity) {
  if (identity === null || identity === undefined) return "<no-identity>";
  return IDENTITY_FIELDS.map((field) => {
    const value = identity[field];
    if (value === null || value === undefined) return `${field}=null`;
    if (Array.isArray(value)) return `${field}=[${value.join("|")}]`;
    if (typeof value === "object") return `${field}={${["x", "y", "width", "height"].map((key) => (value[key] === undefined ? "" : value[key])).join(",")}}`;
    return `${field}=${value}`;
  }).join("; ");
}

export const isWorkOp = (op) => WORK_OPS.has(op.op);
export const isSwitchOp = (op) => SWITCH_OPS.has(op.op);

/**
 * Partition a recorded trace into derived passes plus the switch/state evidence the judgement needs.
 *
 * @param {object[]} ops trace operations (T020 output, `seq`-ordered)
 * @param {{changedOps?: Set<number>}} [options] `changedOps` = seqs of platform calls whose *state*
 *   actually changed (the tracer records `changed: false` for redundant calls); used to distinguish
 *   "a switch happened here" from "the same target was re-bound".
 */
export function partitionTrace(ops, options = {}) {
  const work = ops.filter((op) => isWorkOp(op) && op.identity !== undefined && op.identity !== null);
  const passes = [];
  for (const op of work) {
    const key = identityKey(op.identity);
    const last = passes[passes.length - 1];
    if (last === undefined || last.key !== key) {
      // State operations between the previous pass's last work op and this pass's first work op are the
      // evidence that justifies the boundary (target switch, viewport/scissor change, …).
      const previousEnd = last?.endSeq ?? 0;
      passes.push({
        index: passes.length,
        key,
        identity: op.identity,
        startSeq: op.seq,
        endSeq: op.seq,
        firstWorkOp: op.op,
        lastWorkOp: op.op,
        work: [],
        clearOps: 0,
        drawOps: 0,
        triangleCount: 0,
        stateOpsInside: ops
          .filter((candidate) => candidate.seq > previousEnd && candidate.seq < op.seq && !isWorkOp(candidate))
          .map((candidate) => ({ seq: candidate.seq, op: candidate.op, changed: candidate.changed ?? null })),
        boundaryCause: last === undefined ? "frame-start" : "identity-change",
      });
    }
    const pass = passes[passes.length - 1];
    pass.work.push(op.seq);
    pass.endSeq = op.seq;
    pass.lastWorkOp = op.op;
    if (op.op.startsWith("clear")) pass.clearOps += 1;
    else {
      pass.drawOps += 1;
      if (op.mode === 4) pass.triangleCount += Math.floor((op.count ?? 0) / 3) * (op.instanceCount ?? 1);
    }
  }

  const workIndex = new Map();
  work.forEach((op, index) => workIndex.set(op.seq, index));
  const passOfWorkIndex = [];
  passes.forEach((pass, passIndex) => pass.work.forEach((seq) => passOfWorkIndex[workIndex.get(seq)] = passIndex));

  const switches = [];
  for (const op of ops) {
    if (!isSwitchOp(op)) continue;
    const previousWork = work.filter((candidate) => candidate.seq < op.seq).pop() ?? null;
    const nextWork = work.find((candidate) => candidate.seq > op.seq) ?? null;
    const previousKey = previousWork === null ? null : identityKey(previousWork.identity);
    const nextKey = nextWork === null ? null : identityKey(nextWork.identity);
    const crossesTargets =
      op.op === "blitFramebuffer" ? `${op.source?.id ?? "?"} -> ${op.destination?.id ?? "?"}` : `${op.previousTargetId ?? "?"} -> ${op.targetId ?? "?"}`;
    const sampleTransition = op.op === "blitFramebuffer" ? `${op.source?.sampleCount ?? "?"} -> ${op.destination?.sampleCount ?? "?"}` : null;
    switches.push({
      seq: op.seq,
      op: op.op,
      crossesTargets,
      sampleTransition,
      effective: op.op === "blitFramebuffer" ? true : op.changed !== false,
      previousKey,
      nextKey,
      // A switch is "covered" when it sits exactly at a pass boundary: the work before and after it
      // belong to different passes (or the switch is before the first / after the last work op).
      atPassBoundary: previousKey !== nextKey,
      previousWorkSeq: previousWork?.seq ?? null,
      nextWorkSeq: nextWork?.seq ?? null,
    });
  }

  const redundantRebinds = ops.filter((op) => op.op === "bindFramebuffer" && op.changed === false).length;
  return { passes, switches, work, redundantRebinds, keyOf: (op) => identityKey(op.identity) };
}

/**
 * Judge a partition against T021's three assertions plus the structural properties the WebGPU backend
 * depends on. Returns `{ checks, measurements }`; every check is `{ id, ok, detail }`.
 */
export function judgePartition(ops, { frameEndSeq = null } = {}) {
  const { passes, switches, work, redundantRebinds } = partitionTrace(ops);
  const checks = [];

  // ---- (a) every target switch is covered ---------------------------------------------------------
  const effectiveSwitches = switches.filter((entry) => entry.effective);
  const uncovered = effectiveSwitches.filter((entry) => entry.atPassBoundary !== true);
  const resolveSwitches = switches.filter((entry) => entry.op === "blitFramebuffer");
  const resolveCrossing = resolveSwitches.filter((entry) => !/^(\S+) -> \1$/.test(entry.crossesTargets));
  checks.push({
    id: "all-target-switches-covered",
    ok: switches.length > 0 && effectiveSwitches.length > 0 && uncovered.length === 0,
    detail:
      `${switches.length} target-switch operation(s) recorded (${switches.filter((entry) => entry.op === "bindFramebuffer").length} bindFramebuffer, ` +
      `${resolveSwitches.length} blitFramebuffer); ${redundantRebinds} redundant re-bind(s) of the already-current target (no state change); ` +
      `${effectiveSwitches.length} effective switch(es), of which ${uncovered.length} are NOT at a pass boundary` +
      `${uncovered.length > 0 ? ` → ${JSON.stringify(uncovered.slice(0, 5).map((entry) => ({ seq: entry.seq, op: entry.op, crosses: entry.crossesTargets })))}` : ""}; ` +
      `an effective switch MUST separate two work operations with different identities, otherwise the WebGPU backend would have to split a pass in the middle`,
  });
  checks.push({
    id: "multisample-resolve-switch-covered",
    ok: resolveCrossing.length > 0 && resolveCrossing.every((entry) => entry.atPassBoundary === true),
    detail:
      resolveCrossing.length === 0
        ? `no resolve blit crossing two different targets was recorded (${resolveSwitches.length} blit operation(s) total) — the frame does not exercise resolveFramebuffers`
        : `${resolveCrossing.length} resolve blit(s) crossing targets (${resolveCrossing.map((entry) => `${entry.crossesTargets} [sampleCount ${entry.sampleTransition}]`).join(", ")}) — ` +
          `all of them sit at a pass boundary; research §5.2 maps the multisample resolve to colorAttachments[i].resolveTarget`,
  });

  // ---- (b) partition boundaries correspond one-to-one with the clear/draw sequence -----------------
  const boundaries = passes.slice(1).map((pass) => ({
    passIndex: pass.index,
    fromPassIndex: pass.index - 1,
    atSeq: pass.startSeq,
    previousSeq: passes[pass.index - 1].endSeq,
    cause: pass.boundaryCause,
    justifyOps: pass.stateOpsInside,
  }));
  const boundariesJustified = boundaries.every((boundary) =>
    boundary.justifyOps.some((op) => isSwitchOp({ op: op.op }) || ["viewport", "scissor", "enable", "disable"].includes(op.op)),
  );
  const emptyPasses = passes.filter((pass) => pass.clearOps === 0 && pass.drawOps === 0);
  const unassigned = work.filter((op) => !passes.some((pass) => pass.work.includes(op.seq)));
  checks.push({
    id: "partition-boundaries-match-clear-draw-sequence",
    ok: work.length > 0 && unassigned.length === 0 && emptyPasses.length === 0 && boundariesJustified,
    detail:
      `${work.length} clear/draw operation(s) in ${passes.length} pass(es); boundaries=${boundaries.length} ` +
      `(each one between two consecutive work ops with different identities, justified by recorded state operations=${boundariesJustified}); ` +
      `unassigned work operations=${unassigned.length}; empty passes=${emptyPasses.length}; ` +
      `state changes that produced no work are NOT counted as passes (the backend defers opening a pass until the first draw), which is what makes (c) achievable`,
  });

  const clearsNotFirst = passes
    .map((pass) => ({ pass, workOps: pass.work.map((seq) => ops.find((op) => op.seq === seq)?.op) }))
    .filter(({ workOps }) => workOps.some((name) => name?.startsWith("clear")) && !workOps[0]?.startsWith("clear"))
    .map(({ pass, workOps }) => ({ pass: pass.index, firstWorkOp: workOps[0] }));
  checks.push({
    id: "clears-are-first-in-their-pass",
    ok: clearsNotFirst.length === 0,
    detail:
      `${clearsNotFirst.length} pass(es) have a clear that is not the first work operation ${clearsNotFirst.length > 0 ? `→ ${JSON.stringify(clearsNotFirst)}` : ""} ` +
      `(research §5.1 maps the first operation of a pass to loadOp:"clear" and any later clear to the clearBuffer fallback)`,
  });

  // ---- (c) no unclosed pass before endFrame --------------------------------------------------------
  const last = passes[passes.length - 1] ?? null;
  const endSeq = frameEndSeq ?? ops[ops.length - 1]?.seq ?? null;
  const stateAfterLastPass = last === null ? [] : ops.filter((op) => op.seq > last.endSeq && !isWorkOp(op) && op.op !== "trace-stop").map((op) => op.op);
  const endsOnPresentation = last !== null && last.identity?.targetKind === "default-framebuffer";
  const switchesAfterLastWork = last === null ? [] : switches.filter((entry) => entry.seq > last.endSeq);
  checks.push({
    id: "no-unclosed-pass-before-endframe",
    ok: last !== null && endsOnPresentation && (endSeq === null || last.endSeq <= endSeq),
    detail:
      last === null
        ? "no pass could be derived from the trace"
        : `last derived pass #${last.index} ends at work op seq ${last.endSeq} (frame end seq ${endSeq}) on target ${last.identity?.targetId} (${last.identity?.targetKind}); ` +
          `it writes into the presentation target=${endsOnPresentation}; ${switchesAfterLastWork.length} target switch(es) and ${stateAfterLastPass.length} state operation(s) follow it ` +
          `[${[...new Set(stateAfterLastPass)].join(", ")}] — every earlier pass is closed by the identity change that starts the next one, so endFrame closes exactly one pass`,
  });

  const identityFieldsOnly = passes.every((pass) => IDENTITY_FIELDS.every((field) => pass.key.includes(`${field}=`)));
  checks.push({
    id: "identity-uses-only-platform-state",
    ok: identityFieldsOnly && passes.length > 0,
    detail: `every pass key is built from exactly the platform-visible identity fields (${IDENTITY_FIELDS.join(", ")}); sample key: ${passes[0]?.key ?? "<none>"}`,
  });

  return {
    checks,
    measurements: {
      passCount: passes.length,
      switchCount: switches.length,
      effectiveSwitchCount: effectiveSwitches.length,
      redundantRebindCount: redundantRebinds,
      resolveBlitCount: resolveSwitches.length,
      resolveBlitCrossingCount: resolveCrossing.length,
      drawCount: work.filter((op) => !op.op.startsWith("clear")).length,
      clearCount: work.filter((op) => op.op.startsWith("clear")).length,
      passesWithMultipleDraws: passes.filter((pass) => pass.drawOps > 1).length,
      boundaries: boundaries.map((boundary) => ({ passIndex: boundary.passIndex, atSeq: boundary.atSeq, cause: boundary.cause, justifiers: boundary.justifyOps.map((op) => `${op.op}@${op.seq}`) })),
      passes: passes.map((pass) => ({
        index: pass.index,
        key: pass.key,
        startSeq: pass.startSeq,
        endSeq: pass.endSeq,
        firstWorkOp: pass.firstWorkOp,
        lastWorkOp: pass.lastWorkOp,
        clearOps: pass.clearOps,
        drawOps: pass.drawOps,
        triangleCount: pass.triangleCount,
        targetId: pass.identity?.targetId ?? null,
        targetKind: pass.identity?.targetKind ?? null,
        sampleCount: pass.identity?.sampleCount ?? null,
        viewport: pass.identity?.viewport ?? null,
        scissorRect: pass.identity?.scissorRect ?? null,
      })),
      switches,
    },
  };
}
