# Analysis

The analyzer runs 7 heuristic detectors against a pulse trace and returns structured findings.

```ts
import { analyze, printFindings, fingerprint, createReporter } from 'pulscheck'
```

## analyze(trace, options?)

Run all detectors against a trace and return findings.

```ts
const findings = analyze(tw.trace)
```

With options:

```ts
const findings = analyze(tw.trace, {
  windowMs: 16,  // collision detection window (default: 16)
})
```

**Returns:** `Finding[]`

### Finding

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

### FindingPattern

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

### after-teardown

**Severity:** critical

Events that fire after their scope has ended. The classic React bug: calling `setState` after component unmount, or a `fetch().then()` resolving after the effect that started it has been torn down.

```
[pulscheck] after-teardown (critical)
  fetch:/api/user:done fired 120ms after UserProfile:scope-end
  → src/UserProfile.tsx:14
  Fix: Use useScopedEffect, or add an AbortController tied to the effect cleanup.
```

**Detection:** Builds a correlationId → teardown-beat index from `scope-end` events. Any event whose `parentId` is in the index and whose `beat` is after the teardown is reported.

### response-reorder

**Severity:** critical

API responses arriving in a different order than their requests. The slow response overwrites the fast one. User sees wrong data.

```
[pulscheck] response-reorder (critical)
  Responses for "fetch:/api/search" arrived out of request order
  → src/hooks/useSearch.ts:20
  Stale response was LAST to resolve — app is showing wrong data
  Fix: Use an AbortController to cancel in-flight requests when a new one starts.
```

**Detection:** Normalizes fetch labels by collapsing dynamic segments (`/api/user/123` → `/api/user/:id`), groups request/response pairs by normalized endpoint, and compares request order vs response order. Generation-stamped so the analyzer can distinguish overlap (warning) from a stale response actually being the last write (critical).

### double-trigger

**Severity:** critical

The same logical action fired twice within the collision window. Common causes: React Strict Mode, missing debounce, duplicate event handlers, double-submitted forms.

```
[pulscheck] double-trigger (critical)
  fetch:/api/checkout:start fired 2x within 0.3ms
  → src/CheckoutButton.tsx:42
  Fix: Add a loading-state guard, or debounce the trigger.
```

**Detection:** Scans for events with identical normalized labels within the configured `windowMs` (default 16 ms).

### dangling-async

**Severity:** critical

An operation started inside a scope but never reached a terminal state before the scope ended. A fetch with no response, a timer that was never cleared, a listener that was never removed — all inside a component that unmounted.

```
[pulscheck] dangling-async (critical)
  setInterval in "LiveChart" never cleared before scope-end
  → src/LiveChart.tsx:18
  Fix: Return a cleanup function from the effect that calls clearInterval.
```

**Detection:** Indexes pending `request` / `timer-start` / `listener-add` events by `parentId`. On every `scope-end`, the index is checked — any entry without a matching `response` / `timer-clear` / `listener-remove` before the teardown is dangling.

### sequence-gap

**Severity:** warning

Missing steps in an ordered sequence. Typical with WebSocket streams where packets are dropped or arrive out of order.

```
[pulscheck] sequence-gap (warning)
  ws:message sequence jumped from step 3 to step 5
  Fix: Track last received sequence number and request replay of missed messages on reconnect.
```

**Detection:** Events carrying numeric `meta.step` are grouped by label base; consecutive integer gaps are flagged.

### stale-overwrite

**Severity:** warning

A late response overwrites fresher data. The user sees correct data briefly, then it reverts.

```
[pulscheck] stale-overwrite (warning)
  prices:update overwrote newer data (stale by 800ms)
  Fix: Compare response timestamps or sequence numbers before writing to state.
```

**Detection:** Tracks writes to the same target and flags when an older response's write lands after a newer one has already been applied.

### layout-thrash

**Severity:** warning (3+ cycles) / critical (5+ cycles)

Forced synchronous layout from repeated DOM write-then-read cycles within a single synchronous execution frame.

```
[pulscheck] layout-thrash (critical)
  5 write-then-read cycles in 2ms frame (offsetWidth, offsetHeight)
  → src/Tabs.tsx:88
  Fix: Batch DOM reads and writes separately. Use requestAnimationFrame
       to defer writes, or cache layout values with a WeakMap dirty-tracking pattern.
```

**Detection:** Groups DOM writes and reads into synchronous frames (events within 4 ms). Counts write-then-read transitions where the read target was dirtied by a preceding write. Uses a WeakSet to track dirtied elements, avoiding false positives from reads on unmodified elements.

## printFindings(findings)

Pretty-print findings to the console with severity icons, colors, and call sites.

```ts
printFindings(findings)
```

## fingerprint(finding)

Return the dedup fingerprint for a finding — `${pattern}::${sorted call sites}`. Useful for building your own suppression layer.

```ts
import { fingerprint } from 'pulscheck'

const key = fingerprint(finding)
if (!seen.has(key)) {
  seen.add(key)
  report(finding)
}
```

## createReporter(options?)

Create a reporter that runs `analyze()` on an interval with built-in deduplication.

```ts
const reporter = createReporter({
  intervalMs: 5000,  // default: 5000
})

reporter.start()
```

**Reporter methods**

| Method | Description |
|--------|-------------|
| `start()` | Begin periodic analysis |
| `stop()` | Stop periodic analysis |
| `check()` | Run analysis once, return **new** findings only |
| `reset()` | Clear dedup history |

### Deduplication

The reporter fingerprints each finding as `${pattern}::${sorted call sites}`. Only new fingerprints are logged. If the same race condition fires 1,000 times, you see it once — with the call sites that produced it.

The `check()` method returns only newly discovered findings since the last check. `reset()` wipes the dedup history so a subsequent `check()` returns everything the trace currently supports.

`devMode()` wraps `createReporter().start()` for you — you rarely need to use `createReporter` directly.
