#!/usr/bin/env node
/**
 * Vendor the upstream original `Renderer/Context.js` into the patch layer (plan.md decision D2-a).
 *
 * WHY A COPY IS NECESSARY
 *   The replacement manifest is **static**: `tools/rollup-plugin-engine-patch.mjs` rewrites *every*
 *   import that resolves to `<node_modules>/@cesium/engine/Source/Renderer/<X>.js` into the patch
 *   layer, no matter which specifier was used to reach it (`../Renderer/Context.js`,
 *   `@cesium/engine/Source/Renderer/Context.js`, an absolute path — all of them). There is therefore
 *   no specifier left that can reach the upstream `Context` inside a patched build. The only way to
 *   keep the WebGL2 implementation available for the construction-time whole delegation that D2-a
 *   mandates is to **carry a copy** inside the patch layer.
 *
 * WHAT IS REWRITTEN (and what is not)
 *   Only the import block is rewritten: `./X.js` → `@cesium/engine/Source/Renderer/X.js`,
 *   `../Core/X.js` → `@cesium/engine/Source/Core/X.js`, `../Shaders/X.js` →
 *   `@cesium/engine/Source/Shaders/X.js`. The bare deep specifiers keep the *same* resolution
 *   semantics as the logic layer's own imports, so the build produces a single consistent module
 *   universe (no second copy of the Renderer stack). **Everything after the import block is
 *   byte-identical**: `PROVENANCE.json` records the upstream sha256 and this script re-checks the
 *   body hash, and `tests/unit/context-construction.test.mjs` re-verifies it against the installed
 *   package so upstream drift cannot go unnoticed.
 *
 * BOUNDARY (recorded, not hidden)
 *   In W2 only `Context.js` is vendored, so the delegated object is the genuine upstream context and
 *   its construction path (`ContextLimits` publication, capability flags, `id`, default texture) is
 *   upstream code. The upstream Renderer *resource* classes it reaches (`Texture`, `Buffer`, …) are
 *   still the patch layer's own modules — the WebGL2 build-out of those belongs to W3 (WebGPU
 *   implementations) and to the W6 fallback wiring (T100/T101). Any capability that cannot be
 *   delegated yet fails **loudly** with a `not-implemented` diagnostic; it is never silently ignored.
 *
 * Usage: `node tools/scripts/vendor-upstream-webgl2-context.mjs [--check]`
 *   `--check` verifies the vendored copy still matches the installed upstream (non-zero exit on
 *   drift) instead of rewriting it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT, hashText, sha256Hex } from "../lib/patch-layer.mjs";

const UPSTREAM_RELATIVE = "node_modules/@cesium/engine/Source/Renderer/Context.js";
const VENDOR_DIR_RELATIVE = "packages/cesium-webgpu/backend-webgpu/vendor/upstream-webgl2";
const VENDORED_FILE = "Context.js";
const PROVENANCE_FILE = "PROVENANCE.json";

/** The header that turns the copy into a *derived* file (Apache-2.0 §4(b) modification notice). */
const HEADER = `/**
 * @license
 * Copyright 2011-2024 CesiumJS Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for WebGPU backend: VERBATIM COPY of the upstream module
 * \`Source/Renderer/Context.js\` from @cesium/engine 26.3.0, kept at a patch-layer-private path so the
 * replacement \`Renderer/Context.ts\` can perform the **construction-time whole delegation** required by
 * plan.md decision D2-a (research §3 step 4) when the device hand-off slot is empty.
 *
 * The ONLY modification is the import block: relative specifiers were rewritten to the equivalent
 * bare deep specifiers (which resolve to the same files) so the module can live outside the upstream
 * Source tree. Everything after the import block is byte-identical to upstream — asserted by
 * \`tests/unit/context-construction.test.mjs\` and recorded in \`PROVENANCE.json\`; regenerate with
 * \`node tools/scripts/vendor-upstream-webgl2-context.mjs\`.
 *
 * The file is DORMANT unless the whole delegation actually happens: nothing imports it on the WebGPU
 * path, so it never acquires a GL context, never holds a device and never draws (plan.md D2-a).
 */
`;

/**
 * Rewrite one relative specifier to the equivalent bare deep specifier.
 *
 * @param {string} specifier the original specifier, e.g. `"../Core/defined.js"`
 * @returns {string} e.g. `"@cesium/engine/Source/Core/defined.js"`
 */
function toBareDeepSpecifier(specifier) {
  if (specifier.startsWith("./")) return `@cesium/engine/Source/Renderer/${specifier.slice(2)}`;
  if (specifier.startsWith("../Core/")) return `@cesium/engine/Source/Core/${specifier.slice("../Core/".length)}`;
  if (specifier.startsWith("../Shaders/")) return `@cesium/engine/Source/Shaders/${specifier.slice("../Shaders/".length)}`;
  if (specifier.startsWith("../")) return `@cesium/engine/Source/${specifier.slice(3)}`;
  return specifier;
}

/** Split a module into `{ imports, body }`: the leading import run and everything after it. */
export function splitImports(source) {
  const lines = source.split("\n");
  let index = 0;
  while (index < lines.length && (lines[index].startsWith("import ") || lines[index].trim() === "")) index += 1;
  // `index` is now the first non-import, non-blank line.
  return { imports: lines.slice(0, index).join("\n"), body: lines.slice(index).join("\n") };
}

/** Build the vendored text from the upstream text (imports rewritten, header prepended). */
export function buildVendoredSource(upstreamText) {
  const { imports, body } = splitImports(upstreamText);
  const rewritten = imports.replace(/from "([^"]+)"/g, (match, specifier) => `from "${toBareDeepSpecifier(specifier)}"`);
  return { text: `${HEADER}\n${rewritten}\n\n${body}`, body };
}

function main() {
  const check = process.argv.includes("--check");
  const upstreamPath = path.join(REPO_ROOT, ...UPSTREAM_RELATIVE.split("/"));
  if (!fs.existsSync(upstreamPath)) {
    process.stderr.write(`vendor-upstream-webgl2-context: upstream module missing at ${UPSTREAM_RELATIVE}\n`);
    return 2;
  }
  const upstreamText = fs.readFileSync(upstreamPath, "utf8");
  const { text, body } = buildVendoredSource(upstreamText);
  const vendorDir = path.join(REPO_ROOT, ...VENDOR_DIR_RELATIVE.split("/"));
  const vendoredPath = path.join(vendorDir, VENDORED_FILE);
  const provenancePath = path.join(vendorDir, PROVENANCE_FILE);

  if (check) {
    if (!fs.existsSync(vendoredPath) || !fs.existsSync(provenancePath)) {
      process.stderr.write("vendor-upstream-webgl2-context: the vendored copy or its provenance record is missing\n");
      return 1;
    }
    const record = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
    const currentBody = splitImports(fs.readFileSync(vendoredPath, "utf8")).body;
    const problems = [];
    if (record.upstreamSha256 !== sha256Hex(upstreamText)) {
      problems.push(`upstream Context.js changed: recorded ${record.upstreamSha256}, installed ${sha256Hex(upstreamText)}`);
    }
    if (record.bodySha256 !== hashText(body)) {
      problems.push(`the vendored body no longer matches the upstream body: recorded ${record.bodySha256}, expected ${hashText(body)}`);
    }
    if (record.vendoredBodySha256 !== hashText(currentBody)) {
      problems.push("the vendored file was edited after vendoring (its body no longer matches PROVENANCE.json)");
    }
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`vendor-upstream-webgl2-context: ${problem}\n`);
      return 1;
    }
    process.stdout.write(`vendor-upstream-webgl2-context: check ok (upstream ${record.upstreamSha256})\n`);
    return 0;
  }

  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(vendoredPath, text, "utf8");
  fs.writeFileSync(
    provenancePath,
    `${JSON.stringify(
      {
        tool: "tools/scripts/vendor-upstream-webgl2-context.mjs",
        why:
          "plan.md decision D2-a: the manifest is static, so every route to the upstream Renderer/Context.js is rewritten by " +
          "tools/rollup-plugin-engine-patch.mjs. The construction-time whole delegation therefore needs a copy inside the patch layer.",
        upstream: { path: UPSTREAM_RELATIVE, package: "@cesium/engine", version: "26.3.0" },
        upstreamSha256: sha256Hex(upstreamText),
        bodySha256: hashText(body),
        vendoredBodySha256: hashText(splitImports(text).body),
        modification: "import block only: relative specifiers → equivalent bare deep specifiers; license/modification header prepended",
        boundary:
          "W2 vendors Context.js only. The Renderer resource classes it reaches are still patch-layer modules; the full WebGL2 " +
          "fallback build-out belongs to W3 (resource implementations) and W6 (T100/T101). Undelegatable capabilities fail loudly.",
        regeneratedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.stdout.write(`vendor-upstream-webgl2-context: wrote ${VENDOR_DIR_RELATIVE}/${VENDORED_FILE} (${text.length} bytes)\n`);
  return 0;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = main();
}
