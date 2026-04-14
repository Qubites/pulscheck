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
[pulscheck] response-reorder (critical)
  Responses for "fetch:/api/search" arrived out of request order
  → src/hooks/useSearch.ts:20
  Stale response was LAST to resolve — app is showing wrong data
```

## What `devMode()` does

One call wires up three things:

1. **Instruments** `fetch`, `setTimeout`, `setInterval`, `addEventListener`, `removeEventListener`, and `WebSocket`. Every call is recorded as a timestamped event with its source code location (extracted from stack traces).
2. **Starts the reporter**, which runs all 7 detectors against the trace every 5 seconds and logs new findings.
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

PulsCheck is **dev-only by default**. The `devMode()` call is meant to be guarded by an `import.meta.env.DEV` or `process.env.NODE_ENV === 'development'` check — when that check evaluates to `false` at build time, modern bundlers (Vite, webpack, Next.js, esbuild) tree-shake the entire `pulscheck` import out of the bundle.

No runtime overhead. No bundle size impact.

## Next steps

- **[How It Works](/guide/how-it-works)** — the detection model, ring buffer, and scope tracking
- **[React Integration](/guide/react)** — `useScopedEffect`, hooks, and after-teardown detection
- **[CLI](/guide/cli)** — static analysis for CI pipelines
- **[API Reference](/api/core)** — every exported function
