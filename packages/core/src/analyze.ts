/**
 * analyze.ts — Automatic race condition detector
 *
 * Feed it a trace, it tells you what's wrong. No configuration needed.
 *
 * Detects 5 patterns:
 *   1. after-teardown   — event fires after a known cleanup/dispose/unmount
 *   2. response-reorder — responses arrive in different order than requests
 *   3. double-trigger   — same operation starts twice concurrently
 *   4. sequence-gap     — numbered sequences with missing entries
 *   5. stale-overwrite  — older operation's result overwrites newer one
 *
 * @example
 *   import { tw, analyze } from 'pulscheck'
 *   // ... instrument your code with tw.pulse() ...
 *   const findings = analyze(tw.trace)
 *   findings.forEach(f => console.warn(f.summary))
 */
import type { PulseEvent } from "./types";

// ─── Types ───────────────────────────────────────────────────────────

export type FindingSeverity = "critical" | "warning" | "info";

export type FindingPattern =
  | "after-teardown"
  | "response-reorder"
  | "double-trigger"
  | "sequence-gap"
  | "stale-overwrite";

export interface Finding {
  pattern: FindingPattern;
  severity: FindingSeverity;
  summary: string;
  detail: string;
  /** Actionable fix suggestion */
  fix: string;
  /** The events involved in this finding */
  events: PulseEvent[];
  /** Beat range where the issue occurs */
  beatRange: [number, number];
}

// ─── Well-known label conventions ────────────────────────────────────
// The analyzer infers semantics from label naming conventions.
// Users don't need to configure anything — just follow common patterns.

const TEARDOWN_SIGNALS = [
  "unmount", "dispose", "destroy", "cleanup", "close", "disconnect",
  "teardown", "unsubscribe", "detach", "remove",
];

/** Events that are EXPECTED after teardown — recovery, not bugs */
const RECOVERY_SIGNALS = [
  "reconnect", "retry", "recover", "restart", "resume", "resubscribe",
  "reattach", "reopen", "fallback",
];

const REQUEST_SIGNALS = ["request", "fetch", "call", "send", "query", "start"];
const RESPONSE_SIGNALS = ["response", "result", "complete", "receive", "done", "end"];
const RENDER_SIGNALS = ["render", "update", "display", "show", "paint", "setState"];

function matchesAny(label: string, signals: string[]): boolean {
  const lower = label.toLowerCase();
  return signals.some((s) => lower.includes(s));
}

function labelBase(label: string): string {
  // "search:request" → "search", "ProfileCard:fetch:start" → "ProfileCard:fetch"
  const parts = label.split(":");
  if (parts.length <= 1) return label;
  return parts.slice(0, -1).join(":");
}

/**
 * Normalize fetch label paths by collapsing dynamic segments.
 * "fetch:/api/user/123" and "fetch:/api/user/456" → "fetch:/api/user/:id"
 * This lets detectors group requests to the same logical endpoint.
 */
function normalizeFetchLabel(label: string): string {
  if (!label.startsWith("fetch:")) return label;
  // Extract path portion: "fetch:/api/user/123:start" → "/api/user/123"
  const parts = label.split(":");
  if (parts.length < 3) return label;
  const path = parts[1]; // "/api/user/123"
  const suffix = parts.slice(2).join(":"); // "start" or "done"

  const normalized = path.replace(
    /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]+|[0-9a-f]{24,})/gi,
    "/:id",
  );
  return `fetch:${normalized}:${suffix}`;
}

// ─── Kind-aware helpers ─────────────────────────────────────────────
// Check the structured `kind` field first (always correct for auto-
// instrumented events), fall back to label substring matching for
// manual pulses that don't set kind.

function isRequest(e: PulseEvent): boolean {
  if (e.kind) return e.kind === "request";
  return matchesAny(e.label, REQUEST_SIGNALS) && !matchesAny(e.label, RESPONSE_SIGNALS);
}

function isResponse(e: PulseEvent): boolean {
  if (e.kind) return e.kind === "response";
  return matchesAny(e.label, RESPONSE_SIGNALS);
}

function isTeardown(e: PulseEvent): boolean {
  if (e.kind) return e.kind === "scope-end";
  return matchesAny(e.label, TEARDOWN_SIGNALS);
}

function isRecovery(e: PulseEvent): boolean {
  return matchesAny(e.label, RECOVERY_SIGNALS);
}

function isRender(e: PulseEvent): boolean {
  if (e.kind) return e.kind === "render" || e.kind === "state-write";
  return matchesAny(e.label, RENDER_SIGNALS);
}

function isOperationStart(e: PulseEvent): boolean {
  if (e.kind) return e.kind === "request" || e.kind === "timer-start";
  return e.label.endsWith(":start") || (matchesAny(e.label, REQUEST_SIGNALS) && !matchesAny(e.label, RESPONSE_SIGNALS));
}

function isOperationEnd(e: PulseEvent): boolean {
  if (e.kind) {
    return e.kind === "response" || e.kind === "timer-end" || e.kind === "timer-clear"
      || e.kind === "timer-tick" || e.kind === "error";
  }
  return matchesAny(e.label, ["end", "complete", "response", "done", "fire", "clear", "tick"]);
}

// ─── Pattern 1: After-teardown ───────────────────────────────────────

function detectAfterTeardown(trace: readonly PulseEvent[]): Finding[] {
  const findings: Finding[] = [];

  // Group by correlationId
  const groups = groupByCorrelation(trace);

  // Build parentId index: for each correlationId that has a teardown,
  // also include events whose parentId matches that correlationId.
  // This enables auto-instrumented events (which have their own cid
  // but set parentId to the scope's cid) to be caught by the pattern.
  const parentIndex = new Map<string, PulseEvent[]>();
  for (const e of trace) {
    if (e.parentId) {
      const arr = parentIndex.get(e.parentId) ?? [];
      arr.push(e);
      parentIndex.set(e.parentId, arr);
    }
  }

  for (const [cid, events] of groups) {
    // Merge: direct correlation group + events whose parentId matches this cid
    const children = parentIndex.get(cid) ?? [];
    const merged = [...events, ...children];
    // Deduplicate (an event might be in both groups if its cid equals its parentId)
    const seen = new Set<PulseEvent>();
    const unique = merged.filter((e) => { if (seen.has(e)) return false; seen.add(e); return true; });

    const sorted = unique.sort((a, b) => a.beat - b.beat);
    const teardown = sorted.find(isTeardown);
    if (!teardown) continue;

    const afterTeardown = sorted.filter(
      (e) => e.beat > teardown.beat && e !== teardown,
    );

    // If a recovery event exists (reconnect, retry, etc.), everything after
    // the recovery is expected — only flag events BETWEEN teardown and recovery.
    const recovery = afterTeardown.find(isRecovery);

    for (const stale of afterTeardown) {
      // Skip teardown-like events (e.g. second disconnect)
      if (isTeardown(stale)) continue;
      // Skip recovery events themselves — reconnect after disconnect is the fix, not a bug
      if (isRecovery(stale)) continue;
      // Skip events that come AFTER recovery — they're part of the new lifecycle
      if (recovery && stale.beat >= recovery.beat) continue;

      findings.push({
        pattern: "after-teardown",
        severity: isRender(stale) ? "critical" : "warning",
        fix: "Add cleanup: clear timers, abort fetches (AbortController), unsubscribe listeners in useEffect return. A ref guard (if (!mountedRef.current) return) prevents late setState.",
        summary: `"${stale.label}" fired after "${teardown.label}" (cid: ${cid})`,
        detail:
          `Event "${stale.label}" at beat ${stale.beat.toFixed(2)} occurred ` +
          `${(stale.beat - teardown.beat).toFixed(2)}ms after teardown "${teardown.label}" ` +
          `at beat ${teardown.beat.toFixed(2)}. This often means a callback, timer, or ` +
          `subscription wasn't cleaned up before disposal.` +
          (recovery
            ? ` (Note: recovery event "${recovery.label}" found — events after recovery are excluded.)`
            : ""),
        events: [teardown, stale],
        beatRange: [teardown.beat, stale.beat],
      });
    }
  }

  return findings;
}

// ─── Pattern 2: Response reorder ─────────────────────────────────────

function detectResponseReorder(trace: readonly PulseEvent[]): Finding[] {
  const findings: Finding[] = [];
  const sorted = [...trace].sort((a, b) => a.beat - b.beat);

  // Find request/response pairs by matching label base
  // e.g., "search:request" and "search:response" share base "search"
  const requests: PulseEvent[] = [];
  const responses: PulseEvent[] = [];

  for (const e of sorted) {
    if (isRequest(e)) {
      requests.push(e);
    } else if (isResponse(e)) {
      responses.push(e);
    }
  }

  // Group requests by normalized label base — collapses dynamic segments
  // so /api/user/1 and /api/user/2 are detected as the same endpoint
  const requestsByBase = new Map<string, PulseEvent[]>();
  for (const r of requests) {
    const base = labelBase(normalizeFetchLabel(r.label));
    const arr = requestsByBase.get(base) ?? [];
    arr.push(r);
    requestsByBase.set(base, arr);
  }

  for (const [base, reqs] of requestsByBase) {
    if (reqs.length < 2) continue;

    // Find matching responses by correlationId
    const pairs: { req: PulseEvent; res: PulseEvent }[] = [];
    for (const req of reqs) {
      const res = responses.find((r) => r.correlationId === req.correlationId);
      if (res) pairs.push({ req, res });
    }

    if (pairs.length < 2) continue;

    // Check: did responses arrive in the same order as requests?
    const reqOrder = pairs.map((p) => p.req.correlationId);
    const resByResponseTime = [...pairs].sort((a, b) => a.res.beat - b.res.beat);
    const resOrder = resByResponseTime.map((p) => p.req.correlationId);

    if (JSON.stringify(reqOrder) !== JSON.stringify(resOrder)) {
      // Sink-awareness: if generation metadata is present, check whether
      // a stale response (older generation) was the LAST to resolve.
      // That means the app almost certainly used the stale data (critical),
      // vs just out-of-order arrival that might have been handled (warning).
      const lastToResolve = resByResponseTime[resByResponseTime.length - 1];
      const lastResolveGen = lastToResolve.res.meta?.generation as number | undefined;
      const latestGen = lastToResolve.res.meta?.latestGeneration as number | undefined;
      const staleLastResolve = lastResolveGen != null && latestGen != null && lastResolveGen < latestGen;

      findings.push({
        pattern: "response-reorder",
        severity: staleLastResolve ? "critical" : "warning",
        fix: staleLastResolve
          ? "CONFIRMED STALE: The oldest request resolved last — its data overwrote the fresh result. Use AbortController to cancel superseded requests, or check a generation/sequence number before calling setState."
          : "Cancel stale requests with AbortController when a new request starts. Or stamp each request with an ID and discard responses from older requests before calling setState.",
        summary: staleLastResolve
          ? `Stale response for "${base}" resolved last — confirmed data corruption`
          : `Responses for "${base}" arrived out of request order`,
        detail:
          `Requests were sent in order [${reqOrder.join(", ")}] but responses ` +
          `arrived as [${resOrder.join(", ")}]. ` +
          (staleLastResolve
            ? `Generation tracking confirms the stale response (gen ${lastResolveGen}) resolved after the fresh one (latest gen ${latestGen}). Without cancellation, the UI now shows outdated data.`
            : `The last response to arrive may overwrite the correct (more recent) result.`),
        events: pairs.flatMap((p) => [p.req, p.res]),
        beatRange: [pairs[0].req.beat, pairs[pairs.length - 1].res.beat],
      });
    }
  }

  return findings;
}

// ─── Pattern 3: Double-trigger ───────────────────────────────────────

function detectDoubleTrigger(trace: readonly PulseEvent[]): Finding[] {
  const findings: Finding[] = [];
  const sorted = [...trace].sort((a, b) => a.beat - b.beat);

  // Find operations that start with :start or match request signals
  const starts = sorted.filter(isOperationStart);

  // Group by normalized label — collapses dynamic path segments
  // so fetch:/api/user/1:start and fetch:/api/user/2:start are grouped
  const byLabel = new Map<string, PulseEvent[]>();
  for (const s of starts) {
    const key = normalizeFetchLabel(s.label);
    const arr = byLabel.get(key) ?? [];
    arr.push(s);
    byLabel.set(key, arr);
  }

  for (const [label, events] of byLabel) {
    if (events.length < 2) continue;

    // Skip generic timer labels from auto-instrumentation — multiple independent
    // timers are normal (Vite HMR, React internals, toast/debounce timers).
    // Only flag timers with explicit user labels or fetch operations.
    const isGenericTimer =
      label === "setTimeout:start" || label === "setInterval:start";
    if (isGenericTimer) continue;

    // Check for overlapping: second starts before first's matching :end
    for (let i = 0; i < events.length - 1; i++) {
      const first = events[i];
      const second = events[i + 1];

      // Find the completion event for the first operation
      const firstEnd = sorted.find(
        (e) => e.correlationId === first.correlationId && isOperationEnd(e),
      );

      const isOverlapping = !firstEnd || second.beat < firstEnd.beat;

      if (isOverlapping) {
        // Check if operations have different parameters — if so, it's intentional
        // concurrency (e.g. two different search queries), not a double-trigger bug.
        const sameParams = metaEqual(first.meta, second.meta);

        findings.push({
          pattern: "double-trigger",
          severity: sameParams ? "critical" : "info",
          fix: sameParams
            ? "Guard against duplicate triggers: check a loading flag before starting, debounce the action, or disable the trigger element until completion."
            : "Different parameters suggest intentional concurrency. If not intended, add deduplication by operation key.",
          summary: sameParams
            ? `"${label}" triggered twice concurrently with same parameters`
            : `"${label}" triggered twice concurrently (different parameters — likely intentional)`,
          detail:
            `Operation "${label}" was started at beat ${first.beat.toFixed(2)} (cid: ${first.correlationId}) ` +
            `and again at beat ${second.beat.toFixed(2)} (cid: ${second.correlationId}) ` +
            `${firstEnd ? `before the first completed at beat ${firstEnd.beat.toFixed(2)}` : "and the first hasn't completed yet"}. ` +
            (sameParams
              ? `Both have identical parameters — this often indicates a missing mutex, debounce, or deduplication.`
              : `Parameters differ, so this may be intentional concurrency rather than a bug.`),
          events: [first, second, ...(firstEnd ? [firstEnd] : [])],
          beatRange: [first.beat, (firstEnd ?? second).beat],
        });
      }
    }
  }

  return findings;
}

// ─── Pattern 4: Sequence gap ─────────────────────────────────────────

function detectSequenceGap(trace: readonly PulseEvent[]): Finding[] {
  const findings: Finding[] = [];

  // Group by correlationId AND label — so ws:message and ws:server:sent
  // are checked independently. A gap in ws:message [1,2,5,6] is a real gap
  // even if ws:server:sent covers [3,4].
  const groups = new Map<string, PulseEvent[]>();
  for (const e of trace) {
    if (!e.meta || typeof e.meta.seq !== "number") continue;
    const key = `${e.correlationId}::${e.label}`;
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }

  for (const [key, events] of groups) {
    const sorted = [...events].sort(
      (a, b) => (a.meta!.seq as number) - (b.meta!.seq as number),
    );

    if (sorted.length < 2) continue;

    const cid = sorted[0].correlationId;
    const label = sorted[0].label;
    const seqs = sorted.map((e) => e.meta!.seq as number);

    for (let i = 1; i < seqs.length; i++) {
      const gap = seqs[i] - seqs[i - 1];
      if (gap > 1) {
        findings.push({
          pattern: "sequence-gap",
          severity: "critical",
          fix: "Handle reconnection gaps: re-fetch missed data after WebSocket reconnect, or request a replay of the missing sequence range from the server.",
          summary: `Sequence gap in "${label}": ${gap - 1} missing between seq ${seqs[i - 1]} and ${seqs[i]} (cid: ${cid})`,
          detail:
            `"${label}" events with correlationId "${cid}" have sequence numbers [${seqs.join(", ")}]. ` +
            `${gap - 1} item(s) are missing between positions ${seqs[i - 1]} and ${seqs[i]}. ` +
            `This often indicates dropped messages, lost events, or a reconnect gap.`,
          events: [sorted[i - 1], sorted[i]],
          beatRange: [sorted[i - 1].beat, sorted[i].beat],
        });
      }
    }
  }

  return findings;
}

// ─── Pattern 5: Stale overwrite ──────────────────────────────────────

function detectStaleOverwrite(trace: readonly PulseEvent[]): Finding[] {
  const findings: Finding[] = [];
  const sorted = [...trace].sort((a, b) => a.beat - b.beat);

  // Find render/update events
  const renders = sorted.filter(isRender);
  if (renders.length < 2) return findings;

  // Group renders by label base
  const byBase = new Map<string, PulseEvent[]>();
  for (const r of renders) {
    const base = labelBase(r.label);
    const arr = byBase.get(base) ?? [];
    arr.push(r);
    byBase.set(base, arr);
  }

  for (const [base, renderEvents] of byBase) {
    if (renderEvents.length < 2) continue;

    // For each render, find its originating request by correlationId
    for (let i = 0; i < renderEvents.length - 1; i++) {
      const earlier = renderEvents[i];
      const later = renderEvents[i + 1];

      // Find the request that triggered each render
      const earlierReq = sorted.find(
        (e) => e.correlationId === earlier.correlationId && isRequest(e),
      );
      const laterReq = sorted.find(
        (e) => e.correlationId === later.correlationId && isRequest(e),
      );

      // Stale overwrite: later render is from an OLDER request
      if (earlierReq && laterReq && laterReq.beat < earlierReq.beat) {
        findings.push({
          pattern: "stale-overwrite",
          severity: "critical",
          fix: "Check data freshness before rendering: track the most recent request timestamp and discard responses from older requests. AbortController also prevents this by canceling the slow request entirely.",
          summary: `Stale overwrite at "${base}": render from older request (${later.correlationId}) overwrote newer (${earlier.correlationId})`,
          detail:
            `Render at beat ${later.beat.toFixed(2)} is from request "${later.correlationId}" ` +
            `(sent at beat ${laterReq.beat.toFixed(2)}), which is OLDER than the previous render's ` +
            `request "${earlier.correlationId}" (sent at beat ${earlierReq.beat.toFixed(2)}). ` +
            `The UI now shows stale data. Fix: abort older requests, or check sequence before rendering.`,
          events: [laterReq, earlierReq, earlier, later],
          beatRange: [laterReq.beat, later.beat],
        });
      }
    }
  }

  return findings;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function groupByCorrelation(
  trace: readonly PulseEvent[],
): Map<string, PulseEvent[]> {
  const groups = new Map<string, PulseEvent[]>();
  for (const e of trace) {
    const arr = groups.get(e.correlationId) ?? [];
    arr.push(e);
    groups.set(e.correlationId, arr);
  }
  return groups;
}

/** Fields added by instrumentation — not user-meaningful parameters */
const INTERNAL_META_KEYS = new Set(["generation", "latestGeneration"]);

/** Shallow compare two meta objects (ignoring instrumentation-internal fields) */
function metaEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const keysA = Object.keys(a).filter((k) => !INTERNAL_META_KEYS.has(k));
  const keysB = Object.keys(b).filter((k) => !INTERNAL_META_KEYS.has(k));
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

// ─── Main API ────────────────────────────────────────────────────────

export interface AnalyzeOptions {
  /** Suppress specific patterns entirely */
  suppress?: FindingPattern[];
  /** Minimum severity to report. Default: "info" (show everything) */
  minSeverity?: FindingSeverity;
  /** Suppress findings matching a custom predicate */
  filter?: (finding: Finding) => boolean;
}

/**
 * Analyze a pulse trace for race conditions.
 * Returns findings sorted by severity (critical first) then by beat.
 */
export function analyze(
  trace: readonly PulseEvent[],
  opts: AnalyzeOptions = {},
): Finding[] {
  const suppress = new Set(opts.suppress ?? []);
  const minSev = opts.minSeverity ?? "info";

  const detectors: [FindingPattern, () => Finding[]][] = [
    ["after-teardown", () => detectAfterTeardown(trace)],
    ["response-reorder", () => detectResponseReorder(trace)],
    ["double-trigger", () => detectDoubleTrigger(trace)],
    ["sequence-gap", () => detectSequenceGap(trace)],
    ["stale-overwrite", () => detectStaleOverwrite(trace)],
  ];

  const severityOrder: Record<FindingSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  let findings: Finding[] = [];

  for (const [pattern, detect] of detectors) {
    if (suppress.has(pattern)) continue;
    findings.push(...detect());
  }

  // Filter by minimum severity
  const minOrder = severityOrder[minSev];
  findings = findings.filter((f) => severityOrder[f.severity] <= minOrder);

  // Apply custom filter
  if (opts.filter) {
    findings = findings.filter(opts.filter);
  }

  // Sort: critical first, then by beat
  findings.sort((a, b) => {
    const sev = severityOrder[a.severity] - severityOrder[b.severity];
    if (sev !== 0) return sev;
    return a.beatRange[0] - b.beatRange[0];
  });

  return findings;
}

/**
 * Pretty-print findings to console.
 */
export function printFindings(findings: Finding[]): void {
  if (findings.length === 0) {
    console.log("\u2705 No race conditions detected.");
    return;
  }

  const icons: Record<FindingSeverity, string> = {
    critical: "\uD83D\uDED1",
    warning: "\u26A0\uFE0F",
    info: "\u2139\uFE0F",
  };

  console.log(`\n\uD83D\uDD0D Found ${findings.length} potential issue(s):\n`);

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    console.log(`${icons[f.severity]} [${f.severity.toUpperCase()}] ${f.summary}`);
    console.log(`  Pattern: ${f.pattern}`);
    console.log(`  ${f.detail}`);
    if (f.fix) {
      console.log(`  Fix: ${f.fix}`);
    }
    console.log();
  }
}
