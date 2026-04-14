# Research & Validation

## Paper

PulsCheck ships with a technical report that documents the system architecture, the seven detectors, and the evaluation methodology.

**Title:** *PulsCheck: Runtime Detection of Asynchronous Race Conditions in Frontend Applications via Global Function Interception and Call Site Attribution*

**Author:** Oliver Nordsve, Qubites, Norway. April 2026.

**Status:** Self-published design-and-evaluation report attached to the open-source repository. **Not** peer-reviewed, **not** on arXiv, **not** submitted to any venue. Every factual claim in the paper is grounded in either the source code in `packages/core/src/` or the audit result files in `packages/core/.real-*.json`, both of which are present in the repository and reproducible with `pnpm test`.

The full paper is in the repository: [PAPER.md](https://github.com/Qubites/pulscheck/blob/main/PAPER.md).

## Install

```bash
npm install -D pulscheck
```

One package. The runtime detector, the React hooks, the testing helpers, and the CLI all ship from the same `pulscheck` npm package.

```ts
import { devMode } from 'pulscheck'                              // runtime detector
import { TwProvider, useScopedEffect } from 'pulscheck/react'    // React
import { withPulsCheck, assertClean } from 'pulscheck/testing'   // tests
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

## Detection results

### Current audit corpus: 77 bugs, 71 repos, 85.7%

PulsCheck is evaluated against **77 documented race conditions** sourced from GitHub issues across **71 distinct open-source repositories**. Every test replays the same `fetch` / `setTimeout` / `setInterval` / `addEventListener` call stream the documented bug would produce, captured by `instrument()`, and then runs `analyze()` over the resulting trace to verify that the correct pattern fires.

**Overall detection rate: 66 of 77 bugs (85.7%).**

The audit is broken down by bug category, each in its own Vitest file:

| Category | File | Bugs | Detected | Rate |
|---|---|---|---|---|
| Fetch races | `tests/real-audit-fetch.test.ts` | 25 | 16 | 64.0% |
| Timer leaks | `tests/real-audit-timers.test.ts` | 25 | 25 | 100% |
| Listener leaks | `tests/real-audit-listeners.test.ts` | 20 | 20 | 100% |
| Mixed real code | `tests/real-code-audit.test.ts` | 7 | 5 | 71.4% |
| **Total** | | **77** | **66** | **85.7%** |

### Per-detector coverage

Of the seven detectors, only four fire on the audit corpus. The other three depend on event kinds or metadata that the current `instrument()` layer does not auto-emit:

| Detector | Bugs flagged | Notes |
|---|---:|---|
| `after-teardown` | 44 | Most common detector — catches every timer leak and most listener leaks |
| `double-trigger` | 21 | Timer-leak tests typically fire both after-teardown and double-trigger |
| `dangling-async` | 20 | Catches unpaired `listener-add` events |
| `response-reorder` | 1 | Only BUG-54 has the generation metadata to confirm stale-last-to-resolve |
| `sequence-gap` | 0 | Requires `meta.seq` on WebSocket messages (manual instrumentation only) |
| `stale-overwrite` | 0 | Requires render events that fetch auto-instrumentation does not emit |
| `layout-thrash` | 0 | Requires `dom-read` / `dom-write` events that `instrument()` does not emit |

The three zero-coverage detectors are **not invalidated** by the current audit — they are **unvalidated**. They work on manually instrumented traces (see `PulseKind` in `packages/core/src/types.ts`) but no audit-corpus bug exercises them.

### The 11 misses

Nine of the eleven missed bugs are in `real-audit-fetch.test.ts` and share the same shape: a stale fetch response overwrites the state produced by a newer fetch. Catching them requires observing render or state-write events that the current `fetch` patch does not emit. The library-specific cases (SWR, TanStack Query, Apollo, tRPC, urql, axios, react-hook-form, Formik, Gatsby) would also need library-aware instrumentation to surface the underlying write.

The remaining two misses are in `real-code-audit.test.ts` (BUG-4 and BUG-5, involving zustand-style store patterns that do not go through any of the eight patched globals).

The full list of misses is in PAPER.md §4.4.

### Representative source bugs

A subset of the corpus traces back to well-known open-source issues. These are **source bugs that inspired the test scenarios**, not bugs the tool discovered in production code:

**after-teardown / dangling-async**
- facebook/react [#15006](https://github.com/facebook/react/issues/15006) — fetch resolves after unmount
- facebook/react [#19671](https://github.com/facebook/react/issues/19671) — timer fires after cleanup
- apollographql/apollo-client [#6880](https://github.com/apollographql/apollo-client/issues/6880) — WebSocket subscription leak

**listener leaks**
- radix-ui/primitives [#1973](https://github.com/radix-ui/primitives/issues/1973) — scroll listeners accumulated on Dialog cycles
- react-dnd/react-dnd [#2900](https://github.com/react-dnd/react-dnd/issues/2900) — touch listeners not removed on drop end
- facebook/docusaurus [#3599](https://github.com/facebook/docusaurus/issues/3599) — keydown/mousedown accumulated during navigation
- chakra-ui/chakra-ui [#5156](https://github.com/chakra-ui/chakra-ui/issues/5156) — Tooltip keydown listeners accumulated

**layout-thrash (source bugs — not currently exercised by the runtime detector)**
- TanStack/virtual [#359](https://github.com/TanStack/virtual/issues/359) / akiran/react-slick [#1274](https://github.com/akiran/react-slick/issues/1274) — row measurement loops
- framer/motion [#1431](https://github.com/framer/motion/issues/1431) — drag handler forced reflow
- radix-ui/primitives [#1634](https://github.com/radix-ui/primitives/issues/1634) — scroll-lock reflow
- mui/material-ui [#11673](https://github.com/mui/material-ui/issues/11673) — Tabs indicator layout thrash

Every test input in the audit is a **real** `fetch`, `setTimeout`, or `addEventListener` call captured by `instrument()`. The test scenarios are reconstructions of the documented bug shapes, not synthetic events bypassing the patch layer.

## Relationship to existing tools

PulsCheck occupies the runtime detection layer between lint-time analysis and production monitoring. It's designed to complement, not replace, what's already in your stack:

| Tool | What it covers | How PulsCheck relates |
|------|----------------|-----------------------|
| eslint-plugin-react-hooks | Stale closures (static) | Catches a large class of hook misuse at lint time. PulsCheck detects the runtime shape (fetch/timer/listener interactions) that lint rules cannot model. |
| TanStack Query / SWR | Race prevention (library-scoped) | Effective *within* their API. PulsCheck covers async code outside those boundaries, or code that uses them incorrectly. |
| fast-check (scheduler) | Response ordering (test-time) | Strongest for ordering bugs during property-based testing. PulsCheck observes ordering in live dev/CI traces rather than scheduled test runs. |
| Chrome DevTools Performance | Layout thrashing (manual) | Authoritative for targeted investigation. PulsCheck's `layout-thrash` detector exists but **currently requires manual `dom-read`/`dom-write` pulses** — it does not yet auto-instrument `getBoundingClientRect` / `offsetHeight` / style writes. |
| MemLab / Fuite | Memory leaks (heap analysis) | Confirm downstream memory impact. PulsCheck identifies the *causal* pattern (e.g. `dangling-async` on an unpaired `listener-add`) that produces it. |
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

PulsCheck is at version 0.1.0 and published on [npm](https://www.npmjs.com/package/pulscheck). The 77-bug audit is the principal validation corpus. Broader field evaluation across more development teams and codebases is the next milestone.

**Not yet demonstrated:**

- False-positive rates on diverse real-world codebases that contain no documented race conditions.
- Auto-instrumentation for the three currently unexercised detectors (`sequence-gap` would need `meta.seq` stamping on WebSocket messages; `stale-overwrite` would need render/state-write events from a React integration; `layout-thrash` would need auto-patching of forced-reflow-triggering DOM properties).
- Detection coverage across application architectures the audit does not touch (heavily SSR'd Next.js apps, mobile-first PWAs, Solid / Svelte runtimes).
- Runtime overhead of the patch layer under high-frequency async workloads.

If you use PulsCheck on a real codebase, [issues](https://github.com/Qubites/pulscheck/issues) and [sponsorships](https://github.com/sponsors/Qubites) are both very welcome.

## License

Apache 2.0 — [LICENSE](https://github.com/Qubites/pulscheck/blob/main/LICENSE).
