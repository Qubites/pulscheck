/**
 * ast-scanner.ts — AST-based static detector for `fetch` in `useEffect`
 * without an `AbortController`.
 *
 * Why only this rule lives here: the sibling rules for `setTimeout`,
 * `setInterval`, and `addEventListener` are already covered with similar
 * quality by the `@eslint-react` plugin's `no-leaked-timeout`,
 * `no-leaked-interval`, and `no-leaked-event-listener` rules. A head-to-head
 * comparison on identical source files from five production repos showed
 * parity (46% vs. 50%) on that shared territory, so we no longer ship our
 * own. `fetch-no-abort-in-effect` has no equivalent upstream yet — keeping
 * it is the reason this scanner exists.
 *
 * How the scanner works:
 *
 *   1. Find every `useEffect` / `useLayoutEffect` / `useInsertionEffect`
 *      call in the file.
 *   2. Collect every `fetch(...)` call inside the effect's function body,
 *      including nested closures, event handlers, `.map()` callbacks, and
 *      helper functions defined inside the effect.
 *   3. For each `fetch` call, check whether an `AbortSignal` was passed
 *      via `fetch(url, { signal: ... })`. A call without `signal` is
 *      unabortable and always flagged — cleanup can't save it.
 *   4. For cleanable calls (signal present or opaque options), inspect
 *      the effect's `return` statement: does its returned function call
 *      `.abort()` on anything? If so, treat them as cleaned up.
 *   5. Report every unclean `fetch` call.
 *
 * Limitations (honest list):
 *   - Does not follow calls out of the effect body. If `fetch` lives in a
 *     helper defined outside the effect, we miss it. Cross-function
 *     analysis is the largest remaining miss class.
 *   - Conditional cleanup (`return cond ? cleanup : undefined`) is not
 *     statically evaluated; we conservatively treat any `.abort()` inside
 *     the returned function as sufficient.
 *   - Indeterminate returns (`return cleanupRef.current`, `return a ?? b`)
 *     suppress findings from that effect to avoid false positives.
 *   - Opaque options (`fetch(url, opts)` where `opts` is an identifier or
 *     contains a spread) are treated as MAYBE having a signal, which
 *     leaves one residual FN: `fetch(url, optsWithoutSignal)` cleared by
 *     an unrelated `.abort()` elsewhere in cleanup. Requires type info
 *     to close cleanly.
 *
 * Uses only the `typescript` package (already a devDep via tsc). No new
 * runtime dependency.
 */
import * as ts from "typescript";

// ─── Public types ───────────────────────────────────────────────────

export interface AstFinding {
  rule: string;
  risk: string;
  severity: "critical" | "warning" | "info";
  detector: string;
  fix: string;
  line: number;
  column: number;
  code: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const EFFECT_HOOKS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
]);

// For each dangerous call, which cleanup call name(s) satisfy it.
// `abort` matches any `.abort()` method call (AbortController instances).
interface DangerRule {
  call: string;
  cleanups: readonly string[];
  severity: AstFinding["severity"];
  detector: string;
  rule: string;
  risk: string;
  fix: string;
}

const DANGER_RULES: readonly DangerRule[] = [
  {
    call: "fetch",
    cleanups: ["abort"],
    severity: "critical",
    detector: "after-teardown",
    rule: "fetch-no-abort-in-effect",
    risk: "fetch() inside useEffect without AbortController — response may arrive after unmount",
    fix: "Use AbortController: const ctrl = new AbortController(); fetch(url, { signal: ctrl.signal }); return () => ctrl.abort();",
  },
];

const CALL_BY_NAME = new Map(DANGER_RULES.map((r) => [r.call, r]));

// ─── AST helpers ────────────────────────────────────────────────────

/** Resolve the simple name of a called expression: `foo(...)` → "foo",
 *  `x.foo(...)` → "foo". Returns undefined for anything fancier. */
function getCalleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** Global objects on which `.fetch` refers to the real native API (so the
 *  cleanup rule applies the same as a bare call). Anything else (e.g.
 *  `sdk.fetch(...)`) is a user-space wrapper with its own lifecycle — we
 *  must not flag it. */
const NATIVE_TIMER_HOSTS = new Set(["window", "globalThis", "self", "global"]);

/** For `fetch`, the call must be bare OR a property access on a known
 *  global host. Rejects managed wrappers like `sdk.fetch(...)`. */
function isNativeGlobalCallTarget(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return true;
  if (ts.isPropertyAccessExpression(expr)) {
    const obj = expr.expression;
    if (ts.isIdentifier(obj)) return NATIVE_TIMER_HOSTS.has(obj.text);
    return false;
  }
  return false;
}

/** Calls that are only dangerous when invoked on the native global —
 *  i.e. the `sdk.fetch` escape hatch applies. */
const RESTRICTED_TO_NATIVE_GLOBAL = new Set(["fetch"]);

/** Does this `fetch(url, options?)` call pass a `signal` option that could
 *  be aborted from cleanup?
 *
 *  - "no"    — no second arg, or second arg is an object literal with no
 *              `signal` property and no spreads. Can never be aborted;
 *              flag regardless of what cleanup does.
 *  - "yes"   — second arg is an object literal with a `signal` property.
 *              Cleanup heuristic applies.
 *  - "maybe" — second arg is an identifier, call expression, or object
 *              literal containing a spread. We can't prove signal absence
 *              without type info; conservatively apply cleanup heuristic
 *              (risk: FN for `fetch(url, optsWithoutSignal)`). */
function fetchSignalStatus(call: ts.CallExpression): "no" | "yes" | "maybe" {
  const options = call.arguments[1];
  if (!options) return "no";
  if (!ts.isObjectLiteralExpression(options)) return "maybe";
  let sawSpread = false;
  for (const prop of options.properties) {
    if (ts.isSpreadAssignment(prop)) {
      sawSpread = true;
      continue;
    }
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      const nameNode = prop.name;
      const n =
        ts.isIdentifier(nameNode) ? nameNode.text
        : ts.isStringLiteral(nameNode) ? nameNode.text
        : undefined;
      if (n === "signal") return "yes";
    }
  }
  return sawSpread ? "maybe" : "no";
}

/** Does this call expression look like a React effect hook? */
function isEffectHookCall(node: ts.CallExpression): boolean {
  const name = getCalleeName(node.expression);
  return name !== undefined && EFFECT_HOOKS.has(name);
}

/** Body of an effect's first argument, if it's an inline function with a
 *  block body. We ignore expression-bodied arrows (`() => foo()`) — they
 *  can't have a return statement for cleanup anyway. */
function getEffectBody(effectArg: ts.Expression): ts.Block | undefined {
  if (ts.isArrowFunction(effectArg) || ts.isFunctionExpression(effectArg)) {
    return ts.isBlock(effectArg.body) ? effectArg.body : undefined;
  }
  return undefined;
}

/** Walk any node, yielding every CallExpression in source order. */
function collectCalls(root: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(root, visit);
  // forEachChild skips the root itself; if the root is a call expression
  // (rare for a Block but possible for a nested arrow body), include it.
  if (ts.isCallExpression(root)) out.push(root);
  return out;
}

interface CleanupCollection {
  /** Bodies of inline cleanup functions (arrow/function expression) —
   *  safe to walk for abort calls. */
  inlineBodies: ts.Node[];
  /** True if any return returned a non-function expression (e.g.
   *  `return cleanupRef.current`). We can't trace those without
   *  cross-function analysis; suppress findings to avoid false positives. */
  indeterminate: boolean;
}

/** Find the effect's cleanup. We only analyze inline arrow/function
 *  returns (`return () => {...}` or `return () => call(...)`). Anything
 *  else (`return cleanupFn`, `return cond ? a : b`) is flagged as
 *  indeterminate and the entire effect is skipped. */
function findCleanup(effectBody: ts.Block): CleanupCollection {
  const out: CleanupCollection = { inlineBodies: [], indeterminate: false };
  const visit = (n: ts.Node): void => {
    if (ts.isReturnStatement(n)) {
      if (!n.expression) {
        // `return;` — no cleanup registered.
      } else if (ts.isArrowFunction(n.expression) || ts.isFunctionExpression(n.expression)) {
        out.inlineBodies.push(n.expression.body);
      } else {
        out.indeterminate = true;
      }
    }
    // Don't descend into nested functions — their returns aren't the
    // effect's cleanup.
    if (
      ts.isArrowFunction(n) ||
      ts.isFunctionExpression(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n)
    ) {
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(effectBody, visit);
  return out;
}

// ─── Core analyzer ──────────────────────────────────────────────────

/** Walk a binding pattern (array/object destructuring) and yield every
 *  identifier it binds. Handles `const [a, b]`, `const {x, y: z}`, and
 *  rest patterns. */
function collectBindingNames(pattern: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(pattern)) {
    out.add(pattern.text);
    return;
  }
  if (ts.isArrayBindingPattern(pattern)) {
    for (const el of pattern.elements) {
      if (ts.isBindingElement(el)) collectBindingNames(el.name, out);
    }
    return;
  }
  if (ts.isObjectBindingPattern(pattern)) {
    for (const el of pattern.elements) collectBindingNames(el.name, out);
  }
}

/** Walk up from a node to the nearest enclosing function-like node. This
 *  is the component body (for a hook call inside a function component),
 *  or a hook implementation for useXxx helpers. */
function enclosingFunction(
  node: ts.Node,
): ts.FunctionLikeDeclaration | ts.ArrowFunction | undefined {
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent)
    ) {
      return parent;
    }
    parent = parent.parent;
  }
  return undefined;
}

/** Collect every local binding name inside a function. Used to detect
 *  shadows: `const [fetch, setFetch] = useState(...)` declares a local
 *  `fetch` that has nothing to do with the global, so we must not flag
 *  `fetch(...)` calls against that name. */
function collectLocalBindings(fn: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) {
      collectBindingNames(n.name, names);
    } else if (ts.isFunctionDeclaration(n) && n.name) {
      names.add(n.name.text);
    } else if (ts.isParameter(n)) {
      collectBindingNames(n.name, names);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return names;
}

/** Walk any node collecting every Identifier reference. Used for cleanup
 *  analysis where helpers are passed by name: `controllers.forEach(c => c.abort())`
 *  still references `abort` without us having to trace the closure. */
function collectIdentifierNames(root: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(root, visit);
  if (ts.isIdentifier(root)) out.add(root.text);
  return out;
}

interface DangerousCall {
  call: ts.CallExpression;
  /** If false, cleanup cannot possibly satisfy this call (no signal was
   *  passed), so we flag unconditionally. If true, we consult the cleanup
   *  heuristic. */
  cleanable: boolean;
}

interface EffectAnalysis {
  effectCall: ts.CallExpression;
  dangerousCalls: DangerousCall[];
  cleanupCallNames: Set<string>;
  /** True if we saw a `return <something-not-a-function>` — unclear
   *  intent, so we suppress findings from this effect to avoid FPs. */
  cleanupIndeterminate: boolean;
}

function analyzeEffect(effectCall: ts.CallExpression): EffectAnalysis | undefined {
  const [effectArg] = effectCall.arguments;
  if (!effectArg) return undefined;
  const body = getEffectBody(effectArg);
  if (!body) return undefined;

  // Shadow check: if the component declares a local `fetch` (e.g. via
  // `const [fetch, setFetch] = useState(...)`), the name in this scope
  // does NOT refer to the global API.
  const enclosing = enclosingFunction(effectCall);
  const shadowedNames = enclosing ? collectLocalBindings(enclosing) : new Set<string>();

  const calls = collectCalls(body);
  const dangerousCalls: DangerousCall[] = [];
  for (const c of calls) {
    const name = getCalleeName(c.expression);
    if (name === undefined || !CALL_BY_NAME.has(name)) continue;
    // `fetch` must be bare or called on a real global. Managed wrappers
    // like `sdk.fetch` are out of scope — they have their own disposal
    // and we can't reason about them.
    if (RESTRICTED_TO_NATIVE_GLOBAL.has(name) && !isNativeGlobalCallTarget(c.expression)) {
      continue;
    }
    // Only apply shadow check to bare identifier calls — `window.fetch`
    // is always the real thing regardless of local bindings.
    if (
      RESTRICTED_TO_NATIVE_GLOBAL.has(name) &&
      ts.isIdentifier(c.expression) &&
      shadowedNames.has(name)
    ) {
      continue;
    }
    // A fetch called without any `signal` option can't be aborted from
    // cleanup, so the cleanup heuristic doesn't apply — we flag
    // unconditionally. Anything else (signal present, or opaque options
    // object) defers to the cleanup check.
    const cleanable = name === "fetch" ? fetchSignalStatus(c) !== "no" : true;
    dangerousCalls.push({ call: c, cleanable });
  }
  if (dangerousCalls.length === 0) return undefined;

  const cleanup = findCleanup(body);
  const cleanupCallNames = new Set<string>();

  for (const node of cleanup.inlineBodies) {
    // Include both called names AND any identifier referenced in the
    // cleanup body. This covers `controllers.forEach(c => c.abort())`
    // where the cleanup helper is passed by reference.
    for (const name of collectIdentifierNames(node)) {
      cleanupCallNames.add(name);
    }
  }

  return {
    effectCall,
    dangerousCalls,
    cleanupCallNames,
    cleanupIndeterminate: cleanup.indeterminate,
  };
}

function danger(call: ts.CallExpression): DangerRule | undefined {
  const name = getCalleeName(call.expression);
  return name ? CALL_BY_NAME.get(name) : undefined;
}

// ─── Public entry point ─────────────────────────────────────────────

export function scanSourceAst(filePath: string, content: string): AstFinding[] {
  const ext = filePath.toLowerCase();
  const scriptKind = ext.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ext.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : ext.endsWith(".ts")
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;

  let source: ts.SourceFile;
  try {
    source = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      scriptKind,
    );
  } catch {
    // Parse failure on unusual syntax — return empty so the caller can
    // keep scanning other files.
    return [];
  }

  const findings: AstFinding[] = [];
  const lines = content.split("\n");

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isEffectHookCall(node)) {
      const analysis = analyzeEffect(node);
      if (analysis) {
        for (const { call, cleanable } of analysis.dangerousCalls) {
          const rule = danger(call);
          if (!rule) continue;

          // If this specific call isn't cleanable at all (e.g. a fetch
          // called with no `signal` option), skip the cleanup check and
          // flag unconditionally. Otherwise, apply the usual heuristic.
          if (cleanable) {
            // Indeterminate cleanup → suppress to avoid FPs.
            if (analysis.cleanupIndeterminate) continue;

            // If any listed cleanup appears in the cleanup function, the
            // effect is considered cleaned.
            const cleaned = rule.cleanups.some((c) => analysis.cleanupCallNames.has(c));
            if (cleaned) continue;
          }

          const { line, character } = source.getLineAndCharacterOfPosition(call.getStart(source));
          findings.push({
            rule: rule.rule,
            risk: rule.risk,
            severity: rule.severity,
            detector: rule.detector,
            fix: rule.fix,
            line: line + 1,
            column: character + 1,
            code: (lines[line] ?? "").trim().slice(0, 160),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return findings;
}
