import { ReactNode, EffectCallback, DependencyList } from 'react';

type PulseLane = "ui" | "api" | "auth" | "ws" | "worker" | (string & {});
/** Structured event classification. Auto-instrumentation always sets this. */
type PulseKind = "request" | "response" | "error" | "timer-start" | "timer-end" | "timer-tick" | "timer-clear" | "dom-event" | "message" | "close" | "scope-start" | "scope-end" | "state-write" | "render" | "custom" | (string & {});
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
 * Detects 6 patterns:
 *   1. after-teardown   — event fires after a known cleanup/dispose/unmount
 *   2. response-reorder — responses arrive in different order than requests
 *   3. double-trigger   — same operation starts twice concurrently
 *   4. sequence-gap     — numbered sequences with missing entries
 *   5. stale-overwrite  — older operation's result overwrites newer one
 *   6. dangling-async   — operation started but never completed before scope teardown
 *
 * @example
 *   import { tw, analyze } from 'pulscheck'
 *   // ... instrument your code with tw.pulse() ...
 *   const findings = analyze(tw.trace)
 *   findings.forEach(f => console.warn(f.summary))
 */

type FindingSeverity = "critical" | "warning" | "info";
type FindingPattern = "after-teardown" | "response-reorder" | "double-trigger" | "sequence-gap" | "stale-overwrite" | "dangling-async";
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
 * react.ts — React-specific hooks for Pulse Code
 * Import from 'pulscheck/react', NOT from 'pulscheck'
 * This keeps React out of the main bundle for Node/non-React consumers.
 *
 * @example
 * import { usePulse, usePulseMount } from 'pulscheck/react'
 */

/**
 * Fire a pulse after every committed render. Safe in Concurrent Mode.
 * This is the recommended default — pulses only fire for renders React actually commits.
 */
declare function usePulse(label: string, opts?: PulseOptions): void;
/**
 * Fire a pulse during render (before commit). Use only when you need to track
 * abandoned renders in Concurrent Mode. In most cases, prefer usePulse().
 *
 * WARNING: React may call render() multiple times without committing.
 * Each call produces a pulse, so you may see "phantom" events.
 */
declare function usePulseRender(label: string, opts?: PulseOptions): void;
declare function usePulseMount(label: string, opts?: PulseOptions): void;
declare function usePulseMeasure(label: string, opts?: PulseOptions): void;
/**
 * Drop-in replacement for useEffect that auto-scopes the effect.
 *
 * All async operations registered during the effect's synchronous setup
 * (fetch, setTimeout, setInterval, addEventListener) capture the scope's
 * parentId. On cleanup, the scope emits a teardown event. Any late async
 * callbacks are detected as after-teardown race conditions.
 *
 * @example
 *   useScopedEffect(() => {
 *     fetch('/api/data').then(setData);
 *     const id = setInterval(poll, 5000);
 *     return () => clearInterval(id);
 *   }, []);
 */
declare function useScopedEffect(effect: EffectCallback, deps?: DependencyList, name?: string): void;
/**
 * Same as useScopedEffect but uses useLayoutEffect.
 * Use for scoping effects that must run synchronously after DOM mutations.
 */
declare function useScopedLayoutEffect(effect: EffectCallback, deps?: DependencyList, name?: string): void;
interface TwProviderProps {
    children: ReactNode;
    /** DevMode options (instrument + reporter config). */
    options?: DevModeOptions;
}
/**
 * Drop-in provider that enables race condition detection for your React app.
 * Instruments all async boundaries on mount, starts the reporter,
 * and cleans up on unmount.
 *
 * @example
 *   import { TwProvider } from 'pulscheck/react'
 *
 *   function App() {
 *     return (
 *       <TwProvider>
 *         <YourApp />
 *       </TwProvider>
 *     )
 *   }
 */
declare function TwProvider({ children, options }: TwProviderProps): ReactNode;

export { TwProvider, type TwProviderProps, usePulse, usePulseMeasure, usePulseMount, usePulseRender, useScopedEffect, useScopedLayoutEffect };
