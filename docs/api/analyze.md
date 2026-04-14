# Analysis

The analyzer runs seven heuristic detectors against a pulse trace and returns structured findings.

```ts
import { analyze, printFindings, fingerprint, createReporter } from 'pulscheck'
```

## `analyze(trace, options?)`

Run all detectors against a trace and return findings, sorted by severity (critical first) then by `beat`.

```ts
import { analyze, tw } from 'pulscheck'

const findings = analyze(tw.trace)
```

### `AnalyzeOptions`

```ts
interface AnalyzeOptions {
  /** Suppress specific patterns entirely */
  suppress?: FindingPattern[]
  /** Minimum severity to report. Default: "info" (show everything) */
  minSeverity?: 'info' | 'warning' | 'critical'
  /** Custom predicate — return false to drop a finding */
  filter?: (finding: Finding) => boolean
}
```

Example:

```ts
const findings = analyze(tw.trace, {
  suppress: ['layout-thrash'],
  minSeverity: 'warning',
  filter: (f) => !f.events.some((e) => e.callSite?.includes('node_modules')),
})
```

`analyze()` does **not** accept a `windowMs` option — the layout-thrash frame window (16 ms) is a module-level constant inside `analyze.ts`, not a public parameter.

**Returns:** `Finding[]`

### `Finding`

```ts
interface Finding {
  pattern: FindingPattern
  severity: 'info' | 'warning' | 'critical'
  summary: string
  detail: string
  fix: string                  // actionable fix suggestion
  events: PulseEvent[]         // the events involved
  beatRange: [number, number]  // beat window where the issue occurs
}
```

### `FindingPattern`

```ts
type FindingPattern =
  | 'after-teardown'
  | 'response-reorder'
  | 'double-trigger'
  | 'sequence-gap'
  | 'stale-overwrite'
  | 'dangling-async'
  | 'layout-thrash'
```

## Detection patterns

Severity rules are read directly from `packages/core/src/analyze.ts`. Where a detector has conditional severity, both branches are listed.

### `after-teardown`

**Severity:** `critical` if the late event is a render/setState-like event (label matches `render`, `update`, `display`, `show`, `paint`, or `setState`); otherwise `warning`.

Events that fire after their scope has ended. The classic React bug: a `fetch().then(setState)` or `setTimeout(update, 100)` that fires after the component unmounts.

```
⚠️ [WARNING] "setTimeout:fire" fired after "UserProfile:scope-end" (cid: 7a3c)
   Pattern: after-teardown
   Event "setTimeout:fire" at beat 1420.12 occurred 120.48ms after teardown
   "UserProfile:scope-end" at beat 1299.64. This often means a callback, timer,
   or subscription wasn't cleaned up before disposal.
   Location: src/UserProfile.tsx:14
   Fix: Add cleanup: clear timers, abort fetches (AbortController), unsubscribe
        listeners in useEffect return. A ref guard prevents late setState.
```

**Detection:** Group by correlationId, merge in events whose `parentId` matches, find the scope teardown event, and flag any event with a later `beat`. If a recovery event (`reconnect`, `retry`, `resume`, `restart`, `resubscribe`, `reattach`, `reopen`, `fallback`) is present, events at or after the recovery beat are excluded — reconnecting is the fix, not a bug.

### `response-reorder`

**Severity:** `critical` if `meta.generation` and `meta.latestGeneration` confirm the stale response was the last to resolve; otherwise `warning`.

API responses arriving in a different order than their requests. The slow response overwrites the fast one — the UI shows wrong data.

```
🛑 [CRITICAL] Stale response for "fetch:/api/search" resolved last — confirmed data corruption
   Pattern: response-reorder
   Requests were sent in order [cid-1, cid-2] but responses arrived as [cid-2, cid-1].
   Generation tracking confirms the stale response (gen 1) resolved after the fresh one
   (latest gen 2). Without cancellation, the UI now shows outdated data.
   Location: src/hooks/useSearch.ts:20
   Fix: CONFIRMED STALE: The oldest request resolved last — its data overwrote the
        fresh result. Use AbortController to cancel superseded requests.
```

**Detection:** Normalise fetch labels by collapsing dynamic segments (`/api/user/123` → `/api/user/:id`). Group request/response pairs by normalised endpoint and compare request order against response-arrival order. If the last response to resolve has `meta.generation < meta.latestGeneration`, escalate to `critical`.

### `double-trigger`

**Severity:** `critical` if `meta` parameters are identical (internal keys `generation` / `latestGeneration` excluded); `info` if they differ.

Two starts of the same normalised operation overlap — the second starts before the first's matching end.

```
🛑 [CRITICAL] "fetch:/api/checkout:start" triggered twice concurrently with same parameters
   Pattern: double-trigger
   Operation "fetch:/api/checkout:start" was started at beat 210.33 (cid: a1)
   and again at beat 210.61 (cid: a2) before the first completed at beat 315.02.
   Both have identical parameters — this often indicates a missing mutex,
   debounce, or deduplication.
   Location: src/CheckoutButton.tsx:42
   Fix: Guard against duplicate triggers: check a loading flag, debounce,
        or disable the trigger element until completion.
```

**Detection:** Group start events by normalised label. For each adjacent pair, check whether the second starts before the first operation's matching end event. Generic timer labels (`setTimeout:start` / `setInterval:start`) only flag when the two starts share the same `parentId` scope or the same `callSite` — otherwise unrelated timers from Vite HMR or React internals produce spurious findings.

### `sequence-gap`

**Severity:** `critical`.

A numbered message stream has missing entries.

```
🛑 [CRITICAL] Sequence gap in "ws:message": 1 missing between seq 3 and 5 (cid: ws-4a)
   Pattern: sequence-gap
   "ws:message" events with correlationId "ws-4a" have sequence numbers [1, 2, 3, 5, 6].
   1 item(s) are missing between positions 3 and 5. This often indicates
   dropped messages, lost events, or a reconnect gap.
   Fix: Handle reconnection gaps: re-fetch missed data after WebSocket reconnect,
        or request a replay of the missing sequence range from the server.
```

**Detection:** Events carrying numeric `meta.seq` are grouped by `(correlationId, label)`, sorted by `seq`, and flagged on any consecutive integer gap.

**Note:** the `WebSocket` patch in `instrument()` does **not** currently stamp `meta.seq`. This detector only fires on manually instrumented traces and is not exercised by the current audit corpus.

### `stale-overwrite`

**Severity:** `critical`.

A render from an older request lands after a render from a newer request — the UI flips from correct back to stale.

**Detection:** Collect render-like events, group by label base, and for each consecutive pair find the originating request event by correlationId. If the later render's request was sent *earlier* than the previous render's request, flag it.

**Note:** render/state-write events are not emitted by any patch in `instrument()`. This detector only fires on manually instrumented traces that emit events with a render-like kind or label, and is not exercised by the current audit corpus.

### `dangling-async`

**Severity:** `warning`.

An operation started inside a scope but never reached a terminal state before the scope ended.

```
⚠️ [WARNING] setInterval never completed before "LiveChart" tore down
   Pattern: dangling-async
   A setInterval operation with cid "tmr-9" started at beat 82.10 inside scope
   "LiveChart" (cid: s-2), but the scope tore down at beat 450.44 without a
   matching clearInterval. The interval is still firing.
   Location: src/LiveChart.tsx:18
   Fix: Return a cleanup function from the effect that calls clearInterval.
```

**Detection:** Build a correlationId → scope-teardown-beat map. For each operation-start with a `parentId` whose scope teared down, check whether any terminal event exists for that correlationId using per-operation-type rules:

- `fetch` — needs `response` or `error`
- `setTimeout` — needs `timer-end` or `timer-clear`
- `setInterval` — needs `timer-clear` (ticks mean the interval is still running)
- `addEventListener` — needs `listener-remove`
- `WebSocket` — needs `response`, `close`, or `error`

A label-suffix fallback (`:done`, `:cancel`, `:close`, `:unsubscribe`, …) covers manual pulses without an explicit `kind`.

### `layout-thrash`

**Severity:** `warning` at 3–4 cycles per frame; `critical` at 5 or more cycles per frame.

Rapid DOM write→read cycles within a single synchronous frame. Each cycle forces the browser to recalculate layout synchronously.

**Detection:** Collect events with `kind === "dom-write"` or `kind === "dom-read"`. Group them into frames using a 16 ms window (`FRAME_WINDOW_MS`). Inside each frame, count transitions where a `dom-write` is immediately followed by a `dom-read`. At least 3 cycles fire `warning`; 5 or more fire `critical`.

**Note:** `instrument()` does not currently patch any forced-reflow DOM API (`getBoundingClientRect`, `offsetHeight`, style writes, …). This detector only fires on manually instrumented traces that emit `dom-write` / `dom-read` events and is not exercised by the current audit corpus.

## `printFindings(findings)`

Pretty-print findings to the console with severity icons and call sites.

```ts
printFindings(findings)
```

## `fingerprint(finding)`

Return the dedup fingerprint for a finding. The format is:

```
{pattern}::{sortedLabels}           // no call site available
{pattern}::{sortedLabels}::{callSite} // when any event has a call site
```

where `sortedLabels` is the finding's `events[*].label` array sorted and joined with commas. Useful for building your own suppression layer:

```ts
import { fingerprint } from 'pulscheck'

const key = fingerprint(finding)
if (!seen.has(key)) {
  seen.add(key)
  report(finding)
}
```

## `createReporter(options?)`

Create a reporter that runs `analyze()` on an interval and applies structural deduplication.

```ts
const reporter = createReporter({
  intervalMs: 5_000,       // default: 5000
  minSeverity: 'warning',  // default: 'warning'
  suppress: [],            // FindingPattern[], default: undefined
  log: console.log,        // custom log sink
  quiet: false,            // silence the startup banner
})

reporter.start()
```

### `ReporterOptions`

| Option | Default | Description |
|---|---|---|
| `intervalMs` | `5000` | Polling interval for the internal `analyze()` loop |
| `minSeverity` | `'warning'` | Lowest severity the reporter surfaces (`info` findings are suppressed by default) |
| `suppress` | `undefined` | Array of `FindingPattern` values to skip entirely |
| `log` | `console.log` | Custom log sink — receives already-formatted strings |
| `quiet` | `false` | Suppress the `[pulscheck] Reporter started` banner |

### `Reporter` methods

| Method | Description |
|---|---|
| `start()` | Begin periodic analysis. Idempotent. |
| `stop()` | Stop periodic analysis. Idempotent. |
| `check()` | Run `analyze()` once and return the full `Finding[]` — does **not** apply reporter dedup. |
| `reset()` | Clear the reporter's seen-fingerprint map. |

### Deduplication

Each interval, the reporter fingerprints every finding from `analyze()`. New fingerprints are logged once; recurring fingerprints only increment a count and are suppressed from output. `check()` runs a single `analyze()` and bypasses the dedup map — use `reset()` followed by the next interval to re-surface known findings.

`devMode()` wraps `createReporter().start()` for you — you rarely need to use `createReporter` directly unless you want non-default `minSeverity`, a custom `log` sink, or programmatic `check()` access.
