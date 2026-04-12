# PulsCheck

Runtime race condition detection for frontend apps. One function call, five bug patterns, zero config.

> **Early release.** 80% detection on external test scenarios, zero false positives in controlled tests. Real-world validation in progress. All feedback appreciated — [issues](https://github.com/Qubites/pulscheck/issues) · [discussions](https://github.com/Qubites/pulscheck/discussions)
>
> **[Try the online scanner](https://pulscheck.dev)** — paste a React component, see what PulsCheck finds. No install needed.

```
npm install pulscheck
```

## What it catches

| Pattern | Example | Severity |
|---------|---------|----------|
| **after-teardown** | fetch completes after component unmounts | critical |
| **response-reorder** | slow search response overwrites fast one | critical |
| **double-trigger** | two identical fetches fire 0.3ms apart | critical |
| **sequence-gap** | WebSocket messages arrive out of order | warning |
| **stale-overwrite** | old response overwrites newer data | warning |

## Quick start (React)

```tsx
import { devMode } from "pulscheck";

if (process.env.NODE_ENV === "development") {
  devMode(); // instruments fetch, timers, events, WebSocket
}
```

That's it. Open your browser console — PulsCheck reports race conditions as they happen, with file:line for both sides of the conflict:

```
[PulsCheck] response-reorder (critical)
  Responses for "fetch:/api/search" arrived out of request order
  → src/hooks/useSearch.ts:20
  → src/hooks/useSearch.ts:20
  Stale response was LAST to resolve — app is showing wrong data
```

## React Provider (alternative)

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

## Scoped Effects

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

If `fetch` completes after the component unmounts, PulsCheck flags it as `after-teardown`.

## CLI Scanner (CI)

Static analysis for race condition patterns in your source code:

```bash
npx pulscheck scan src/
```

```
PulsCheck v0.1.0 scanning src/...
============================================================
Found 3 patterns (1 critical, 2 warning, 0 info) in 4ms

src/hooks/useData.ts (1 findings)
  !! L12 [critical] fetch-no-abort-in-effect
     fetch() inside useEffect without AbortController
     Fix: const ctrl = new AbortController(); fetch(url, {signal: ctrl.signal}); return () => ctrl.abort();
```

### CI mode (SARIF for GitHub Code Scanning)

```bash
npx pulscheck ci src/ --fail-on critical
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

PulsCheck patches `fetch`, `setTimeout`, `setInterval`, `addEventListener`, and `WebSocket` at the global level. Each call is recorded as a timestamped event with its source code location (extracted from stack traces). Five heuristic detectors analyze the event stream:

1. **After-teardown** — async operation fires after its scope (React component) unmounted
2. **Response-reorder** — responses arrive in different order than requests were sent
3. **Double-trigger** — same operation fires twice before the first completes
4. **Sequence-gap** — missing entries in sequential message streams
5. **Stale-overwrite** — older response arrives after newer one to same endpoint

Per-endpoint **generation tracking** distinguishes "responses overlapped" (warning) from "stale data was last to resolve and the app consumed it" (critical).

Events are stored in a **ring buffer** (10k events, ~2MB, O(1) insertion). The analyzer runs every 5 seconds. Findings are **structurally deduplicated** so you see each bug once, not once per occurrence.

**Dev-only.** Zero production overhead. The `devMode()` call is tree-shaken in production builds.

## API

### Runtime

```typescript
import { devMode } from "pulscheck";
import { instrument, restore, analyze, VERSION } from "pulscheck";
```

| Function | Description |
|----------|-------------|
| `devMode(opts?)` | One-line activation: instruments + starts reporter |
| `instrument(opts?)` | Patch globals, returns cleanup function |
| `restore()` | Remove all patches |
| `analyze(events, opts?)` | Run detectors on an event array |
| `VERSION` | Build-time version string |

### React Hooks

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
pulscheck --version            # Print version
pulscheck help                 # Show help
```

## Why not React Query / SWR?

React Query and SWR **prevent** race conditions by managing the request lifecycle. PulsCheck **detects** race conditions in code that doesn't use those libraries — or in code that uses them incorrectly.

If your whole app uses React Query correctly, you probably don't need PulsCheck. If you have any raw `fetch()` calls, `setInterval` polling, WebSocket handlers, or event listeners — PulsCheck catches what those miss.

## What we've tested

- **345 tests** across 20 test files
- **80% detection rate** on 15 externally-sourced blind audit scenarios
- **7/7 bugs caught** in live browser testing via Playwright injection
- **3 → 0 findings** in before/after production app scan

## What we don't know yet

- False positive rate on large, real-world codebases (our tests were designed to have race conditions)
- Whether findings actually save developer time vs just adding noise
- How it behaves with React Query, SWR, or other request management libraries
- Whether the CLI scanner is useful in CI or just annoying after the first run

If you can help answer any of these, we'd genuinely appreciate an [issue](https://github.com/Qubites/pulscheck/issues) or [discussion](https://github.com/Qubites/pulscheck/discussions).

## Security & Trust

PulsCheck patches `fetch` and `setTimeout` — we know that looks like what malicious packages do. Here's why you can trust it:

- **Full source on GitHub** — every line is readable, no obfuscation
- **~50KB total** — nothing hidden in the bundle size
- **No install scripts** — `npm install` doesn't execute any code
- **No network calls** — PulsCheck never sends data anywhere, all analysis is local
- **Dev-only** — tree-shaken out of production builds
- **npm provenance** — cryptographically verified build from this exact repo *(coming soon)*

Run `npx pulscheck scan node_modules/pulscheck/dist/` on itself if you want to verify.

## License

Apache 2.0 — free for all use, commercial and open source. See [LICENSE](LICENSE).

Read the [research paper](PAPER.md) for full technical details and honest evaluation.
