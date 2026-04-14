# PulsCheck: Runtime Detection of Asynchronous Race Conditions in Frontend Applications via Global Function Interception and Call Site Attribution

**Oliver Nordsve**
Qubites · Norway
April 2026

> **Status.** This is a self-published design-and-evaluation report attached to the [PulsCheck open-source repository](https://github.com/Qubites/pulscheck). It is **not** peer-reviewed, **not** on arXiv, and **not** submitted to any venue. Every factual claim below is grounded in either the source code in `packages/core/src/` or the audit result files in `packages/core/.real-*.json`, both of which are present in the repository at the time of writing and can be reproduced with `pnpm test`. Where the evaluation has limitations, they are stated. Nothing is stretched.

---

## Abstract

Frontend applications rely heavily on asynchronous operations — network requests, timers, event listeners, and persistent connections — that execute concurrently and interact through shared mutable state. Race conditions arising from these interactions are invisible to type checkers, linters, and AST-based static analysis because they manifest only at specific runtime moments.

We present **PulsCheck**, a runtime detection system that intercepts asynchronous primitives at the JavaScript global-function level, records each intercepted call as a timestamped event with its source code location, and applies **seven heuristic pattern detectors** to the resulting event stream: `after-teardown`, `response-reorder`, `double-trigger`, `sequence-gap`, `stale-overwrite`, `dangling-async`, and `layout-thrash`.

We evaluate PulsCheck against a corpus of **77 documented bugs** drawn from GitHub issues across **71 distinct open-source repositories**. The current test suite detects **66 of the 77 bugs (85.7%)**. Detection is uneven across bug categories: **100% on timer-leak bugs (25/25)**, **100% on listener-leak bugs (20/20)**, **64% on fetch-race bugs (16/25)**, and **71.4% on a mixed real-code subset (5/7)**. Of the seven detectors, **only four fire on the audit corpus**: `after-teardown` (flags 44 of 77 bugs), `double-trigger` (21), `dangling-async` (20), and `response-reorder` (1). The remaining three detectors (`sequence-gap`, `stale-overwrite`, `layout-thrash`) **do not fire on any bug in this audit** — they are dependent on event types or metadata that the current `instrument()` layer does not auto-emit, and therefore require manual instrumentation to exercise. These three detectors are **unvalidated by the current evaluation**.

The nine missed fetch-race bugs cluster into a single shape: stale-overwrite patterns where a response from an older request overwrites state that a newer request populated. Catching these requires observing render or state-write events that the current auto-instrumentation layer does not emit from a fetch patch alone. The two other misses are in a small mixed-source test file.

We describe the system architecture, the seven detectors, the static companion CLI (9 regex-based patterns), and the evaluation methodology. We then enumerate the limitations of this evaluation and the open questions that must be answered by real-world usage before any stronger claims can be made.

**Keywords:** race condition detection, asynchronous programming, runtime analysis, frontend development, monkey-patching, call site attribution

---

## 1. Introduction

The shift to asynchronous, event-driven frontend architectures has introduced a class of bugs that existing developer tooling does not reliably detect. When a user types a search query, the application may fire multiple fetch requests concurrently. If the responses arrive in a different order than the requests were sent, the user interface displays stale data — not because any individual function is incorrect, but because the temporal relationship between two correct functions produces an incorrect outcome.

These temporal bugs share a property: they are invisible to tools that analyse code as a static snapshot. TypeScript verifies types. ESLint enforces patterns. AST-based code review tools examine structure. None of these tools model execution time. A race condition between two `fetch()` calls on line 20 and line 36 of the same file passes every static check — the types are correct, the patterns are standard, the code reads well. The bug exists only in the milliseconds between two function calls that happen to execute concurrently.

AI-assisted code generation tools may amplify the problem. Generators such as GitHub Copilot, Cursor, and Claude Code produce asynchronous code that passes type checks and linting, but they have no model of the temporal context in which the generated code will execute — specifically, what other asynchronous operations are already in flight at the point of insertion. Whether AI-generated code produces race conditions at a higher rate than human-written code is an **open empirical question** that we do not attempt to answer in this paper. The claim here is narrower: no tool in the typical AI-assisted development workflow validates temporal correctness, regardless of whether the code was written by a human or a model.

We present PulsCheck, a runtime detection system that addresses this gap. PulsCheck operates by intercepting standard asynchronous primitives (`fetch`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `addEventListener`, `removeEventListener`, `WebSocket`) at the global function level, recording each intercepted call as a timestamped event with its originating source code location, and applying seven heuristic pattern detectors to the event stream. When a pattern matches, the system reports the pattern name, a severity level, the source file and line number of the implicated operations, and a concrete fix suggestion.

The contributions of this paper are:

1. An auto-instrumentation technique that patches eight asynchronous globals to emit typed pulse events, with a sentinel to prevent double-patching across hot module replacement.
2. A call-site attribution method that extracts source-code locations from stack traces in both browser (Vite) and Node.js environments.
3. Seven heuristic race-condition detectors operating on a ring-buffer event stream, with well-defined severity rules grounded in the detector implementations.
4. URL-path normalisation and per-endpoint generation tracking that lets the `response-reorder` detector distinguish benign ordering anomalies (warning) from "stale-response-was-last-to-resolve" (critical).
5. A structural fingerprinting scheme that deduplicates repeated occurrences of the same bug across reporter cycles.
6. A companion static CLI with 9 regex-based patterns that map to runtime detectors, with SARIF 2.1.0 output for CI integration.
7. An evaluation against 77 documented bugs from 71 open-source repositories, with per-category and per-detector breakdowns, including an explicit accounting of the three detectors that do not fire on this corpus.

**What this paper is not.** This is not a peer-reviewed publication. The evaluation uses a single-author-curated corpus, runs in Node.js rather than real browsers, and does not measure developer time-to-fix, false-positive rates on non-buggy code, or detection coverage across application architectures we have not tested. Section 6 lists the open questions in detail.

---

## 2. Related work

**Static analysis.** Tools such as ESLint, TypeScript, and Semgrep operate on the abstract syntax tree of source code. They are effective for structural bugs but cannot model runtime timing. The `no-floating-promises` family of rules catches a narrow subset of concurrency issues (unawaited promises) but cannot detect conflicts between correctly-awaited operations that execute concurrently.

**Browser developer tools.** Chrome DevTools provides the Performance and Network panels. These tools record execution but do not analyse it for race conditions — the developer must manually identify temporal conflicts from flame charts and waterfall diagrams.

**Error monitoring.** Sentry, Datadog, and LogRocket capture errors that throw exceptions. Race conditions that produce incorrect state without throwing — such as a stale API response overwriting fresh data — are invisible to these tools because no error occurs.

**Data-race literature.** The classical data-race detection literature targets multi-threaded shared-memory systems. Eraser [1] detects data races via lockset analysis. ThreadSanitizer [2] uses compile-time instrumentation for happens-before analysis. These approaches target thread-level concurrency and do not apply directly to single-threaded, event-loop-based JavaScript applications where concurrency arises from asynchronous callbacks rather than parallel threads.

**JavaScript-specific approaches.** EventRacer [3] analyses event-handler interleavings in web applications using record-and-replay techniques. Node.fz [4] applies fuzzing to the Node.js event-driven architecture. Both require specialised runtime environments or external instrumentation infrastructure. PulsCheck differs in that it operates inside the application's own JavaScript context via monkey-patching, requiring no external infrastructure beyond a single import.

**Query libraries.** TanStack Query (React Query), SWR, Apollo Client, and urql prevent some races by managing the request lifecycle inside their own hooks. They are effective within their own API surface. PulsCheck addresses code that does not use these libraries or that uses them alongside raw `fetch`/`setTimeout` calls.

---

## 3. System architecture

PulsCheck comprises five components arranged in a pipeline:

```
┌──────────────┐   ┌──────────────┐   ┌────────────┐   ┌──────────┐   ┌──────────┐
│ instrument() │──▶│  registry    │──▶│  analyze   │──▶│  dedup   │──▶│ reporter │
│ (6 patches)  │   │ (ring buffer │   │ (7 patterns)│  │ (fingerp.)│  │ (console)│
│              │   │  10k events) │   │            │   │          │   │          │
└──────────────┘   └──────────────┘   └────────────┘   └──────────┘   └──────────┘
       │
       ▼
 ┌─────────────┐
 │ call-site   │
 │ capture     │
 │ (stacktrace)│
 └─────────────┘
```

### 3.1 Auto-instrumentation

The instrumentation layer (`packages/core/src/instrument.ts`) replaces eight global functions (`fetch`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `addEventListener`, `removeEventListener`, `WebSocket`), grouped into four categories, with patched versions:

| Category | Patched globals | Events emitted (`kind`) |
|---|---|---|
| Fetch | `fetch` | `request` (on call), `response` (on success), `error` (on throw) |
| Timers | `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` | `timer-start` on `setTimeout`/`setInterval`; `timer-end` on `setTimeout` fire; `timer-tick` on `setInterval` fire; `timer-clear` on `clearTimeout`/`clearInterval` |
| Event listeners | `addEventListener`, `removeEventListener` | `listener-add` (only inside a scope, and not `{once: true}`); `dom-event` on each event fire; `listener-remove` on `removeEventListener` |
| WebSocket | `WebSocket` | `request` on `new WebSocket()`; `response` on `open`; `message` on `message`; `close` on `close`; `error` on `error` |

A sentinel symbol (`Symbol.for("tw.patched")`) is checked before applying each patch to prevent double-patching during hot module replacement, which re-runs module initialisation in Vite and Webpack Dev Server.

**Native timer references** are captured at module load (`_nativeSetTimeout`, `_nativeSetInterval`, etc.) before any patching occurs. The reporter's periodic analysis timer uses these native references so the reporter does not instrument itself.

**Event listener allowlist.** The default event filter includes only events meaningful for race-condition analysis: `click`, `dblclick`, `submit`, `change`, `input`, `focus`, `blur`, `keydown`, `keyup`, `popstate`, `hashchange`, `beforeunload`, `visibilitychange`, `online`, `offline`, `error`, `unhandledrejection`. High-frequency events like `scroll`, `mousemove`, and `wheel` are excluded by default because they would swamp the ring buffer. Users can override the filter via `instrument({ events: { include: [...], exclude: [...] } })`.

**What `instrument()` does not emit.** The current auto-patcher **does not emit DOM read/write events** and **does not stamp sequence numbers on WebSocket messages**. Detectors that depend on those event types (`layout-thrash` and `sequence-gap`, respectively) therefore require manual `tw.pulse({ kind: "dom-write" })` / `tw.pulse({ kind: "dom-read" })` / `tw.pulse({ meta: { seq: N } })` calls from user code. This is discussed further in Section 5.

### 3.2 Call-site attribution

When an instrumented function is called, the system generates a stack trace via `Error.captureStackTrace` (V8) or `new Error().stack` (other engines). The stack is parsed line by line, skipping frames that reference PulsCheck's own source files (`instrument.ts`, `tw.ts`, `registry.ts`, `devMode.ts`, `scope.ts`, `reporter.ts`, or paths ending in `dist/index.`, `dist/react.`, `dist/testing.`) and skipping frames under `node_modules`.

The first user-code frame is parsed using two patterns:

- **Browser (Vite dev server):** `at useFaq (http://localhost:8080/src/hooks/useFaq.ts?t=abc:20:5)` → the `src/`-relative path and first line number are extracted.
- **Node.js / absolute paths:** `at func (/abs/path/src/file.ts:20:5)` → the path is normalised to a `src/`-relative form (or the basename, if no `src/` segment exists).

The resulting call-site string (e.g., `src/hooks/useFaq.ts:20`) is attached to the event and propagated through the analysis pipeline to the final finding report.

**Known fragility.** Stack trace formats vary across engines. The current implementation is validated against V8 (Node.js, Chrome) and Vite dev-server URL formats. Firefox and Safari-specific formats have not been tested. Production-minified code would produce meaningless locations, but PulsCheck is development-only and does not run in production builds.

### 3.3 Event model

Each recorded event is a `PulseEvent`:

```typescript
interface PulseEvent {
  label: string;            // e.g. "fetch:/api/users:start"
  lane: PulseLane;          // "ui" | "api" | "auth" | "ws" | "worker" | string
  beat: number;             // performance.now() timestamp
  ts: number;               // Date.now() wall clock
  public: boolean;          // true = opted into prod collection
  correlationId: string;    // links related events
  parentId?: string;        // links to an enclosing scope
  meta?: Record<string, unknown>;
  kind?: PulseKind;         // "request"|"response"|"error"|"timer-start"|...
  source?: PulseSource;     // "auto" | "manual" | "scope"
  callSite?: string;        // "src/hooks/useFaq.ts:20"
}
```

The `kind` field is the canonical classification. Detectors prefer `kind` and fall back to label-substring matching for manual pulses that do not set it.

**Ring buffer.** Events are stored in a fixed-size ring buffer implemented in `registry.ts`. The default capacity is 10,000 events. Insertion is O(1) via a write pointer that wraps modulo the capacity. When full, the oldest event is overwritten. The buffer exposes two iteration APIs: `trace` (allocates a sorted copy) and `forEach` (zero-alloc in-place iteration).

### 3.4 Correlation scopes

A scope (`scope.ts`) provides lifecycle-boundary tracking. Creating a scope pushes it onto a global stack and emits a `${name}:start` event with `kind: "scope-start"`. While the scope is on top of the stack, auto-instrumented events read it via `currentScope()` and stamp its `correlationId` as their `parentId`. Calling `scope.end()` emits a `${name}:teardown` event with `kind: "scope-end"` and pops the scope from the stack. Calling `scope.deactivate()` pops the scope without emitting teardown — used by the React integration so that asynchronous operations capture `parentId` during synchronous setup, then sibling components do not inherit the scope while it is still waiting for a later cleanup.

The `after-teardown` and `dangling-async` detectors both use this relationship: any event whose `parentId` matches a scope that has already emitted its teardown event is examined for race-condition shape.

### 3.5 Seven-pattern analyser

The analyser (`analyze.ts`) runs seven independent detectors against the ring-buffer contents. Each detector is described here with the **exact severity rules as implemented in the source**, not idealised rules.

#### Pattern 1: `after-teardown`

**Shape.** An event whose `parentId` matches a scope that has already emitted a teardown (`kind: "scope-end"` or a label matching one of `unmount`, `dispose`, `destroy`, `cleanup`, `close`, `disconnect`, `teardown`, `unsubscribe`, `detach`, `remove`).

**Severity.**

- `critical` if the late event is a render/state-write (`kind: "render"` or `kind: "state-write"`, or label matching `render`/`update`/`display`/`show`/`paint`/`setState`).
- `warning` otherwise.

**Recovery filter.** If a recovery-shaped event (label matching `reconnect`/`retry`/`recover`/`restart`/`resume`/`resubscribe`/`reattach`/`reopen`/`fallback`) appears after the teardown, any events *at or after* the recovery are excluded from the finding set. This prevents false positives where a deliberate reconnect handshake fires legitimate events after the original teardown.

**Empirical note.** In the current audit corpus, most `after-teardown` findings land at `warning` severity because the detected event is a `fetch:done`, `timer-fire`, or `timer-tick` — none of which are render events. In a real React application with state updates in the response handler, the resulting `setState`-after-unmount is more severe than the current severity assigns. See Section 5 for discussion.

#### Pattern 2: `response-reorder`

**Shape.** Two or more requests to the same normalised endpoint (paths with dynamic segments like `/user/123` are collapsed to `/user/:id`) whose responses arrive in a different order than the requests.

**Severity.**

- `critical` when **generation tracking confirms the stale response was the last to resolve**. Each fetch request increments a per-endpoint generation counter; the response stamps both its own generation and the latest generation for the endpoint. If the last response by beat has `generation < latestGeneration`, the application almost certainly consumed outdated data.
- `warning` otherwise. The responses arrived out of order but the final one is still the latest generation, so the application may have handled it correctly.

This sink-awareness adds approximately 25 lines of code in `instrument.ts` (a module-level `endpointGeneration` map, two helper functions, and the call-site integrations in the `fetch` patch) and zero runtime overhead beyond a `Map.get`/`Map.set` pair per request.

#### Pattern 3: `double-trigger`

**Shape.** The same normalised operation starts twice where the second start fires before the first's corresponding end event (`kind: "response"`, `timer-end`, `timer-clear`, `timer-tick`, `error`, or `listener-remove`).

**Severity.**

- `critical` if the two starts have **identical parameters** after removing instrumentation-internal fields (`generation`, `latestGeneration`). Typically indicates a missing debounce, loading guard, or mutex.
- `info` if the parameters differ. This is more often intentional concurrency (two different search queries) than a bug, so the finding is produced but downgraded.

**Generic timer special case.** Plain `setTimeout:start` and `setInterval:start` labels (i.e., timers called outside of a named scope and not targeting a specific endpoint) are flagged only when the two starts share the same `parentId` scope **or** the same `callSite`. This prevents false positives where unrelated parts of the application schedule timers around the same time — a normal occurrence in Vite HMR, React internals, and any codebase with multiple independent polling components.

#### Pattern 4: `sequence-gap`

**Shape.** Events that carry `meta.seq` as a numeric field, grouped by `(correlationId, label)`, with a gap of more than one in the sorted sequence numbers.

**Severity.** `critical`.

**Auto-instrumentation note.** The current `patchWebSocket()` implementation **does not stamp `meta.seq`** on WebSocket message events. For `sequence-gap` to fire, user code must either emit manual `tw.pulse(..., { meta: { seq: N } })` or write a custom WebSocket wrapper that adds the sequence numbers. This detector does not fire on any bug in the current audit corpus (Section 4).

#### Pattern 5: `stale-overwrite`

**Shape.** Two consecutive render events (`kind: "render"` or `kind: "state-write"`, or label matching render signals) on the same label-base, where the second render's originating request was sent *earlier* than the first's originating request.

**Severity.** `critical`.

**Auto-instrumentation note.** The current `instrument()` layer **does not emit render or state-write events**. For `stale-overwrite` to fire, user code must emit manual `tw.pulse(..., { kind: "render" })` or `tw.pulse(..., { kind: "state-write" })` pulses. This detector does not fire on any bug in the current audit corpus (Section 4). Most of the missed fetch-race bugs in the audit are shape-matched to `stale-overwrite`, but because only `fetch:start` and `fetch:done` pulses exist, the detector cannot correlate them to a render ordering.

#### Pattern 6: `dangling-async`

**Shape.** An operation start (`kind: "request"`, `timer-start`, `listener-add`) that has a `parentId` pointing to a scope that eventually emitted a teardown, where the operation started **before** the teardown and has no completion event on its own `correlationId`.

**Completion rules (per operation type).**

- `fetch:*` — needs `response` or `error`.
- `ws:*` (WebSocket handshake) — needs `response`, `error`, or `close`.
- `setInterval:*` — needs `timer-clear`. `timer-tick` alone does not count (ticks mean the interval is still running, i.e., still leaking).
- `setTimeout:*` — needs `timer-end` or `timer-clear`.
- `listener-add` — needs `listener-remove`.
- Generic with `kind` — any of `response`, `error`, `timer-end`, `timer-clear`, `listener-remove`, or `close`.

**Label-based fallback.** For manual pulses without an explicit `kind`, any event whose label's trailing segment matches one of `end`, `done`, `complete`, `cancel`, `abort`, `close`, `stop`, `finish`, `clear`, `remove`, `error`, `response`, `resolve`, `unsubscribe`, `disconnect` counts as completion for the `correlationId`.

**Severity.** `warning`.

#### Pattern 7: `layout-thrash`

**Shape.** Three or more consecutive DOM write→read cycles within a 16 ms window (one frame at 60 fps), where the events carry `kind: "dom-write"` or `kind: "dom-read"`.

**Severity.**

- `critical` if the frame contains 5 or more cycles.
- `warning` for 3 or 4 cycles.

**Auto-instrumentation note.** The current `instrument()` layer **does not emit DOM read/write events**. For `layout-thrash` to fire, user code must emit manual `tw.pulse(..., { kind: "dom-write", meta: { property: "..." } })` calls from the relevant read/write sites. A higher-level DOM wrapper or a `DocumentFragment`-based instrumentation is a possible future extension but is not present in the current code. This detector does not fire on any bug in the current audit corpus (Section 4).

### 3.6 Analyser control flow

`analyze(trace, opts?)` sorts the trace by beat once, runs all seven detectors (unless suppressed via `opts.suppress`), filters by minimum severity (`opts.minSeverity`, default `info`), applies any user-supplied `opts.filter` predicate, and returns findings sorted by severity (`critical` → `warning` → `info`) and then by beat.

### 3.7 Structural deduplication

Each finding is fingerprinted by `fingerprint(f)`:

```typescript
export function fingerprint(f: Finding): string {
  const labels = f.events.map(e => e.label).sort().join(",");
  const site = f.events.find(e => e.callSite)?.callSite;
  return site ? `${f.pattern}::${labels}::${site}` : `${f.pattern}::${labels}`;
}
```

This captures the structural shape of the bug independent of exact timing. The reporter maintains a set of already-reported fingerprints and suppresses findings that have already been reported in the current session, incrementing an occurrence counter for the suppressed finding.

### 3.8 Reporter

The reporter (`reporter.ts`) runs `analyze()` on a configurable interval (default 5 000 ms) via `_nativeSetInterval` (so it does not instrument itself). It supports:

- `intervalMs` — analysis interval (default 5 000 ms).
- `minSeverity` — minimum severity to surface (default `"warning"`).
- `suppress` — array of `FindingPattern` names to exclude entirely.
- `log` — custom logger function (default `console.warn`).
- `quiet` — suppress all output.

The reporter uses `fingerprint()` for session-scoped deduplication.

### 3.9 Static analysis CLI

In addition to the runtime detector, the package ships a static CLI (`cli.ts`) that scans source files using regular expressions. The CLI is regex-based, not AST-based, and has known false-positive classes (it will match patterns inside comments and string literals).

The CLI defines **9 patterns**:

| Rule | Default severity | Runtime detector mapping |
|---|---|---|
| `fetch-no-abort-in-effect` | critical | `after-teardown` |
| `setInterval-no-cleanup` | warning | `after-teardown` |
| `setTimeout-in-effect-no-clear` | warning | `after-teardown` |
| `concurrent-useQuery-same-table` | info | `double-trigger` |
| `async-onclick-no-guard` | warning | `double-trigger` |
| `websocket-no-reconnect-handler` | info | `sequence-gap` |
| `supabase-concurrent-queries` | info | `double-trigger` |
| `state-update-in-then` | warning | `after-teardown` |
| `promise-race-no-cancel` | info | `stale-overwrite` |

The CLI has three commands:

- `pulscheck scan [dir]` — text output by default.
- `pulscheck ci [dir]` — SARIF 2.1.0 by default, with `--fail-on` severity gate.
- `pulscheck help` / `pulscheck --version`.

`--format` supports `text`, `json`, and `sarif`. The SARIF output integrates with GitHub Code Scanning.

The static CLI and runtime detector are complementary. The CLI flags structural patterns pre-merge without running the code; the runtime detector catches temporal bugs that only manifest during execution.

---

## 4. Evaluation

### 4.1 Audit corpus

We constructed a corpus of **77 documented race-condition bugs** sourced from GitHub issues across **71 distinct open-source repositories**. Each bug is implemented as a vitest test case that:

1. Installs a real `fetch`/`setTimeout`/`addEventListener` replacement (for example, `installFakeFetch()` installs a fetch implementation that resolves after a configurable delay using the *native* captured `_nativeSetTimeout`).
2. Calls `instrument()` to patch the globals.
3. Replays the shape of the documented bug (e.g., mount a component scope, fire the offending async call, then end the scope).
4. Calls `analyze(tw.trace)` and records the resulting `findings` array.
5. Classifies the bug as `DETECTED` if any finding has severity `critical` or `warning`; as `MISSED` otherwise (including findings of severity `info`).
6. Writes per-file summary JSON to `packages/core/.real-*.json`.

No test emits synthetic `tw.pulse()` events. Every event in the analysed trace is produced by `instrument()` intercepting real global calls.

The corpus is distributed across four test files:

| Test file | Category | Bugs |
|---|---|---|
| `src/__tests__/real-audit-fetch.test.ts` | Fetch races | 25 |
| `src/__tests__/real-audit-timers.test.ts` | Timer leaks | 25 |
| `src/__tests__/real-audit-listeners.test.ts` | Listener leaks | 20 |
| `src/__tests__/real-code-audit.test.ts` | Mixed real-code | 7 |
| **Total** | | **77** |

There are no other test files in `packages/core/src/__tests__/`. The audit corpus **is** the test suite — there are no separate unit tests for each detector.

### 4.2 Overall detection rate

From the four JSON result files (all generated on 2026-04-14, reproducible by running `pnpm test` in `packages/core`):

| Test file | Total | Detected | Missed | Rate |
|---|---|---|---|---|
| Fetch race audit | 25 | 16 | 9 | **64.0%** |
| Timer leak audit | 25 | 25 | 0 | **100.0%** |
| Listener leak audit | 20 | 20 | 0 | **100.0%** |
| Real-code audit | 7 | 5 | 2 | **71.4%** |
| **Aggregate** | **77** | **66** | **11** | **85.7%** |

The headline **85.7%** is driven by the two 100% categories. The fetch category is substantially weaker at 64%, and the real-code category is small enough (7) that its 71.4% rate is not statistically meaningful on its own.

### 4.3 Per-detector coverage of the audit corpus

For each detector, we count how many of the 77 bugs produced at least one finding with severity `critical` or `warning` from that detector:

| Detector | Bugs flagged (of 77) | Share |
|---|---|---|
| `after-teardown` | 44 | 57% |
| `double-trigger` | 21 | 27% |
| `dangling-async` | 20 | 26% |
| `response-reorder` | 1 | 1% |
| `sequence-gap` | 0 | **0%** |
| `stale-overwrite` | 0 | **0%** |
| `layout-thrash` | 0 | **0%** |

(Bugs are double-counted across rows when multiple detectors fire on the same bug — e.g., a timer leak commonly fires both `after-teardown` and `dangling-async`.)

**Three of the seven detectors do not fire on any bug in the current audit corpus.** The reasons are structural, not statistical:

- **`sequence-gap`** requires events with `meta.seq` stamped. The current `instrument()` layer does not stamp sequence numbers on WebSocket messages. There is no test in the audit corpus that manually stamps `meta.seq`.
- **`stale-overwrite`** requires render or state-write events. The current `instrument()` layer does not emit them from a `fetch` patch alone. There is no test that manually emits render pulses.
- **`layout-thrash`** requires events with `kind: "dom-write"` and `kind: "dom-read"`. The current `instrument()` layer does not patch DOM-layout-triggering properties. There is no test that manually emits DOM read/write pulses.

These three detectors are therefore **unvalidated by the current evaluation**. The code exists and has been unit-reviewed, but no real-world bug in the audit corpus exercises any of them. Any claim that "PulsCheck has seven working detectors" should be read with this caveat.

Separately, **`response-reorder`** fires on only **one** bug (`BUG-54`, contentful/contentful.js #1634, paginated `getEntries` where old query pages overwrite new results). This is the full set of response-reorder wins in the current corpus. The detector is implemented and the generation-tracking logic functions correctly, but the coverage is thin.

The meaningful coverage on this audit comes from three detectors: `after-teardown`, `double-trigger`, and `dangling-async`.

### 4.4 Missed bugs

All 11 misses, enumerated:

| ID | Repo | Bug | Category |
|---|---|---|---|
| BUG-33 | vercel/swr | stale-while-revalidate: old key fetch overwrites new key data | stale-overwrite |
| BUG-36 | TanStack/query | Mutation response overwrites refetch's fresh data | stale-overwrite |
| BUG-37 | apollographql/apollo-client | refetchQueries from multiple mutations overlap — stale cache write | stale-overwrite |
| BUG-38 | trpc/trpc | Stale refetch overwrites optimistic mutation update | stale-overwrite |
| BUG-39 | urql-graphql/urql | Query response overwrites newer subscription update | stale-overwrite |
| BUG-41 | axios/axios | CancelToken doesn't prevent response handler from running | stale-overwrite / guard |
| BUG-47 | react-hook-form/react-hook-form | Async validation fetch races with form submit | stale-overwrite |
| BUG-48 | formik/formik | Async field validations overlap — stale errors overwrite fresh | stale-overwrite |
| BUG-50 | gatsbyjs/gatsby | Hydration fetch resolves after client render — stale flash | stale-overwrite |
| BUG-4 | OWASP/Nest | Async fetch loop with no cancellation — stale overwrite | stale-overwrite |
| BUG-5 | pmndrs/zustand | Async setState after conditional unmount via store subscription | after-teardown (missed) |

**Nine of the eleven misses are stale-overwrite-shaped fetch races.** The `stale-overwrite` detector is designed for these, but it requires render events that `instrument()` does not emit. From fetch instrumentation alone, the analyser cannot tell which response the application actually consumed. BUG-41 (axios CancelToken) is also stale-overwrite-shaped, but its test records a `double-trigger` with `info` severity — demoted to `info` because the fetch parameters differ, and `info` findings are classified as MISSED by the audit scorer.

The one after-teardown miss (BUG-5, zustand) is an edge case where the teardown is gated on a conditional, and the current parent-id propagation does not link the async setState back to the unmounted subscription's scope.

**The weakness of the fetch category is concentrated in one pattern shape.** If the audit corpus were rerun with manual render-event emission on the fetch completion sites, most of these bugs would likely be caught by `stale-overwrite` — but that is a hypothesis, not a measurement, and we have not run it.

### 4.5 Repo distribution

The 71 unique repositories in the corpus span:

- Meta-frameworks: `vercel/next.js`, `nuxt/nuxt`, `sveltejs/kit`, `remix-run/remix`, `gatsbyjs/gatsby`, `redwoodjs/redwood`, `blitz-js/blitz`, `solidjs/solid-start`.
- React core & internals: `facebook/react`, `facebook/lexical`.
- Query libraries: `TanStack/query`, `tanstack/router`, `vercel/swr`, `apollographql/apollo-client`, `urql-graphql/urql`, `trpc/trpc`, `reduxjs/redux-toolkit`.
- UI libraries: `mui/material-ui`, `chakra-ui/chakra-ui`, `ant-design/ant-design`, `mantinedev/mantine`, `radix-ui/primitives`, `tailwindlabs/headlessui`, `floating-ui/floating-ui`, `downshift-js/downshift`, `react-hot-toast/react-hot-toast`, `notistack/notistack`, `fkhadra/react-toastify`, `JedWatson/react-select`, `react-dropzone/react-dropzone`.
- DnD and gestures: `atlassian/react-beautiful-dnd`, `clauderic/dnd-kit`, `framer/motion`.
- Charts, calendars, visualisations: `recharts/recharts`, `fullcalendar/fullcalendar`, `xyflow/xyflow`, `pmndrs/drei`, `excalidraw/excalidraw`.
- Virtualisation and layout: `TanStack/virtual`, `bvaughn/react-window`, `react-grid-layout/react-grid-layout`.
- Editors: `ueberdosis/tiptap`, `ianstormtaylor/slate`.
- Backends & SDKs: `supabase/supabase-js`, `supabase/realtime-js`, `firebase/firebase-js-sdk`, `pocketbase/js-sdk`, `sanity-io/client`, `contentful/contentful.js`, `directus/directus`.
- Dev tools & infra: `vitejs/vite`, `cypress-io/cypress`, `ionic-team/ionic-framework`, `axios/axios`, `sindresorhus/ky`, `grafana/grafana`, `elastic/kibana`, `nextcloud/server`, `mattermost/mattermost-webapp`, `jitsi/jitsi-meet`, `calcom/cal.com`, `storyblok/storyblok-react`, `streamich/react-use`, `alibaba/hooks`, `pmndrs/zustand`, `DevExpress/devextreme-reactive`, `RocketChat/Rocket.Chat`, `VolvoxCommunity/sobers`, `OWASP/Nest`, `react-hook-form/react-hook-form`, `formik/formik`.

The full list is in `packages/core/.real-*.json`.

### 4.6 What this evaluation does not measure

- **False positive rate on non-buggy code.** Every test in the audit corpus is designed to contain a race condition. We do not have a test suite of known-correct code against which to measure how often PulsCheck fires spuriously. This is the single most important gap in the evaluation.
- **Real browsers.** The audit runs under Node.js with a substituted `fetch`. Browser-specific concerns — real network jitter, Firefox/Safari stack trace formats, real `WebSocket` connections, real DOM measurements — are not tested.
- **Developer time-to-fix.** The evaluation measures whether PulsCheck *detects* bugs, not whether the detection helps developers fix them faster than discovering the bug through user reports or QA.
- **Long-running application scenarios.** Tests run for milliseconds. Memory growth under hours-long dev sessions, ring-buffer saturation patterns, and reporter noise levels under realistic activity are not measured.
- **Concurrent library coverage overlap.** If a codebase uses TanStack Query or SWR correctly, the library itself prevents most of the races in the fetch category. PulsCheck's value on such codebases may be closer to zero than the audit rate suggests.

---

## 5. Discussion

### 5.1 The severity scheme is conservative for fetch races

In the current implementation, `after-teardown` severity is `critical` only when the late event is a render or state-write. Most auto-instrumented fetch completions land as `warning` because `fetch:done` is neither. In a real React application, a `fetch:done` followed by a `setState` in an unmounted component is the classical "setState on unmounted component" bug, which React treats as a development-time warning and which can leak memory in production.

The audit scorer classifies any `warning` finding as DETECTED, so the 85.7% headline absorbs this. But a reader who takes the number at face value should know that many of the "detected" bugs produced `warning` findings rather than `critical` ones. A stricter scorer that required `critical` would report a lower rate.

One principled fix is to emit `kind: "state-write"` from the React integration when it can detect a state update in scope. That would upgrade many fetch-bug findings to `critical`. This change is a candidate for future work; it is not in the current release.

### 5.2 Three detectors depend on instrumentation we have not written

`sequence-gap`, `stale-overwrite`, and `layout-thrash` are all implemented in `analyze.ts`, and all three work correctly on manually-constructed event streams. What they are missing is the *emitter side*: `instrument()` does not stamp `meta.seq` on WebSocket messages, does not emit render events from fetch completions, and does not wrap DOM layout-triggering property accessors.

These are separate pieces of engineering, each with its own design decisions:

- **`meta.seq` for WebSocket** would require either a wire-protocol convention the user opts into or an application-level frame-counter. Neither is universal.
- **Render events** would require either a React integration deep enough to observe state updates (a hooks-level wrapper around `useState`/`useReducer`) or a user-level `tw.pulse({ kind: "render" })` in their render-side code.
- **DOM layout tracking** would require wrapping `Element.prototype` getters and setters — a heavy patch that affects every DOM access and would not be free at runtime.

All three are plausible future extensions, and all three would convert the currently-unvalidated detectors into detectors that have real-bug audit coverage. But **as of the current release, three of the seven detectors are not exercised by any real-world bug in the audit corpus**, and the claim "PulsCheck has seven detectors" is most defensibly stated as "PulsCheck has seven detectors, four of which fire on the current audit corpus."

### 5.3 The CLI is a lightweight supplement, not a primary tool

The static CLI uses regular expressions, not an AST parser. It will produce false matches on patterns inside string literals, inside commented-out code, and in non-standard formatting. It is fast (a 50-file project scans in under 10 ms in informal testing) and produces SARIF for GitHub Code Scanning, which makes it a reasonable CI gate for obviously-unsafe patterns, but it is not a replacement for the runtime detector and should not be treated as one.

### 5.4 Open questions

These questions cannot be answered by the evaluation in this paper. They require real-world usage across diverse projects and teams.

1. **Does the false-positive rate make PulsCheck usable in large codebases?** Every bug in our audit was designed to contain a race condition, so the FP rate in the audit is zero by construction. In a real codebase where many concurrent operations are intentional, the rate could be much higher. If it is high enough that developers start ignoring PulsCheck output, the tool has negative value.
2. **Does detection translate into fixes?** PulsCheck reports the pattern and a generic fix suggestion. For unfamiliar patterns (e.g., `response-reorder` with generation tracking), the report may be harder to act on than finding the bug via user reports. We do not have data on time-to-fix.
3. **How much overlap is there with query libraries?** A team using TanStack Query correctly has most of these races prevented at the library layer. PulsCheck's value on such teams may be limited to detecting misuse or raw `fetch` calls outside the query library.
4. **Will the per-detector coverage shift with a non-curated corpus?** Our 77-bug corpus was selected for pattern diversity and is biased toward teardown/lifecycle bugs. A random sample of real bug reports might shift the per-pattern distribution substantially.
5. **Does the runtime overhead matter on complex apps?** Call-site capture costs a few microseconds per intercepted call. Ring-buffer writes cost O(1). Neither is noticeable on the audit micro-benchmarks. On a real dev session with many thousands of events per second, the cost is unmeasured.

### 5.5 Comparison with existing approaches

| Tool | Detects temporal bugs | Source attribution | Zero config | No external infrastructure |
|---|---|---|---|---|
| TypeScript | No | N/A | Yes | Yes |
| ESLint (incl. `react-hooks`) | Structural only | N/A | Yes (rule config) | Yes |
| Chrome DevTools Performance | Manual inspection only | Partial | Yes | Yes |
| Sentry / LogRocket | Thrown errors only | Yes (stack trace) | No | No |
| TanStack Query / SWR | Prevents (inside library) | N/A | No | Yes |
| EventRacer [3] | Yes | No | No | Requires record-and-replay |
| **PulsCheck** | **Yes (heuristic, runtime)** | **Yes (file:line)** | **Yes (`devMode()`)** | **Yes (in-process patching)** |

---

## 6. Conclusion

PulsCheck detects 66 of 77 documented asynchronous race-condition bugs (85.7%) in a corpus drawn from 71 open-source repositories. The detection is strong on timer leaks (100%) and listener leaks (100%), moderate on mixed real-code (71.4%), and notably weaker on fetch races (64%). Four of the seven detectors carry the detection rate; three others are implemented but not exercised by any bug in the current audit, because they depend on event types that the auto-instrumentation layer does not yet emit.

We release PulsCheck as an open-source tool specifically to enable the validation that this paper cannot perform: false-positive rates on non-buggy codebases, time-to-fix outcomes in real development workflows, and coverage on application architectures not represented in our corpus. The architecture, source, audit scripts, and JSON result files are all in the repository, and the 85.7% / 64% / 100% split can be reproduced by running `pnpm test` in `packages/core`.

If the tool proves genuinely useful in these validations, the approach merits further investment, starting with emitter-side work that would unblock the three currently-unvalidated detectors. If it does not, the architecture and evaluation methodology documented here may still inform future work on temporal correctness in frontend applications.

The source is available at https://github.com/Qubites/pulscheck under the Apache 2.0 license.

---

## References

[1] Savage, S., Burrows, M., Nelson, G., Sobalvarro, P., & Anderson, T. (1997). *Eraser: A Dynamic Data Race Detector for Multithreaded Programs.* ACM Transactions on Computer Systems, 15(4), 391–411.

[2] Serebryany, K., & Iskhodzhanov, T. (2009). *ThreadSanitizer: Data Race Detection in Practice.* Workshop on Binary Instrumentation and Applications (WBIA), co-located with MICRO.

[3] Raychev, V., Vechev, M., & Sridharan, M. (2013). *Effective Race Detection for Event-Driven Programs.* ACM SIGPLAN International Conference on Object-Oriented Programming, Systems, Languages, and Applications (OOPSLA). The system described in the paper is widely referred to as EventRacer.

[4] Davis, J. C., Thekumparampil, A., & Lee, D. (2017). *Node.fz: Fuzzing the Server-Side Event-Driven Architecture.* European Conference on Computer Systems (EuroSys).

---

## Appendix A — Reproducibility

All audit numbers in this paper come from four JSON files committed to the repository:

- `packages/core/.real-audit-fetch.json`
- `packages/core/.real-audit-timers.json`
- `packages/core/.real-audit-listeners.json`
- `packages/core/.real-code-audit.json`

To regenerate them:

```bash
cd packages/core
pnpm install
pnpm test
```

The files are rewritten on every run. Each contains a `summary` object with `total`, `detected`, `missed`, and `rate`, and a `results` array with one entry per bug including the matched findings.

All detector implementations are in `packages/core/src/analyze.ts`. All auto-instrumentation is in `packages/core/src/instrument.ts`. The ring buffer is in `packages/core/src/registry.ts`. The reporter is in `packages/core/src/reporter.ts`. The CLI is in `packages/core/src/cli.ts`. There is no hidden code path; if a claim in this paper is not backed by one of these files or by one of the JSON result files, that is a bug in the paper and should be reported.
