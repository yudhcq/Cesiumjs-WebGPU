/**
 * G-5 gate — **conservative WGSL dead-declaration elimination** for the emitted module.
 *
 * Why this exists (measured, G-6/T025 revision 2): the whole `czm_` prelude is inlined into **both**
 * stages of every variant, but a variant only ever calls a fraction of it. Pipeline creation on the
 * measured device costs ~8.6 ms for a trivial module pair and ~107 ms for the emitted ~48 kB pair, so
 * the per-variant cost is dominated by module size — and the second half of the G-6 fix (plan.md G-6
 * 修复(b)) is exactly this: emit only what the variant can reach.
 *
 * The elimination is **conservative in one direction only**: it may keep a declaration it cannot prove
 * dead, but it MUST NOT drop one that is reachable. Reachability is computed over the module-scope
 * declarations the emitted text actually contains:
 *
 *   - roots: the entry points (a `fn` under `@vertex`/`@fragment`/`@compute`, including the split form
 *     where the decorator sits on its own line), every `override`, every `var<...>`/`@group`/`@binding`
 *     resource declaration, every `enable`/`diagnostic`/`alias`/`requires` directive, and everything
 *     the caller passes in `roots`;
 *   - an edge `A → B` exists when A's text mentions the identifier `B` and `B` is declared at module
 *     scope in the same text. Identifiers that are not declared here (WGSL builtins, type names,
 *     swizzles) create no edges, so a false positive can only *add* a kept declaration.
 *
 * The text is split at column-0 declaration starts (a bare decorator line is attached to the
 * declaration that follows it); everything between two starts travels with the declaration, so comments
 * stay attached and no statement is ever separated from its declaration.
 *
 * Node-only, zero dependencies, cross-platform.
 */

/** A column-0 line that begins a module-scope declaration. */
const DECLARATION_START = /^(?:fn\s|struct\s|const\s|var\s|alias\s|enable\s|diagnostic\s|requires\s|override\s)/;

/** A column-0 decorator line; when it carries no declaration it belongs to the declaration after it. */
const DECORATOR_LINE = /^@/;

const NAME_PATTERNS = [/^fn\s+([A-Za-z_]\w*)/m, /^struct\s+([A-Za-z_]\w*)/m, /^const\s+([A-Za-z_]\w*)/m, /^var\s*(?:<[^>]*>)?\s*([A-Za-z_]\w*)/m, /^alias\s+([A-Za-z_]\w*)/m, /^override\s+([A-Za-z_]\w*)/m];

const IDENTIFIER = /[A-Za-z_]\w*/g;

/** Split a WGSL module into top-level chunks, each starting at a column-0 declaration. */
export function splitDeclarations(text) {
  const chunks = [];
  let current = null;
  let pendingDecorators = [];
  const flush = () => {
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
    let name = null;
    for (const pattern of NAME_PATTERNS) {
      const match = pattern.exec(chunk.header.join("\n"));
      if (match !== null) {
        name = match[1];
        break;
      }
    }
    return { name, text: chunk.lines.join("\n"), first: chunk.lines[0], preamble: chunk.preamble === true };
  });
}

/** Every identifier mentioned by a chunk (a superset of what it really references — deliberately). */
function identifiersOf(text) {
  return text.match(IDENTIFIER) ?? [];
}

/**
 * Drop the module-scope declarations the roots cannot reach.
 *
 * @param {string} text preprocessed WGSL (inactive regions already gone — see `glsl-preprocess.mjs`)
 * @param {{roots?: Iterable<string>}} [options] extra root names
 * @returns {{text: string, kept: string[], dropped: string[], keptBytes: number, droppedBytes: number}}
 */
export function pruneWgsl(text, { roots = [] } = {}) {
  const chunks = splitDeclarations(text);
  const byName = new Map();
  for (const chunk of chunks) if (chunk.name !== null && !byName.has(chunk.name)) byName.set(chunk.name, chunk);

  // A declaration carries an interface — and is therefore a root — when it is an entry point (a `fn`
  // under `@vertex`/`@fragment`/`@compute`), a resource (`@group`/`@binding` var, or any `var<...>`),
  // an `override`, or a module directive. Everything else (`fn`, `struct`, `const`) must be reachable.
  const ALWAYS_KEEP = /^(?:@|var\s|enable\s|diagnostic\s|alias\s|requires\s|override\s)/;

  const keep = new Set();
  const worklist = [];
  const keepName = (name) => {
    if (byName.has(name) && !keep.has(name)) {
      keep.add(name);
      worklist.push(byName.get(name));
    }
  };
  for (const chunk of chunks) {
    if (chunk.preamble === true) continue;
    // Unnamed declarations (bindings like `@group(0) @binding(0) var<uniform> czm : T;`) and decorated
    // ones (entry points, overrides, resources) are always kept; their references seed the walk too.
    if (chunk.name === null || ALWAYS_KEEP.test(chunk.first)) {
      if (chunk.name !== null) keep.add(chunk.name);
      worklist.push(chunk);
    }
  }
  for (const name of roots) keepName(name);

  const visited = new Set();
  while (worklist.length > 0) {
    const chunk = worklist.pop();
    if (visited.has(chunk)) continue;
    visited.add(chunk);
    for (const identifier of identifiersOf(chunk.text)) keepName(identifier);
  }

  const keptChunks = [];
  const kept = [];
  const dropped = [];
  for (const chunk of chunks) {
    const isKept = chunk.preamble === true || chunk.name === null || keep.has(chunk.name);
    if (isKept) keptChunks.push(chunk.text);
    if (chunk.preamble === true || chunk.name === null) continue;
    (isKept ? kept : dropped).push(chunk.name);
  }
  const keptText = keptChunks.join("\n");
  return { text: keptText, kept, dropped, keptBytes: keptText.length, droppedBytes: text.length - keptText.length };
}
