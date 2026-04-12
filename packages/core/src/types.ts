export type PulseLane = "ui"|"api"|"auth"|"ws"|"worker"|(string & {});

/** Structured event classification. Auto-instrumentation always sets this. */
export type PulseKind =
  | "request" | "response" | "error"
  | "timer-start" | "timer-end" | "timer-tick" | "timer-clear"
  | "dom-event" | "message" | "close"
  | "scope-start" | "scope-end"
  | "state-write" | "render"
  | "custom"
  | (string & {});

/** Who emitted the event. */
export type PulseSource = "auto" | "manual" | "scope" | (string & {});

export interface PulseOptions {
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

export interface PulseEvent {
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
