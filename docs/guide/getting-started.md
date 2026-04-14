# Getting Started

## Install

```bash
npm install -D pulscheck
```

## Setup (pick your framework)

### Vite / Vite + React

```ts
// main.ts (or main.tsx)
import { devMode } from 'pulscheck'

if (import.meta.env.DEV) {
  devMode()
}
```

### Next.js (App Router)

```tsx
// app/providers.tsx
'use client'
import { devMode } from 'pulscheck'

if (process.env.NODE_ENV === 'development') {
  devMode()
}

export function Providers({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
```

### Create React App / Webpack

```ts
// src/index.tsx
import { devMode } from 'pulscheck'

if (process.env.NODE_ENV === 'development') {
  devMode()
}
```

### Any JS app (no framework)

```ts
import { devMode } from 'pulscheck'
devMode()
```

That's it. Open your browser console. PulsCheck reports race conditions as they happen:

```
🛑 [CRITICAL] Stale response for "fetch:/api/search" resolved last — confirmed data corruption
   Pattern: response-reorder
   Requests were sent in order [...] but responses arrived as [...].
   Location: src/hooks/useSearch.ts:20
   Fix: Use AbortController to cancel superseded requests.
```

## What `devMode()` does

One call wires up three things:

1. **Instruments** `fetch`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `addEventListener`, `removeEventListener`, and `WebSocket` — eight globals in total. Every call is recorded as a timestamped event with its source code location (extracted from `new Error().stack`). A `Symbol.for("tw.patched")` sentinel prevents double-patching across hot module replacement.
2. **Starts the reporter**, which runs all seven detectors against the trace every 5 seconds (configurable) and logs newly seen findings. Recurring findings are deduplicated by `(pattern, sorted labels, call site)`.
3. **Returns a cleanup function** that reverses every patch and stops the reporter. Call it during HMR dispose so hot reloads do not double-patch.

```ts
const cleanup = devMode()

// On HMR dispose, test teardown, etc.
cleanup()
```

## Configuration

`devMode()` accepts the same options as `instrument()` plus a `reporter` sub-option:

```ts
devMode({
  fetch: true,       // patch fetch (default: true)
  timers: true,      // patch setTimeout / setInterval (default: true)
  events: true,      // patch addEventListener (default: true)
  websocket: true,   // patch WebSocket (default: true)
  reporter: {
    intervalMs: 3000,  // analyze every 3s (default: 5000)
  },
})
```

To limit event instrumentation to specific event types:

```ts
devMode({
  events: {
    include: ['click', 'submit', 'change'],
    exclude: ['focus', 'blur'],
  },
})
```

## React apps: use `TwProvider`

`TwProvider` is a thin wrapper around `devMode()` that hooks into React's mount/unmount lifecycle instead of a raw module-level call:

```tsx
import { TwProvider } from 'pulscheck/react'

function App() {
  return (
    <TwProvider>
      <YourApp />
    </TwProvider>
  )
}
```

Pass `devMode` options via the `options` prop:

```tsx
<TwProvider options={{ reporter: { intervalMs: 3000 } }}>
  <YourApp />
</TwProvider>
```

For scope-tracked effects, see [React Integration](/guide/react).

## Production

PulsCheck is **dev-only by convention**, but the package does not strip itself — you must gate the call site:

```ts
if (import.meta.env.DEV) devMode()                        // Vite
if (process.env.NODE_ENV === 'development') devMode()     // Webpack / Next.js / CRA
```

When the environment constant resolves to `false` at build time, modern bundlers (Vite, webpack, Next.js, esbuild) eliminate the guarded branch and tree-shake the `pulscheck` import out of the production bundle. The registry also internally no-ops when `process.env.NODE_ENV === 'production'` as a second line of defence, but the primary mechanism is the call-site gate.

If you call `devMode()` unconditionally, it *will* run in production — patches apply, the reporter ticks, and the buffer fills. Always gate.

## Next steps

- **[How It Works](/guide/how-it-works)** — the detection model, ring buffer, and scope tracking
- **[React Integration](/guide/react)** — `useScopedEffect`, hooks, and after-teardown detection
- **[CLI](/guide/cli)** — static analysis for CI pipelines
- **[API Reference](/api/core)** — every exported function
