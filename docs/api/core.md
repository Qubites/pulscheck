# Core API

Everything in this page is exported from the main `pulscheck` entrypoint:

```ts
import {
  tw,
  devMode,
  instrument,
  restore,
  analyze,
  printFindings,
  createReporter,
  createTracker,
  registry,
  VERSION,
} from 'pulscheck'
```

The runtime primitive is `tw` — a small object with methods that build and emit `PulseEvent`s. Every other API in the package either wraps it (`devMode`), patches globals to call it (`instrument`), or reads the events it produces (`analyze`, `createReporter`, `createTracker`).

## tw.pulse(label, options?)

Fire a single timestamped event into the trace buffer.

```ts
tw.pulse('cart:render', { lane: 'ui' })
tw.pulse('auth:refresh', { lane: 'auth', meta: { userId: 42 } })
```

**Parameters**

| Param | Type | Description |
|-------|------|-------------|
| `label` | `string` | Event label — e.g. `"cart:render"` |
| `options` | `PulseOptions` | Optional configuration |

**PulseOptions**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `lane` | `PulseLane` | `"ui"` | Execution lane |
| `correlationId` | `string` | auto | Link related events |
| `parentId` | `string` | — | Causal parent (scope correlationId) |
| `meta` | `Record<string, unknown>` | — | Arbitrary metadata |
| `public` | `boolean` | `false` | Emit in production |
| `sample` | `number` | `1` | Sampling rate (0–1) |
| `kind` | `PulseKind` | — | Structured classifier — see below |
| `source` | `PulseSource` | `"manual"` | Who emitted this event |
| `callSite` | `string` | — | `file:line` of the origin |

**Returns:** `PulseEvent`

## tw.measure(label, options?)

Start a timed span. Returns an object with a `stop()` method.

```ts
const m = tw.measure('api:fetch-prices', { lane: 'api' })
const data = await fetchPrices()
const durationMs = m.stop()
```

Emits `label:start` on creation and `label:end` on `stop()`. Both events share the same `correlationId`. The end event includes `durationMs` and `startBeat` in its metadata. `stop()` is idempotent — calling it twice returns `0` the second time.

**Returns:** `MeasureResult`

| Property | Type | Description |
|----------|------|-------------|
| `startEvent` | `PulseEvent` | The start event |
| `stop()` | `() => number` | End the span, returns duration in ms |

## tw.checkpoint(label, step, options?)

Fire a pulse carrying a numeric `step` value in its `meta`. Useful for marking progress through an ordered flow.

```ts
tw.checkpoint('onboarding', 1, { lane: 'ui' })
tw.checkpoint('onboarding', 2, { lane: 'ui' })
tw.checkpoint('onboarding', 3, { lane: 'ui' })
```

**Note:** `tw.checkpoint` is a labeling convenience — the four shipped detectors don't consume `meta.step`. If you want to correlate checkpoints with a fetch that was torn down, the `after-teardown` and `dangling-async` detectors reason about `parentId` / scope teardown, not step numbers.

## tw.scope(name, options?)

Create a correlation scope. Emits `"{name}:start"` with `kind: "scope-start"` immediately, pushes the scope onto the global scope stack, and returns a `Scope` handle. All auto-instrumented events that fire while this scope is on top of the stack capture its `correlationId` as their `parentId`. Call `scope.end()` to emit the teardown event and pop the scope.

```ts
const scope = tw.scope('checkout-flow', { lane: 'ui' })

await fetch('/api/submit-order')   // parentId → scope.correlationId
setTimeout(pollStatus, 1000)       // parentId → scope.correlationId

scope.end()                        // emits "checkout-flow:teardown" with kind: "scope-end"
```

**Returns:** `Scope`

| Property | Type | Description |
|----------|------|-------------|
| `correlationId` | `string` | The scope's unique ID |
| `end()` | `() => void` | End the scope (idempotent) |
| `deactivate()` | `() => void` | Pop from the scope stack without ending — used by `useScopedEffect` |

Events fired after `scope.end()` with matching `parentId` are flagged as **after-teardown** by the analyzer.

## tw.on(handler)

Subscribe to all pulse events in real time:

```ts
const unsub = tw.on((event) => {
  console.log(event.label, event.lane, event.beat, event.callSite)
})

unsub() // unsubscribe
```

**Returns:** `() => void` — unsubscribe function

## tw.trace

Read the ring buffer contents. Returns a readonly snapshot of the last N events (default 10,000).

```ts
const events: readonly PulseEvent[] = tw.trace
```

## tw.clearTrace()

Clear the ring buffer.

```ts
tw.clearTrace()
```

## tw.configure(options)

Configure the registry:

```ts
tw.configure({
  enabled: false,    // disable all event collection
  maxTrace: 50_000,  // increase ring buffer capacity
})
```

## PulseEvent

The event object stored in the trace:

```ts
interface PulseEvent {
  label: string              // e.g. "fetch:/api/search:start"
  lane: PulseLane            // "ui" | "api" | "auth" | "ws" | "worker" | custom
  beat: number               // performance.now() — monotonic
  ts: number                 // Date.now() — wall clock
  public: boolean            // emitted in production?
  correlationId: string
  parentId?: string
  kind?: PulseKind           // "request" | "response" | "scope-end" | ...
  source?: PulseSource       // "auto" | "manual" | "scope"
  callSite?: string          // "src/hooks/useSearch.ts:20"
  meta?: Record<string, unknown>
}
```

## PulseLane

```ts
type PulseLane =
  | 'ui'
  | 'api'
  | 'auth'
  | 'ws'
  | 'worker'
  | (string & {})   // any custom string
```

## PulseKind

The analyzer prefers `kind` over label substring matching — auto-instrumentation always sets it.

```ts
type PulseKind =
  | 'request' | 'response' | 'error'
  | 'timer-start' | 'timer-end' | 'timer-tick' | 'timer-clear'
  | 'listener-add' | 'listener-remove'
  | 'dom-event' | 'message' | 'close'
  | 'scope-start' | 'scope-end'
  | 'state-write' | 'render'
  | 'custom'
  | (string & {})
```

## PulseSource

```ts
type PulseSource = 'auto' | 'manual' | 'scope' | (string & {})
```

## VERSION

The package version string, injected at build time:

```ts
import { VERSION } from 'pulscheck'
console.log(VERSION) // "0.1.0"
```
