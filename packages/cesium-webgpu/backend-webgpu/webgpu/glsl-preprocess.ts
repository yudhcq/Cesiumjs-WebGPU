/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * New module of the cesium-webgpu render backend layer (not derived from any upstream file).
 *
 * GLSL conditional-compilation front end (tasks.md **T066**, SH-4; contract fork-patch-layer §5
 * rule **R4**; research §6.4 items 1–2).
 *
 * Why this exists (measured, `experiments/shader-spike/REPORT.md` §6.4): upstream Cesium has **no
 * preprocessor** — `Renderer/ShaderSource.js:250-258` only *writes* `#define` lines into the text and
 * lets the GL driver evaluate them. WebGPU has no driver-side preprocessor, so the fork layer MUST
 * evaluate the conditionals itself. This module is that evaluator, for both channels:
 *
 *   - the **GLSL side** uses it to find out which declarations are live for a define set (uniform
 *     set → binding layout, `out`/`in` set → varying pairing, T072);
 *   - the **WGSL side** uses it to select the live regions of the WGSL leaf library
 *     (`webgpu/wgsl/**`), because WGSL has no `#ifdef` at all (spike §6.4).
 *
 * **Order semantics (R4, "先内联 `czm_`、后条件求值").** Upstream inlines the referenced `czm_`
 * built-ins into the *combined* source (`ShaderSource.js:155-304`: `combineShader` →
 * `getBuiltinsAndAutomaticUniforms`, `:138-153`) and only then hands the result to the driver.
 * The dependency scan matches `\bczm_[A-Za-z0-9_]*` over the **whole** text, so a `czm_` reference
 * inside an *inactive* `#if` branch still pulls its built-in in. `evaluateShaderSource()` below
 * performs exactly that order: `inlineCzmBuiltins()` first, then `preprocess()`.
 *
 * Implemented (the GLSL ES 3.00 §3.4 subset upstream actually uses, plus the general expression
 * grammar): `#define` (object-like, with and without a body), `#undef`, `#ifdef`, `#ifndef`, `#if`,
 * `#elif`, `#else`, `#endif`, `defined(X)` / `defined X`, and the full integer operator set
 * (`? :`, `||`, `&&`, `|`, `^`, `&`, `==`/`!=`, relational, shifts, `+ -`, `* / %`, unary `+ - ! ~`,
 * parentheses) with C integer semantics (JavaScript's bitwise operators are already 32-bit
 * two's-complement, which matches). Object-like macros are also substituted in ordinary text (that
 * is how `uniform vec4 u_dayTextureTexCoordsRectangle[TEXTURE_UNITS];` becomes `…[3]`), with an
 * expansion guard against recursion.
 *
 * Explicitly **not** implemented (upstream does not use them; a diagnostic is emitted if one is ever
 * seen, so the gap can never be silent): function-like macros, `#include`, `#error`, `#pragma`,
 * `#line` semantics (the directive is passed through verbatim), stringisation and token pasting.
 *
 * Ported from the verified G-5 gate implementation
 * (`experiments/gates/g5-shader/glsl-preprocess.mjs`); the algorithms are unchanged, the types and
 * the `ConditionalCompilationTrace` audit record are new.
 *
 * Zero dependencies, cross-platform — **no `node:` import anywhere**: this module runs in the
 * browser bundle as well as under `node --test`.
 */

/** Macros a GLSL ES 3.00 driver defines on this project's desktop WebGL2 baseline. */
export const DRIVER_MACROS: Readonly<Record<string, string>> = { GL_FRAGMENT_PRECISION_HIGH: "1" };

/** The define set of one shader variant: `{ FOG: 1, TEXTURE_UNITS: 3 }`. */
export type DefineTable = Readonly<Record<string, string | number | boolean>>;

/** Upstream's own define format, `["FOG", "TEXTURE_UNITS 3"]`, is the input of every entry point. */
export type DefineList = readonly string[];

/** One `#if`/`#elif`/`#else`/`#endif` decision, recorded for `ConditionalCompilationTrace`. */
export interface ConditionalDecision {
  /** 1-based line of the directive in the (comment-stripped) input. */
  readonly line: number;
  readonly directive: string;
  readonly argument: string;
  /** The condition value the branch was evaluated to (`#else` → the negation of "any taken"). */
  readonly taken: boolean;
  /** `true` when the enclosing region was already inactive (the branch was not evaluated). */
  readonly inactive: boolean;
}

/**
 * `ConditionalCompilationTrace` (data-model §4.5) — the audit record that makes SH-4 ("求值结果与
 * 上游一致") checkable instead of asserted: which variant, how many conditional blocks were
 * evaluated, which branch indices were taken, and every warning the evaluator produced.
 */
export interface ConditionalCompilationTrace {
  readonly variantKey: string;
  readonly blocksEvaluated: number;
  readonly branchesTaken: number[];
  readonly warnings: string[];
}

/** A preprocessor diagnostic. Always produced for an unsupported construct — never swallowed. */
export interface PreprocessDiagnostic {
  readonly line: number;
  readonly directive: string;
  readonly message: string;
  /** The variant this evaluation belonged to (present when the caller supplied one). */
  readonly variantKey?: string;
}

export interface PreprocessOptions {
  /** Substitute object-like macros in ordinary text (default `true`; G-5 uses `false` for analysis). */
  readonly substituteText?: boolean;
  /** Extra driver macros beyond `DRIVER_MACROS`. */
  readonly driverMacros?: Readonly<Record<string, string>>;
  /** Keep the directive lines verbatim instead of blanking them (line numbers stay valid either way). */
  readonly keepDirectives?: boolean;
  /** Variant identity recorded on the trace and on every diagnostic. */
  readonly variantKey?: string;
}

export interface PreprocessResult {
  /** Every input line, with directive lines blanked (unless `keepDirectives`). */
  readonly lines: string[];
  /** Per line: is it live for this define set? Directive lines are always `false`. */
  readonly activeMask: boolean[];
  /** Every directive seen, in file order. */
  readonly directives: readonly ConditionalDecision[];
  readonly macros: Map<string, string>;
  readonly diagnostics: readonly PreprocessDiagnostic[];
  /** All lines joined — the text a GLSL driver would see (directives included). */
  readonly text: string;
  /** Live non-directive lines only — the text a WebGPU-side consumer sees. */
  readonly activeText: string;
  /** The audit record (data-model §4.5). */
  readonly trace: ConditionalCompilationTrace;
}

/** `["FOG", "TEXTURE_UNITS 3"]` → `Map { FOG → "", TEXTURE_UNITS → "3" }` (upstream's own format). */
export function parseDefines(defines: DefineList = []): Map<string, string> {
  const map = new Map<string, string>();
  for (const define of defines) {
    const text = String(define).trim();
    if (text.length === 0) continue;
    const space = text.search(/\s/);
    if (space < 0) map.set(text, "");
    else map.set(text.slice(0, space), text.slice(space + 1).trim());
  }
  return map;
}

/** Replace comments with spaces, preserving every newline (so line numbers stay valid). */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
}

// --------------------------------------------------------------------------------------------
// integer expression evaluator (C semantics)
// --------------------------------------------------------------------------------------------

type Token = { kind: "number"; value: number } | { kind: "ident"; value: string } | { kind: "op"; value: string } | { kind: "subexpression"; value: string };

const TOKEN = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?[uUlL]*)|(0[xX][0-9a-fA-F]+[uUlL]*)|([A-Za-z_]\w*)|(<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%&|^~!<>()?:]))/y;

function tokenise(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const text = expression.trim();
  while (index < text.length) {
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(text);
    if (match === null) {
      if (text.slice(index).trim().length === 0) break;
      throw new Error(`unexpected character "${text[index] ?? ""}" in #if expression`);
    }
    index = TOKEN.lastIndex;
    if (match[1] !== undefined || match[2] !== undefined) {
      const raw = (match[1] ?? match[2] ?? "").replace(/[uUlL]+$/, "");
      tokens.push({ kind: "number", value: match[2] !== undefined ? Number.parseInt(raw, 16) : Number.parseFloat(raw) | 0 });
    } else if (match[3] !== undefined) tokens.push({ kind: "ident", value: match[3] });
    else tokens.push({ kind: "op", value: match[4] ?? "" });
  }
  return tokens;
}

/**
 * Evaluate a `#if` / `#elif` controlling expression.
 *
 * An identifier that is not a macro evaluates to 0 — C/GLSL preprocessor behaviour. A macro defined
 * without a value is an error rather than 0, because silently treating `#define FOG` as 0 would
 * change which branch is live.
 */
export function evaluateCondition(expression: string, macros: ReadonlyMap<string, string>): { value: boolean; error: string | null } {
  try {
    return { value: parseExpression(String(expression), macros) !== 0, error: null };
  } catch (error) {
    return { value: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseExpression(source: string, macros: ReadonlyMap<string, string>): number {
  // `defined(X)` / `defined X` is resolved before tokenising: it is a preprocessor operator, not a
  // macro call.
  const withDefined = String(source)
    .replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_all, name: string) => (macros.has(name) ? "1" : "0"))
    .replace(/defined\s+([A-Za-z_]\w*)/g, (_all, name: string) => (macros.has(name) ? "1" : "0"));
  let tokens: Token[] = tokenise(withDefined);
  // Resolve nested macro/sub-expression references (bounded, no recursion).
  for (let round = 0; round < 32; round += 1) {
    if (!tokens.some((token) => token.kind === "ident" || token.kind === "subexpression")) break;
    const next: Token[] = [];
    for (const token of tokens) {
      if (token.kind === "ident") {
        const name = token.value;
        if (!macros.has(name)) {
          next.push({ kind: "number", value: 0 });
          continue;
        }
        const body = String(macros.get(name) ?? "").trim();
        if (body.length === 0) throw new Error(`"${name}" is defined without a value and cannot be used in a #if expression`);
        if (/^-?\d+$/.test(body)) next.push({ kind: "number", value: Number.parseInt(body, 10) });
        else next.push(...tokenise(body));
      } else if (token.kind === "subexpression") {
        next.push(...tokenise(token.value));
      } else next.push(token);
    }
    tokens = next;
  }
  if (tokens.some((token) => token.kind === "ident" || token.kind === "subexpression")) {
    throw new Error("macro expansion did not converge (recursive macro?)");
  }

  let position = 0;
  const peek = (): Token | undefined => tokens[position];
  const eat = (value: string): boolean => {
    const token = tokens[position];
    if (token === undefined || token.kind !== "op" || token.value !== value) return false;
    position += 1;
    return true;
  };
  const expect = (value: string): void => {
    if (!eat(value)) throw new Error(`expected "${value}" in #if expression`);
  };

  // Precedence climbing, highest binding last.
  const levels: readonly (readonly string[])[] = [
    ["||"],
    ["&&"],
    ["|"],
    ["^"],
    ["&"],
    ["==", "!="],
    ["<=", ">=", "<", ">"],
    ["<<", ">>"],
    ["+", "-"],
    ["*", "/", "%"],
  ];
  const apply = (operator: string, left: number, right: number): number => {
    switch (operator) {
      case "||":
        return left || right ? 1 : 0;
      case "&&":
        return left && right ? 1 : 0;
      case "|":
        return left | right;
      case "^":
        return left ^ right;
      case "&":
        return left & right;
      case "==":
        return left === right ? 1 : 0;
      case "!=":
        return left !== right ? 1 : 0;
      case "<=":
        return left <= right ? 1 : 0;
      case ">=":
        return left >= right ? 1 : 0;
      case "<":
        return left < right ? 1 : 0;
      case ">":
        return left > right ? 1 : 0;
      case "<<":
        return left << right;
      case ">>":
        return left >> right;
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return Math.imul(left, right);
      case "/":
        return right === 0 ? 0 : (left / right) | 0;
      case "%":
        return right === 0 ? 0 : left % right;
      default:
        throw new Error(`unsupported operator "${operator}"`);
    }
  };

  function parseUnary(): number {
    const token = peek();
    if (token !== undefined && token.kind === "op") {
      if (token.value === "-") {
        position += 1;
        return -parseUnary();
      }
      if (token.value === "+") {
        position += 1;
        return parseUnary();
      }
      if (token.value === "!") {
        position += 1;
        return parseUnary() === 0 ? 1 : 0;
      }
      if (token.value === "~") {
        position += 1;
        return ~parseUnary();
      }
      if (token.value === "(") {
        position += 1;
        const value = parseConditional();
        expect(")");
        return value;
      }
    }
    if (token === undefined || token.kind !== "number") throw new Error(`unexpected token ${token === undefined ? "<end>" : JSON.stringify(token.value)} in #if expression`);
    position += 1;
    return token.value;
  }

  function parseBinary(level: number): number {
    const row = levels[level];
    if (row === undefined) return parseUnary();
    let left = parseBinary(level + 1);
    for (;;) {
      const token = peek();
      if (token === undefined || token.kind !== "op" || !row.includes(token.value)) return left;
      position += 1;
      const right = parseBinary(level + 1);
      left = apply(token.value, left, right);
    }
  }

  function parseConditional(): number {
    const condition = parseBinary(0);
    if (!eat("?")) return condition;
    const whenTrue = parseConditional();
    expect(":");
    const whenFalse = parseConditional();
    return condition !== 0 ? whenTrue : whenFalse;
  }

  const value = parseConditional();
  if (position !== tokens.length) throw new Error(`trailing tokens in #if expression: "${tokens.slice(position).map((token) => token.value).join(" ")}"`);
  return value;
}

// --------------------------------------------------------------------------------------------
// text substitution (object-like macros in ordinary code)
// --------------------------------------------------------------------------------------------

/** Substitute object-like macros in a non-directive line (bounded recursion; no token pasting). */
export function substituteMacros(line: string, macros: ReadonlyMap<string, string>): string {
  let text = line;
  for (let round = 0; round < 32; round += 1) {
    let changed = false;
    text = text.replace(/\b([A-Za-z_]\w*)\b/g, (all, name: string) => {
      if (!macros.has(name)) return all;
      const body = String(macros.get(name) ?? "");
      // `#define FOG` (empty body) means "defined but not usable as a value": leave it alone.
      if (body.length === 0) return all;
      changed = true;
      return body;
    });
    if (!changed) break;
  }
  return text;
}

// --------------------------------------------------------------------------------------------
// the preprocessor
// --------------------------------------------------------------------------------------------

const DIRECTIVE = /^\s*#\s*([A-Za-z_]\w*)\s*(.*)$/;

interface ConditionalFrame {
  readonly parent: boolean;
  any: boolean;
  taken: boolean;
  elseSeen: boolean;
  readonly line: number;
}

/**
 * Evaluate the conditional directives of one shader for a define set (T066, R4, SH-4).
 *
 * @param source assembled GLSL (or a WGSL library leaf using the same directive syntax)
 * @param defines upstream define list, e.g. `["FOG", "TEXTURE_UNITS 1"]`
 */
export function preprocess(source: string, defines: DefineList = [], options: PreprocessOptions = {}): PreprocessResult {
  const substituteText = options.substituteText !== false;
  const macros = new Map<string, string>(Object.entries({ ...DRIVER_MACROS, ...(options.driverMacros ?? {}) }));
  for (const [name, value] of parseDefines(defines)) macros.set(name, value);

  const clean = stripComments(source);
  const rawLines = clean.split("\n");
  const lines: string[] = [];
  const activeMask: boolean[] = [];
  const directives: ConditionalDecision[] = [];
  const diagnostics: PreprocessDiagnostic[] = [];
  const stack: ConditionalFrame[] = [];
  let current = true;

  const warn = (line: number, directive: string, message: string): void => {
    const entry: PreprocessDiagnostic = options.variantKey === undefined ? { line, directive, message } : { line, directive, message, variantKey: options.variantKey };
    diagnostics.push(entry);
  };

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] ?? "";
    const match = DIRECTIVE.exec(raw);
    if (match === null) {
      activeMask.push(current);
      lines.push(substituteText && current ? substituteMacros(raw, macros) : raw);
      continue;
    }
    const name = match[1] ?? "";
    const argument = (match[2] ?? "").trim();
    activeMask.push(false);
    lines.push(options.keepDirectives === true ? raw : "");
    const enclosing = stack[stack.length - 1];
    const record: ConditionalDecision = { line: index + 1, directive: `#${name}`, argument, taken: enclosing === undefined ? current : enclosing.taken, inactive: !current };

    if (name === "ifdef" || name === "ifndef" || name === "if") {
      const parent: boolean = current;
      let condition: boolean;
      if (name === "ifdef") condition = macros.has(argument);
      else if (name === "ifndef") condition = !macros.has(argument);
      else {
        const evaluated = evaluateCondition(argument, macros);
        condition = evaluated.value;
        if (evaluated.error !== null) warn(index + 1, `#${name} ${argument}`, evaluated.error);
      }
      stack.push({ parent, any: condition, taken: condition, elseSeen: false, line: index + 1 });
      current = parent && condition;
      directives.push({ ...record, taken: condition, inactive: !parent });
    } else if (name === "elif") {
      const frame = stack[stack.length - 1];
      if (frame === undefined) warn(index + 1, "#elif", "#elif without #if");
      else {
        const evaluated = evaluateCondition(argument, macros);
        const condition = !frame.any && evaluated.value;
        if (evaluated.error !== null) warn(index + 1, `#elif ${argument}`, evaluated.error);
        frame.taken = condition;
        frame.any = frame.any || condition;
        current = frame.parent && condition;
        directives.push({ ...record, taken: condition, inactive: !frame.parent || frame.any !== condition });
      }
    } else if (name === "else") {
      const frame = stack[stack.length - 1];
      if (frame === undefined) warn(index + 1, "#else", "#else without #if");
      else {
        const condition = !frame.any;
        frame.taken = condition;
        frame.any = true;
        frame.elseSeen = true;
        current = frame.parent && condition;
        directives.push({ ...record, taken: condition, inactive: !frame.parent });
      }
    } else if (name === "endif") {
      const frame = stack.pop();
      if (frame === undefined) warn(index + 1, "#endif", "#endif without #if");
      else current = frame.parent;
    } else if (name === "define") {
      if (current) {
        const defineMatch = /^([A-Za-z_]\w*)\s*(.*)$/.exec(argument);
        if (defineMatch === null) warn(index + 1, `#define ${argument}`, "malformed #define (function-like macros are not supported)");
        else macros.set(defineMatch[1] ?? "", (defineMatch[2] ?? "").trim());
      }
    } else if (name === "undef") {
      if (current) macros.delete(argument);
    } else if (["version", "extension", "line", "pragma"].includes(name)) {
      // Passed through verbatim (active lines only); no semantics attached.
    } else {
      warn(index + 1, `#${name}`, `unsupported preprocessor directive "#${name}" (NOT silently ignored)`);
    }
  }

  for (const frame of stack) warn(frame.line, "#if", "unterminated conditional (missing #endif)");

  const trace: ConditionalCompilationTrace = {
    variantKey: options.variantKey ?? "unspecified",
    blocksEvaluated: directives.filter((entry) => entry.inactive !== true).length,
    branchesTaken: directives.map((entry, index) => (entry.taken ? index : -1)).filter((index) => index >= 0),
    warnings: diagnostics.map((entry) => `line ${entry.line}: ${entry.directive}: ${entry.message}`),
  };

  return {
    lines,
    activeMask,
    directives,
    macros,
    diagnostics,
    text: lines.join("\n"),
    activeText: lines.filter((_line, index) => activeMask[index] === true).join("\n"),
    trace,
  };
}

/** Collapse runs of blank lines (WGSL emission readability); line numbers are not preserved. */
export function collapseBlank(text: string): string {
  return text
    .split("\n")
    .filter((line, index, all) => !(line.trim().length === 0 && (index === 0 || (all[index - 1] ?? "").trim().length === 0)))
    .join("\n")
    .trim();
}

/** The per-line liveness mask for one source and define set (used by the uniform/varying analyses). */
export function activeLines(source: string, defines: DefineList): boolean[] {
  return preprocess(source, defines).activeMask;
}

// --------------------------------------------------------------------------------------------
// `czm_` inlining — the half of R4 that has to happen **before** conditional evaluation
// --------------------------------------------------------------------------------------------

/** Resolves a `czm_` identifier to its GLSL declaration text (upstream `CzmBuiltins` + automatic uniforms). */
export type CzmBuiltinResolver = (name: string) => string | undefined;

interface DependencyNode {
  readonly name: string;
  readonly glslSource: string;
  readonly dependsOn: DependencyNode[];
  readonly requiredBy: DependencyNode[];
  evaluated: boolean;
}

function getDependencyNode(name: string, glslSource: string, nodes: DependencyNode[]): DependencyNode {
  for (const node of nodes) if (node.name === name) return node;
  const created: DependencyNode = { name, glslSource: stripComments(glslSource), dependsOn: [], requiredBy: [], evaluated: false };
  nodes.push(created);
  return created;
}

function generateDependencies(currentNode: DependencyNode, nodes: DependencyNode[], resolver: CzmBuiltinResolver): void {
  if (currentNode.evaluated) return;
  currentNode.evaluated = true;
  const matches = currentNode.glslSource.match(/\bczm_[a-zA-Z0-9_]*/g);
  if (matches === null) return;
  for (const element of new Set(matches)) {
    if (element === currentNode.name) continue;
    const declaration = resolver(element);
    if (declaration === undefined) continue;
    const referenced = getDependencyNode(element, declaration, nodes);
    currentNode.dependsOn.push(referenced);
    referenced.requiredBy.push(currentNode);
    generateDependencies(referenced, nodes, resolver);
  }
}

/** Topological sort (Kahn); a cycle is an error, never a silent reordering. */
function sortDependencies(nodes: DependencyNode[]): DependencyNode[] {
  const withoutIncoming: DependencyNode[] = [];
  const all: DependencyNode[] = [];
  while (nodes.length > 0) {
    const node = nodes.pop() as DependencyNode;
    all.push(node);
    if (node.requiredBy.length === 0) withoutIncoming.push(node);
  }
  const ordered: DependencyNode[] = [];
  while (withoutIncoming.length > 0) {
    const current = withoutIncoming.shift() as DependencyNode;
    ordered.push(current);
    for (const referenced of current.dependsOn) {
      const index = referenced.requiredBy.indexOf(current);
      if (index >= 0) referenced.requiredBy.splice(index, 1);
      if (referenced.requiredBy.length === 0) withoutIncoming.push(referenced);
    }
  }
  const cyclic = all.filter((node) => node.requiredBy.length !== 0);
  if (cyclic.length !== 0) {
    throw new Error(`a circular dependency was found in the following built-in functions/structs/constants:\n${cyclic.map((node) => node.name).join("\n")}`);
  }
  return ordered;
}

/** The full set of `czm_` names a source references — **including inactive `#if` branches** (R4). */
export function referencedCzmBuiltins(source: string, resolver: CzmBuiltinResolver): string[] {
  const seen = new Set<string>();
  const candidates = stripComments(source).match(/\bczm_[a-zA-Z0-9_]*/g) ?? [];
  for (const element of new Set(candidates)) if (resolver(element) !== undefined) seen.add(element);
  return [...seen].sort();
}

/**
 * Inline the referenced `czm_` built-ins (upstream `ShaderSource.js:138-153` reproduced), so that
 * the conditional evaluation sees the same text the GL driver would.
 *
 * The dependency scan runs over the **whole** source, inactive branches included — that is the
 * upstream behaviour (`getBuiltinsAndAutomaticUniforms` matches the combined text before the driver
 * evaluates anything) and it is what makes "未激活分支仍参与 `czm_` 依赖收集" true. Transitive
 * dependencies are resolved the same way, exactly as upstream does.
 *
 * @returns the inlined built-in declarations followed by the (unmodified) source, i.e.
 *   `builtinSources + source` — the text `combineShader` would hand to the driver.
 */
export function inlineCzmBuiltins(source: string, resolver: CzmBuiltinResolver): string {
  const nodes: DependencyNode[] = [];
  const root = getDependencyNode("main", source, nodes);
  generateDependencies(root, nodes, resolver);
  // `sortDependencies` consumes `nodes` (upstream rebuilds that array in place); use its return value.
  const ordered = sortDependencies(nodes);
  // Upstream's order: iterate in reverse so that dependent items are declared before they are used.
  let builtinsSource = "";
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const node = ordered[index];
    if (node === undefined) continue;
    builtinsSource = `${builtinsSource}${node.glslSource}\n`;
  }
  const withoutRoot = builtinsSource.replace(root.glslSource, "");
  return `${withoutRoot}${source}`;
}

// --------------------------------------------------------------------------------------------
// the W4 entry points named by tasks.md T066
// --------------------------------------------------------------------------------------------

/**
 * Evaluate every `#if`/`#ifdef`/`#elif` chain of a source with a define table and return the live
 * text (inactive regions and the directives themselves are gone).
 */
export function evaluateConditionals(source: string, defines: DefineTable, variantKey = "unspecified"): string {
  const list = Object.entries(defines).map(([name, value]) => (value === true ? name : value === false ? `${name} 0` : `${name} ${String(value)}`));
  return preprocess(source, list, { variantKey }).activeText;
}

/** The `TEXTURE_UNITS` define carries the number of texture units of the variant (research §6.3). */
export function textureUnitsDefine(textureUnits: number): DefineTable {
  if (!Number.isInteger(textureUnits) || textureUnits < 0) throw new Error(`textureUnitsDefine: "${String(textureUnits)}" is not a non-negative integer`);
  return { TEXTURE_UNITS: textureUnits };
}

/**
 * The R4 order, as one call: **inline `czm_` first, then evaluate conditionals** (T066).
 *
 * @returns the live text plus the `ConditionalCompilationTrace` SH-4 requires to be persisted.
 */
export function evaluateShaderSource({ source, defines, resolver, variantKey = "unspecified" }: { source: string; defines: DefineList; resolver: CzmBuiltinResolver; variantKey?: string }): { text: string; trace: ConditionalCompilationTrace } {
  const inlined = inlineCzmBuiltins(source, resolver);
  const evaluated = preprocess(inlined, defines, { variantKey });
  return { text: evaluated.activeText, trace: evaluated.trace };
}

/** The audit record for one source/define set, without materialising the text twice. */
export function traceFor(variantKey: string, defines: DefineList, source: string, resolver?: CzmBuiltinResolver): ConditionalCompilationTrace {
  const inlined = resolver === undefined ? source : inlineCzmBuiltins(source, resolver);
  return preprocess(inlined, defines, { variantKey }).trace;
}
