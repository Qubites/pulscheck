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

import { instrument, type InstrumentOptions } from "./instrument";
import { createReporter, type ReporterOptions } from "./reporter";

export interface DevModeOptions extends InstrumentOptions {
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
export function devMode(options: DevModeOptions = {}): () => void {
  const { reporter: reporterOpts, ...instrumentOpts } = options;

  const restoreGlobals = instrument(instrumentOpts);

  const reporter = createReporter(reporterOpts);
  reporter.start();

  console.log(
    "%c[pulscheck]%c active — monitoring fetch, timers, events, WebSocket for race conditions",
    "color: #e94560; font-weight: bold",
    "color: inherit"
  );

  return () => {
    reporter.stop();
    restoreGlobals();
  };
}
