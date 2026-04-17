---
layout: home
hero:
  name: PulsCheck
  text: Runtime race condition detection
  tagline: One function call. Four detectors. Zero config.
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
  - title: 4 runtime detectors
    details: after-teardown, response-reorder, double-trigger, and dangling-async. The runtime timing bugs that static analysis cannot see.
  - title: Dev-only by convention
    details: Gate devMode() behind import.meta.env.DEV or process.env.NODE_ENV in your entrypoint. The registry no-ops when NODE_ENV is production, but the package does not strip itself — the call site must do the guarding.
  - title: Actionable output
    details: Every finding includes the pattern, severity, call sites extracted from stack traces, and a concrete fix suggestion. Structurally deduplicated by (pattern, sorted labels, call site) — one report per bug, not per occurrence.
  - title: Static analysis CLI
    details: 'npx pulscheck scan src/ runs an AST-based detector for fetch() inside useEffect without AbortController — the static sibling of the runtime after-teardown pattern. npx pulscheck ci outputs SARIF and exits non-zero on findings for CI gates.'
---
