/**
 * Suite lock (`tests/support/suite-lock.mjs`) — the mechanism that keeps suite runs serial on one
 * machine, which is a rule tasks.md states and the interaction/benchmark suites actually depend on.
 *
 * The assertions here are written so that each one **can** fail for the reason it names:
 *   - two real processes are raced, and their recorded hold intervals must not overlap (a lock that
 *     never blocks anything would fail this);
 *   - the loser must actually have waited (a lock that "waits" for 0 ms would fail this);
 *   - a lock whose holder is gone, and one held past `staleMs`, must both be **stolen** (a lock that
 *     deadlocks the pipeline after a killed run would fail this);
 *   - a timeout must throw **and leave the live holder's lock in place** (a lock that cleans up
 *     someone else's lock on timeout would fail this).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { acquireSuiteLock } from "../support/suite-lock.mjs";
import { repoPath } from "../support/repo.mjs";

const HOLDER = repoPath("tests/support/suite-lock-holder.mjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "suite-lock-test-"));
}

function runHolder(lockFile, logFile, holdMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOLDER, lockFile, logFile, String(holdMs)], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

function parseLog(logFile) {
  const records = new Map();
  for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 0 || parts[0] === "") continue;
    const [pid, kind, a, b] = parts;
    const record = records.get(pid) ?? {};
    if (kind === "start") {
      record.requestedAt = Number(a);
      record.acquiredAt = Number(b);
    } else {
      record.releasedAt = Number(a);
    }
    records.set(pid, record);
  }
  return [...records.values()];
}

function quietLogger() {
  const lines = { log: [], warn: [] };
  return { lines, log: (message) => lines.log.push(message), warn: (message) => lines.warn.push(message) };
}

test("two live processes never hold the lock at the same time, and the loser actually waits", async () => {
  const dir = tempDir();
  const lockFile = path.join(dir, "suite.lock");
  const logFile = path.join(dir, "holds.log");
  const holdMs = 400;

  const [first, second] = await Promise.all([runHolder(lockFile, logFile, holdMs), runHolder(lockFile, logFile, holdMs)]);
  assert.equal(first, 0, "the first holder MUST exit cleanly");
  assert.equal(second, 0, "the second holder MUST exit cleanly");

  const holds = parseLog(logFile);
  assert.equal(holds.length, 2, "both processes MUST have recorded a hold");
  for (const hold of holds) {
    assert.ok(Number.isFinite(hold.requestedAt) && Number.isFinite(hold.acquiredAt) && Number.isFinite(hold.releasedAt));
    assert.ok(hold.acquiredAt >= hold.requestedAt, "a hold cannot be acquired before it was requested");
  }
  const [a, b] = holds;
  const overlap = Math.min(a.releasedAt, b.releasedAt) - Math.max(a.acquiredAt, b.acquiredAt);
  assert.ok(overlap <= 0, `the two holds MUST NOT overlap (overlap=${overlap} ms; holds=${JSON.stringify(holds)})`);

  const later = a.acquiredAt > b.acquiredAt ? a : b;
  assert.ok(
    later.acquiredAt - later.requestedAt >= holdMs / 2,
    `the losing process MUST have waited for the winner (waited=${later.acquiredAt - later.requestedAt} ms, hold=${holdMs} ms)`,
  );
  assert.equal(fs.existsSync(lockFile), false, "a released lock MUST be gone");
});

test("a lock whose holder is gone is stolen loudly instead of deadlocking the run", () => {
  const dir = tempDir();
  const lockFile = path.join(dir, "suite.lock");
  // A pid that cannot be running: pid reuse is irrelevant here because liveness is checked by pid.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483646, host: "gone", label: "killed run", startedAt: new Date().toISOString() }));
  const logger = quietLogger();
  const lock = acquireSuiteLock({ file: lockFile, label: "test", logger });
  try {
    assert.equal(lock.stolen, true, "an abandoned lock MUST be reported as stolen");
    assert.equal(logger.lines.warn.length, 1, "stealing MUST be loud (exactly one warning)");
    assert.match(logger.lines.warn[0], /stealing/, "the warning MUST say what happened");
    const holder = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    assert.equal(holder.pid, process.pid, "the lock MUST now name this process");
  } finally {
    lock.release();
  }
});

test("a lock held past staleMs is stolen even though its pid is alive", () => {
  const dir = tempDir();
  const lockFile = path.join(dir, "suite.lock");
  // Our own pid: alive by construction. Only the age can justify stealing it.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), label: "stuck run", startedAt: new Date(Date.now() - 60_000).toISOString() }));
  const logger = quietLogger();
  const lock = acquireSuiteLock({ file: lockFile, label: "test", staleMs: 1000, logger });
  try {
    assert.equal(lock.stolen, true, "a lock older than staleMs MUST be stolen");
  } finally {
    lock.release();
  }
});

test("waiting gives up loudly, and never removes a live holder's lock", () => {
  const dir = tempDir();
  const lockFile = path.join(dir, "suite.lock");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), label: "live holder", startedAt: new Date().toISOString() }));
  const logger = quietLogger();
  assert.throws(
    () => acquireSuiteLock({ file: lockFile, label: "test", waitMs: 700, staleMs: 60_000, logger }),
    /gave up after 700 ms waiting for pid/,
  );
  assert.equal(fs.existsSync(lockFile), true, "a timeout MUST NOT delete the live holder's lock");
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).label, "live holder", "the holder's record MUST be untouched");
});

test("the lock file records who holds it, so a stolen lock names the dead run", () => {
  const dir = tempDir();
  const lockFile = path.join(dir, "suite.lock");
  const lock = acquireSuiteLock({ file: lockFile, label: "webgpu suite A", logger: quietLogger() });
  try {
    const holder = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.label, "webgpu suite A");
    assert.ok(Number.isFinite(Date.parse(holder.startedAt)), "startedAt MUST be a parseable timestamp");
  } finally {
    lock.release();
  }
});
