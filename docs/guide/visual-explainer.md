# How PulsCheck Works — Visual Guide

## Your app has invisible timing problems

Imagine you click "Get Quote" on a website:

```
  You type "cat"        You type "cats"
       │                      │
       ▼                      ▼
   ┌────────┐            ┌────────┐
   │ fetch  │            │ fetch  │
   │ "cat"  │            │ "cats" │
   └───┬────┘            └───┬────┘
       │                      │
       │   (slow network)     │  (fast network)
       │                      │
       │                      ▼
       │                 ┌──────────┐
       │                 │ ✓ shows  │
       │                 │ "cats"   │  ← correct!
       │                 └──────────┘
       │
       ▼
  ┌──────────┐
  │ ✗ shows  │
  │ "cat"    │  ← WRONG! old result overwrites new one
  └──────────┘
```

This is a **race condition**. Two things happened at the same time, and the slow one won. The user sees stale data.

Every dev tool (linters, Copilot, code review) looks at your code like a photograph. They can't see this bug because it only exists **in time**.

## What PulsCheck does

PulsCheck puts a tiny heartbeat monitor on your app:

```
  TIME ──────────────────────────────────────────────►

  0ms       100ms      300ms      500ms     800ms
   │          │          │          │         │
   │    💓 fetch#1       │    💓 fetch#2      │
   │     starts          │     starts         │
   │          │          │          │         │
   │          │          │          │   💓 fetch#2
   │          │          │          │    response ✓
   │          │          │          │         │
   │          │          │          │         │  💓 fetch#1
   │          │          │          │         │   response
   │          │          │          │         │   (LATE!)
   ▼          ▼          ▼          ▼         ▼      ▼
  ┌──────────────────────────────────────────────────────┐
  │  💓💓💓💓💓💓💓  heartbeat timeline  💓💓💓💓💓💓💓  │
  └──────────────────────────────────────────────────────┘
                           │
                           ▼
                  🚨 RESPONSE REORDER DETECTED
```

## The seven bugs PulsCheck catches

### 1. Ghost Callback (after-teardown)

You left the page but a fetch came back and wrote to a screen that doesn't exist.

```
  🧑 ──► page A ──► page B
              ◄── fetch returns to page A (dead!)
```

### 2. Slow Winner (response-reorder)

Old slow response overwrites new fast one.

```
  fast ──────► ✓ correct answer
  slow ──────────────► 💀 overwrites with old data
```

### 3. Double Tap (double-trigger)

Same action fires twice in milliseconds.

```
  click ──► submit order
  click ──► submit order  (duplicate!)
```

### 4. Abandoned Work (dangling-async)

A component kicks off a fetch, timer, or listener — then unmounts before it finishes. The work continues in the background for no reason.

```
  mount  ──► fetch("/api/heavy")
              setInterval(poll, 5000)
              addEventListener("message", handler)
  unmount
              fetch still running  ← wasted
              interval still firing ← wasted
              handler still attached ← leak
```

### 5. Missing Message (sequence-gap)

WebSocket messages arrive with gaps.

```
  msg 1 ✓  msg 2 ✓  msg 3 ???  msg 4 ✓
```

### 6. Time Travel (stale-overwrite)

Screen shows fresh data, then flips back to old data.

```
  "DKK 800" (correct) ──► "DKK 1,200" (stale!)
```

### 7. Layout Thrash (layout-thrash)

DOM writes and reads interleaved, forcing the browser to recalculate layout repeatedly.

```
  el.style.width = "100px"     ← write (dirty)
  x = el.offsetWidth           ← read  (forced reflow!)
  el.style.width = "200px"     ← write (dirty again)
  y = el.offsetWidth           ← read  (forced reflow again!)
  el.style.width = "300px"     ← write
  z = el.offsetWidth           ← read  (3rd reflow — flagged!)
```

## What you see in the console

When PulsCheck finds a bug, it prints a warning in your browser console with:

1. **What pattern** — which of the 7 bugs was detected
2. **Where it lives** — file and line for both sides of the collision (extracted from stack traces at the moment the event fired)
3. **What happened** — plain-English description
4. **What to do** — concrete code fix

Example:

```
[pulscheck] response-reorder (critical)
  Responses for "fetch:/api/search" arrived out of request order
  → src/hooks/useSearch.ts:20
  Stale response was LAST to resolve — app is showing wrong data
  Fix: Use an AbortController to cancel in-flight requests when a new one starts,
       or track a request sequence number and ignore stale responses.
```

Silence means no bugs found. That's good.

## Your decision

```
  See a [pulscheck] warning
        │
        ▼
  Is this actually a bug?
        │
   ┌────┴────┐
  YES        NO (intentional)
   │          │
   ▼          ▼
  Fix it     Ignore it.
  using      No penalty.
  the hint   Won't log again.
```

You never HAVE to act on a warning. It's a smoke detector, not a fire alarm. And thanks to structural deduplication, the same finding is only logged once — no console spam.
