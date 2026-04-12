declare const VERSION: string;

type PulseLane = "ui" | "api" | "auth" | "ws" | "worker" | (string & {});
/** Structured event classification. Auto-instrumentation always sets this. */
type PulseKind = "request" | "response" | "error" | "timer-start" | "timer-end" | "timer-tick" | "timer-clear" | "dom-event" | "message" | "close" | "scope-start" | "scope-end" | "state-write" | "render" | "custom" | (string & {});
/** Who emitted the event. */
type PulseSource = "auto" | "manual" | "scope" | (string & {});
interface PulseOptions {
    lane?: PulseLane;
    public?: boolean;
    doc?: string;
    maxMs?: number;
    meta?: Record<string, unknown>;
    /** Correlation ID — links related pulses across lanes. Auto-generated if omitted. */
    correlationId?: string;
    /** Parent pulse correlationId — enables causal chain tracing. */
    parentId?: string;
    /** Sampling rate 0–1. Default 1 (always fire). Use 0.1 to sample 10% of calls. */
    sample?: number;
    /** Structured event classification. Detectors use this before falling back to label matching. */
    kind?: PulseKind;
    /** Event source. Default: "manual". Auto-instrumentation sets "auto", scopes set "scope". */
    source?: PulseSource;
    /** Source code location (file:line). Auto-captured by instrumentation. */
    callSite?: string;
}
interface PulseEvent {
    label: string;
    lane: PulseLane;
    beat: number;
    ts: number;
    public: boolean;
    /** DNA address — unique per label+lane+namespace: "pulse://ns/label/lane" */
    dna: string;
    /** Links related pulses across lanes — the core of collision detection */
    correlationId: string;
    /** Parent pulse ID for causal chain tracing */
    parentId?: string;
    meta?: Record<string, unknown>;
    /** Structured event classification — set by auto-instrumentation, optional for manual pulses */
    kind?: PulseKind;
    /** Who emitted this event */
    source?: PulseSource;
    /** Source code location where this event originated (file:line). Dev-only. */
    callSite?: string;
}

/**
 * scope.ts — Correlation scopes for auto-instrumentation
 *
 * A scope links auto-instrumented events (fetch, timers, etc.) to a
 * lifecycle boundary (component mount/unmount, user flow, etc.).
 *
 * When a scope is active, all auto-instrumented events inherit its
 * correlationId as their parentId. When the scope ends, it emits a
 * teardown event — enabling the after-teardown analyzer pattern.
 *
 * @example
 *   import { tw } from 'pulscheck'
 *
 *   // React component
 *   useEffect(() => {
 *     const scope = tw.scope("checkout");
 *     fetch("/api/pay");           // auto: parentId = scope.correlationId
 *     const id = setInterval(poll, 3000); // auto: parentId = scope.correlationId
 *     return () => {
 *       clearInterval(id);
 *       scope.end();               // emits "checkout:teardown"
 *     };
 *   }, []);
 */

interface Scope {
    /** The scope's unique correlation ID. Auto-events get this as parentId. */
    readonly correlationId: string;
    /** Human-readable name (used in teardown label: "{name}:teardown") */
    readonly name: string;
    /** Lane for this scope's own events */
    readonly lane: PulseLane;
    /** Whether the scope is still active (not yet ended) */
    readonly active: boolean;
    /**
     * Remove from scope stack without emitting teardown. Use in React effects:
     * async ops capture parentId during synchronous setup, then deactivate()
     * prevents other components from inheriting this scope. Call end() later
     * in the cleanup to emit the teardown event.
     */
    deactivate(): void;
    /** End the scope: emits a teardown event and removes from the scope stack. */
    end(): void;
}

interface MeasureResult {
    stop: () => number;
    startEvent: PulseEvent;
}
declare const tw: {
    readonly pulse: (label: string, opts?: PulseOptions) => PulseEvent;
    readonly measure: (label: string, opts?: PulseOptions) => MeasureResult;
    readonly checkpoint: (label: string, step: number, opts?: PulseOptions) => PulseEvent;
    /**
     * Create a correlation scope. All auto-instrumented events that fire
     * while this scope is active get its correlationId as their parentId.
     * Call scope.end() to emit a teardown event and close the scope.
     *
     * @example
     *   useEffect(() => {
     *     const scope = tw.scope("checkout");
     *     fetch("/api/pay"); // auto-pulsed with parentId = scope.correlationId
     *     return () => scope.end(); // emits "checkout:teardown"
     *   }, []);
     */
    readonly scope: (name: string, opts?: PulseOptions) => Scope;
    readonly on: (handler: (event: PulseEvent) => void) => () => void;
    readonly configure: (opts: {
        enabled?: boolean;
        maxTrace?: number;
    }) => void;
    readonly trace: readonly PulseEvent[];
    readonly clearTrace: () => void;
};
type TW = typeof tw;

/**
 * dom.ts — data-tw-pulse DOM attribute scanner
 *
 * Scans the DOM for elements with data-tw-pulse attributes and fires
 * pulse events when they become visible (IntersectionObserver) or
 * on DOMContentLoaded.
 *
 * Usage in JSX/HTML:
 *   <Skeleton data-tw-pulse="hero:loading" data-tw-lane="ui" data-tw-max="600" />
 *   <div data-tw-pulse="cart:visible" data-tw-public="true" />
 */
/**
 * Scan the document for data-tw-pulse elements and fire pulses.
 * Call once after DOMContentLoaded, or after dynamic content renders.
 */
declare function scanDom(root?: Element | Document): void;
/**
 * Observe data-tw-pulse elements and fire when they enter the viewport.
 * Returns a cleanup function.
 */
declare function observeDom(root?: Element | Document): () => void;
/**
 * Auto-initialize: scan on DOMContentLoaded and observe all pulse elements.
 * Call this once in your app entry point.
 *
 * @example
 * // In main.tsx / app entry
 * import { initDomPulse } from 'pulscheck'
 * initDomPulse()
 */
declare function initDomPulse(): () => void;

type PulseHandler = (event: PulseEvent) => void;
declare class PulseRegistry {
    private handlers;
    private _buf;
    private _head;
    private _count;
    private _cap;
    private _enabled;
    private _winCap;
    constructor(capacity?: number);
    configure(opts: {
        enabled?: boolean;
        maxTrace?: number;
    }): void;
    on(handler: PulseHandler): () => void;
    emit(event: PulseEvent): void;
    get trace(): readonly PulseEvent[];
    /** Zero-alloc iteration over the ring buffer. No array created. */
    forEach(fn: (event: PulseEvent, index: number) => void | false): void;
    /** Zero-alloc: find first event matching predicate */
    find(fn: (event: PulseEvent) => boolean): PulseEvent | undefined;
    get length(): number;
    clear(): void;
}
declare const registry: PulseRegistry;

/**
 * instrument.ts — Auto-instrumentation layer
 *
 * Patches browser/Node globals (fetch, timers, events, WebSocket)
 * to emit pulses automatically. Combined with tw.scope(), enables
 * the analyzer to detect race conditions without manual pulse placement.
 *
 * @example
 *   import { instrument } from 'pulscheck'
 *   const cleanup = instrument()           // patches all globals
 *   // ... app runs, pulses auto-emitted ...
 *   cleanup()                              // restores originals
 */
interface EventInstrumentOptions {
    /** Only instrument these event types (overrides default list) */
    include?: string[];
    /** Exclude these event types from instrumentation */
    exclude?: string[];
}
interface InstrumentOptions {
    /** Instrument globalThis.fetch. Default: true */
    fetch?: boolean;
    /** Instrument setTimeout / setInterval. Default: true */
    timers?: boolean;
    /** Instrument addEventListener. Default: true. Pass object to customize. */
    events?: boolean | EventInstrumentOptions;
    /** Instrument WebSocket. Default: true */
    websocket?: boolean;
}
/**
 * Patch browser/Node globals to auto-emit pulses at async boundaries.
 * Returns a cleanup function that restores all originals.
 *
 * @example
 *   import { instrument } from 'pulscheck'
 *
 *   // Instrument everything (default)
 *   const cleanup = instrument()
 *
 *   // Or selectively
 *   const cleanup = instrument({ fetch: true, timers: true, events: false })
 */
declare function instrument(options?: InstrumentOptions): () => void;
/**
 * Remove all patches and restore original globals. Idempotent.
 */
declare function restore(): void;

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

type FindingSeverity = "critical" | "warning" | "info";
type FindingPattern = "after-teardown" | "response-reorder" | "double-trigger" | "sequence-gap" | "stale-overwrite";
interface Finding {
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
declare function fingerprint(f: Finding): string;
interface AnalyzeOptions {
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
declare function analyze(trace: readonly PulseEvent[], opts?: AnalyzeOptions): Finding[];
/**
 * Pretty-print findings to console.
 */
declare function printFindings(findings: Finding[]): void;

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

interface ReporterOptions {
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
interface Reporter {
    /** Start the reporter loop. Idempotent. */
    start(): void;
    /** Stop the reporter loop. Idempotent. */
    stop(): void;
    /** Run analysis once and return findings (for programmatic use). */
    check(): Finding[];
    /** Reset dedup state — re-report previously seen findings. */
    reset(): void;
}
declare function createReporter(options?: ReporterOptions): Reporter;

/**
 * devMode.ts — One-line setup for race condition detection
 *
 * Instruments all async boundaries + starts the reporter.
 * One import, one call, and you're detecting races.
 *
 * @example
 *   // At the top of your app's entry point:
 *   import { devMode } from 'pulscheck'
 *   const cleanup = devMode()
 *
 *   // That's it. Races are now detected and logged to console.
 *   // Call cleanup() to stop (e.g., in HMR dispose).
 */

interface DevModeOptions extends InstrumentOptions {
    /** Reporter options (interval, severity, suppress, etc.) */
    reporter?: ReporterOptions;
}
/**
 * Enable race condition detection with one call.
 *
 * - Patches fetch, setTimeout, setInterval, addEventListener, WebSocket
 * - Starts a background reporter that checks the trace every 5s
 * - Logs findings with severity, explanation, and fix suggestions
 *
 * Returns a cleanup function that restores all globals and stops the reporter.
 */
declare function devMode(options?: DevModeOptions): () => void;

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

type FindingStatus = "new" | "recurring" | "resolved" | "regressed" | "ignored";
interface FindingSnapshot {
    commit?: string;
    timestamp: string;
    beatRange: [number, number];
}
interface HistoryEntry {
    action: "detected" | "recurred" | "resolved" | "regressed" | "ignored" | "unignored";
    commit?: string;
    timestamp: string;
    beatRange?: [number, number];
}
interface TrackedFinding {
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
interface Baseline {
    version: 2;
    lastRun: string;
    lastCommit?: string;
    findings: Record<string, TrackedFinding>;
}
interface DiffSummary {
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
interface TrackerOptions {
    /** Path to baseline file. Default: '.pulscheck-baseline.json' */
    baselinePath?: string;
    /** Current git commit SHA (auto-detected if not provided) */
    commit?: string;
    /** Custom read function (for non-Node environments) */
    readFile?: (path: string) => string | null;
    /** Custom write function (for non-Node environments) */
    writeFile?: (path: string, content: string) => void;
}
interface Tracker {
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
declare function createTracker(options?: TrackerOptions): Tracker;

export { type AnalyzeOptions, type Baseline, type DevModeOptions, type DiffSummary, type EventInstrumentOptions, type Finding, type FindingPattern, type FindingSeverity, type FindingStatus, type InstrumentOptions, type MeasureResult, type PulseEvent, type PulseKind, type PulseLane, type PulseOptions, type PulseSource, type Reporter, type ReporterOptions, type Scope, type TW, type TrackedFinding, type Tracker, type TrackerOptions, VERSION, analyze, createReporter, createTracker, devMode, fingerprint, initDomPulse, instrument, observeDom, printFindings, registry, restore, scanDom, tw };
