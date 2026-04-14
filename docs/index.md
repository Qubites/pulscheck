---
layout: home
hero:
  name: PulsCheck
  text: Runtime race condition detection
  tagline: One function call. Seven detectors. Zero config.
  image:
    src: /logo.svg
    alt: PulsCheck
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: API Reference
      link: /api/core
    - theme: alt
      text: View on GitHub
      link: https://github.com/Qubites/pulscheck
features:
  - title: One-line setup
    details: Call devMode() once at app startup. PulsCheck auto-instruments fetch, setTimeout, setInterval, clearTimeout, clearInterval, addEventListener, removeEventListener, and WebSocket. No manual placement, no configuration.
  - title: 7 runtime detectors
    details: after-teardown, response-reorder, double-trigger, dangling-async, sequence-gap, stale-overwrite, and layout-thrash. The runtime timing bugs that static analysis cannot see. Four fire on the current audit; three require manual instrumentation and are not yet validated.
  - title: 66 of 77 documented bugs
    details: 85.7% detection rate on a 77-bug corpus sourced from 71 open-source repositories. Breakdown — timers 25/25, listeners 20/20, fetch 16/25, mixed real-code 5/7. Test inputs are real fetch, setTimeout, and addEventListener calls captured by instrument() — no hand-crafted events.
  - title: Dev-only by convention
    details: Gate devMode() behind import.meta.env.DEV or process.env.NODE_ENV in your entrypoint. The registry no-ops when NODE_ENV is production, but the package does not strip itself — the call site must do the guarding.
  - title: Actionable output
    details: Every finding includes the pattern, severity, call sites extracted from stack traces, and a concrete fix suggestion. Structurally deduplicated by (pattern, sorted labels, call site) — one report per bug, not per occurrence.
  - title: Static analysis CLI
    details: 'npx pulscheck scan src/ runs 9 regex-based source-level patterns that map onto the runtime detectors. npx pulscheck ci outputs SARIF and exits non-zero on findings for CI gates.'
---
