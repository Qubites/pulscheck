# PulsCheck

[![CI](https://github.com/Qubites/pulscheck/actions/workflows/publish.yml/badge.svg)](https://github.com/Qubites/pulscheck/actions/workflows/publish.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![npm](https://img.shields.io/npm/v/pulscheck)](https://www.npmjs.com/package/pulscheck)

Runtime race condition detection for frontend apps. One function call, seven detectors, zero config.

**Detection rate on the current audit corpus: 66 of 77 documented bugs (85.7%), drawn from 71 open-source repositories.** The audit is broken down by bug category: 100% on timer-leak bugs (25/25), 100% on listener-leak bugs (20/20), 64% on fetch-race bugs (16/25), and 71.4% on a mixed real-code subset (5/7). All test inputs are real `fetch` / `setTimeout` / `addEventListener` call streams captured by `instrument()` — there are no synthetic events. Reproduce from `packages/core/` with `pnpm vitest run tests/real-*`. Full methodology, per-detector breakdown, and the list of misses are in [PAPER.md](PAPER.md).

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

### Runtime detection (7 patterns)

| Pattern | Example | Severity |
|---------|---------|----------|
| **after-teardown** | fetch completes after component unmounts | critical if the late event is a render/setState; otherwise warning |
| **response-reorder** | slow search response overwrites fast one | critical if generation tracking confirms the stale response resolved last; otherwise warning |
| **double-trigger** | two identical fetches fire 0.3ms apart | critical if parameters match; info if parameters differ (likely intentional concurrency) |
| **dangling-async** | operation started but never completed before teardown | warning |
| **sequence-gap** | numbered messages with missing entries in the sequence | critical |
| **stale-overwrite** | older request's render overwrites a newer request's render | critical |
| **layout-thrash** | repeated forced reflows in the same frame | warning at 3–4 cycles/frame; critical at ≥5 |

Severity rules are defined in `packages/core/src/analyze.ts`. The default reporter surfaces `warning` and `critical` findings; `info` findings require passing `{ minSeverity: "info" }` to `devMode()`.

**Coverage note.** Of the seven detectors, four fire on the 77-bug audit corpus (`after-teardown`, `double-trigger`, `dangling-async`, `response-reorder`). The three others (`sequence-gap`, `stale-overwrite`, `layout-thrash`) depend on event types or metadata that the current `instrument()` layer does not auto-emit — they require manual `tw.pulse()` instrumentation and are not validated by the current audit. See [PAPER.md](PAPER.md) §4.3 for the per-detector breakdown.

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

PulsCheck patches eight global asynchronous primitives — `fetch`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `addEventListener`, `removeEventListener`, and `WebSocket` — using a sentinel symbol (`Symbol.for("tw.patched")`) to prevent double-patching across hot module replacement. Each intercepted call is recorded as a timestamped `PulseEvent` with its source code location, extracted from `new Error().stack` and parsed for both Vite browser URLs and Node.js paths.

Events are stored in a ring buffer with a default capacity of 10,000 events (O(1) insertion, configurable via `registry.configure({ maxTrace })`). Seven heuristic detectors run over the trace on an interval (default 5,000 ms) via the built-in reporter. Findings are structurally deduplicated by a fingerprint of pattern, sorted labels, and call site — so one logical bug produces one report, not one per occurrence.

**Dev-only by convention.** `devMode()` is meant to be gated behind `import.meta.env.DEV` or `process.env.NODE_ENV === "development"` at the call site, as shown above. There is no automatic production stripping inside the package itself — if you call `devMode()` unconditionally, it will run in production.

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

## Support the project

PulsCheck is free and open source. If it saved you debugging time or improved your product, consider supporting continued development:

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa)](https://github.com/sponsors/Qubites)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-donate-yellow)](https://buymeacoffee.com/olivernordsve)

## License

Apache 2.0. See [LICENSE](LICENSE).

[Research paper](PAPER.md) with full methodology and evaluation.
