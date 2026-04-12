# Changelog

## 0.1.0 (2026-04-12)

Initial public release.

### Runtime Detector
- 5 heuristic pattern detectors: after-teardown, response-reorder, double-trigger, sequence-gap, stale-overwrite
- Auto-instrumentation of fetch, setTimeout, setInterval, clearTimeout, clearInterval, addEventListener, WebSocket
- Call site attribution (file:line for both sides of the race)
- Per-endpoint generation tracking for sink-awareness (warning vs critical severity)
- Ring buffer with O(1) memory (10k events, ~2MB)
- Dynamic URL normalization (/user/123 and /user/456 detected as same endpoint)
- Structural deduplication via fingerprinting

### React Integration
- `devMode()` — one-line activation
- `<TwProvider>` — React provider component
- `useScopedEffect()` / `useScopedLayoutEffect()` — drop-in useEffect replacements with lifecycle scoping
- `usePulse()`, `usePulseMount()`, `usePulseMeasure()` — manual pulse hooks

### CLI Scanner
- 9 static detection rules for CI pipelines
- Text, JSON, and SARIF 2.1.0 output formats
- GitHub Code Scanning integration via SARIF upload
- `--severity`, `--fail-on`, `--ignore`, `--quiet` options

### GitHub Action
- `Qubites/pulscheck/action` composite action
- Auto SARIF upload to GitHub Code Scanning
- PR summary comment with finding counts

### Testing
- 345 tests across 20 test files
- 15-scenario blind audit (80% detection rate, external sources)
- 7-scenario live browser validation via Playwright
- Before/after production app scan (3 findings → 0 after fix)
