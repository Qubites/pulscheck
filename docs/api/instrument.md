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

Labels use the path portion of the URL (not the full URL with query string), truncated to 120 characters. Full URL and method are preserved in `meta.url` / `meta.method`.

| Global | Labels | `kind` |
|---|---|---|
| `fetch` | `fetch:{path}:start` → `fetch:{path}:done` (success) or `fetch:{path}:error` | `request` → `response` / `error` |
| `setTimeout` | `setTimeout:start` → `setTimeout:fire` → `setTimeout:clear` (if cancelled) | `timer-start` → `timer-end` / `timer-clear` |
| `setInterval` | `setInterval:start` → repeating `setInterval:tick` → `setInterval:clear` (if cancelled) | `timer-start` → `timer-tick` / `timer-clear` |
| `addEventListener` | `listener:{type}:add` on register (only when inside an active scope and not `{once: true}`), `event:{type}` on fire | `listener-add` → `dom-event` |
| `removeEventListener` | `listener:{type}:remove` (only when the add was recorded) | `listener-remove` |
| `WebSocket` | `ws:open:start` → `ws:open:done`, then `ws:message` / `ws:close` / `ws:error` | `request` → `response`, then `message` / `close` / `error` |

Every auto-emitted event carries a `callSite` (`file:line`) extracted from `new Error().stack` (via `Error.captureStackTrace` on V8). The stack walker skips pulscheck internal frames and understands both Vite browser URLs (`http://localhost:8080/src/...?t=123:12:5`) and Node.js absolute paths.

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
