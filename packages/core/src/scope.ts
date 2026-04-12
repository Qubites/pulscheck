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

import type { PulseLane, PulseOptions } from "./types";

// ─── Types ──────────────────────────────────────────────────────────

export interface Scope {
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

// ─── Scope stack ────────────────────────────────────────────────────
// Global stack of active scopes. Auto-instrumented events read the
// top of this stack to get parentId. Scopes can end out of order —
// splice handles this.

const scopeStack: Scope[] = [];

/**
 * Get the currently active scope (top of stack), or undefined if no scope is active.
 * Called by instrument.ts patches to set parentId on auto-emitted events.
 */
export function currentScope(): Scope | undefined {
  return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : undefined;
}

// ─── Scope factory ──────────────────────────────────────────────────
// The actual tw.scope() is wired up in tw.ts, but the factory lives
// here to keep scope logic centralized. tw.ts imports createScope().

let _seq = 0;
function scopeId(): string {
  return `scope_${Date.now().toString(36)}_${(++_seq).toString(36)}`;
}

export interface CreateScopeDeps {
  /** The tw.pulse function — injected to avoid circular import */
  pulse: (label: string, opts: PulseOptions) => { correlationId: string };
}

export function createScope(
  name: string,
  opts: PulseOptions,
  deps: CreateScopeDeps,
): Scope {
  const correlationId = scopeId();
  const lane = opts.lane ?? "ui";

  // Emit scope start
  deps.pulse(`${name}:start`, {
    ...opts,
    lane,
    correlationId,
    kind: "scope-start",
    source: "scope",
  });

  let _active = true;

  const scope: Scope = {
    get correlationId() { return correlationId; },
    get name() { return name; },
    get lane() { return lane; },
    get active() { return _active; },
    deactivate() {
      // Remove from scope stack so other components' events don't inherit
      // this scope. Does NOT emit teardown — the scope is still conceptually
      // active for after-teardown detection.
      const idx = scopeStack.lastIndexOf(scope);
      if (idx >= 0) scopeStack.splice(idx, 1);
    },
    end() {
      if (!_active) return; // idempotent
      _active = false;

      // Emit teardown event with the scope's correlationId
      // This is what the after-teardown pattern looks for
      deps.pulse(`${name}:teardown`, {
        ...opts,
        lane,
        correlationId,
        kind: "scope-end",
        source: "scope",
      });

      // Remove from stack if still there (deactivate() may have already done this)
      const idx = scopeStack.lastIndexOf(scope);
      if (idx >= 0) scopeStack.splice(idx, 1);
    },
  };

  scopeStack.push(scope);
  return scope;
}
