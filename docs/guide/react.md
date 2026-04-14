# React Integration

All React-specific APIs live at the `pulscheck/react` subpath so that React never lands in the main bundle:

```ts
import {
  TwProvider,
  useScopedEffect,
  useScopedLayoutEffect,
  usePulse,
  usePulseMount,
  usePulseMeasure,
} from 'pulscheck/react'
```

## TwProvider

Drop-in provider. Wraps `devMode()` with a proper mount/unmount lifecycle:

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
| `options?` | `DevModeOptions` | Same options as `devMode()` — `fetch`, `timers`, `events`, `websocket`, `reporter` |

```tsx
<TwProvider options={{ reporter: { intervalMs: 3000 }, events: { exclude: ['input'] } }}>
  <YourApp />
</TwProvider>
```

The provider is inert in production builds — guard the import with `process.env.NODE_ENV === 'development'` if you want it gone at build time.

## useScopedEffect

**The most important React hook.** Drop-in replacement for `useEffect` that auto-scopes the effect, so every `fetch` / `setTimeout` / `setInterval` / `addEventListener` started inside it is bound to the component's lifecycle.

```tsx
import { useScopedEffect } from 'pulscheck/react'

function UserProfile({ id }: { id: string }) {
  useScopedEffect(() => {
    fetch(`/api/user/${id}`)
      .then((r) => r.json())
      .then(setUser)

    const interval = setInterval(pollStatus, 5000)
    return () => clearInterval(interval)
  }, [id])
}
```

What happens under the hood:

1. On effect run, opens a `tw.scope()` named after the component (inferred from the call stack).
2. Inside the effect body, every auto-instrumented async call captures the scope's `correlationId` as its `parentId`.
3. When React tears the effect down, the scope's `end()` emits a `scope-end` event.
4. Any async callback that fires **after** the scope ended — e.g. the `fetch().then(setUser)` resolving after unmount — is flagged as **after-teardown** by the analyzer, with both sides of the call site.

The scope pops from the active stack immediately after the setup function returns, so sibling components don't inherit it. Only operations started synchronously during setup are bound to this scope.

### Signature

```ts
function useScopedEffect(
  effect: EffectCallback,
  deps?: DependencyList,
  name?: string,
): void
```

Pass an explicit `name` to override component-name inference (useful inside HOCs or when the inferred name is `unknown`):

```tsx
useScopedEffect(() => { /* ... */ }, [id], 'UserProfile')
```

## useScopedLayoutEffect

Same as `useScopedEffect` but uses `useLayoutEffect`. Use this when your effect must run synchronously after DOM mutations.

```tsx
useScopedLayoutEffect(() => {
  const node = ref.current
  const observer = new ResizeObserver(handler)
  observer.observe(node)
  return () => observer.disconnect()
}, [])
```

## Pulse hooks

Three small hooks for manual event emission. These work alongside (or without) `TwProvider` and `useScopedEffect`.

### usePulse(label, options?)

Fire a pulse after every committed render. Safe in Concurrent Mode — it only fires for renders React actually commits, so you never get phantom events from abandoned renders.

```tsx
function ProductCard({ id }: { id: string }) {
  usePulse('product-card:render', { lane: 'ui', meta: { id } })
  return <div>…</div>
}
```

### usePulseMount(label, options?)

Fire `label:mount` on mount and `label:unmount` on cleanup:

```tsx
function Dashboard() {
  usePulseMount('dashboard', { lane: 'ui' })
  // ...
}
```

This establishes a manual lifecycle boundary. Most apps don't need this — `useScopedEffect` gives you a scoped lifecycle automatically for every effect.

### usePulseMeasure(label, options?)

Measure time between consecutive commits. The emitted event carries `durationMs` and `renderCount` in its metadata:

```tsx
function LiveChart() {
  usePulseMeasure('live-chart:render-gap', { lane: 'ui' })
  return <svg>…</svg>
}
```

Useful for spotting jank — if `durationMs` stays above ~16 ms, you're dropping frames.

## Combining with scopes directly

You can also create scopes imperatively when the component-level granularity of `useScopedEffect` isn't what you want:

```tsx
import { tw } from 'pulscheck'

function CheckoutFlow() {
  useEffect(() => {
    const scope = tw.scope('checkout-flow')
    // All async operations started here are scoped to 'checkout-flow'
    void preloadCheckoutAssets()
    return () => scope.end()
  }, [])

  return <CheckoutSteps />
}
```

## Dev-only

Every React hook and `TwProvider` is guarded by the same dev-only build path as the rest of pulscheck. In production builds, they compile to no-ops (or are tree-shaken entirely) unless you explicitly set `public: true` on a pulse — which is rare and opt-in.
