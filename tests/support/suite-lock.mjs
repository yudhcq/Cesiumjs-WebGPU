/**
 * Cross-process suite lock — one suite run at a time, on this machine.
 *
 * Why this exists (and is enforced rather than documented):
 *
 *   - tasks.md states the rule for the acceptance suites ("每条路径各自…串行执行以免违反『每次只启用
 *     一条路径』"): the suites of one phase MUST NOT run at the same moment. Two concurrent Chromes on
 *     one GPU also distort exactly the quantities the interaction and benchmark suites measure
 *     (frame-time percentiles, `>1000 ms` stall detection), so a concurrent run is not merely untidy —
 *     it can turn a real pass into a false failure, or a real failure into a flaky pass.
 *   - Every suite run rebuilds/validates the same bundle path (`artifacts/contract/<backend>/bundle.js`)
 *     through `ensureBundle`. Two runs that build at once can read each other's half-written sources.
 *
 * The lock is a single file created with `wx` (exclusive create), so the kernel arbitrates rather than
 * a check-then-act race. It carries the holder's pid: a lock left behind by a killed process is stolen
 * loudly instead of deadlocking the pipeline, because "the CI hangs forever" is a worse failure than
 * "two runs overlapped once, and the log says so".
 *
 * Escape hatches, both explicit: `SUITE_LOCK_WAIT_MS` (how long to wait before giving up) and
 * `SUITE_LOCK_STALE_MS` (when a held lock counts as abandoned).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_WAIT_MS = 30 * 60 * 1000;
export const DEFAULT_STALE_MS = 30 * 60 * 1000;
const POLL_MS = 500;

/** Synchronous sleep: this runner is `spawnSync`-based, so waiting must not need the event loop. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** `EPERM` means the pid exists but belongs to another user — still a live holder. */
function holderIsAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Acquire the suite lock, waiting for a live holder.
 *
 * @param {{file: string, label?: string, waitMs?: number, staleMs?: number, logger?: {log: Function, warn: Function}, now?: () => number}} options
 * @returns {{release: () => void, waitedMs: number, stolen: boolean}}
 */
export function acquireSuiteLock(options) {
  const { file, label = "" } = options;
  const waitMs = options.waitMs ?? Number(process.env.SUITE_LOCK_WAIT_MS ?? DEFAULT_WAIT_MS);
  const staleMs = options.staleMs ?? Number(process.env.SUITE_LOCK_STALE_MS ?? DEFAULT_STALE_MS);
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const startedAt = now();
  let announced = false;
  let stolen = false;

  for (;;) {
    let handle = null;
    try {
      handle = fs.openSync(file, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (handle !== null) {
      try {
        fs.writeSync(
          handle,
          JSON.stringify({ pid: process.pid, host: os.hostname(), label, startedAt: new Date(now()).toISOString() }),
        );
      } finally {
        fs.closeSync(handle);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          fs.unlinkSync(file);
        } catch {
          // Already gone (stolen or cleaned): nothing to do, and nothing to report — the lock only
          // ever protects a run, it never asserts ownership afterwards.
        }
      };
      process.once("exit", release);
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => {
          release();
          process.exit(130);
        });
      }
      return { release, waitedMs: now() - startedAt, stolen };
    }

    const holder = readLock(file);
    const ageMs = holder === null || Number.isNaN(Date.parse(holder.startedAt ?? "")) ? Infinity : now() - Date.parse(holder.startedAt);
    const abandoned = holder === null || !holderIsAlive(holder.pid) || ageMs >= staleMs;
    if (abandoned) {
      // Loud on purpose: a stolen lock means the previous holder died mid-run, which is itself worth
      // seeing in the transcript.
      logger.warn(`suite-lock: stealing ${file} — holder=${JSON.stringify(holder)} ageMs=${Number.isFinite(ageMs) ? ageMs : "unreadable"}`);
      try {
        fs.unlinkSync(file);
      } catch {
        // Another waiter stole it first; loop and retry the exclusive create.
      }
      stolen = true;
      continue;
    }
    if (now() - startedAt >= waitMs) {
      throw new Error(
        `suite-lock: gave up after ${waitMs} ms waiting for pid ${holder.pid} (${holder.label}) to release ${file}. ` +
          "Suites run one at a time on purpose; re-run when it finishes, or set SUITE_LOCK_WAIT_MS.",
      );
    }
    if (!announced) {
      logger.log(`suite-lock: another suite run is in flight (pid ${holder.pid}, ${holder.label}) — waiting, suites run one at a time`);
      announced = true;
    }
    sleep(POLL_MS);
  }
}
