/**
 * react.ts — React-specific hooks for Pulse Code
 * Import from 'pulscheck/react', NOT from 'pulscheck'
 * This keeps React out of the main bundle for Node/non-React consumers.
 *
 * @example
 * import { usePulse, usePulseMount } from 'pulscheck/react'
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode, type EffectCallback, type DependencyList } from "react";
import type { PulseOptions } from "./types";
import { tw } from "./tw";
import { devMode, type DevModeOptions } from "./devMode";
import type { Scope } from "./scope";

/**
 * Fire a pulse after every committed render. Safe in Concurrent Mode.
 * This is the recommended default — pulses only fire for renders React actually commits.
 */
export function usePulse(label: string, opts: PulseOptions = {}): void {
  useEffect(() => { tw.pulse(label, opts); });
}

/**
 * Fire a pulse during render (before commit). Use only when you need to track
 * abandoned renders in Concurrent Mode. In most cases, prefer usePulse().
 *
 * WARNING: React may call render() multiple times without committing.
 * Each call produces a pulse, so you may see "phantom" events.
 */
export function usePulseRender(label: string, opts: PulseOptions = {}): void {
  tw.pulse(label, opts);
}

export function usePulseMount(label: string, opts: PulseOptions = {}): void {
  useEffect(() => {
    tw.pulse(`${label}:mount`, opts);
    return () => { tw.pulse(`${label}:unmount`, opts); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function usePulseMeasure(label: string, opts: PulseOptions = {}): void {
  const lastBeat = useRef<number | null>(null);
  const count = useRef(0);
  useEffect(() => {
    count.current++;
    const now = performance?.now?.() ?? Date.now();
    if (lastBeat.current !== null) {
      tw.pulse(label, { ...opts, meta: { ...opts.meta, durationMs: now - lastBeat.current, renderCount: count.current } });
    }
    lastBeat.current = now;
  });
}

// ─── Component name inference ───────────────────────────────────────

function inferComponentName(): string {
  try {
    const stack = new Error().stack ?? "";
    const lines = stack.split("\n");
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.includes("node_modules")) continue;
      if (line.includes("inferComponentName")) continue;
      if (line.includes("useScopedEffect")) continue;
      if (line.includes("useScopedLayoutEffect")) continue;
      const match = line.match(/at\s+(\w+)/);
      if (match && match[1] !== "Object" && match[1] !== "Module" && match[1] !== "eval") {
        return match[1];
      }
    }
  } catch {}
  return "unknown";
}

// ─── Scoped effects ────────────────────────────────────────────────

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
export function useScopedEffect(
  effect: EffectCallback,
  deps?: DependencyList,
  name?: string,
): void {
  // Stable ref for the name — only infer once
  const nameRef = useRef<string | undefined>(name);
  if (nameRef.current === undefined && name === undefined) {
    nameRef.current = inferComponentName();
  }

  useEffect(() => {
    const scope = tw.scope(nameRef.current ?? name ?? "unknown");
    const cleanup = effect();
    // Pop from scope stack so other components don't inherit this scope.
    // Async ops already captured parentId during synchronous setup above.
    scope.deactivate();
    return () => {
      if (typeof cleanup === "function") cleanup();
      scope.end(); // emits teardown — late async callbacks are now detectable
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * Same as useScopedEffect but uses useLayoutEffect.
 * Use for scoping effects that must run synchronously after DOM mutations.
 */
export function useScopedLayoutEffect(
  effect: EffectCallback,
  deps?: DependencyList,
  name?: string,
): void {
  const nameRef = useRef<string | undefined>(name);
  if (nameRef.current === undefined && name === undefined) {
    nameRef.current = inferComponentName();
  }

  useLayoutEffect(() => {
    const scope = tw.scope(nameRef.current ?? name ?? "unknown");
    const cleanup = effect();
    scope.deactivate();
    return () => {
      if (typeof cleanup === "function") cleanup();
      scope.end();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// ─── TwProvider ─────────────────────────────────────────────────────

export interface TwProviderProps {
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
export function TwProvider({ children, options }: TwProviderProps): ReactNode {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    cleanupRef.current = devMode(options);
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return children;
}
