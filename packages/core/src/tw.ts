import type { PulseOptions, PulseEvent } from "./types";
import { registry } from "./registry";
import { createScope, type Scope } from "./scope";

let _seq = 0;
function uid(): string { return `pw_${Date.now().toString(36)}_${(++_seq).toString(36)}`; }

function now(): number {
  if (typeof performance !== "undefined") return performance.now();
  if (typeof process !== "undefined") { const [s,ns]=process.hrtime(); return s*1000+ns/1e6; }
  return Date.now();
}

function buildEvent(label: string, opts: PulseOptions, correlationId?: string): PulseEvent {
  const lane = opts.lane ?? "ui";
  const event: PulseEvent = {
    label, lane, beat: now(), ts: Date.now(),
    public: opts.public ?? false,
    correlationId: correlationId ?? opts.correlationId ?? uid(),
    parentId: opts.parentId,
    meta: opts.meta,
    kind: opts.kind,
    source: opts.source ?? "manual",
  };
  if (opts.callSite) event.callSite = opts.callSite;
  return event;
}

export interface MeasureResult {
  stop: () => number;
  startEvent: PulseEvent;
}

export const tw = {
  pulse(label: string, opts: PulseOptions = {}): PulseEvent {
    if (opts.sample !== undefined && Math.random() > opts.sample) {
      // Sampled out — return minimal stub (callers only need correlationId)
      return { label, lane: opts.lane ?? "ui", beat: 0, ts: 0, public: false, dna: "", correlationId: opts.correlationId ?? uid(), source: opts.source ?? "manual" } as PulseEvent;
    }
    const event = buildEvent(label, opts);
    registry.emit(event);
    return event;
  },

  measure(label: string, opts: PulseOptions = {}): MeasureResult {
    const correlationId = opts.correlationId ?? uid();
    const startEvent = buildEvent(`${label}:start`, opts, correlationId);
    registry.emit(startEvent);
    let stopped = false;
    return {
      startEvent,
      stop(): number {
        if (stopped) return 0; // guard: double-stop is a no-op
        stopped = true;
        const duration = now() - startEvent.beat;
        const endEvent = buildEvent(`${label}:end`, {
          ...opts, meta: { ...opts.meta, durationMs: duration, startBeat: startEvent.beat },
        }, correlationId);
        registry.emit(endEvent);
        return duration;
      },
    };
  },

  checkpoint(label: string, step: number, opts: PulseOptions = {}): PulseEvent {
    return tw.pulse(label, { ...opts, meta: { ...opts.meta, step } });
  },

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
  scope(name: string, opts: PulseOptions = {}): Scope {
    return createScope(name, opts, { pulse: tw.pulse });
  },

  on(handler: (event: PulseEvent) => void): () => void { return registry.on(handler); },
  configure(opts: { enabled?: boolean; maxTrace?: number }): void { registry.configure(opts); },
  get trace(): readonly PulseEvent[] { return registry.trace; },
  clearTrace(): void { registry.clear(); },
} as const;

export type TW = typeof tw;
