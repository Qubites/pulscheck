# Where Bugs Live

## The frontend tool map

Every layer of a frontend app has a tool watching it. Here is the full pipeline, with what each tool sees:

```
  ┌─────────────────────────────────────────────────────────────────┐
  │ 1. Source code                                                  │
  │    ↑ ESLint, TypeScript, Biome, Copilot, code review            │
  │                                                                 │
  │ 2. Build / bundle                                               │
  │    ↑ Vite, webpack, esbuild, Rollup                             │
  │                                                                 │
  │ 3. Ship to CDN                                                  │
  │    ↑ (nothing watches this)                                     │
  │                                                                 │
  │ 4. Browser loads JS                                             │
  │    ↑ DevTools Sources tab                                       │
  │                                                                 │
  │ 5. Parse, layout, paint, composite                              │
  │    ↑ Chrome Performance, Lighthouse, Web Vitals                 │
  │                                                                 │
  │ 6. ── RUNTIME / user session ──────────────────────────┐        │
  │      user clicks, types, navigates, waits              │        │
  │      components mount and unmount                      │        │
  │      async work resolves in whatever order             │        │
  │      the network and the event loop decide             │        │
  │                                                        │        │
  │      ↑ nothing looks here automatically                │        │
  │                                                        │        │
  │ 7. Tab close                                           │        │
  │    ↑ Sentry / Datadog RUM (only if something throws)   │        │
  └─────────────────────────────────────────────────────────────────┘
```

Layer 6 — the runtime session — is where the user actually lives. It is also where every tool in the pipeline either stops looking or looks at the wrong axis.

## Bugs don't live in code. They live between events.

Every static tool — linter, type checker, bundler, AI assistant — looks at your code like a photograph. It is looking for bad lines.

Race conditions are not bad lines. They are bad *relationships* between events.

```
  Line of code                      Is it wrong?
  ─────────────────────────────     ──────────────────
  fetch('/api/search?q=' + q)       No. Perfect line.
  setTimeout(update, 1000)          No. Perfect line.
  target.addEventListener(...)      No. Perfect line.
```

The bug only exists when two events collide in time:

```
  t=0ms     user types "cat"    ──►  fetch #1 starts
  t=50ms    user types "cats"   ──►  fetch #2 starts
  t=200ms   fetch #2 returns    ──►  UI shows "cats" ✓
  t=450ms   fetch #1 returns    ──►  UI overwrites to "cat" ✗
```

Nothing about any single line is wrong. The bug is **the 250ms between the two responses**, and the fact that the second one overwrote the first. That gap does not exist in the source code. It exists only in a live trace.

This is why no static tool can see race conditions. They are not looking at the wrong thing — they are looking at a *medium* (the code) in which the bug is literally not present.

## Why every category of existing tool misses these

| Tool category | What it sees | Why it cannot catch races |
|---|---|---|
| **Linters** (ESLint, Biome) | Source code as text | Runs before execution. Can say *"you used setTimeout"* — cannot know whether the component unmounted before the timer fired. |
| **TypeScript** | Type graph | Has no concept of wall-clock time, async ordering, or lifecycle. |
| **AI code assistants** (Copilot, Cursor) | Source + patterns | Same problem. Pattern-matches what you wrote, not what happens at runtime. |
| **Bundlers** (Vite, webpack) | Modules → static files | They transform code. They do not observe execution. |
| **Chrome DevTools — Network** | Real request waterfall | Shows the timing **to a human who has to spot the race** by staring at the waterfall. No automatic detection. |
| **Chrome DevTools — Performance** | Frame timings, paint, main thread | Measures *how fast* things happen, not *in what order they resolved*. A stale response is fast and wrong; the profiler calls that a win. |
| **Lighthouse / Web Vitals** | Paint and interaction timings | Scores the average user experience. Silent on ordering. |
| **Error monitoring** (Sentry, Datadog RUM) | Thrown exceptions, unhandled rejections | A stale response that overwrites fresh data **does not throw**. The app silently shows wrong data. Sentry never sees it. |
| **Server APM** (New Relic, Datadog APM) | Server spans, DB queries | Does not see the browser at all. |
| **E2E tests** (Playwright, Cypress) | Scripted user actions on CI | CI network is deterministic — 50 ms every time. The race that happens on a user's 3G phone at 2000 ms does not reproduce in CI. Tests pass, bug ships. |
| **Unit tests** (Vitest, Jest) | Functions in isolation with mocks | You mock the very async primitives the race lives in. |
| **React Query / SWR / TanStack Query** | Their own cache keys | They *prevent* a subset of races for code that uses them. They do not detect races in code that does not. |

Notice the pattern: every tool is either **pre-runtime** (code as text) or **post-runtime** (server spans, thrown errors, paint timings). Nothing sits on the **runtime timeline** and watches how asynchronous neighbours relate to each other.

## Where PulsCheck plugs in

PulsCheck inserts itself at the eight global functions that asynchronous JavaScript *must* go through to exist:

```
  ┌──────────────────────────────────────────────────────┐
  │  fetch                       ← network               │
  │  setTimeout, setInterval     ← one-shot / recurring  │
  │  clearTimeout, clearInterval ← cancellation          │
  │  addEventListener            ← DOM / EventTarget     │
  │  removeEventListener         ← listener lifecycle    │
  │  WebSocket                   ← persistent streams    │
  └──────────────────────────────────────────────────────┘
                         │
                         ▼
              Every call is now witnessed
              with timestamp + source line
                         │
                         ▼
              Ring buffer (10,000 events)
                         │
                         ▼
              Four pattern detectors run
              over the observed event order
                         │
                         ▼
              Finding[] → console (dev only)
```

The key phrase is **observed event order**. PulsCheck is not looking at your code. It is looking at the actual sequence of events your app produced during a live session, and asking whether that sequence contains any of four known race-condition shapes.

That is the layer no other tool occupies. Linters cannot reach it — it does not exist at their analysis time. Server APM cannot reach it — it is not on the server. Error monitoring cannot reach it — the bugs do not throw. Chrome DevTools exposes the raw material, but a human has to read it.

## The one-sentence version

> **Race conditions live in the ordering relationship between two async events within one user session.**
>
> Linters see the code as a still photograph and have no axis for time at all. DevTools shows you the timeline and makes you spot the pattern yourself. Error monitoring only fires when something throws — and stale data does not throw. Server tools do not see the browser.
>
> PulsCheck is the layer that sits on the runtime timeline and automatically reports when two neighbours on that timeline form a known race shape, with the source line of each side of the collision.

## An analogy

| Tool | House analogy |
|---|---|
| Linter | Reads the blueprints and circles the weak latch on the back window. |
| TypeScript | Checks the blueprints for load-bearing contradictions. |
| DevTools Network tab | A live CCTV feed you have to watch yourself. |
| Sentry | The alarm that only fires when glass breaks. |
| Chrome Performance tab | A stopwatch timing how long each room takes to enter. |
| **PulsCheck** | **A motion detector on the timeline that says "someone entered through the back window at 2:37:04 and the kitchen lights came on at 2:37:09 — here are the two frames, and here is the exact line of code each side came from."** |

Static tools analyse the blueprint. PulsCheck watches the timeline.
