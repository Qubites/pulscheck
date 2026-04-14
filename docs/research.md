# Research & Validation

## Paper

PulsCheck is documented in a technical paper describing the system architecture, detection algorithms, and evaluation methodology.

**Title:** *PulsCheck: Automatic Runtime Detection of Asynchronous Race Conditions in Frontend Applications via Global Function Interception and Call Site Attribution*

**Author:** Oliver Nordsve, Qubites, Norway. April 2026.

The full paper is in the repository: [PAPER.md](https://github.com/Qubites/pulscheck/blob/main/PAPER.md).

## Install

```bash
npm install -D pulscheck
```

One package, one binary. The runtime detector, the React hooks, the testing helpers, and the CLI all ship from the same `pulscheck` npm package.

```ts
import { devMode } from 'pulscheck'                         // runtime detector
import { TwProvider, useScopedEffect } from 'pulscheck/react' // React
import { createTestHarness } from 'pulscheck/testing'        // tests
```

```bash
npx pulscheck scan src/     # CLI: static analysis
npx pulscheck ci src/       # CLI: SARIF + exit code for CI
```

## Source

```bash
git clone https://github.com/Qubites/pulscheck.git
cd pulscheck
npm install
npm run build
```

## Detection Results

### 77-bug real-world audit

PulsCheck was validated against **77 documented race conditions** sourced from **71 open-source repositories** — real issues linked from GitHub, not hand-crafted scenarios. Every test replays the same `fetch` / `setTimeout` / `setInterval` / `addEventListener` call stream the documented bug would produce, captured by `instrument()`, and verifies the correct pattern fires.

**Detection rate: 85.7% (66/77 bugs).**

The misses cluster in two categories:

- **Framework-internal listener registration** that bypasses the patched `addEventListener` (some virtual-DOM event systems attach via delegated root handlers, so the per-element `listener-add` pulse never fires).
- **Stateful protocol gaps** — a small number of WebSocket sequence-gap cases require replay awareness beyond sequential step tracking.

Everything else is caught by one of the seven runtime detectors.

### Representative bugs

A subset of the 77 bugs traces back to well-known open-source issues:

**after-teardown / dangling-async:**
- facebook/react [#15006](https://github.com/facebook/react/issues/15006) — fetch resolves after unmount
- facebook/react [#19671](https://github.com/facebook/react/issues/19671) — timer fires after cleanup
- apollographql/apollo-client [#6880](https://github.com/apollographql/apollo-client/issues/6880) — WebSocket subscription leak

**Listener leaks (caught by dangling-async):**
- radix-ui/primitives [#1973](https://github.com/radix-ui/primitives/issues/1973) — scroll listeners accumulated on Dialog cycles
- react-dnd [#2900](https://github.com/react-dnd/react-dnd/issues/2900) — touch listeners not removed on drop end
- facebook/docusaurus [#3599](https://github.com/facebook/docusaurus/issues/3599) — keydown/mousedown accumulated during navigation
- chakra-ui [#5156](https://github.com/chakra-ui/chakra-ui/issues/5156) — Tooltip keydown listeners accumulated

**layout-thrash:**
- TanStack/virtual [#359](https://github.com/TanStack/virtual/issues/359) / react-slick [#1274](https://github.com/akiran/react-slick/issues/1274) — row measurement loops
- framer/motion [#1431](https://github.com/framer/motion/issues/1431) — drag handler forced reflow
- radix-ui/primitives [#1634](https://github.com/radix-ui/primitives/issues/1634) — scroll-lock reflow
- mui/material-ui [#11673](https://github.com/mui/material-ui/issues/11673) — Tabs indicator layout thrash

Every test in the audit uses **real** `fetch`, `setTimeout`, and `addEventListener` calls captured by `instrument()`. No synthetic events.

## Relationship to existing tools

PulsCheck occupies the runtime detection layer between lint-time analysis and production monitoring. It's designed to complement, not replace, what's already in your stack:

| Tool | What it covers | How PulsCheck relates |
|------|----------------|-----------------------|
| eslint-plugin-react-hooks | Stale closures (static) | Catches ~80–90% at lint time. PulsCheck detects the runtime remainder that survives lint. |
| TanStack Query / SWR | Race prevention (library-scoped) | Effective *within* their API. PulsCheck covers async code outside those boundaries, or code that uses them incorrectly. |
| fast-check (scheduler) | Response ordering (test-time) | Strongest for ordering bugs during property-based testing. PulsCheck detects them during dev/CI. |
| Chrome DevTools Performance | Layout thrashing (manual) | Authoritative for targeted investigation. PulsCheck automates detection so you don't have to open a recording. |
| MemLab / Fuite | Memory leaks (heap analysis) | Confirm downstream memory impact. PulsCheck identifies the *causal* pattern (e.g. dangling-async) that produces it. |
| Sentry / LogRocket | Error monitoring (production) | Capture consequences in production. PulsCheck identifies causes in development before they ship. |

## Static CLI vs runtime detector

The `pulscheck` CLI ships 9 source-level detectors (`fetch-no-abort-in-effect`, `state-update-in-then`, `async-onclick-no-guard`, etc.) that run against the source tree. See [CLI](/guide/cli).

The runtime `devMode()` detector complements this by catching what static analysis can't see — real async timing, real endpoint generations, real call graphs.

| Layer | Strength | Blind spot |
|-------|----------|-----------|
| Static (CLI) | Fast, runs in CI, zero runtime | Can't see async timing |
| Runtime (`devMode`) | Real traces, real bugs, call sites | Only finds what you actually execute |

Use both.

## Current status

PulsCheck is at version 0.1.0 and published on [npm](https://www.npmjs.com/package/pulscheck). The 77-bug audit is the principal validation corpus; broader field evaluation across more development teams and codebases is the next milestone.

**Not yet demonstrated publicly:** false positive rates under diverse real-world usage patterns, detection coverage across application architectures we haven't tested (e.g. heavily SSR'd apps, mobile-first PWAs), and the performance impact of layout instrumentation on DOM-intensive workloads.

If you use PulsCheck on a real codebase, [issues](https://github.com/Qubites/pulscheck/issues) and [sponsorships](https://github.com/sponsors/Qubites) are both very welcome.

## License

Apache 2.0 — [LICENSE](https://github.com/Qubites/pulscheck/blob/main/LICENSE).
