/**
 * testing.ts — PulsCheck test helper for Vitest / Jest
 *
 * Makes race conditions fail your tests. Works in CI, works with
 * Claude Code, works with any test runner that supports expect().
 *
 * @example
 *   import { withPulsCheck } from 'pulscheck/testing'
 *
 *   test('checkout has no race conditions', async () => {
 *     const result = await withPulsCheck(async ({ tw }) => {
 *       tw.pulse('cart:request', { kind: 'request', correlationId: 'a' })
 *       tw.pulse('cart:response', { kind: 'response', correlationId: 'a' })
 *     })
 *     expect(result.findings).toHaveLength(0)
 *   })
 *
 * @example — with auto-instrumentation
 *   test('fetches don\'t race', async () => {
 *     const result = await withPulsCheck({ instrument: true }, async () => {
 *       await fetch('/api/search?q=cat')
 *       await fetch('/api/search?q=cats')
 *     })
 *     result.expectClean()  // throws if any critical/warning findings
 *   })
 */

import { tw } from "./tw";
import { registry } from "./registry";
import { instrument, restore } from "./instrument";
import type { InstrumentOptions } from "./instrument";
import { analyze, printFindings } from "./analyze";
import type { Finding, FindingSeverity, AnalyzeOptions } from "./analyze";
import type { PulseEvent } from "./types";

// ─── Types ───────────────────────────────────────────────────────────

export interface PulsCheckTestOptions {
  /** Auto-instrument fetch, timers, WebSocket, DOM events. Default: false */
  instrument?: boolean | InstrumentOptions;
  /** Analyzer options (suppress patterns, min severity, etc.) */
  analyze?: AnalyzeOptions;
  /** Print findings to console even when tests pass. Default: false */
  verbose?: boolean;
}

export interface PulsCheckTestContext {
  /** The tw instance — use to emit manual pulses */
  tw: typeof tw;
  /** Direct access to the registry for advanced assertions */
  registry: typeof registry;
}

export interface PulsCheckResult {
  /** All findings from the analyzer */
  findings: Finding[];
  /** Only critical and warning findings */
  issues: Finding[];
  /** The raw trace (readonly snapshot) */
  trace: readonly PulseEvent[];
  /** Duration of the test function in ms */
  durationMs: number;

  /**
   * Assert no critical or warning findings.
   * Throws with a readable report if any are found.
   */
  expectClean(): void;

  /**
   * Assert no findings of a specific severity or higher.
   * @example result.expectNoSeverity('warning') // fails on warning or critical
   */
  expectNoSeverity(severity: FindingSeverity): void;

  /**
   * Assert a specific pattern was detected.
   * Useful for testing that your instrumentation actually catches a known bug.
   * @example result.expectPattern('stale-overwrite')
   */
  expectPattern(pattern: string): void;

  /**
   * Print findings to console (useful for debugging).
   */
  print(): void;
}

// ─── Severity helpers ────────────────────────────────────────────────

const SEV_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function findingsAtOrAbove(
  findings: Finding[],
  severity: FindingSeverity,
): Finding[] {
  const threshold = SEV_ORDER[severity];
  return findings.filter((f) => SEV_ORDER[f.severity] <= threshold);
}

// ─── Format findings for test output ─────────────────────────────────

function formatForTestRunner(findings: Finding[]): string {
  if (findings.length === 0) return "No race conditions detected.";

  const lines = [
    `PulsCheck: ${findings.length} issue(s) detected:\n`,
  ];

  for (const f of findings) {
    const icon = f.severity === "critical" ? "CRITICAL" : f.severity === "warning" ? "WARNING" : "INFO";
    lines.push(`  [${icon}] ${f.pattern}: ${f.summary}`);
    lines.push(`    ${f.detail}`);
    lines.push(`    Fix: ${f.fix}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Main API ────────────────────────────────────────────────────────

/**
 * Run a function with PulsCheck instrumentation and analysis.
 *
 * Overload 1: withPulsCheck(fn)
 * Overload 2: withPulsCheck(options, fn)
 */
export function withPulsCheck(
  fn: (ctx: PulsCheckTestContext) => void | Promise<void>,
): Promise<PulsCheckResult>;
export function withPulsCheck(
  options: PulsCheckTestOptions,
  fn: (ctx: PulsCheckTestContext) => void | Promise<void>,
): Promise<PulsCheckResult>;
export async function withPulsCheck(
  optionsOrFn:
    | PulsCheckTestOptions
    | ((ctx: PulsCheckTestContext) => void | Promise<void>),
  maybeFn?: (ctx: PulsCheckTestContext) => void | Promise<void>,
): Promise<PulsCheckResult> {
  // Parse overloaded arguments
  const options: PulsCheckTestOptions =
    typeof optionsOrFn === "function" ? {} : optionsOrFn;
  const fn =
    typeof optionsOrFn === "function" ? optionsOrFn : maybeFn!;

  // Clean slate
  registry.clear();

  // Optionally instrument globals
  let cleanupInstrument: (() => void) | undefined;
  if (options.instrument) {
    const instrumentOpts =
      typeof options.instrument === "object" ? options.instrument : {};
    cleanupInstrument = instrument(instrumentOpts);
  }

  // Run the test function
  const start = performance.now();
  try {
    await fn({ tw, registry });
  } finally {
    // Always clean up instrumentation, even if fn throws
    if (cleanupInstrument) {
      cleanupInstrument();
    } else {
      restore();
    }
  }
  const durationMs = performance.now() - start;

  // Snapshot the trace before any cleanup
  const trace = [...registry.trace] as readonly PulseEvent[];

  // Analyze
  const findings = analyze(trace, options.analyze ?? {});
  const issues = findingsAtOrAbove(findings, "warning");

  if (options.verbose) {
    printFindings(findings);
  }

  // Build result
  const result: PulsCheckResult = {
    findings,
    issues,
    trace,
    durationMs,

    expectClean() {
      if (issues.length > 0) {
        throw new Error(formatForTestRunner(issues));
      }
    },

    expectNoSeverity(severity: FindingSeverity) {
      const matched = findingsAtOrAbove(findings, severity);
      if (matched.length > 0) {
        throw new Error(formatForTestRunner(matched));
      }
    },

    expectPattern(pattern: string) {
      const matched = findings.filter((f) => f.pattern === pattern);
      if (matched.length === 0) {
        throw new Error(
          `PulsCheck: Expected pattern "${pattern}" but none found.\n` +
          `Detected patterns: [${findings.map((f) => f.pattern).join(", ") || "none"}]\n` +
          `Trace had ${trace.length} event(s).`,
        );
      }
    },

    print() {
      printFindings(findings);
    },
  };

  return result;
}

/**
 * Vitest/Jest-compatible assertion: plug directly into expect().
 *
 * @example
 *   test('no races', async () => {
 *     const result = await withPulsCheck(async ({ tw }) => { ... })
 *     assertClean(result)
 *   })
 */
export function assertClean(result: PulsCheckResult): void {
  result.expectClean();
}
