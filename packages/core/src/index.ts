// Version — injected at build time
export { VERSION } from "./version";

// Core primitive — works everywhere (Node, browser, edge, no React needed)
export { tw } from "./tw";
export type { TW, MeasureResult } from "./tw";
export type { PulseEvent, PulseOptions, PulseLane, PulseKind, PulseSource } from "./types";
export { registry } from "./registry";

// Auto-instrumentation — patches globals to emit pulses at async boundaries
export { instrument, restore } from "./instrument";
export type { InstrumentOptions, EventInstrumentOptions } from "./instrument";

// Scopes — link auto-instrumented events to lifecycle boundaries
export type { Scope } from "./scope";

// One-line setup: instruments + reports
export { devMode } from "./devMode";
export type { DevModeOptions } from "./devMode";

// Reporter — continuous race condition monitoring with dedup
export { createReporter } from "./reporter";
export type { Reporter, ReporterOptions } from "./reporter";

// Auto-detector — feed it a trace, it tells you what's wrong
export { analyze, printFindings, fingerprint } from "./analyze";
export type { Finding, FindingSeverity, FindingPattern, AnalyzeOptions } from "./analyze";

// Persistent finding tracker — lifecycle across runs
export { createTracker } from "./tracker";
export type {
  Tracker,
  TrackerOptions,
  TrackedFinding,
  FindingStatus,
  DiffSummary,
  Baseline,
} from "./tracker";

// React hooks: import from 'pulscheck/react'
