# Auto-Instrumentation

Auto-instrumentation patches browser and Node globals to emit pulses without any manual placement. Combined with `tw.scope()` (or `useScopedEffect`), it enables the analyzer to detect race conditions automatically.

```ts
import { instrument, restore, devMode } from 'pulscheck'
```

## instrument(options?)

Patch globals and start emitting pulse events automatically. Returns a cleanup function.

```ts
const cleanup = instrument()
// ... your app runs, events are captured ...
cleanup()
```

With options:

```ts
const cleanup = instrument({
  fetch: true,       // patch fetch (default: true)
  timers: true,      // patch setTimeout / setInterval (default: true)
  events: true,      // patch addEventListener + removeEventListener (default: true)
  websocket: true,   // patch WebSocket (default: true)
})
```

**Returns:** `() => void` — cleanup function (equivalent to calling `restore()`)

### InstrumentOptions

```ts
interface InstrumentOptions {
  fetch?: boolean
  timers?: boolean
  events?: boolean | EventInstrumentOptions
  websocket?: boolean
}

interface EventInstrumentOptions {
  /** Only instrument these event types (overrides default allowlist) */
  include?: string[]
  /** Exclude these event types from instrumentation */
  exclude?: string[]
}
```

To customize which DOM events are captured:

```ts
instrument({
  events: {
    include: ['click', 'submit', 'change'],
    exclude: ['input'],
  },
})
```

### What gets emitted

| Global | Events | `kind` |
|--------|--------|--------|
| `fetch` | `fetch:{url}:start` → `fetch:{url}:done` (on success) or `fetch:{url}:error` | `request` → `response` / `error` |
| `setTimeout` | `timer:set` → `timer:fire` (or `timer:clear` on `clearTimeout`) | `timer-start` → `timer-tick` / `timer-clear` |
| `setInterval` | `timer:set` → repeating `timer:fire` (or `timer:clear` on `clearInterval`) | `timer-start` → `timer-tick` / `timer-clear` |
| `addEventListener` | `listener:add:{type}` on register, `event:{type}` on fire | `listener-add` → `dom-event` |
| `removeEventListener` | `listener:remove:{type}` | `listener-remove` |
| `WebSocket` | `ws:open`, `ws:message`, `ws:close`, `ws:error` | `message` / `close` / `error` |

Every auto-emitted event carries a `callSite` (`file:line`) extracted from a fresh `Error().stack`. The analyzer uses this to produce findings with both sides of a collision pinpointed in source.

### Default event allowlist

High-frequency DOM events are filtered by default to keep the trace useful. Only these event types emit pulses:

`click`, `dblclick`, `submit`, `change`, `input`, `focus`, `blur`, `keydown`, `keyup`, `popstate`, `hashchange`, `beforeunload`, `visibilitychange`, `online`, `offline`, `error`, `unhandledrejection`.

Events like `scroll`, `mousemove`, `pointermove`, and `resize` are excluded to prevent trace flooding. Use the `include` / `exclude` options on `events` to override.

### Double-patch prevention

A `Symbol.for('tw.patched')` sentinel is set on every patched function. Calling `instrument()` twice (for example, on HMR hot reloads) is safe — the second call detects the sentinel and is a no-op. Call `restore()` (or the cleanup function returned by `instrument`) between reloads if you want a clean re-patch.

### Scope integration

If a scope is active when a patched function runs, the auto-emitted event inherits the scope's `correlationId` as its `parentId`. This is how auto-events get linked to lifecycle boundaries for after-teardown and dangling-async detection.

```ts
import { tw } from 'pulscheck'

const scope = tw.scope('checkout')

// Both events carry parentId → scope.correlationId
await fetch('/api/submit-order')
const id = setTimeout(pollStatus, 1000)

scope.end()  // emits scope-end; any subsequent events from these operations are flagged
```

In React apps, `useScopedEffect` gives you this integration for free on every effect.

### Generation tracking

The fetch patch keeps a per-endpoint generation counter. Every request to the same endpoint increments the counter and stamps the in-flight request with its generation. When the response arrives, the analyzer checks whether it was the latest generation or an older one that resolved out of order.

This is what lets the `response-reorder` detector distinguish "responses overlapped" (warning) from "stale response was actually the last write" (critical — the app ended up displaying wrong data).

## restore()

Remove all patches applied by `instrument()` and restore original browser globals.

```ts
import { restore } from 'pulscheck'

restore()
```

Safe to call multiple times. `instrument()`'s return value is a more convenient handle — prefer that unless you're in a context where you can't hold on to it.

## devMode(options?)

Higher-level wrapper: `instrument()` + `createReporter().start()` in one call. This is the recommended entry point for most apps.

```ts
import { devMode } from 'pulscheck'

const cleanup = devMode({
  fetch: true,
  timers: true,
  events: true,
  websocket: true,
  reporter: {
    intervalMs: 5000,
  },
})

cleanup() // stops reporter + restores globals
```

### DevModeOptions

```ts
interface DevModeOptions extends InstrumentOptions {
  /** Reporter options — interval, severity, suppress, etc. */
  reporter?: ReporterOptions
}
```

All `InstrumentOptions` fields are accepted directly; reporter-specific options go under `reporter`.
