/**
 * G-5 gate — a **self-built GLSL ES 3.00 preprocessor** (tasks.md T023; contract R4 of
 * `specs/001-webgpu-terrain-mvp/contracts/fork-patch-layer.md`).
 *
 * Why this exists (measured, `experiments/shader-spike/REPORT.md` §6.4 / research §6.4):
 * upstream Cesium **has no preprocessor**: `ShaderSource.js:250-258` only *writes* `#define`
 * lines into the text and lets the GL driver evaluate them. WebGPU has no driver-side
 * preprocessor, so the fork layer MUST evaluate the conditionals itself. This module is that
 * evaluator — for both channels:
 *
 *   - the **GLSL side** uses it to find out which declarations are live for a define set
 *     (uniform set → binding layout, `out`/`in` set → varying pairing);
 *   - the **WGSL side** uses it to select the active regions of the WGSL leaf library
 *     (WGSL has no `#ifdef`, so the emitter resolves the conditionals at emission time).
 *
 * Implemented (GLSL ES 3.00 §3.4 subset that upstream actually uses, plus the general
 * expression grammar):
 *   `#define` (object-like, with and without a body), `#undef`, `#ifdef`, `#ifndef`, `#if`,
 *   `#elif`, `#else`, `#endif`, `defined(X)` / `defined X`, and the full integer operator set
 *   (`? :`, `||`, `&&`, `|`, `^`, `&`, `==`/`!=`, relational, shifts, `+ -`, `* / %`, unary
 *   `+ - ! ~`, parentheses) with C integer semantics (JS bitwise operators are already 32-bit
 *   two's-complement, which matches). Object-like macros are also substituted in ordinary text
 *   (that is how `uniform vec4 u_dayTextureTexCoordsRectangle[TEXTURE_UNITS];` becomes
 *   `…[3]`), with an expansion guard against recursion.
 *
 * Explicitly **not** implemented (upstream does not use them; a diagnostic is emitted if one is
 * ever seen, so the gap can never be silent): function-like macros, `#include`, `#error`,
 * `#pragma`, `#line` semantics (the directive is passed through verbatim), stringisation and
 * token pasting.
 *
 * Node-only, zero dependencies, cross-platform.
 */

/** Macros a GLSL ES 3.00 driver defines on this project's desktop WebGL2 baseline. */
export const DRIVER_MACROS = { GL_FRAGMENT_PRECISION_HIGH: "1" };

/** `["FOG", "TEXTURE_UNITS 3"]` → `Map { FOG → "", TEXTURE_UNITS → "3" }` (upstream's own format). */
export function parseDefines(defines = []) {
  const map = new Map();
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
export function stripComments(source) {
  // Regex-based (the hand-rolled character loop was measurably the hot spot once the whole
  // MVP-reachable define matrix goes through this function).
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

// --------------------------------------------------------------------------------------------
// integer expression evaluator (C semantics)
// --------------------------------------------------------------------------------------------

const TOKEN = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?[uUlL]*)|(0[xX][0-9a-fA-F]+[uUlL]*)|([A-Za-z_]\w*)|(<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%&|^~!<>()?:]))/y;

function tokenise(expression) {
  const tokens = [];
  let index = 0;
  const text = expression.trim();
  while (index < text.length) {
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(text);
    if (match === null) {
      if (text.slice(index).trim().length === 0) break;
      throw new Error(`unexpected character "${text[index]}" in #if expression`);
    }
    index = TOKEN.lastIndex;
    if (match[1] !== undefined || match[2] !== undefined) {
      const raw = (match[1] ?? match[2]).replace(/[uUlL]+$/, "");
      tokens.push({ kind: "number", value: match[2] !== undefined ? Number.parseInt(raw, 16) : Number.parseFloat(raw) | 0 });
    } else if (match[3] !== undefined) tokens.push({ kind: "ident", value: match[3] });
    else tokens.push({ kind: "op", value: match[4] });
  }
  return tokens;
}

/**
 * Expand object-like macros in an expression (macro bodies are themselves expressions here).
 * An identifier that is not a macro evaluates to 0 — C/GLSL preprocessor behaviour.
 */
function expandIdentifiers(tokens, macros, expanded) {
  return tokens.map((token) => {
    if (token.kind !== "ident") return token;
    const name = token.value;
    if (!macros.has(name) || expanded.has(name)) return { kind: "number", value: 0 };
    const body = String(macros.get(name)).trim();
    if (body.length === 0) throw new Error(`"${name}" is defined without a value and cannot be used in a #if expression`);
    if (/^-?\d+$/.test(body)) return { kind: "number", value: Number.parseInt(body, 10) };
    return { kind: "subexpression", value: body };
  });
}

/**
 * Evaluate a `#if` / `#elif` controlling expression.
 *
 * @param {string} expression
 * @param {Map<string,string>} macros
 * @returns {{ value: boolean, error: string|null }}
 */
export function evaluateCondition(expression, macros) {
  try {
    return { value: parseExpression(String(expression), macros) !== 0, error: null };
  } catch (error) {
    return { value: false, error: error.message };
  }
}

function parseExpression(source, macros) {
  // `defined(X)` / `defined X` is resolved before tokenising: it is a preprocessor operator,
  // not a macro call.
  const withDefined = String(source)
    .replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_all, name) => (macros.has(name) ? "1" : "0"))
    .replace(/defined\s+([A-Za-z_]\w*)/g, (_all, name) => (macros.has(name) ? "1" : "0"));
  let tokens = tokenise(withDefined);
  // Resolve nested macro/sub-expression references (bounded, no recursion).
  for (let round = 0; round < 32; round += 1) {
    if (!tokens.some((token) => token.kind === "ident" || token.kind === "subexpression")) break;
    const next = [];
    for (const token of tokens) {
      if (token.kind === "ident") {
        const name = token.value;
        if (!macros.has(name)) {
          next.push({ kind: "number", value: 0 });
          continue;
        }
        const body = String(macros.get(name)).trim();
        if (body.length === 0) throw new Error(`"${name}" is defined without a value and cannot be used in a #if expression`);
        if (/^-?\d+$/.test(body)) next.push({ kind: "number", value: Number.parseInt(body, 10) });
        else next.push(...tokenise(body));
      } else if (token.kind === "subexpression") {
        next.push(...tokenise(String(token.value)));
      } else next.push(token);
    }
    tokens = next;
  }
  if (tokens.some((token) => token.kind === "ident" || token.kind === "subexpression")) {
    throw new Error("macro expansion did not converge (recursive macro?)");
  }

  let position = 0;
  const peek = () => tokens[position];
  const eat = (value) => {
    const token = tokens[position];
    if (token === undefined || token.kind !== "op" || token.value !== value) return false;
    position += 1;
    return true;
  };
  const expect = (value) => {
    if (!eat(value)) throw new Error(`expected "${value}" in #if expression`);
  };

  // precedence climbing, highest binding last
  const levels = [
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
  const apply = (operator, left, right) => {
    switch (operator) {
      case "||": return left || right ? 1 : 0;
      case "&&": return left && right ? 1 : 0;
      case "|": return left | right;
      case "^": return left ^ right;
      case "&": return left & right;
      case "==": return left === right ? 1 : 0;
      case "!=": return left !== right ? 1 : 0;
      case "<=": return left <= right ? 1 : 0;
      case ">=": return left >= right ? 1 : 0;
      case "<": return left < right ? 1 : 0;
      case ">": return left > right ? 1 : 0;
      case "<<": return left << right;
      case ">>": return left >> right;
      case "+": return left + right;
      case "-": return left - right;
      case "*": return Math.imul(left, right);
      case "/": return right === 0 ? 0 : (left / right) | 0;
      case "%": return right === 0 ? 0 : left % right;
      default: throw new Error(`unsupported operator "${operator}"`);
    }
  };

  function parseUnary() {
    const token = peek();
    if (token !== undefined && token.kind === "op") {
      if (token.value === "-") { position += 1; return -parseUnary(); }
      if (token.value === "+") { position += 1; return parseUnary(); }
      if (token.value === "!") { position += 1; return parseUnary() === 0 ? 1 : 0; }
      if (token.value === "~") { position += 1; return ~parseUnary(); }
      if (token.value === "(") { position += 1; const value = parseConditional(); expect(")"); return value; }
    }
    if (token === undefined || token.kind !== "number") throw new Error(`unexpected token ${token === undefined ? "<end>" : JSON.stringify(token.value)} in #if expression`);
    position += 1;
    return token.value;
  }

  function parseBinary(level) {
    if (level >= levels.length) return parseUnary();
    let left = parseBinary(level + 1);
    for (;;) {
      const token = peek();
      if (token === undefined || token.kind !== "op" || !levels[level].includes(token.value)) return left;
      position += 1;
      const right = parseBinary(level + 1);
      left = apply(token.value, left, right);
    }
  }

  function parseConditional() {
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
export function substituteMacros(line, macros) {
  let text = line;
  for (let round = 0; round < 32; round += 1) {
    let changed = false;
    text = text.replace(/\b([A-Za-z_]\w*)\b/g, (all, name) => {
      if (!macros.has(name)) return all;
      const body = String(macros.get(name));
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

/**
 * Evaluate the conditional directives of one shader for a define set.
 *
 * @param {string} source assembled GLSL (or a WGSL library leaf using the same directive syntax)
 * @param {string[]} defines upstream define list, e.g. `["FOG", "TEXTURE_UNITS 1"]`
 * @param {{ substituteText?: boolean, driverMacros?: object, keepDirectives?: boolean }} [options]
 * @returns {{
 *   lines: string[], activeMask: boolean[], directives: object[], macros: Map<string,string>,
 *   diagnostics: object[], text: string, activeText: string
 * }}
 */
export function preprocess(source, defines = [], options = {}) {
  const substituteText = options.substituteText !== false;
  const macros = new Map(Object.entries({ ...DRIVER_MACROS, ...(options.driverMacros ?? {}) }));
  for (const [name, value] of parseDefines(defines)) macros.set(name, value);

  const clean = stripComments(source);
  const rawLines = clean.split("\n");
  const lines = [];
  const activeMask = [];
  const directives = [];
  const diagnostics = [];
  const stack = [];
  let current = true;

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    const match = DIRECTIVE.exec(raw);
    if (match === null) {
      activeMask.push(current);
      lines.push(substituteText && current ? substituteMacros(raw, macros) : raw);
      continue;
    }
    const [, name, rest] = match;
    const argument = rest.trim();
    const record = { line: index + 1, name, argument, active: current };
    activeMask.push(false);
    lines.push(options.keepDirectives === true ? raw : "");
    if (name === "ifdef" || name === "ifndef" || name === "if") {
      const parent = current;
      let condition;
      if (name === "ifdef") condition = macros.has(argument);
      else if (name === "ifndef") condition = !macros.has(argument);
      else {
        const evaluated = evaluateCondition(argument, macros);
        condition = evaluated.value;
        if (evaluated.error !== null) diagnostics.push({ line: index + 1, directive: `#${name} ${argument}`, message: evaluated.error });
      }
      stack.push({ parent, any: condition, taken: condition, elseSeen: false, line: index + 1 });
      current = parent && condition;
    } else if (name === "elif") {
      const frame = stack[stack.length - 1];
      if (frame === undefined) diagnostics.push({ line: index + 1, directive: "#elif", message: "#elif without #if" });
      else {
        const evaluated = evaluateCondition(argument, macros);
        const condition = !frame.any && evaluated.value;
        if (evaluated.error !== null) diagnostics.push({ line: index + 1, directive: `#elif ${argument}`, message: evaluated.error });
        frame.taken = condition;
        frame.any = frame.any || condition;
        current = frame.parent && condition;
      }
    } else if (name === "else") {
      const frame = stack[stack.length - 1];
      if (frame === undefined) diagnostics.push({ line: index + 1, directive: "#else", message: "#else without #if" });
      else {
        const condition = !frame.any;
        frame.taken = condition;
        frame.any = true;
        frame.elseSeen = true;
        current = frame.parent && condition;
      }
    } else if (name === "endif") {
      const frame = stack.pop();
      if (frame === undefined) diagnostics.push({ line: index + 1, directive: "#endif", message: "#endif without #if" });
      else current = frame.parent;
    } else if (name === "define") {
      if (current) {
        const defineMatch = /^([A-Za-z_]\w*)\s*(.*)$/.exec(argument);
        if (defineMatch === null) diagnostics.push({ line: index + 1, directive: `#define ${argument}`, message: "malformed #define (function-like macros are not supported)" });
        else macros.set(defineMatch[1], defineMatch[2].trim());
      }
    } else if (name === "undef") {
      if (current) macros.delete(argument);
    } else if (["version", "extension", "line", "pragma"].includes(name)) {
      // Passed through verbatim (active lines only); no semantics attached.
    } else {
      diagnostics.push({ line: index + 1, directive: `#${name}`, message: `unsupported preprocessor directive "#${name}" (NOT silently ignored)` });
    }
    directives.push({ ...record, taken: stack.length > 0 ? stack[stack.length - 1].taken : undefined });
  }

  for (const frame of stack) diagnostics.push({ line: frame.line, directive: "#if", message: "unterminated conditional (missing #endif)" });

  return {
    lines,
    activeMask,
    directives,
    macros,
    diagnostics,
    text: lines.join("\n"),
    /** Active (non-directive) lines only, joined — the text a WebGPU-side consumer would see. */
    activeText: lines.filter((_line, index) => activeMask[index] === true).join("\n"),
  };
}

/** Collapse runs of blank lines (WGSL emission readability); line numbers are not preserved. */
export function collapseBlank(text) {
  return text
    .split("\n")
    .filter((line, index, all) => !(line.trim().length === 0 && (index === 0 || all[index - 1].trim().length === 0)))
    .join("\n")
    .trim();
}

/** Backwards-compatible helper (same contract as `g4-uniform-layout/assemble-glsl.mjs`). */
export function activeLines(source, defines) {
  return preprocess(source, defines).activeMask;
}
