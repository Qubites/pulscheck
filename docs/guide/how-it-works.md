# How It Works

## The core idea

Every dev tool analyses code as a frozen snapshot — file and line. PulsCheck adds a third coordinate: **time**. Each auto-instrumented `fetch` / `setTimeout` / `addEventListener` / `WebSocket` call — or each manual `tw.pulse()` — emits a timestamped event into a ring buffer. When two async operations collide across time, the analyzer recognises the shape of a race condition.

## The pipeline

```
  fetch()          setTimeout()       addEventListener()       new WebSocket()
     │                 │                      │                       │
     ▼                 ▼                      ▼                       ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │  instrument() — patches globals, captures correlationId, parentId, │
  │  callSite, kind. Sentinel Symbol.for("tw.patched") prevents        │
  │  double-patching across HMR.                                       │
  └────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
                       registry.emit(event)
                               │
                               ▼
                    ┌─────────────────────┐
                    │  Ring buffer (10k)  │
                    └──────────┬──────────┘
                               │ every 5 s (default)
                               ▼
                       analyze(trace)
                               │
                               ▼
                 Finding[] → reporter → console
                               │
                               ▼
              dedup by (pattern, sorted labels, call site)
```

## Ring buffer

All events flow into a single ring buffer:

- **Capacity**: 10,000 events by default, configurable via `registry.configure({ maxTrace })`
- **Insert**: O(1), ring with a write pointer, no allocations on the hot path
- **Read**: snapshot via `registry.trace` (or `tw.trace`); zero-alloc iteration via `registry.forEach`
- **Overflow**: oldest events are overwritten when capacity is reached

The buffer is per-process. Every event lives in one array that the detectors can scan in order.

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
  kind?: PulseKind         // "request" | "response" | "timer-start" | ...
  source?: PulseSource     // "auto" | "manual" | "scope"
  callSite?: string        // "src/hooks/useSearch.ts:20"
  meta?: Record<string, unknown>
  public: boolean
}
```

The `kind` field is the detectors' primary classifier — it's always set by auto-instrumentation, so the detectors never have to guess semantics from label substrings. Manual pulses can omit it and the analyzer falls back to label matching (suffixes like `:done`, `:cancel`, `:error`).

## Scopes and `parentId`

A scope is a lifecycle boundary. When you call `tw.scope('checkout-flow')`, the scope emits `"checkout-flow:start"` (kind `scope-start`) and pushes itself onto a global scope stack. Any auto-instrumented event that fires while the scope is on top of the stack captures the scope's correlationId as its `parentId`. When `scope.end()` is called, the scope emits `"checkout-flow:teardown"` (kind `scope-end`) and pops itself off.

```ts
const scope = tw.scope('checkout-flow')

await fetch('/api/submit-order')   // parentId → scope.correlationId
setTimeout(pollStatus, 1000)       // parentId → scope.correlationId

scope.end()                        // emits "checkout-flow:teardown" with kind: "scope-end"
```

The analyzer uses `parentId` to figure out which events belong to which lifecycle. This is how **after-teardown** and **dangling-async** detection work: an event whose `parentId` matches a scope that has already ended is, by definition, a late callback.

In React, `useScopedEffect` automates this pattern — it opens a scope during `useEffect` setup and closes it during cleanup. See [React Integration](/guide/react).

## Auto-instrumentation

`instrument()` patches eight globals: `fetch`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `EventTarget.prototype.addEventListener`, `EventTarget.prototype.removeEventListener`, and `WebSocket`. Each patch:

- Captures the current scope's `correlationId` **synchronously at call time** (so it survives later async callbacks)
- Extracts the call site from `new Error().stack`, parsing both Vite browser URLs and Node.js paths, skipping pulscheck internal frames
- Emits typed events with a structured `kind`
- Restores cleanly when `restore()` is called

### Exact emitted labels and kinds

| Global | Events emitted (label — kind) |
|---|---|
| `fetch` | `fetch:{path}:start` — `request`; `fetch:{path}:done` — `response`; `fetch:{path}:error` — `error` |
| `setTimeout` | `setTimeout:start` — `timer-start`; `setTimeout:fire` — `timer-end`; `setTimeout:clear` — `timer-clear` |
| `setInterval` | `setInterval:start` — `timer-start`; `setInterval:tick` — `timer-tick`; `setInterval:clear` — `timer-clear` |
| `addEventListener` | `listener:{type}:add` — `listener-add` (only emitted when inside an active scope and not `{once: true}`); `event:{type}` — `dom-event` on fire |
| `removeEventListener` | `listener:{type}:remove` — `listener-remove` (only if the add was recorded) |
| `WebSocket` | `ws:open:start` — `request`; `ws:open:done` — `response`; `ws:message` — `message`; `ws:close` — `close`; `ws:error` — `error` |

### Default event allowlist

`addEventListener` is selective by default. Only events in the following allowlist are instrumented — scroll, mousemove, and other high-frequency events are **not** captured unless you pass `{ events: { include: [...] } }`:

`click`, `dblclick`, `submit`, `change`, `input`, `focus`, `blur`, `keydown`, `keyup`, `popstate`, `hashchange`, `beforeunload`, `visibilitychange`, `online`, `offline`, `error`, `unhandledrejection`.

### URL normalisation and generation tracking

- **Path extraction**: fetch labels use `URL.pathname` truncated to 120 chars. Query strings live in `meta.url` instead, so detector grouping doesn't fragment on `?q=foo` vs `?q=bar`.
- **Dynamic-segment collapse**: the `analyze()` layer collapses numeric and hex IDs — `fetch:/api/user/123:start` and `fetch:/api/user/456:start` are grouped as `fetch:/api/user/:id`.
- **Per-endpoint generation**: every new request to a given path increments a counter. The response is stamped with `meta.generation` (the number at request time) and `meta.latestGeneration` (the number at resolve time). The `response-reorder` detector uses these two to tell "responses merely arrived out of order" (warning) from "the stale response was the last to resolve and therefore actually used" (critical).

## Detection patterns

`analyze()` runs seven heuristic detectors against the sorted trace on every reporter tick (default interval 5,000 ms). Severity rules are lifted directly from `packages/core/src/analyze.ts`.

### 1. `after-teardown`

**Severity:** `critical` if the late event is a render/setState-like event; otherwise `warning`.

An event whose `parentId` points to a scope that has already torn down. The classic React bug: a `fetch().then(setState)` or `setTimeout(update, 100)` that fires after the component unmounts.

**How**: Group by correlationId, merge in events whose `parentId` matches, find the scope teardown, then flag any event with a later `beat`. If a recovery event (`reconnect`, `retry`, `resume`, …) exists between the teardown and a later event, events after the recovery are excluded — reconnecting is the fix, not a bug.

### 2. `response-reorder`

**Severity:** `critical` if generation tracking confirms the stale response was the last to resolve; otherwise `warning`.

Responses to the same normalised endpoint arrive in a different order than their requests. Slow response overwrites fast response; the UI shows stale data.

**How**: Group request/response pairs by normalised endpoint. Compare request order vs response-arrival order. If `meta.generation` and `meta.latestGeneration` are present on the last response and indicate it was stale-last-to-resolve, escalate to `critical`.

### 3. `double-trigger`

**Severity:** `critical` if `meta` parameters are identical; `info` if they differ (likely intentional concurrency such as two distinct search queries).

Two starts of the same normalised operation overlap (the second starts before the first's matching end).

**How**: Group start events by normalised label. For each pair, check overlap against the first operation's end. Generic timer labels (`setTimeout:start`, `setInterval:start`) get special handling — they only flag when the two starts share the same `parentId` scope or the same `callSite`, because unrelated timers from Vite HMR and React internals are normal and should not produce findings. Parameter equality is computed on `meta`, excluding instrumentation-internal keys (`generation`, `latestGeneration`).

### 4. `sequence-gap`

**Severity:** `critical`.

A numbered message stream has missing entries. Typical with WebSocket protocols that carry a sequence number per message.

**How**: Events are grouped by `(correlationId, label)` and sorted by `meta.seq`. Consecutive integer gaps are flagged.

**Auto-instrumentation note**: the `WebSocket` patch does **not** currently stamp `meta.seq`, so this detector only fires on manually instrumented traces. It is not exercised by the current audit corpus.

### 5. `stale-overwrite`

**Severity:** `critical`.

A render from an older request lands after a render from a newer request — the UI flips from correct back to stale.

**How**: Collect render-like events, group by label base, and for each consecutive pair find the originating request by correlationId. If the later render came from a request that was *sent earlier* than the previous render's request, flag it.

**Auto-instrumentation note**: render/state-write events are not emitted by the fetch patch, so this detector requires manual `tw.pulse()` instrumentation that emits events with a render-like kind. It is not exercised by the current audit corpus.

### 6. `dangling-async`

**Severity:** `warning`.

An operation started inside a scope but never reached a terminal state (response, fire, clear, close, remove) before the scope ended. The scope is gone but the work is still running.

**How**: Build a correlationId → scope-teardown-beat map. For each operation-start event with a `parentId` that teared down, check whether any completion event exists in the trace for the same correlationId, using a per-operation-type rule:

- `fetch` → needs `response` or `error`
- `setTimeout` → needs `timer-end` or `timer-clear`
- `setInterval` → needs `timer-clear` (ticks mean it's still running)
- `addEventListener` → needs `listener-remove`
- `WebSocket` → needs `response`, `close`, or `error`

If no matching completion exists and the operation started before the scope tore down, it's dangling. A label-suffix fallback (`:done`, `:cancel`, `:close`, etc.) applies to manual pulses without a `kind`.

### 7. `layout-thrash`

**Severity:** `warning` at 3–4 write→read cycles in one frame; `critical` at 5 or more.

Rapid DOM write→read cycles within a single synchronous frame. Each cycle forces the browser to recalculate layout — invisible on fast machines, catastrophic on mobile.

**How**: Collect events with `kind === "dom-write"` or `kind === "dom-read"`. Group into frames using a 16 ms window (`FRAME_WINDOW_MS`). Inside each frame, count write→read transitions. 3+ cycles fire a finding at `warning`, 5+ at `critical`.

**Auto-instrumentation note**: `instrument()` does not currently patch `getBoundingClientRect`, `offsetHeight`, style writes, or any other forced-reflow-triggering API. This detector only fires on manually instrumented traces that emit `dom-write` / `dom-read` events. It is not exercised by the current audit corpus.

## Deduplication

Every finding is fingerprinted as `${pattern}::${sortedLabels}[::${callSite}]`. The reporter tracks seen fingerprints and only logs a finding the first time its fingerprint appears — recurring occurrences increment a count and are suppressed. If the same race condition fires 1,000 times during a dev session, you see it once.

This is the "one report per bug, not per occurrence" guarantee.

## Dev gating

`devMode()`, `instrument()`, and the reporter are intended to run in development only, but **PulsCheck does not enforce this from inside the package**. The dev-only behaviour comes from gating the *call site*:

```ts
if (import.meta.env.DEV) devMode()        // Vite
if (process.env.NODE_ENV === "development") devMode()  // Webpack / Next.js
```

Any modern bundler that treats the environment constant as a compile-time value will eliminate the guarded branch from a production build. If you call `devMode()` unconditionally, it will run in production — so gate at the call site.
