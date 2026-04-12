# PulsCheck: Automatic Runtime Detection of Asynchronous Race Conditions in Frontend Applications via Global Function Interception and Call Site Attribution

**Oliver Nordsve**
Qubites · Norway
April 2026

---

## Abstract

Modern frontend applications rely heavily on asynchronous operations — network requests, timers, event listeners, and persistent connections — that execute concurrently and interact through shared mutable state. Race conditions arising from these interactions are invisible to static analysis, type checkers, linters, and AI code review tools, as they manifest only at specific runtime moments. We present PulsCheck, a zero-configuration runtime detection system that intercepts asynchronous primitives at the JavaScript global function level, records timestamped events with source code location attribution, and applies five heuristic pattern detectors to identify race conditions as they occur. In preliminary evaluation on one production application and 15 externally-sourced scenarios, the system detected previously unknown race conditions and achieved 80% detection coverage. These results are encouraging but narrow — we do not yet know whether the approach generalises across diverse codebases, whether the false positive rate is acceptable in daily development, or whether the findings save meaningful developer time. This paper describes the architecture, presents initial results, and identifies the open questions that real-world usage must answer before any stronger claims can be made.

**Keywords:** race condition detection, asynchronous programming, runtime analysis, frontend development, monkey-patching, call site attribution

---

## 1. Introduction

The shift to asynchronous, event-driven frontend architectures has introduced a class of bugs that existing developer tooling cannot detect. When a user types a search query, the application may fire multiple fetch requests concurrently. If the responses arrive in a different order than the requests were sent, the user interface displays stale data — not because any individual function is incorrect, but because the temporal relationship between two correct functions produces an incorrect outcome.

These temporal bugs share a common property: they are invisible to every tool that analyses code as a static snapshot. TypeScript verifies types. ESLint enforces patterns. AI code review tools examine structure. None of these tools model execution time. A race condition between two `fetch()` calls on line 20 and line 36 of the same file passes every check — the types are correct, the patterns are standard, and the code reads well. The bug exists only in the 0.7 milliseconds between two function calls that happen to execute concurrently.

The problem may be amplified by the rise of AI-assisted code generation. Tools such as GitHub Copilot, Cursor, and Claude Code generate asynchronous code that passes type checks and linting, but these tools have no model of the temporal context in which the generated code will execute — specifically, what other asynchronous operations are already in flight at the point of insertion. Whether AI-generated code produces race conditions at a higher rate than manually written code is an open empirical question that has not been studied. What is clear is that no existing tool in the AI-assisted development workflow validates temporal correctness.

We present PulsCheck, a runtime detection system that addresses this gap. PulsCheck operates by intercepting standard asynchronous primitives (fetch, setTimeout, setInterval, clearTimeout, clearInterval, addEventListener, WebSocket) at the global function level, recording each intercepted call as a timestamped event with its originating source code location, and applying five heuristic pattern detectors to the event stream. When a race condition is detected, the system reports the specific pattern, the severity, the source file and line number of both conflicting operations, and a concrete fix suggestion.

The contributions of this paper are:

1. A zero-configuration auto-instrumentation technique that intercepts asynchronous primitives without requiring source code modification beyond a single activation call
2. A call site attribution method that extracts source code locations from stack traces in both browser and Node.js environments
3. Five heuristic race condition detection patterns (after-teardown, response-reorder, double-trigger, sequence-gap, stale-overwrite) operating on a ring buffer event stream
4. URL-aware operation labelling that prevents false positive grouping of unrelated concurrent operations
5. A structural fingerprinting scheme for deduplicating repeated occurrences of the same race condition
6. A per-endpoint generation counter for sink-awareness that distinguishes benign response reordering (warning) from stale data that was last to resolve and thus consumed by the application (critical)
7. A blind audit methodology using 15 externally-sourced race condition scenarios demonstrating 80% detection rate
8. A companion static analysis CLI that detects 9 structural race condition patterns in source code for CI pipeline integration

---

## 2. Related Work

**Static analysis.** Tools such as ESLint, TypeScript, and Semgrep operate on the abstract syntax tree of source code. While effective for structural bugs, they cannot model runtime timing. Recent work on async/await linting rules (e.g., `no-floating-promises`) catches a narrow subset of concurrency issues — unawaited promises — but cannot detect conflicts between correctly-awaited operations that execute concurrently.

**Browser developer tools.** Chrome DevTools provides the Performance panel for CPU profiling and the Network panel for request timing. These tools record execution but do not analyse it for race conditions. The developer must manually identify temporal conflicts from flame charts and waterfall diagrams.

**Error monitoring.** Services such as Sentry, Datadog, and LogRocket capture errors that throw exceptions. Race conditions that produce incorrect state without throwing — such as a stale API response overwriting fresh data — are invisible to these tools because no error occurs.

**Distributed tracing.** OpenTelemetry and Jaeger trace requests across service boundaries. They operate at the service level, not the source code level, and do not attribute trace spans to specific file and line positions within a single application.

**Academic race detection.** The literature on race condition detection has focused primarily on multi-threaded systems with shared memory. Eraser [Savage et al. 1997] detects data races via lockset analysis. ThreadSanitizer [Serebryany & Iskhodzhanov 2009] uses compile-time instrumentation for happens-before analysis. These approaches target thread-level concurrency and are not applicable to single-threaded, event-loop-based JavaScript applications where concurrency arises from asynchronous callbacks rather than parallel threads.

**JavaScript-specific approaches.** EventRacer [Raychev et al. 2013] analyses event handler interleavings in web applications through record-and-replay techniques. NodeRacer [Davis et al. 2017] detects races in Node.js by analysing the event loop schedule. Both require specialised runtime environments or instrumentation infrastructure. PulsCheck differs by operating within the application's own JavaScript context through monkey-patching, requiring no external infrastructure.

---

## 3. System Architecture

PulsCheck comprises five components arranged in a pipeline:

```
┌─────────────┐    ┌──────────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
│ Instrument   │───▶│ Ring Buffer  │───▶│ Analyser  │───▶│ Dedup    │───▶│ Reporter │
│ (6 patches)  │    │ (10k events) │    │ (5 patterns)│   │ (fingerprint)│ │ (console)│
└─────────────┘    └──────────────┘    └───────────┘    └──────────┘    └──────────┘
       │
       ▼
 ┌─────────────┐
 │ Call Site    │
 │ Capture     │
 └─────────────┘
```

### 3.1 Auto-Instrumentation

The instrumentation layer replaces six categories of global functions with instrumented versions. Each replacement function:

1. Captures the call site from the current stack trace
2. Emits a timestamped event to the ring buffer
3. Delegates to the original function
4. Emits a completion event when the asynchronous operation resolves

For network requests (`fetch`), the URL pathname is extracted and incorporated into the event label. A fetch to `/api/users` produces events labelled `fetch:/api/users:start` and `fetch:/api/users:done`, ensuring that concurrent requests to different endpoints are not falsely grouped.

For timers (`setTimeout`, `setInterval`), the returned timer ID is stored in a tracking map alongside the event's correlation identifier. When a timer cancellation function (`clearTimeout`, `clearInterval`) is called, the correlation identifier is retrieved from the map and a correlated cancellation event is emitted.

To prevent the system from instrumenting its own internal timers (used by the reporter for periodic analysis), references to the native (unpatched) timer functions are captured at module initialisation before any patching occurs.

A sentinel symbol (`Symbol.for("tw.patched")`) is checked before applying each patch to prevent double-patching during hot module replacement, a common development workflow in modern frontend toolchains.

### 3.2 Call Site Attribution

When an instrumented function is called, the system generates a stack trace via `Error.captureStackTrace` (V8) or `new Error().stack` (other engines). The stack is parsed line by line, skipping frames originating from the instrumentation system. The first frame from user code is parsed using environment-specific patterns:

- **Browser (Vite dev server):** Frames contain URLs of the form `http://localhost:8080/src/hooks/useFaq.ts?t=abc:20:5`. The path after the host and before the query string is extracted as the source file, and the subsequent number as the line.
- **Node.js:** Frames contain filesystem paths of the form `/abs/path/src/hooks/useFaq.ts:20:5`. The path is shortened to a source-relative form.

The resulting call site string (e.g., `src/hooks/useFaq.ts:20`) is attached to the event and propagated through the analysis pipeline to the final finding report.

### 3.3 Event Model

Each recorded event contains:

| Field | Type | Description |
|-------|------|-------------|
| label | string | Operation identifier including endpoint, e.g., `fetch:/api/users:start` |
| lane | string | Execution category: `api`, `ui`, `ws`, `worker`, or custom |
| beat | number | High-resolution timestamp via `performance.now()` |
| ts | number | Wall-clock timestamp via `Date.now()` |
| correlationId | string | Links related events (e.g., request and its response) |
| parentId | string? | Links to a correlation scope for lifecycle tracking |
| callSite | string? | Source file and line number, e.g., `src/hooks/useFaq.ts:20` |
| kind | string? | Structured classification: `request`, `response`, `timer-start`, `timer-end`, etc. |
| meta | object? | Operation-specific metadata (URL, HTTP method, timer delay, etc.) |

Events are stored in a ring buffer with a default capacity of 10,000 entries. The buffer uses O(1) insertion by maintaining a write pointer that wraps to zero when capacity is reached, overwriting the oldest events.

### 3.4 Correlation Scopes

A correlation scope provides lifecycle boundary tracking. When a scope is created, a start event is emitted and a correlation identifier is stored. All auto-instrumented events that fire while the scope is active receive the scope's correlation identifier as their `parentId`. When the scope is ended (e.g., on React component unmount), a teardown event is emitted.

The after-teardown detector uses this relationship: any event whose `parentId` matches a scope that has already emitted its teardown event is flagged as a potential race condition.

### 3.5 Five-Pattern Analyser

The analyser runs five independent detectors against the ring buffer contents:

**Pattern 1: After-Teardown.** For each scope teardown event, the detector searches for subsequent events whose `parentId` matches the ended scope. These events represent asynchronous operations that fired after their originating context was destroyed — a common source of "setState on unmounted component" errors in React applications.

**Pattern 2: Response-Reorder.** The detector groups request events by their base label (e.g., `fetch:/api/search`) and checks whether corresponding response events arrived in the same order. If requests were sent at beats [100, 105] but responses arrived at beats [200, 195], the detector reports a response-reorder finding. This pattern detects the classic "stale search results" bug where a slower, older query's results overwrite a faster, newer query's results.

**Pattern 3: Double-Trigger.** The detector identifies pairs of start events with matching labels where the second fires before the first's corresponding end event. For the finding to be reported, both events must target the same operation (same label). The detector uses convention-based matching to identify end events: labels containing "end", "complete", "response", "done", "fire", "clear", or "tick".

**Pattern 4: Sequence-Gap.** The detector examines events carrying sequential metadata (`meta.seq`) and identifies missing entries in the sequence. This is primarily relevant for WebSocket message streams where dropped messages indicate a connection issue.

**Pattern 5: Stale-Overwrite.** The detector identifies cases where a response from an older request arrives after a response from a newer request to the same endpoint, indicating that the older response may overwrite fresher data in the application state.

### 3.6 Generation Tracking (Sink-Awareness)

A response-reorder finding alone does not distinguish two different severity levels: (a) responses arrived out of order but the application consumed the correct (newer) one, and (b) the stale response was the last to resolve and thus the application consumed outdated data. The latter is strictly more severe — it means the user is looking at wrong data with no visible error.

To discriminate these cases, the instrumentation layer maintains a per-endpoint generation counter. Each outgoing request increments the counter and stamps the current generation number on the request event. When the response arrives, the system stamps both the request's generation and the current latest generation for that endpoint:

```typescript
// On request
const gen = nextGeneration(endpoint);  // e.g., 3
meta.generation = gen;

// On response
meta.generation = gen;                  // 3 (this request)
meta.latestGeneration = currentGeneration(endpoint);  // 4 (a newer request fired)
```

The response-reorder detector then checks whether the stale response (lower generation) was the last to resolve. If `generation < latestGeneration` for the final response in temporal order, the finding is elevated from "warning" to "critical".

This adds 33 lines of code and zero runtime overhead beyond the counter increment. It does not require Babel plugins, React internals, or framework-specific hooks — it operates entirely within the existing global function interception layer.

### 3.7 Static Analysis CLI

In addition to the runtime detector, PulsCheck includes a static analysis CLI (`pulscheck scan`) that detects 9 structural patterns commonly associated with race conditions:

1. `fetch-no-abort-in-effect` — fetch inside useEffect without AbortController
2. `setInterval-no-cleanup` — setInterval without cleanup return
3. `setTimeout-in-effect-no-clear` — setTimeout inside useEffect without clearTimeout
4. `concurrent-useQuery-same-table` — multiple useQuery hooks on same page
5. `async-onclick-no-guard` — async onClick without loading guard
6. `websocket-no-reconnect-handler` — WebSocket without reconnect handling
7. `supabase-concurrent-queries` — concurrent Supabase queries to same table
8. `state-update-in-then` — setState inside .then() chain
9. `promise-race-no-cancel` — Promise.race without cancellation

The CLI outputs in text, JSON, or SARIF 2.1.0 format. The SARIF output integrates with GitHub Code Scanning for automated PR review. A companion GitHub Action (`pulscheck/action`) wraps the CLI for zero-configuration CI integration.

The static scanner and runtime detector are complementary: the static scanner catches structural patterns pre-merge, while the runtime detector catches temporal bugs that only manifest during execution.

### 3.8 Structural Deduplication

Each finding is fingerprinted by concatenating the pattern name with a sorted, comma-separated list of event labels involved:

```
double-trigger::fetch:/rest/v1/faq_entries:done,fetch:/rest/v1/faq_entries:start
```

This fingerprint captures the structural shape of the bug independent of timing. The reporter maintains a set of reported fingerprints and suppresses findings that have already been reported, incrementing an occurrence counter for the suppressed finding.

---

## 4. Evaluation

### 4.1 Production Application

We evaluated PulsCheck on a production web application: a Danish windshield repair quote engine built with React 18, Vite, TypeScript, and Supabase. The application includes dynamic FAQ loading, license plate lookup, AI-assisted pricing, and real-time chat. PulsCheck was activated by adding two lines to the application's entry point:

```typescript
import { devMode } from "pulscheck";
if (import.meta.env.DEV) devMode();
```

No other modifications were made to the application's source code.

### 4.2 Findings

On first page load, without any user interaction, PulsCheck detected two race conditions:

**Finding 1 — Double-Trigger (Critical)**

```
"fetch:/rest/v1/faq_entries:start" triggered twice concurrently
  Started at beat 135.20 and again at 135.50 — 0.3ms apart
  First completed at beat 706.80
  Locations:
    → src/hooks/useFaq.ts:20
    → src/hooks/useFaq.ts:36
```

Two separate code paths in the same file both initiated a fetch to the FAQ entries endpoint on component mount. The fetches were 0.3ms apart, both targeting the same Supabase endpoint with identical parameters.

**Finding 2 — Response-Reorder (Warning)**

```
Responses for "fetch:/rest/v1/faq_entries" arrived out of request order
  Requests sent: [cid_8, cid_9]
  Responses arrived: [cid_9, cid_8]
  Locations:
    → src/hooks/useFaq.ts:20
    → src/hooks/useFaq.ts:36
```

Because two identical requests were in flight simultaneously, the server processed them with slightly different latencies. The second request's response arrived before the first's, meaning the application's final state reflected the first (older) response rather than the second (newer) one.

Both findings were previously unknown to the development team.

### 4.3 Blind Audit (External Source Validation)

To validate that the detection patterns generalise beyond the development team's own test cases, we conducted a blind audit using 15 race condition scenarios sourced entirely from external publications (blog posts, conference talks, GitHub issues, and Stack Overflow answers). Each scenario was implemented as an isolated test that replays the described race pattern through PulsCheck's auto-instrumentation layer.

| ID | Source Pattern | Expected Detector | Detected | Severity |
|----|---------------|-------------------|----------|----------|
| BLIND-01 | Search typeahead reorder | response-reorder | Yes | critical |
| BLIND-02 | Unmount during fetch | after-teardown | Yes | critical |
| BLIND-03 | Double-click submit | double-trigger | Yes | critical |
| BLIND-04 | Three concurrent fetches | response-reorder | Yes | warning |
| BLIND-05 | Debounce not cancelling prev fetch | response-reorder | Yes | critical |
| BLIND-06 | Polling during tab switch | after-teardown | Yes | critical |
| BLIND-07 | Paginated fetch on fast navigation | response-reorder | Yes | critical |
| BLIND-08 | Autocomplete with slow API | response-reorder | Yes | critical |
| BLIND-09 | Auth token refresh race | double-trigger | Yes | critical |
| BLIND-10 | WebSocket reconnect gap | sequence-gap | No (expected) | — |
| BLIND-11 | Optimistic update conflict | stale-overwrite | No (expected) | — |
| BLIND-12 | Rapid pagination | response-reorder | Yes | critical |
| BLIND-13 | StrictMode double effect | double-trigger | Yes | critical |
| BLIND-14 | Mixed success/error responses | response-reorder | No | — |
| BLIND-15 | False positive: independent endpoints | (none) | Correct | — |

**Results:** 12 of 15 detected (80%). Two expected misses (BLIND-10 and BLIND-11 require stateful protocol tracking and optimistic update awareness respectively, which are outside PulsCheck's current detector scope). One unexpected miss (BLIND-14) represents a gap in mixed success/error response handling. The false positive test (BLIND-15) correctly produced no findings.

The generation tracking upgrade (Section 3.6) elevated four findings (BLIND-01, -05, -08, -13) from "warning" to "critical" by confirming that the stale response was the last to resolve — a measurable improvement in severity accuracy.

### 4.4 Live Application Scan (Before/After Fix)

To validate end-to-end effectiveness, we scanned a production React application (23 API routes, Supabase backend) using Playwright injection before and after applying fixes. PulsCheck was injected into the running browser via `page.addInitScript()` and findings were collected after automated page navigation.

**Before fixes:** 3 findings across 2 endpoints (1 double-trigger critical, 1 response-reorder critical, 1 response-reorder warning).

**After fixes:** 0 findings. The fixes involved combining duplicate query hooks and adding interval guards to prevent concurrent analysis operations.

This demonstrates that PulsCheck findings are actionable: the detection → fix → re-scan cycle produces a measurable reduction to zero.

### 4.5 Race-Bug-Zoo (Live Browser Validation)

We constructed a standalone React application containing 7 intentionally planted race condition bugs sourced from published blog posts and conference talks. Each component implements a distinct race pattern (search typeahead, user profile switching, polling dashboard, pagination, infinite scroll, tab switching, and StrictMode double-effect). A Vite development server with configurable response delays ensures bugs are reproducible.

PulsCheck was injected via Playwright `addInitScript()` and each scenario was exercised through automated browser interaction. All 7 bugs were detected with correct pattern classification.

### 4.6 Cross-Environment Validation

PulsCheck's test suite was executed on two environments: a local ARM64 Mac (Node v20.19.5) and an x64 Ubuntu GitHub Actions runner (Node v20.20.2). Event sequences captured from both environments were compared via CI artifacts. All seven test scenarios produced identical event orderings, confirming that the detection patterns are deterministic and environment-independent for the timing margins used in the test suite.

### 4.7 Test Suite

The implementation includes 345 automated tests across 20 test files covering:

- Unit tests for each of the five detection patterns
- Integration tests using real auto-instrumented fetch calls with controlled timing
- 13 real-app race condition scenarios using actual fetch/setTimeout calls
- 15 blind audit scenarios from external sources
- 7 live browser scenarios via Playwright injection
- False positive tests verifying that concurrent fetches to different endpoints do not trigger findings
- Timer lifecycle tests verifying that clearTimeout correctly correlates with setTimeout
- Scope lifecycle tests verifying after-teardown detection
- Reporter deduplication tests
- CLI static scanner tests
- Dynamic URL normalization tests (/user/123 and /user/456 → same endpoint)

All tests pass on Node.js versions 18, 20, and 22.

### 4.8 Performance

The ring buffer uses O(1) insertion with fixed memory (10,000 events × ~200 bytes per event ≈ 2MB). The analyser runs on a configurable interval (default: 5 seconds) and processes the buffer contents in a single pass per pattern. Call site capture via `Error.captureStackTrace` adds approximately 5-15 microseconds per intercepted call — negligible relative to the latency of the operations being intercepted (network requests: 50-500ms, timers: 0-10,000ms). The static CLI scanner processes a typical 50-file React application in under 10ms.

---

## 5. Discussion

### 5.1 Known Limitations

**Single-page scope.** PulsCheck operates within a single browser tab's JavaScript context. It cannot detect race conditions that span multiple tabs, workers, or server-side processes.

**Heuristic detection.** The five patterns are heuristic, not formally verified. False positives are possible when the detected pattern is intentional behaviour (e.g., deliberate duplicate requests for redundancy). False negatives are possible for race condition patterns not covered by the five detectors. The 80% detection rate in the blind audit means 20% of real race conditions are missed.

**Dev-only operation.** PulsCheck operates exclusively in development builds. Race conditions that manifest only under production load patterns (higher concurrency, slower networks) may not be triggered during development. This is a fundamental constraint — the tool catches what happens during development, not what happens at scale.

**Call site accuracy.** Stack trace formats vary across JavaScript engines and may be affected by source map quality. We have not tested on Safari or Firefox-specific stack trace formats. In production-minified code (where PulsCheck does not operate), call sites would be meaningless.

**CLI regex scanner.** The static analysis CLI uses regular expressions, not an AST parser. It will produce false positives on commented-out code, code inside strings, and non-standard patterns. It is a lightweight supplement to the runtime detector, not a standalone analysis tool.

### 5.2 Open Questions

The following questions cannot be answered by the evaluation presented in this paper. They require real-world usage data from diverse codebases and development teams.

**1. False positive rate in practice.** Our tests were designed to contain race conditions, so the false positive rate was necessarily low. In a large codebase with hundreds of concurrent operations — many of which are intentionally concurrent — how many findings are noise? If the false positive rate makes developers ignore PulsCheck output, the tool has negative value regardless of its detection capabilities.

**2. Does detection save time?** PulsCheck tells developers a race condition exists. It does not tell them how to fix it (beyond a generic suggestion). For junior developers, a response-reorder finding may be harder to fix than the original bug. We have no data on whether PulsCheck findings reduce time-to-fix compared to encountering the bug through user reports or QA.

**3. Comparison with prevention.** Libraries like React Query and SWR prevent race conditions by managing the request lifecycle. For teams that adopt these libraries, PulsCheck may detect nothing — because the bugs are already prevented. PulsCheck's value may be limited to codebases that use raw fetch, or to detecting misuse of query libraries.

**4. Scalability of heuristic approach.** Five detectors covering the most common patterns may be sufficient for small applications. Large applications may exhibit race condition patterns that require domain-specific detectors. We do not know where the ceiling is for heuristic-based detection.

**5. CLI usefulness in CI.** The static scanner produces findings on every commit. If developers must triage the same findings repeatedly (e.g., intentional setInterval without cleanup), the tool becomes an annoyance rather than a safeguard. Baseline management and suppression mechanisms need real-world validation.

### 5.3 Comparison with Existing Approaches

| Tool | Detects temporal bugs | Source attribution | Zero config | No infrastructure |
|------|----------------------|-------------------|-------------|-------------------|
| TypeScript | No | N/A | Yes | Yes |
| ESLint | No | N/A | No | Yes |
| Chrome DevTools | Manual inspection | No | Yes | Yes |
| Sentry | Thrown errors only | Yes | No | No |
| OpenTelemetry | Service-level | No | No | No |
| React Query/SWR | Prevents (not detects) | N/A | No | Yes |
| EventRacer | Yes | No | No | No |
| **PulsCheck** | **Yes** | **Yes (file:line)** | **Yes** | **Yes** |

### 5.4 Potential Relevance to AI-Assisted Development

AI code generation tools operate on code structure, not runtime timing. A tool that generates a `useEffect` hook with a `fetch()` call has no model of what other `useEffect` hooks in the same component tree will do at the same time. Whether this produces race conditions more frequently than manual development is an open question — no study has compared race condition rates between AI-generated and human-written asynchronous code. PulsCheck provides a feedback signal that could close this gap, readable by both humans (console output) and AI tools (test runner integration, programmatic API). Empirical measurement of race condition frequency across AI-generated codebases is a direction for future work.

---

## 6. Conclusion

We have presented PulsCheck, a runtime race condition detection system for frontend applications that intercepts asynchronous primitives and applies heuristic pattern detectors with source code attribution. Initial results are encouraging: the system detected previously unknown race conditions in a production application, achieved 80% detection in a blind audit, and produced zero false positives in the test scenarios evaluated.

However, these results come from a narrow evaluation — one production application, one developer team, controlled test scenarios. The critical questions are not "does it detect race conditions in test environments" (it does) but "does it save real developer time", "is the false positive rate tolerable in large codebases", and "do the findings lead to fixes or just confusion". These can only be answered by real-world usage across diverse projects and teams.

We release PulsCheck as an open-source tool specifically to enable this validation. If it proves genuinely useful — reduces debugging time, catches bugs before users do, and doesn't create more noise than signal — then the approach merits further development. If it doesn't, the architecture and evaluation methodology documented here may still inform future work on temporal correctness in frontend applications.

The source code is available at https://github.com/Qubites/pulscheck under the Apache 2.0 license.

---

## References

[1] Savage, S., Burrows, M., Nelson, G., Sobalvarro, P., & Anderson, T. (1997). Eraser: A Dynamic Data Race Detector for Multithreaded Programs. ACM Transactions on Computer Systems, 15(4), 391-411.

[2] Serebryany, K., & Iskhodzhanov, T. (2009). ThreadSanitizer: Data Race Detection in Practice. Workshop on Binary Instrumentation and Applications (WBIA).

[3] Raychev, V., Vechev, M., & Sridharan, M. (2013). Effective Race Detection for Event-Driven Programs. ACM SIGPLAN International Conference on Object-Oriented Programming, Systems, Languages, and Applications (OOPSLA).

[4] Davis, J., Thekumparampil, A., & Lee, D. (2017). Node.fz: Fuzzing the Server-Side Event-Driven Architecture. European Conference on Computer Systems (EuroSys).

[5] Anthropic. (2025). Claude Code: AI-Assisted Software Development. Technical Report.

[6] GitHub. (2024). GitHub Copilot: Your AI Pair Programmer. Product Documentation.
