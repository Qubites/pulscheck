# Research & Validation

**See also:** [v0.1.0 Findings](/research/v0.1-findings) — retrospective on what was built, what was cut, and where the gaps are.

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

## Representative source bugs

A subset of the patterns PulsCheck targets trace back to well-known open-source issues. These are **source bugs that inspired the detector scenarios**, not claims about what the tool discovered in production code:

**after-teardown / dangling-async**
- facebook/react [#15006](https://github.com/facebook/react/issues/15006) — fetch resolves after unmount
- facebook/react [#19671](https://github.com/facebook/react/issues/19671) — timer fires after cleanup
- apollographql/apollo-client [#6880](https://github.com/apollographql/apollo-client/issues/6880) — WebSocket subscription leak

**listener leaks**
- radix-ui/primitives [#1973](https://github.com/radix-ui/primitives/issues/1973) — scroll listeners accumulated on Dialog cycles
- react-dnd/react-dnd [#2900](https://github.com/react-dnd/react-dnd/issues/2900) — touch listeners not removed on drop end
- facebook/docusaurus [#3599](https://github.com/facebook/docusaurus/issues/3599) — keydown/mousedown accumulated during navigation
- chakra-ui/chakra-ui [#5156](https://github.com/chakra-ui/chakra-ui/issues/5156) — Tooltip keydown listeners accumulated

## Relationship to existing tools

PulsCheck occupies the runtime detection layer between lint-time analysis and production monitoring. It's designed to complement, not replace, what's already in your stack:

| Tool | What it covers | How PulsCheck relates |
|------|----------------|-----------------------|
| eslint-plugin-react-hooks | Stale closures (static) | Catches a large class of hook misuse at lint time. PulsCheck detects the runtime shape (fetch/timer/listener interactions) that lint rules cannot model. |
| TanStack Query / SWR | Race prevention (library-scoped) | Effective *within* their API. PulsCheck covers async code outside those boundaries, or code that uses them incorrectly. |
| fast-check (scheduler) | Response ordering (test-time) | Strongest for ordering bugs during property-based testing. PulsCheck observes ordering in live dev/CI traces rather than scheduled test runs. |
| @eslint-react/eslint-plugin | Timer / listener / observer leak rules (static) | Authoritative at lint time for `setTimeout`, `setInterval`, `addEventListener`, and `ResizeObserver` inside `useEffect`. PulsCheck's CLI does **not** duplicate these — our only static rule is `fetch-no-abort-in-effect`, which has no equivalent upstream. |
| MemLab / Fuite | Memory leaks (heap analysis) | Confirm downstream memory impact. PulsCheck identifies the *causal* pattern (e.g. `dangling-async` on an unpaired `listener-add`) that produces it. |
| Sentry / LogRocket | Error monitoring (production) | Capture consequences in production. PulsCheck identifies causes in development before they ship. |

## Static CLI vs runtime detector

The `pulscheck` CLI runs source-level detectors (AST-based, plus a small set of regex heuristics) against the source tree. See [CLI](/guide/cli).

The runtime `devMode()` detector complements this by catching what static analysis can't see — real async timing, real endpoint generations, real call graphs.

| Layer | Strength | Blind spot |
|-------|----------|-----------|
| Static (CLI) | Fast, runs in CI, zero runtime | Can't see async timing |
| Runtime (`devMode`) | Real traces, real bugs, call sites | Only finds what you actually execute |

Use both.

## License

Apache 2.0 — [LICENSE](https://github.com/Qubites/pulscheck/blob/main/LICENSE).
