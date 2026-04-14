# How It Works

## The core idea

Every dev tool analyses code as a frozen snapshot — file and line. PulsCheck adds a third coordinate: **time**. Each `tw.pulse()` call — or every auto-instrumented `fetch` / `setTimeout` / `addEventListener` invocation — emits a timestamped event into a ring buffer. When two async operations collide across time, the analyzer recognizes the shape of a race condition.

## The pipeline

```
  fetch()          setTimeout()       addEventListener()
     │                 │                      │
     ▼                 ▼                      ▼
  ┌──────────────────────────────────────────────┐
  │   instrument() — patches globals, captures   │
  │   correlationId, parentId, callSite, kind    │
  └──────────────────────┬───────────────────────┘
                         │
                         ▼
                 registry.emit(event)
                         │
                         ▼
              ┌─────────────────────┐
              │  Ring buffer (10k)  │
              └──────────┬──────────┘
                         │ every 5s
                         ▼
                 analyze(trace)
                         │
                         ▼
                 Finding[] → reporter → console
                                │
                                ▼
                          (deduped)
```

## Ring buffer

All events flow into a single ring buffer:

- **Capacity**: 10,000 events (configurable via `tw.configure({ maxTrace })`)
- **Insert**: O(1), no allocations on the hot path
- **Read**: snapshot via `tw.trace`
- **Overflow**: oldest events evicted first

On a real app this stays under ~2 MB. The buffer is per-process — every event lives in one array the detectors can scan in order.

## Event structure

Every event carries enough information for the analyzer to correlate it with others:

```ts
interface PulseEvent {
  label: string            // e.g. "fetch:/api/search:start"
  lane: PulseLane          // "ui" | "api" | "auth" | "ws" | "worker" | custom
  beat: number             // performance.now() — monotonic
  ts: number               // Date.now() — wall clock
  correlationId: string    // links related events
  parentId?: string        // scope parent — the lifecycle this belongs to
  kind?: PulseKind         // "request" | "response" | "scope-end" | ...
  source?: PulseSource     // "auto" | "manual" | "scope"
  callSite?: string        // "src/hooks/useSearch.ts:20"
  meta?: Record<string, unknown>
  public: boolean
}
```

The `kind` field is the detectors' primary classifier — it's always set by auto-instrumentation, so the detectors never have to guess semantics from label substrings. Manual pulses can omit it and the analyzer will fall back to label matching.

## Scopes and `parentId`

A scope is a lifecycle boundary. When you call `tw.scope('checkout-flow')`, any auto-instrumented event that fires while that scope is active captures the scope's correlationId as its `parentId`. When the scope ends, it emits a `scope-end` event.

```ts
const scope = tw.scope('checkout-flow')

await fetch('/api/submit-order')   // parentId → scope.correlationId
setTimeout(pollStatus, 1000)       // parentId → scope.correlationId

scope.end()                        // emits "checkout-flow" with kind: "scope-end"
```

The analyzer uses `parentId` chains to figure out which events belong to which lifecycle. This is how **after-teardown** and **dangling-async** detection work: an event with a `parentId` that matches a scope that has already ended is, by definition, a late callback.

In React, `useScopedEffect` automates this pattern — it opens a scope during `useEffect` setup and closes it during cleanup. See [React Integration](/guide/react).

## Auto-instrumentation

`instrument()` patches browser globals at the global level. Each patched function:

- Captures the current scope's `correlationId` **synchronously at call time** (surviving later async callbacks)
- Extracts the call site from a fresh `Error().stack`
- Emits a typed event with structured `kind`
- Restores cleanly when `restore()` is called

| Global | What's emitted |
|--------|----------------|
| `fetch` | `fetch:{url}:start` (kind: `request`), `fetch:{url}:done` (kind: `response`), `fetch:{url}:error` (kind: `error`) |
| `setTimeout` / `setInterval` | `timer:set` (kind: `timer-start`), `timer:fire` (kind: `timer-tick`), `timer:clear` (kind: `timer-clear`) |
| `addEventListener` | `listener:add:{type}` (kind: `listener-add`), `event:{type}` (kind: `dom-event`) on fire |
| `removeEventListener` | `listener:remove:{type}` (kind: `listener-remove`) |
| `WebSocket` | `ws:open`, `ws:message`, `ws:close`, `ws:error` |

Key design decisions:

- **Symbol sentinel** (`Symbol.for('tw.patched')`) prevents double-patching during HMR. Calling `instrument()` twice is a no-op.
- **Event allowlist** filters out high-frequency events (`scroll`, `mousemove`, `pointermove`, …) by default.
- **Generation tracking** on fetch: every request to the same endpoint increments a counter. Responses are stamped with their generation so the analyzer can tell *overlapping* responses (warning) apart from *stale responses that were actually consumed last* (critical).

## Detection patterns

The analyzer runs 7 heuristic detectors against the trace on every reporter tick:

### 1. after-teardown

**Severity: critical** — Events whose `parentId` points at a scope that has already ended. The classic React bug: `fetch().then(setState)` after the component unmounted.

**How**: Build a correlationId → teardown-beat map from `scope-end` events, then scan for events whose `parentId` is in the map and whose `beat` is after the teardown.

### 2. response-reorder

**Severity: critical** — Responses to the same logical endpoint arrive in a different order than their requests. Slow response overwrites fast response; user sees wrong data.

**How**: Normalize fetch labels by collapsing dynamic segments (`/api/user/123` → `/api/user/:id`), group request/response pairs by normalized endpoint, and compare request order vs response order. Generation-stamped so a stale response that was **last to resolve** (and therefore actually used) becomes critical.

### 3. double-trigger

**Severity: critical** — The same logical action fires twice within the collision window. Common with React Strict Mode, missing debounce, duplicate event handlers, or double-submitted forms.

**How**: Scan for events with identical normalized labels within a configurable window (default 16 ms).

### 4. dangling-async

**Severity: critical** — An operation started inside a scope but never reached a terminal state (response, clear, close) before the scope ended. The scope is gone but the work continues.

**How**: Index pending `request` / `timer-start` / `listener-add` events by `parentId`, then check each `scope-end` against that index. Any entry without a matching `response` / `timer-clear` / `listener-remove` before the teardown is dangling.

### 5. sequence-gap

**Severity: warning** — A numbered message stream has missing steps. Typical with WebSocket streams where packets are dropped or reordered.

**How**: Events carrying numeric `meta.step` are grouped by label base; consecutive integer gaps are flagged.

### 6. stale-overwrite

**Severity: warning** — A late response overwrites data that was already updated by a newer response. The user sees correct data briefly, then it flips back to stale.

**How**: Track writes to the same target and flag when an older response's write lands after a newer one has already been applied.

### 7. layout-thrash

**Severity: warning** — Repeated forced synchronous layout from write-then-read cycles in the same frame. Causes the browser to recalculate layout multiple times per frame instead of once.

**How**: Group DOM writes and reads into synchronous frames (events within 4 ms). Count write-then-read transitions where the read target was dirtied by a preceding write. 3+ cycles → warning, 5+ → critical. A WeakSet tracks dirtied elements so reads on unmodified elements don't fire false positives.

## Deduplication

The reporter fingerprints each finding as `${pattern}::${sorted call sites}`. Only new fingerprints are logged. If the same race condition fires 1,000 times, you see it once, with the call sites that produced it.

This is the "one report per bug, not per occurrence" guarantee. You won't get spammed.

## Dev-only

`devMode()`, `instrument()`, and the reporter are guarded by environment checks. In production, a bundler that can evaluate `import.meta.env.DEV` / `process.env.NODE_ENV` at build time will tree-shake the entire import out. The only thing that survives is pulses marked `public: true` — which is opt-in and rarely needed.

No runtime cost in production builds.
