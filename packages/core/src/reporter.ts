/**
 * reporter.ts — Built-in DevReporter
 *
 * Continuously monitors the pulse trace for race conditions and
 * reports findings to the console with deduplication, occurrence
 * counting, and actionable fix suggestions.
 *
 * @example
 *   import { createReporter } from 'pulscheck'
 *   const reporter = createReporter()
 *   reporter.start()
 *   // ... app runs ...
 *   reporter.stop()
 */

import { registry } from "./registry";
import { analyze, fingerprint } from "./analyze";
import { _nativeSetInterval, _nativeClearInterval } from "./instrument";
import type { Finding, FindingSeverity, AnalyzeOptions } from "./analyze";

// ─── Types ──────────────────────────────────────────────────────────

export interface ReporterOptions {
  /** Polling interval in ms. Default: 5000 */
  intervalMs?: number;
  /** Minimum severity to report. Default: "warning" */
  minSeverity?: FindingSeverity;
  /** Suppress specific patterns */
  suppress?: AnalyzeOptions["suppress"];
  /** Log to a custom function instead of console. */
  log?: (message: string) => void;
  /** Silence the startup banner. Default: false */
  quiet?: boolean;
}

export interface Reporter {
  /** Start the reporter loop. Idempotent. */
  start(): void;
  /** Stop the reporter loop. Idempotent. */
  stop(): void;
  /** Run analysis once and return findings (for programmatic use). */
  check(): Finding[];
  /** Reset dedup state — re-report previously seen findings. */
  reset(): void;
}

interface SeenEntry {
  finding: Finding;
  count: number;
  firstBeat: number;
  lastBeat: number;
}

// ─── Console formatting ─────────────────────────────────────────────

const SEVERITY_ICON: Record<FindingSeverity, string> = {
  critical: "\uD83D\uDED1",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

function formatFinding(entry: SeenEntry, log: (msg: string) => void): void {
  const f = entry.finding;
  const icon = SEVERITY_ICON[f.severity];
  const countStr = entry.count > 1 ? ` (x${entry.count})` : "";

  log(`${icon} [${f.severity.toUpperCase()}] ${f.summary}${countStr}`);
  log(`   Pattern: ${f.pattern}`);
  log(`   ${f.detail}`);

  // Show source code locations for the racing events
  const sites = f.events
    .filter((e) => e.callSite)
    .map((e) => ({ label: e.label, site: e.callSite! }));

  if (sites.length > 0) {
    const unique = [...new Map(sites.map((s) => [s.site, s])).values()];
    if (unique.length === 1) {
      log(`   Location: ${unique[0].site}`);
    } else {
      log(`   Locations:`);
      for (const s of unique) {
        log(`     → ${s.site}  (${s.label})`);
      }
    }
  }

  if (f.fix) {
    log(`   Fix: ${f.fix}`);
  }

  log("");
}

// ─── Reporter factory ───────────────────────────────────────────────

export function createReporter(options: ReporterOptions = {}): Reporter {
  const {
    intervalMs = 5_000,
    minSeverity = "warning",
    suppress,
    log = (msg: string) => console.log(msg),
    quiet = false,
  } = options;

  let intervalId: ReturnType<typeof setInterval> | null = null;
  const seen = new Map<string, SeenEntry>();

  function check(): Finding[] {
    const trace = registry.trace;
    if (trace.length === 0) return [];

    return analyze(trace, { minSeverity, suppress });
  }

  function report(): void {
    const findings = check();
    if (findings.length === 0) return;

    let newFindings = 0;

    for (const f of findings) {
      const fp = fingerprint(f);
      const existing = seen.get(fp);

      if (existing) {
        // Same structural bug — increment count, update timestamp
        existing.count++;
        existing.lastBeat = f.beatRange[1];
        existing.finding = f; // keep latest instance for detail
      } else {
        // New finding — record and display
        seen.set(fp, {
          finding: f,
          count: 1,
          firstBeat: f.beatRange[0],
          lastBeat: f.beatRange[1],
        });
        newFindings++;
      }
    }

    if (newFindings === 0) return;

    // Only print newly discovered findings
    const toPrint = [...seen.values()].filter((e) => e.count === 1);

    if (toPrint.length === 0) return;

    log(`\n[pulscheck] ${toPrint.length} new finding(s):\n`);

    for (const entry of toPrint) {
      formatFinding(entry, log);
    }

    // Summary of recurring issues
    const recurring = [...seen.values()].filter((e) => e.count > 1);
    if (recurring.length > 0) {
      log(`[pulscheck] ${recurring.length} recurring issue(s) suppressed (use reporter.reset() to re-report)`);
      log("");
    }
  }

  return {
    start() {
      if (intervalId) return;
      if (!quiet) {
        log("[pulscheck] Reporter started — monitoring for race conditions\n");
      }
      // Run immediately, then on interval
      report();
      intervalId = _nativeSetInterval(report, intervalMs);
    },

    stop() {
      if (!intervalId) return;
      _nativeClearInterval(intervalId);
      intervalId = null;
      if (!quiet) {
        log("[pulscheck] Reporter stopped\n");
      }
    },

    check,

    reset() {
      seen.clear();
    },
  };
}
