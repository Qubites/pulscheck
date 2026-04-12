/**
 * tracker.ts — Persistent finding lifecycle tracker
 *
 * Tracks race condition findings across runs with full lifecycle:
 *   new → recurring → resolved (or regressed)
 *
 * Developer can mark findings as "ignored" (intentional behavior).
 * Tracks both git commit SHA and beat timing for resolution.
 *
 * @example
 *   import { createTracker } from 'pulscheck'
 *   const tracker = createTracker({ baselinePath: '.pulscheck-baseline.json' })
 *   tracker.load()                    // read previous baseline
 *   const diff = tracker.compare(findings)  // compare with current
 *   tracker.save()                    // persist updated baseline
 */

import type { Finding, FindingPattern, FindingSeverity } from "./analyze";

// ─── Types ──────────────────────────────────────────────────────────

export type FindingStatus =
  | "new"        // First time seen
  | "recurring"  // Seen before, still present
  | "resolved"   // Was present, now gone
  | "regressed"  // Was resolved, came back
  | "ignored";   // Developer marked as intentional

export interface FindingSnapshot {
  commit?: string;
  timestamp: string;
  beatRange: [number, number];
}

export interface HistoryEntry {
  action: "detected" | "recurred" | "resolved" | "regressed" | "ignored" | "unignored";
  commit?: string;
  timestamp: string;
  beatRange?: [number, number];
}

export interface TrackedFinding {
  /** Structural fingerprint: pattern::sorted_labels */
  fingerprint: string;
  /** Which detection pattern */
  pattern: FindingPattern;
  /** Current severity */
  severity: FindingSeverity;
  /** Human-readable summary from latest occurrence */
  summary: string;
  /** Fix suggestion */
  fix: string;
  /** Current lifecycle status */
  status: FindingStatus;
  /** When this finding was first detected */
  firstSeen: FindingSnapshot;
  /** Most recent occurrence (or resolution) */
  lastSeen: FindingSnapshot;
  /** When it was resolved (null if still active) */
  resolvedAt: FindingSnapshot | null;
  /** Total times detected across all runs */
  occurrences: number;
  /** Consecutive runs where this finding appeared */
  streak: number;
  /** Full lifecycle history */
  history: HistoryEntry[];
}

export interface Baseline {
  version: 2;
  lastRun: string;
  lastCommit?: string;
  findings: Record<string, TrackedFinding>;
}

export interface DiffSummary {
  /** Findings seen for the first time */
  new: TrackedFinding[];
  /** Findings that were resolved but came back */
  regressed: TrackedFinding[];
  /** Findings still present from before */
  recurring: TrackedFinding[];
  /** Findings that disappeared since last run */
  resolved: TrackedFinding[];
  /** Findings marked as intentional (still detected but not flagged) */
  ignored: TrackedFinding[];
  /** Total active findings (new + regressed + recurring) */
  activeCount: number;
  /** Change from last run */
  delta: number;
  /** Human-readable summary */
  summary: string;
}

export interface TrackerOptions {
  /** Path to baseline file. Default: '.pulscheck-baseline.json' */
  baselinePath?: string;
  /** Current git commit SHA (auto-detected if not provided) */
  commit?: string;
  /** Custom read function (for non-Node environments) */
  readFile?: (path: string) => string | null;
  /** Custom write function (for non-Node environments) */
  writeFile?: (path: string, content: string) => void;
}

export interface Tracker {
  /** Load baseline from disk. Returns true if file existed. */
  load(): boolean;
  /** Compare current findings against baseline. Updates internal state. */
  compare(findings: Finding[]): DiffSummary;
  /** Mark a finding as ignored (intentional behavior). */
  ignore(fingerprint: string): boolean;
  /** Unmark a finding — re-track it. */
  unignore(fingerprint: string): boolean;
  /** Save updated baseline to disk. */
  save(): void;
  /** Get the current baseline (all tracked findings). */
  baseline(): Baseline;
  /** Get a specific tracked finding by fingerprint. */
  get(fingerprint: string): TrackedFinding | undefined;
  /** Print a human-readable diff summary. */
  printDiff(diff: DiffSummary, log?: (msg: string) => void): void;
}

// ─── Fingerprinting (matches reporter.ts) ───────────────────────────

export function fingerprint(f: Finding): string {
  const labels = f.events.map((e) => e.label).sort().join(",");
  return `${f.pattern}::${labels}`;
}

// ─── Default I/O (Node.js) ──────────────────────────────────────────

function defaultReadFile(path: string): string | null {
  try {
    // Dynamic require to avoid bundler issues in browser
    const fs = require("fs");
    return fs.readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function defaultWriteFile(path: string, content: string): void {
  const fs = require("fs");
  fs.writeFileSync(path, content, "utf-8");
}

// ─── Tracker factory ────────────────────────────────────────────────

export function createTracker(options: TrackerOptions = {}): Tracker {
  const {
    baselinePath = ".pulscheck-baseline.json",
    commit,
    readFile = defaultReadFile,
    writeFile = defaultWriteFile,
  } = options;

  let state: Baseline = {
    version: 2,
    lastRun: new Date().toISOString(),
    lastCommit: commit,
    findings: {},
  };

  function now(): string {
    return new Date().toISOString();
  }

  function snapshot(f: Finding): FindingSnapshot {
    return {
      commit,
      timestamp: now(),
      beatRange: f.beatRange,
    };
  }

  function load(): boolean {
    const raw = readFile(baselinePath);
    if (!raw) return false;

    try {
      const parsed = JSON.parse(raw);
      if (parsed.version === 2) {
        state = parsed;
      } else if (parsed.version === 1 || !parsed.version) {
        // Migrate v1 → v2 if needed
        state = { ...parsed, version: 2 };
      }
      return true;
    } catch {
      return false;
    }
  }

  function compare(findings: Finding[]): DiffSummary {
    const currentFingerprints = new Set<string>();
    const ts = now();

    // Phase 1: Process current findings
    for (const f of findings) {
      const fp = fingerprint(f);
      currentFingerprints.add(fp);
      const existing = state.findings[fp];

      if (!existing) {
        // Brand new finding
        state.findings[fp] = {
          fingerprint: fp,
          pattern: f.pattern,
          severity: f.severity,
          summary: f.summary,
          fix: f.fix,
          status: "new",
          firstSeen: snapshot(f),
          lastSeen: snapshot(f),
          resolvedAt: null,
          occurrences: 1,
          streak: 1,
          history: [{ action: "detected", commit, timestamp: ts, beatRange: f.beatRange }],
        };
      } else if (existing.status === "ignored") {
        // Still detected, but developer said it's intentional — update silently
        existing.occurrences++;
        existing.lastSeen = snapshot(f);
        existing.severity = f.severity;
        existing.summary = f.summary;
      } else if (existing.status === "resolved") {
        // Was resolved, now it's back — regression!
        existing.status = "regressed";
        existing.severity = f.severity;
        existing.summary = f.summary;
        existing.fix = f.fix;
        existing.lastSeen = snapshot(f);
        existing.resolvedAt = null;
        existing.occurrences++;
        existing.streak = 1;
        existing.history.push({ action: "regressed", commit, timestamp: ts, beatRange: f.beatRange });
      } else {
        // Still present (new → recurring, or already recurring/regressed)
        if (existing.status === "new" || existing.status === "regressed") {
          existing.status = "recurring";
        }
        existing.occurrences++;
        existing.streak++;
        existing.lastSeen = snapshot(f);
        existing.severity = f.severity;
        existing.summary = f.summary;
        existing.history.push({ action: "recurred", commit, timestamp: ts, beatRange: f.beatRange });
      }
    }

    // Phase 2: Mark disappeared findings as resolved
    for (const [fp, tracked] of Object.entries(state.findings)) {
      if (!currentFingerprints.has(fp) && tracked.status !== "resolved" && tracked.status !== "ignored") {
        tracked.status = "resolved";
        tracked.resolvedAt = { commit, timestamp: ts, beatRange: [0, 0] };
        tracked.streak = 0;
        tracked.history.push({ action: "resolved", commit, timestamp: ts });
      }
    }

    // Update run metadata
    state.lastRun = ts;
    state.lastCommit = commit;

    // Build diff summary
    const tracked = Object.values(state.findings);
    const newFindings = tracked.filter((t) => t.status === "new");
    const regressed = tracked.filter((t) => t.status === "regressed");
    const recurring = tracked.filter((t) => t.status === "recurring");
    const resolved = tracked.filter((t) => t.status === "resolved");
    const ignored = tracked.filter((t) => t.status === "ignored");

    const activeCount = newFindings.length + regressed.length + recurring.length;
    const previousActive = findings.length; // approximate — real delta needs pre-state
    const delta = newFindings.length - resolved.length + regressed.length;

    const parts: string[] = [];
    if (newFindings.length > 0) parts.push(`${newFindings.length} new`);
    if (regressed.length > 0) parts.push(`${regressed.length} regressed`);
    if (recurring.length > 0) parts.push(`${recurring.length} recurring`);
    if (resolved.length > 0) parts.push(`${resolved.length} resolved`);
    if (ignored.length > 0) parts.push(`${ignored.length} ignored`);
    const summary = parts.length > 0 ? parts.join(", ") : "no findings";

    return {
      new: newFindings,
      regressed,
      recurring,
      resolved,
      ignored,
      activeCount,
      delta,
      summary,
    };
  }

  function ignore(fp: string): boolean {
    const tracked = state.findings[fp];
    if (!tracked) return false;
    tracked.status = "ignored";
    tracked.history.push({ action: "ignored", commit, timestamp: now() });
    return true;
  }

  function unignore(fp: string): boolean {
    const tracked = state.findings[fp];
    if (!tracked || tracked.status !== "ignored") return false;
    tracked.status = "recurring";
    tracked.history.push({ action: "unignored", commit, timestamp: now() });
    return true;
  }

  function save(): void {
    const content = JSON.stringify(state, null, 2);
    writeFile(baselinePath, content);
  }

  function printDiff(diff: DiffSummary, log: (msg: string) => void = console.log): void {
    log("");
    log("╔══════════════════════════════════════════════════════╗");
    log("║              PulsCheck Run Summary                   ║");
    log("╚══════════════════════════════════════════════════════╝");
    log("");

    if (commit) {
      log(`  Commit: ${commit.slice(0, 8)}`);
    }
    log(`  Active: ${diff.activeCount}  |  Delta: ${diff.delta >= 0 ? "+" : ""}${diff.delta}`);
    log(`  ${diff.summary}`);
    log("");

    if (diff.new.length > 0) {
      log("  🆕 NEW");
      for (const t of diff.new) {
        log(`     ${severityIcon(t.severity)} ${t.summary}`);
        log(`        Pattern: ${t.pattern}  |  Beat: ${t.firstSeen.beatRange[0].toFixed(0)}–${t.firstSeen.beatRange[1].toFixed(0)}ms`);
      }
      log("");
    }

    if (diff.regressed.length > 0) {
      log("  🔄 REGRESSED (was fixed, came back)");
      for (const t of diff.regressed) {
        log(`     ${severityIcon(t.severity)} ${t.summary}`);
        log(`        Was resolved at ${t.history.filter((h) => h.action === "resolved").pop()?.commit?.slice(0, 8) ?? "?"}`);
      }
      log("");
    }

    if (diff.resolved.length > 0) {
      log("  ✅ RESOLVED");
      for (const t of diff.resolved) {
        log(`     ${t.summary}`);
        log(`        First seen: ${t.firstSeen.timestamp.slice(0, 10)}  |  Occurrences: ${t.occurrences}`);
      }
      log("");
    }

    if (diff.recurring.length > 0) {
      log(`  ⏳ RECURRING (${diff.recurring.length})`);
      for (const t of diff.recurring) {
        log(`     ${severityIcon(t.severity)} ${t.summary}  (x${t.occurrences}, streak: ${t.streak})`);
      }
      log("");
    }

    if (diff.ignored.length > 0) {
      log(`  🔇 IGNORED (${diff.ignored.length})`);
      for (const t of diff.ignored) {
        log(`     ${t.summary}`);
      }
      log("");
    }

    log("─".repeat(56));
  }

  return {
    load,
    compare,
    ignore,
    unignore,
    save,
    baseline: () => state,
    get: (fp: string) => state.findings[fp],
    printDiff,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function severityIcon(severity: FindingSeverity): string {
  switch (severity) {
    case "critical":
      return "\uD83D\uDED1"; // 🛑
    case "warning":
      return "\u26A0\uFE0F"; // ⚠️
    case "info":
      return "\u2139\uFE0F"; // ℹ️
  }
}
