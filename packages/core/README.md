# PulsCheck

[![CI](https://github.com/Qubites/pulscheck/actions/workflows/publish.yml/badge.svg)](https://github.com/Qubites/pulscheck/actions/workflows/publish.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![npm](https://img.shields.io/npm/v/pulscheck)](https://www.npmjs.com/package/pulscheck)

Runtime race condition detection for frontend apps. One function call, four detectors, zero config.

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
🛑 [CRITICAL] Stale response for "fetch:/api/search" resolved last — confirmed data corruption
   Pattern: response-reorder
   Requests were sent in order [...] but responses arrived as [...].
   Location: src/hooks/useSearch.ts:20
   Fix: CONFIRMED STALE: The oldest request resolved last — its data overwrote the fresh result.
```

## What it catches

### Runtime detection (4 patterns)

| Pattern | Example | Severity |
|---------|---------|----------|
| **after-teardown** | fetch completes after component unmounts | critical if the late event is a render/setState; otherwise warning |
| **response-reorder** | slow search response overwrites fast one | critical if generation tracking confirms the stale response resolved last; otherwise warning |
| **double-trigger** | two identical fetches fire 0.3ms apart | critical if parameters match; info if parameters differ |
| **dangling-async** | operation started but never completed before teardown | warning |

The default reporter surfaces `warning` and `critical` findings; `info` findings require passing `{ minSeverity: "info" }` to `devMode()`.

### Static analysis CLI (1 rule)

```bash
npx pulscheck scan src/
```

Ships a single cleanup-aware AST rule — `fetch-no-abort-in-effect` — that catches `fetch()` inside `useEffect` / `useLayoutEffect` / `useInsertionEffect` without an `AbortController` wired into cleanup. It walks nested closures and checks for a matching `.abort()` call in the effect's return function. The equivalent rules for `setTimeout`, `setInterval`, and `addEventListener` already live in [`@eslint-react/eslint-plugin`](https://www.npmjs.com/package/@eslint-react/eslint-plugin) (`no-leaked-timeout`, `no-leaked-interval`, `no-leaked-event-listener`), so we don't duplicate them.

**Known limitation.** The AST scanner does not follow calls into helper functions defined outside the effect body. The runtime detector is the authoritative path for real coverage.

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

## CI

```bash
npx pulscheck scan src/                   # text output
npx pulscheck ci src/ --fail-on critical  # SARIF + exit code
```

Drop straight into GitHub Actions — no wrapper action needed:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 20
- run: npx -y pulscheck ci src/ --fail-on critical --out pulscheck.sarif
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: pulscheck.sarif
```

## How it works

PulsCheck patches eight globals — `fetch`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `addEventListener`, `removeEventListener`, and `WebSocket` — using a sentinel symbol (`Symbol.for("tw.patched")`) to prevent double-patching across hot module replacement. Each intercepted call is recorded as a timestamped `PulseEvent` with its source code location, extracted from `new Error().stack`.

Events are stored in a ring buffer with a default capacity of 10,000 events. Four heuristic detectors run over the trace every 5,000 ms via the built-in reporter. Findings are structurally deduplicated by a fingerprint of pattern, sorted labels, and call site — so one logical bug produces one report, not one per occurrence.

**Dev-only by convention.** `devMode()` is meant to be gated behind `import.meta.env.DEV` or `process.env.NODE_ENV === "development"` at the call site. There is no automatic production stripping inside the package itself — if you call `devMode()` unconditionally, it will run in production.

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
import { withPulsCheck, assertClean } from "pulscheck/testing";
```

`withPulsCheck(fn)` runs a callback inside a captured pulse trace and returns `{ findings, issues, trace, expectClean() }`. Pass `{ instrument: true }` to also patch `fetch`, timers, events, and `WebSocket` for the duration of the call.

### CLI

```bash
pulscheck scan [dir]           # Scan for patterns
pulscheck ci [dir]             # CI mode (SARIF + exit code)
pulscheck --version
```

## Why not React Query / SWR?

React Query and SWR **prevent** race conditions by managing the request lifecycle. PulsCheck **detects** race conditions in code that doesn't use those libraries — or in code that uses them incorrectly. If your whole app uses React Query correctly, you probably don't need PulsCheck.

## License

Apache 2.0. See [LICENSE](LICENSE).
