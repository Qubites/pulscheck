type PulseLane = "ui" | "api" | "auth" | "ws" | "worker" | (string & {});
/** Structured event classification. Auto-instrumentation always sets this. */
type PulseKind = "request" | "response" | "error" | "timer-start" | "timer-end" | "timer-tick" | "timer-clear" | "listener-add" | "listener-remove" | "dom-event" | "message" | "close" | "scope-start" | "scope-end" | "state-write" | "render" | "custom" | (string & {});
/** Who emitted the event. */
type PulseSource = "auto" | "manual" | "scope" | (string & {});
interface PulseOptions {
    lane?: PulseLane;
    public?: boolean;
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
 * analyze.ts — Automatic race condition detector
 *
 * Feed it a trace, it tells you what's wrong. No configuration needed.
 *
 * Detects 4 patterns:
 *   1. after-teardown   — event fires after a known cleanup/dispose/unmount
 *   2. response-reorder — responses arrive in different order than requests
 *   3. double-trigger   — same operation starts twice concurrently
 *   4. dangling-async   — operation started but never completed before scope teardown
 *
 * @example
 *   import { tw, analyze } from 'pulscheck'
 *   // ... instrument your code with tw.pulse() ...
 *   const findings = analyze(tw.trace)
 *   findings.forEach(f => console.warn(f.summary))
 */

type FindingSeverity = "critical" | "warning" | "info";
type FindingPattern = "after-teardown" | "response-reorder" | "double-trigger" | "dangling-async";
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
interface AnalyzeOptions {
    /** Suppress specific patterns entirely */
    suppress?: FindingPattern[];
    /** Minimum severity to report. Default: "info" (show everything) */
    minSeverity?: FindingSeverity;
    /** Suppress findings matching a custom predicate */
    filter?: (finding: Finding) => boolean;
}

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

interface PulsCheckTestOptions {
    /** Auto-instrument fetch, timers, WebSocket, DOM events. Default: false */
    instrument?: boolean | InstrumentOptions;
    /** Analyzer options (suppress patterns, min severity, etc.) */
    analyze?: AnalyzeOptions;
    /** Print findings to console even when tests pass. Default: false */
    verbose?: boolean;
}
interface PulsCheckTestContext {
    /** The tw instance — use to emit manual pulses */
    tw: typeof tw;
    /** Direct access to the registry for advanced assertions */
    registry: typeof registry;
}
interface PulsCheckResult {
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
     * @example result.expectPattern('after-teardown')
     */
    expectPattern(pattern: string): void;
    /**
     * Print findings to console (useful for debugging).
     */
    print(): void;
}
/**
 * Run a function with PulsCheck instrumentation and analysis.
 *
 * Overload 1: withPulsCheck(fn)
 * Overload 2: withPulsCheck(options, fn)
 */
declare function withPulsCheck(fn: (ctx: PulsCheckTestContext) => void | Promise<void>): Promise<PulsCheckResult>;
declare function withPulsCheck(options: PulsCheckTestOptions, fn: (ctx: PulsCheckTestContext) => void | Promise<void>): Promise<PulsCheckResult>;
/**
 * Vitest/Jest-compatible assertion: plug directly into expect().
 *
 * @example
 *   test('no races', async () => {
 *     const result = await withPulsCheck(async ({ tw }) => { ... })
 *     assertClean(result)
 *   })
 */
declare function assertClean(result: PulsCheckResult): void;

export { type PulsCheckResult, type PulsCheckTestContext, type PulsCheckTestOptions, assertClean, withPulsCheck };
