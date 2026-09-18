/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * **Conservative WGSL dead-declaration elimination** for the emitted module.
 *
 * Why this exists (measured, G-6/T025 revision 2): the whole `czm_` prelude is inlined into **both**
 * stages of every variant, but a variant only ever calls a fraction of it. Pipeline creation on the
 * measured device costs ~8.6 ms for a trivial module pair and ~107 ms for the emitted ~48 kB pair, so
 * the per-variant cost is dominated by module size — and the second half of the G-6 fix is exactly
 * this: emit only what the variant can reach. Measured effect: module pair 48 kB → 13 kB.
 *
 * The elimination is **conservative in one direction only**: it may keep a declaration it cannot prove
 * dead, but it MUST NOT drop one that is reachable.
 *
 * Ported from the verified G-5 gate implementation
 * (`experiments/gates/g5-shader/wgsl-prune.mjs`).
 *
 * Zero dependencies, cross-platform, no `node:` import.
 */

/** A column-0 line that begins a module-scope declaration. */
const DECLARATION_START = /^(?:fn\s|struct\s|const\s|var\s|alias\s|enable\s|diagnostic\s|requires\s|override\s)/;

/** A column-0 decorator line; when it carries no declaration it belongs to the declaration after it. */
const DECORATOR_LINE = /^@/;

const NAME_PATTERNS: readonly RegExp[] = [/^fn\s+([A-Za-z_]\w*)/m, /^struct\s+([A-Za-z_]\w*)/m, /^const\s+([A-Za-z_]\w*)/m, /^var\s*(?:<[^>]*>)?\s*([A-Za-z_]\w*)/m, /^alias\s+([A-Za-z_]\w*)/m, /^override\s+([A-Za-z_]\w*)/m];

const IDENTIFIER = /[A-Za-z_]\w*/g;

interface Chunk {
  readonly name: string | null;
  readonly text: string;
  readonly first: string;
  readonly preamble: boolean;
}

/** Split a WGSL module into top-level chunks, each starting at a column-0 declaration. */
export function splitDeclarations(text: string): Chunk[] {
  const chunks: { lines: string[]; header: string[]; preamble?: boolean }[] = [];
  let current: { lines: string[]; header: string[]; preamble?: boolean } | null = null;
  let pendingDecorators: string[] = [];
  const flush = (): void => {
    if (current !== null) chunks.push(current);
    current = null;
  };
  for (const line of text.split("\n")) {
    if (DECORATOR_LINE.test(line) && !DECLARATION_START.test(line)) {
      pendingDecorators.push(line);
      continue;
    }
    if (DECLARATION_START.test(line)) {
      flush();
      current = { header: [...pendingDecorators, line], lines: [...pendingDecorators, line] };
      pendingDecorators = [];
      continue;
    }
    if (current === null) {
      if (pendingDecorators.length > 0) {
        current = { header: [...pendingDecorators], lines: [...pendingDecorators] };
        pendingDecorators = [];
      } else {
        chunks.push({ preamble: true, lines: [line], header: [line] });
        continue;
      }
    }
    current.lines.push(line);
  }
  flush();
  if (pendingDecorators.length > 0) chunks.push({ preamble: true, lines: pendingDecorators, header: pendingDecorators });
  return chunks.map((chunk) => {
    let name: string | null = null;
    for (const pattern of NAME_PATTERNS) {
      const match = pattern.exec(chunk.header.join("\n"));
      if (match !== null) {
        name = match[1] ?? null;
        break;
      }
    }
    return { name, text: chunk.lines.join("\n"), first: chunk.lines[0] ?? "", preamble: chunk.preamble === true };
  });
}

/** Every identifier mentioned by a chunk (a superset of what it really references — deliberately). */
function identifiersOf(text: string): string[] {
  return text.match(IDENTIFIER) ?? [];
}

export interface PruneResult {
  readonly text: string;
  readonly kept: readonly string[];
  readonly dropped: readonly string[];
  readonly keptBytes: number;
  readonly droppedBytes: number;
}

/**
 * Drop the module-scope declarations the roots cannot reach.
 *
 * @param text preprocessed WGSL (inactive regions already gone — see `glsl-preprocess.ts`)
 * @param roots extra root names in addition to the module's entry points and resources
 */
export function pruneWgsl(text: string, { roots = [] }: { roots?: readonly string[] } = {}): PruneResult {
  const chunks = splitDeclarations(text);
  const byName = new Map<string, Chunk>();
  for (const chunk of chunks) if (chunk.name !== null && !byName.has(chunk.name)) byName.set(chunk.name, chunk);

  // A declaration carries an interface — and is therefore a root — when it is an entry point (a `fn`
  // under `@vertex`/`@fragment`/`@compute`), a resource (`@group`/`@binding` var, or any `var<...>`),
  // an `override`, or a module directive. Everything else (`fn`, `struct`, `const`) must be reachable.
  const ALWAYS_KEEP = /^(?:@|var\s|enable\s|diagnostic\s|alias\s|requires\s|override\s)/;

  const keep = new Set<string>();
  const worklist: Chunk[] = [];
  const keepName = (name: string): void => {
    const chunk = byName.get(name);
    if (chunk !== undefined && !keep.has(name)) {
      keep.add(name);
      worklist.push(chunk);
    }
  };
  for (const chunk of chunks) {
    if (chunk.preamble) continue;
    // Unnamed declarations (bindings like `@group(0) @binding(0) var<uniform> czm : T;`) and decorated
    // ones (entry points, overrides, resources) are always kept; their references seed the walk too.
    if (chunk.name === null || ALWAYS_KEEP.test(chunk.first)) {
      if (chunk.name !== null) keep.add(chunk.name);
      worklist.push(chunk);
    }
  }
  for (const name of roots) keepName(name);

  const visited = new Set<Chunk>();
  while (worklist.length > 0) {
    const chunk = worklist.pop() as Chunk;
    if (visited.has(chunk)) continue;
    visited.add(chunk);
    for (const identifier of identifiersOf(chunk.text)) keepName(identifier);
  }

  const keptChunks: string[] = [];
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const chunk of chunks) {
    const isKept = chunk.preamble || chunk.name === null || keep.has(chunk.name);
    if (isKept) keptChunks.push(chunk.text);
    if (chunk.preamble || chunk.name === null) continue;
    (isKept ? kept : dropped).push(chunk.name);
  }
  const keptText = keptChunks.join("\n");
  return { text: keptText, kept, dropped, keptBytes: keptText.length, droppedBytes: text.length - keptText.length };
}
