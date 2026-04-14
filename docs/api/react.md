# React Hooks

All React integrations are exported from the `pulscheck/react` subpath — this keeps React out of the main bundle for non-React consumers:

```ts
import {
  TwProvider,
  useScopedEffect,
  useScopedLayoutEffect,
  usePulse,
  usePulseRender,
  usePulseMount,
  usePulseMeasure,
} from 'pulscheck/react'
```

## TwProvider

Drop-in provider. Calls `devMode()` on mount and cleans up on unmount.

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

### Props

| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Your app |
| `options?` | `DevModeOptions` | All `instrument()` options plus `reporter` |

```tsx
<TwProvider
  options={{
    events: { exclude: ['input'] },
    reporter: { intervalMs: 3000 },
  }}
>
  <YourApp />
</TwProvider>
```

## useScopedEffect(effect, deps?, name?)

Drop-in replacement for `useEffect` that auto-scopes the effect. Every `fetch`, `setTimeout`, `setInterval`, and `addEventListener` started inside the effect body is bound to the component's lifecycle via `parentId`, so the analyzer can detect after-teardown and dangling-async bugs on it.

```tsx
import { useScopedEffect } from 'pulscheck/react'

function UserProfile({ id }: { id: string }) {
  useScopedEffect(() => {
    fetch(`/api/user/${id}`).then((r) => r.json()).then(setUser)
    const interval = setInterval(pollStatus, 5000)
    return () => clearInterval(interval)
  }, [id])
}
```

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `effect` | `EffectCallback` | Effect body (returns optional cleanup) |
| `deps?` | `DependencyList` | Dependency array — same semantics as `useEffect` |
| `name?` | `string` | Override the inferred scope name |

### How it works

1. On effect run, opens a `tw.scope(name ?? inferredComponentName)`.
2. Runs your effect body. Every auto-instrumented async call inside captures the scope's `correlationId` as its `parentId`.
3. Calls `scope.deactivate()` so the scope is popped off the active stack — sibling components don't inherit it. Async operations already scoped are still bound.
4. On cleanup, runs your cleanup function first, then `scope.end()` emits a `scope-end` event. Any late callbacks with a matching `parentId` become after-teardown findings.

Component name is inferred from the call stack. If the inference lands on `unknown` (rare — common inside HOCs or anonymous components), pass an explicit `name`.

## useScopedLayoutEffect(effect, deps?, name?)

Same as `useScopedEffect` but uses `useLayoutEffect`. Use when your effect must run synchronously after DOM mutations — `ResizeObserver` setup, measuring the DOM, etc.

```tsx
useScopedLayoutEffect(() => {
  const observer = new ResizeObserver(handler)
  observer.observe(ref.current!)
  return () => observer.disconnect()
}, [])
```

## usePulse(label, options?)

Fire a pulse **after every committed render**. Safe in Concurrent Mode — it only fires for renders React actually commits, so you never get phantom events from abandoned renders.

```tsx
function ProductCard({ id }: { id: string }) {
  usePulse('product-card:render', { lane: 'ui', meta: { id } })
  return <div>…</div>
}
```

## usePulseRender(label, options?)

Fire a pulse **during render** (before commit). Only use this when you need to track abandoned renders in Concurrent Mode — in most cases you want `usePulse()` instead.

::: warning
React may call `render()` multiple times without committing. Each call produces a pulse, so you may see phantom events.
:::

## usePulseMount(label, options?)

Fire `label:mount` on mount and `label:unmount` on unmount:

```tsx
function Dashboard() {
  usePulseMount('dashboard', { lane: 'ui' })
  // ...
}
```

This gives you a manual lifecycle boundary. Most apps don't need it — `useScopedEffect` gives you an automatic lifecycle for every effect without having to pick a component name yourself.

## usePulseMeasure(label, options?)

Measure time between consecutive commits. Each pulse includes in its metadata:

- `durationMs` — milliseconds since the previous commit
- `renderCount` — how many times the component has committed

```tsx
function LiveChart() {
  usePulseMeasure('live-chart:render-gap', { lane: 'ui' })
  return <svg>…</svg>
}
```

Useful for spotting jank: if `durationMs` consistently exceeds 16.7 ms, you're dropping frames.

## PulseOptions

All hooks (`usePulse`, `usePulseMount`, `usePulseMeasure`, etc.) accept `PulseOptions` as their second argument:

```ts
interface PulseOptions {
  lane?: PulseLane         // default: "ui"
  correlationId?: string
  parentId?: string
  meta?: Record<string, unknown>
  public?: boolean         // default: false
  sample?: number          // 0-1, default: 1
  kind?: PulseKind
  source?: PulseSource
  callSite?: string
}
```

See [Core API](/api/core) for the full `PulseOptions` type.
