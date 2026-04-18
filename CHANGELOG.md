# Changelog

## 0.1.0 — 2026-04-18

Initial public release.

### Runtime Detector
- 4 heuristic pattern detectors: after-teardown, response-reorder, double-trigger, dangling-async
- Auto-instrumentation of fetch, setTimeout, setInterval, clearTimeout, clearInterval, addEventListener, removeEventListener, WebSocket
- Call site attribution (file:line for both sides of the race, extracted from stack traces)
- Per-endpoint generation tracking for sink-awareness (warning vs critical severity on response-reorder)
- Ring buffer with O(1) insertion (10k events, configurable via `registry.configure({ maxTrace })`)
- Dynamic URL normalization (/user/123 and /user/456 grouped as the same endpoint)
- Structural deduplication via fingerprinting — one finding per bug, not per occurrence

### React Integration
- `devMode()` — one-line activation
- `<TwProvider>` — React provider component
- `useScopedEffect()` / `useScopedLayoutEffect()` — drop-in useEffect replacements with lifecycle scoping
- `usePulse()`, `usePulseMount()`, `usePulseMeasure()` — manual pulse hooks

### CLI Scanner
- 1 cleanup-aware AST rule: `fetch-no-abort-in-effect` (fetch inside useEffect without AbortController)
- Text, JSON, and SARIF 2.1.0 output formats
- GitHub Code Scanning integration via SARIF upload
- `--severity`, `--fail-on`, `--ignore`, `--quiet` options

The timer/listener siblings (`setTimeout`, `setInterval`, `addEventListener`) are already
well-covered by `@eslint-react/eslint-plugin`'s `no-leaked-*` rules, and we do not duplicate them.
