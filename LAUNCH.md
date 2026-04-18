# Launch package — v0.1.0

Four drafts, one file. Copy each section to its destination. Post them in one wave (same day, ideally within a few hours); don't stagger.

**Gate:** None of this helps until `npm install pulscheck` works. Set `NPM_TOKEN` in the repo secrets first, let the release workflow publish, verify, *then* post.

---

## 1. Blog post

**Where:** Your personal blog, dev.to, or as an orphan page at `docs/blog/v0-1.md`. Pick one. Everything else links back to it.

**Title options:**
- "Race conditions don't live in your code. They live between events."
- "The runtime layer no frontend tool watches"
- "PulsCheck 0.1 — catching the async races your linter can't see"

**Body:**

---

The race condition you've hit a hundred times:

```
t=0ms     user types "cat"     → fetch #1 starts
t=50ms    user types "cats"    → fetch #2 starts
t=200ms   fetch #2 returns     → UI shows "cats" ✓
t=450ms   fetch #1 returns     → UI overwrites to "cat" ✗
```

Nothing about any line of that code is wrong. `fetch` is fine. The `setState` in the response handler is fine. The bug is the **250ms between the two responses** — a relationship, not a statement. That gap doesn't exist in source code. It only exists in a live trace.

This is why no static tool can see it.

### Every tool in the frontend stack either looks too early or too late

- **Linters and TypeScript** run before execution — no concept of time.
- **AI assistants** (Copilot, Cursor) pattern-match the source — same problem.
- **Sentry and Datadog RUM** only fire when something throws. A stale response that overwrites fresh data doesn't throw. Sentry never sees it.
- **Chrome DevTools** shows you the timeline, but a human has to spot the pattern.
- **Playwright and Cypress** run on CI, where the network is deterministic. The race that happens on a user's 3G phone at 2,000ms never reproduces in the test.

Everything is either **pre-runtime** (code as text) or **post-runtime** (thrown exceptions, server spans). Nothing sits on the runtime timeline itself and watches how async neighbours relate to each other.

### What PulsCheck does

PulsCheck patches the eight globals that asynchronous JavaScript has to go through to exist: `fetch`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `addEventListener`, `removeEventListener`, `WebSocket`. Every call is recorded as a timestamped event with its source line. Four detectors run over the observed event order and report when two events form a known race shape:

- **after-teardown** — a timer, listener, or fetch is still alive after its scope is gone
- **response-reorder** — a stale response resolves last and overwrites fresh data (the typeahead bug)
- **double-trigger** — the same action fires twice in a handful of milliseconds
- **dangling-async** — an async chain started but never completed

Each finding comes with the source line of *both sides* of the collision — the request that started it and the render/setState/unmount that it collided with.

### Setup

```bash
npm install -D pulscheck
```

```ts
import { devMode } from "pulscheck";

if (import.meta.env.DEV) devMode();
```

That's it. Open the console during dev. If a race happens during your session, you'll see something like:

```
🛑 [CRITICAL] Stale response for "fetch:/api/search" resolved last — confirmed data corruption
   Pattern: response-reorder
   Requests sent in order [...] but responses arrived as [...].
   Location: src/hooks/useSearch.ts:20
```

### What it is and isn't

**Prevention beats detection every time.** If your whole app goes through TanStack Query / SWR / React Query with correct cache keys, plus `AbortController` in every effect, most of these races can't exist — and you probably don't need PulsCheck. That's not a dig at PulsCheck, it's the state of things: you've eliminated the class of bug at the source.

PulsCheck earns its keep in:

- **Legacy or mixed codebases** — some code goes through Query, some is raw `fetch`. Races happen in the gap.
- **Teams without strong async discipline** — catches what humans forget.
- **Library code** that can't assume consumers use Query.
- **Reproducing a flaky race you already suspect** — because Playwright won't and Sentry can't.

It ships with four runtime detectors and one static AST rule (`fetch-no-abort-in-effect`). That's deliberately narrow — not every race pattern gets a detector, only the ones that are common, cheap to detect, and high-confidence.

### Try it, break it, file issues

v0.1.0 is out on npm now. [GitHub](https://github.com/Qubites/pulscheck) · [Docs](https://pulscheck.qubites.io) · Issue tracker is open. I want to hear: races you caught, false positives, noise, missing patterns. Especially the last one — if your app has a race shape the four detectors don't cover, that's the feedback that shapes what ships next.

---

## 2. Show HN

**Where:** https://news.ycombinator.com/submit

**Title (80 char max):**

```
Show HN: PulsCheck – runtime race-condition detection for frontend apps
```

**URL field:** Link to the blog post (not the GitHub repo — HN rewards a story, not a readme).

**First comment** (post this immediately after submission so the thread starts with context):

```
Author here. Built this after hitting the typeahead bug ("cat" vs "cats" responses racing) for the Nth time and realizing nothing in the stack can automatically catch it — linters look at code, Sentry only fires on throws, DevTools shows you the timeline but makes you spot races yourself.

PulsCheck patches the 8 async globals (fetch, setTimeout/setInterval, addEventListener, WebSocket, etc.), records every call with a source line, and runs 4 detectors over the observed event order. When it finds a race shape, you get the file:line of both sides of the collision.

Four runtime detectors + one static AST rule. Deliberately narrow — if your whole app uses TanStack Query correctly you probably don't need this. It's for mixed codebases, legacy code, and reproducing the flaky races you already suspect.

Apache 2.0, zero config (one `devMode()` call). Feedback welcome, especially on race patterns the 4 detectors miss.

GitHub: https://github.com/Qubites/pulscheck
Docs: https://pulscheck.qubites.io
```

**HN best-practice reminders:**
- Post between Tue–Thu, 6–9am PT for best visibility.
- Don't repost within 8 hours; mods will notice.
- Reply to every first-hour comment; the algorithm weights engagement.
- Don't argue with critics — answer their question and move on.

---

## 3. Reddit r/reactjs

**Where:** https://www.reddit.com/r/reactjs/submit

**Title:**

```
I built a dev-only race condition detector for React apps — looking for feedback
```

**Flair:** `Show /r/reactjs` (if available) or `Discussion`.

**Body:**

```
A race condition I've seen in dozens of React apps:

1. User types "cat" → fetch starts
2. User types "cats" → fetch starts  
3. Response for "cats" arrives first → UI shows correct result
4. Response for "cat" arrives second → UI overwrites with stale data

Nothing threw. Tests passed. Sentry silent. ESLint clean. The bug lives in the *ordering* between two responses, not in any single line — and nothing in the normal toolchain watches ordering.

I built **PulsCheck** to sit on exactly that layer. It patches fetch, setTimeout, setInterval, addEventListener, WebSocket (the 8 globals async JS has to go through), records every call with a source line, and runs 4 detectors over the observed event order:

- **after-teardown** — timer/listener/fetch alive after unmount
- **response-reorder** — stale response resolves last, overwrites fresh (the typeahead bug above)
- **double-trigger** — same action fires twice within ms
- **dangling-async** — chain started but never finished

Plus one static AST rule for `fetch()` inside `useEffect` without `AbortController`.

Setup is one line:

```ts
import { devMode } from "pulscheck";
if (import.meta.env.DEV) devMode();
```

Findings land in the console with file:line for *both* sides of the collision.

**Caveat:** if you use TanStack Query / SWR / React Query religiously, most of this won't find anything — prevention beats detection, those libs kill these races at the source. This is for mixed codebases, teams without strong async discipline, and reproducing flaky races you already suspect.

GitHub: https://github.com/Qubites/pulscheck  
Docs: https://pulscheck.qubites.io

Happy to hear where it's wrong, where it's noisy, and what race shapes it should cover but doesn't. 0.1.0 on npm now.
```

**Reddit best-practice reminders:**
- Post Wed–Thu morning US time; weekends get less dev traffic.
- Engage every top-level comment in the first 2 hours.
- Don't link to your own site more than twice in the thread — auto-mod flags it.
- If someone asks "why not just use X?" answer with "you're right for X, but here's the case I had in mind."

---

## 4. DMs

**Target list (pick 3, max 5):**

1. **Tanner Linsley** (TanStack) — creator of React Query. The prevention-vs-detection framing will land. If he boosts, developers who care about async correctness see it. [@tannerlinsley on X]
2. **Dan Abramov** — react-core alum, writes about async React. Long shot for engagement but even a one-line reply moves the needle. [@dan_abramov2 on X / dan.abramov.is]
3. **Kent C. Dodds** — teaches React / testing-library. Cares about reliability. [@kentcdodds on X]
4. **Ryan Florence** — Remix, writes about async patterns. [@ryanflorence on X]
5. **Josh Comeau** — writes approachable pieces on React edge cases. [@JoshWComeau on X]
6. **Theo Browne** — reaches a big React/TS audience. [@theo on X]

**Template (customize the first line to each person):**

```
Hey [name] — I saw your piece on [specific thing they wrote about async React / races / effects]. 
Just shipped v0.1 of a tool that might be up your alley: PulsCheck, a dev-only runtime race detector 
that patches the async globals and reports when two events form a race shape, with the file:line of 
both sides.

The thesis is that runtime races (stale responses, after-unmount fetches, double-triggers) live 
between events, not in code — so linters and Sentry can't see them. Four detectors, one function 
call, redundant by design if you TanStack-Query everything.

Would love your take, especially on false positives or race shapes I'm missing. No ask beyond 
"try it for 5 minutes in one of your apps if you have time."

GitHub: https://github.com/Qubites/pulscheck
Blog: [link to the post]
```

**DM best-practice reminders:**
- Personalize the first line for each person — reference something specific they wrote. Generic DMs get ignored.
- Send once, never follow up unless they engage first.
- Don't batch — space them across a day so replies don't overlap.
- If they share, thank them publicly but briefly; don't fanboy.

---

## Launch-day checklist

- [ ] `NPM_TOKEN` set in repo secrets
- [ ] GitHub Release v0.1.0 created, publish workflow green
- [ ] `npm view pulscheck version` returns `0.1.0`
- [ ] Blog post live (with stable URL)
- [ ] Show HN submitted + first comment posted
- [ ] Reddit posted + monitoring replies
- [ ] DMs sent (one batch, personalized)
- [ ] Pin GitHub repo; update README badges if any are stale

## Post-launch

Don't post anything else about it for 90 days. One wave, then data. Come back at +30, +60, +90 days and check: stars, issues filed, "it found X" reports. That tells you whether to invest more or park it.
