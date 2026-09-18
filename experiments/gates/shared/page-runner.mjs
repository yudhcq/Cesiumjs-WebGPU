/**
 * Shared gate helper — run one gate page in a real (headless, zero-flag) Chrome and collect the
 * result object the page publishes on a global.
 *
 * Used by the G-5 harness (`tools/shader-verify.mjs`) and by G-6's two device halves, so all gates
 * observe the *same* environment shape (browser version, adapter info, page errors) and the same
 * discipline: no browser flags, a static server over the repository root, one page per run.
 *
 * Node-only, cross-platform.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createStaticServer } from "../../../tools/scripts/serve.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function repoRelative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

/**
 * @param {{page: string, globalName: string, input: object, inputFile: string, quiet?: boolean,
 *          channel?: string, headed?: boolean, timeoutMs?: number}} options
 * @returns {Promise<{collected: object|null, runtimeError: string|null, pageErrors: string[], browserVersion: string}>}
 */
export async function runGatePage(options) {
  const log = (line) => {
    if (options.quiet !== true) process.stdout.write(`[gate-page] ${line}\n`);
  };
  fs.mkdirSync(path.dirname(options.inputFile), { recursive: true });
  fs.writeFileSync(options.inputFile, JSON.stringify(options.input), "utf8");

  const server = createStaticServer({ root: REPO_ROOT });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/${repoRelative(options.page)}?input=${encodeURIComponent(`/${repoRelative(options.inputFile)}`)}`;

  let browser = null;
  let collected = null;
  let runtimeError = null;
  const pageErrors = [];
  let browserVersion = "none";
  try {
    browser = await chromium.launch({
      channel: options.channel ?? process.env.GATE_BROWSER_CHANNEL ?? "chrome",
      headless: options.headed !== true,
    });
    browserVersion = browser.version();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(`${error.name ?? "Error"}: ${error.message ?? String(error)}`));
    log(`opening ${url} (browser ${browserVersion})`);
    await page.goto(url, { waitUntil: "load", timeout: options.timeoutMs ?? 1800000 });
    await page.waitForFunction(
      (name) => globalThis[name] !== undefined && globalThis[name].ready === true,
      options.globalName,
      { timeout: options.timeoutMs ?? 1800000 },
    );
    collected = await page.evaluate((name) => globalThis[name], options.globalName);
  } catch (error) {
    runtimeError = `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
  } finally {
    if (browser !== null) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
  return { collected, runtimeError, pageErrors, browserVersion };
}

/** Histogram of a list of millisecond samples (shared by G-6's two halves so the shape matches). */
export function histogram(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted.length === 0 ? 0 : sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    mean: sorted.length === 0 ? 0 : total / sorted.length,
    totalMs: total,
    buckets: [
      [0, 5], [5, 10], [10, 20], [20, 40], [40, 80], [80, 160], [160, 320], [320, Infinity],
    ].map(([low, high]) => ({ low, high: high === Infinity ? null : high, count: sorted.filter((value) => value >= low && value < high).length })),
  };
}
