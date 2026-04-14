# PulsCheck

[![CI](https://github.com/Qubites/pulscheck/actions/workflows/publish.yml/badge.svg)](https://github.com/Qubites/pulscheck/actions/workflows/publish.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![npm](https://img.shields.io/npm/v/pulscheck)](https://www.npmjs.com/package/pulscheck)

Runtime race condition detection for frontend apps. One function call, seven detectors, zero config.

**Validated on 77 real bugs from 71 open-source repos — 85.7% detection rate.** All tests use real `fetch`/`setTimeout`/`addEventListener` captured by `instrument()`. No hand-crafted events.

## Install

```bash
npm install -D pulscheck
```

## Setup (pick your framework)

### Vite / Vite + React

```ts
// main.ts (or main.tsx)
import { devMode } from "pulscheck";

if (import.meta.env.DEV) {
  devMode();
}
```

### Next.js (App Router)

```tsx
// app/providers.tsx
"use client";
import { devMode } from "pulscheck";

if (process.env.NODE_ENV === "development") {
  devMode();
}

export function Providers({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
```

### Create React App / Webpack

```ts
// src/index.tsx
import { devMode } from "pulscheck";

if (process.env.NODE_ENV === "development") {
  devMode();
}
```

### Any JS app (no framework)

```ts
import { devMode } from "pulscheck";
devMode();
```

That's it. Open your browser console. PulsCheck reports race conditions as they happen:

```
[PulsCheck] response-reorder (critical)
  Responses for "fetch:/api/search" arrived out of request order
  → src/hooks/useSearch.ts:20
  Stale response was LAST to resolve — app is showing wrong data
```

## What it catches

### Runtime detection (7 patterns)

| Pattern | Example | Severity |
|---------|---------|----------|
| **after-teardown** | fetch completes after component unmounts | critical |
| **response-reorder** | slow search response overwrites fast one | critical |
| **double-trigger** | two identical fetches fire 0.3ms apart | critical |
| **dangling-async** | operation started but never completed before teardown | critical |
| **sequence-gap** | WebSocket messages arrive out of order | warning |
| **stale-overwrite** | old response overwrites newer data | warning |
| **layout-thrash** | repeated forced reflows in the same frame | warning |

### Static analysis CLI (9 patterns)

```bash
npx pulscheck scan src/
```

Catches `fetch-no-abort-in-effect`, `setInterval-no-cleanup`, `setTimeout-in-effect-no-clear`, `state-update-in-then`, `async-onclick-no-guard`, and more.

## React integration (optional)

### Provider

```tsx
import { TwProvider } from "pulscheck/react";

function App() {
  return (
    <TwProvider>
      <YourApp />
    </TwProvider>
  );
}
```

### Scoped Effects

Drop-in `useEffect` replacement that tracks component lifecycle boundaries:

```tsx
import { useScopedEffect } from "pulscheck/react";

function UserProfile({ id }) {
  useScopedEffect(() => {
    fetch(`/api/user/${id}`).then(r => r.json()).then(setUser);
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, [id]);
}
```

## CI / GitHub Action

### CLI

```bash
npx pulscheck scan src/              # text output
npx pulscheck ci src/ --fail-on critical  # SARIF + exit code
```

### GitHub Action

```yaml
- uses: Qubites/pulscheck/action@main
  with:
    path: src/
    severity: warning
    fail-on: critical
```

## How it works

PulsCheck patches `fetch`, `setTimeout`, `setInterval`, `addEventListener`, `removeEventListener`, and `WebSocket` at the global level. Each call is recorded as a timestamped event with its source code location (extracted from stack traces). Seven heuristic detectors analyze the event stream every 5 seconds.

Events are stored in a ring buffer (10k events, ~2MB, O(1) insertion). Findings are structurally deduplicated — one report per bug, not per occurrence.

**Dev-only.** The `devMode()` call tree-shakes out of production builds. Zero runtime cost in production.

## API

### Runtime

```typescript
import { devMode, instrument, restore, analyze, VERSION } from "pulscheck";
```

| Function | Description |
|----------|-------------|
| `devMode(opts?)` | One-line activation: instruments + starts reporter |
| `instrument(opts?)` | Patch globals, returns cleanup function |
| `restore()` | Remove all patches |
| `analyze(events)` | Run detectors on an event array |

### React

```typescript
import { TwProvider, useScopedEffect, usePulse, usePulseMount } from "pulscheck/react";
```

### Testing

```typescript
import { createTestHarness } from "pulscheck/testing";
```

### CLI

```bash
pulscheck scan [dir]           # Scan for patterns
pulscheck ci [dir]             # CI mode (SARIF + exit code)
pulscheck --version
```

## Why not React Query / SWR?

React Query and SWR **prevent** race conditions by managing the request lifecycle. PulsCheck **detects** race conditions in code that doesn't use those libraries — or in code that uses them incorrectly. If your whole app uses React Query correctly, you probably don't need PulsCheck.

## Support the project

PulsCheck is free and open source. If it saved you debugging time or improved your product, consider supporting continued development:

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa)](https://github.com/sponsors/Qubites)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-donate-yellow)](https://buymeacoffee.com/olivernordsve)

## License

Apache 2.0. See [LICENSE](LICENSE).

[Research paper](PAPER.md) with full methodology and evaluation.
