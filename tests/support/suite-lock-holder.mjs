/**
 * Test helper for `tests/unit/suite-lock.test.mjs` — a real second process that holds the suite lock.
 *
 * It exists as a file (rather than `node -e "…"`) because the assertion that matters is **mutual
 * exclusion between two live processes**, and inline `-e` code with Windows quoting rules is exactly
 * the kind of thing that silently turns a concurrency test into a no-op.
 *
 * Usage: `node tests/support/suite-lock-holder.mjs <lockFile> <logFile> <holdMs>`
 * Log format: `<pid> start <requestedAt> <acquiredAt>` then `<pid> end <releasedAt>`.
 */
import fs from "node:fs";

import { acquireSuiteLock } from "./suite-lock.mjs";

const [lockFile, logFile, holdMsRaw] = process.argv.slice(2);
if (lockFile === undefined || logFile === undefined) {
  console.error("usage: node tests/support/suite-lock-holder.mjs <lockFile> <logFile> <holdMs>");
  process.exit(2);
}
const holdMs = Number(holdMsRaw ?? 300);

const requestedAt = Date.now();
const lock = acquireSuiteLock({
  file: lockFile,
  label: "suite-lock-holder",
  // The helper is a measurement device, not a reporter: the assertions live in the test.
  logger: { log: () => {}, warn: () => {} },
});
const acquiredAt = Date.now();
fs.appendFileSync(logFile, `${process.pid} start ${requestedAt} ${acquiredAt}\n`);

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);

fs.appendFileSync(logFile, `${process.pid} end ${Date.now()}\n`);
lock.release();
