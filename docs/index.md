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
    details: Call devMode() once at app startup. PulsCheck auto-instruments fetch, setTimeout, setInterval, addEventListener, removeEventListener, and WebSocket. No manual placement, no configuration.
  - title: 7 runtime detectors
    details: after-teardown, response-reorder, double-trigger, dangling-async, sequence-gap, stale-overwrite, and layout-thrash. The runtime timing bugs that static analysis cannot see.
  - title: Validated on 77 real bugs
    details: 85.7% detection rate on 77 documented race conditions from 71 open-source repositories. Every test replays real fetch, setTimeout, and addEventListener calls — no hand-crafted events.
  - title: Dev-only, zero production cost
    details: devMode() tree-shakes out of production builds. The entire detector, reporter, and trace buffer is inert when NODE_ENV=production. No bundle impact, no runtime overhead.
  - title: Actionable output
    details: Every finding includes the pattern, severity, call sites extracted from stack traces, and a concrete fix suggestion. Structurally deduplicated — one report per bug, not per occurrence.
  - title: Static analysis CLI
    details: 'npx pulscheck scan src/ runs 9 source-level detectors for lint-time race patterns. npx pulscheck ci outputs SARIF and exits non-zero on findings for CI gates.'
---
