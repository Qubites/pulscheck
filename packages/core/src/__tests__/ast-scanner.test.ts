/**
 * Precision audit for the `fetch-no-abort-in-effect` AST rule.
 *
 * Every test below maps to a real decision the rule has to make in
 * production code. The goal is to pin down what the rule actually flags
 * — and, just as importantly, what it does NOT — before we propose it
 * upstream or publish it standalone.
 *
 * Each test states, in one sentence, the shape of the fixture and what
 * we expect. If behaviour changes, the diff lands here first and we
 * reason about whether it's a bug or an intentional narrowing.
 */
import { describe, it, expect } from "vitest";
import { scanSourceAst } from "../ast-scanner";

function scan(source: string) {
  return scanSourceAst("fixture.tsx", source);
}

function hasFetchFinding(source: string): boolean {
  return scan(source).some((f) => f.rule === "fetch-no-abort-in-effect");
}

// ─── True positives — rule should fire ──────────────────────────────

describe("fetch-no-abort-in-effect — true positives", () => {
  it("plain fetch in useEffect, no return", () => {
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {
          fetch('/api/x').then(r => r.json());
        }, []);
      }
    `)).toBe(true);
  });

  it("plain fetch in useLayoutEffect", () => {
    expect(hasFetchFinding(`
      import { useLayoutEffect } from 'react';
      function C() {
        useLayoutEffect(() => {
          fetch('/api/x');
        }, []);
      }
    `)).toBe(true);
  });

  it("plain fetch in useInsertionEffect", () => {
    expect(hasFetchFinding(`
      import { useInsertionEffect } from 'react';
      function C() {
        useInsertionEffect(() => {
          fetch('/api/x');
        }, []);
      }
    `)).toBe(true);
  });

  it("fetch in nested arrow callback inside effect", () => {
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {
          [1,2,3].forEach(() => { fetch('/api/x'); });
        }, []);
      }
    `)).toBe(true);
  });

  it("fetch in helper function declared inside effect", () => {
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {
          async function load() { await fetch('/api/x'); }
          load();
        }, []);
      }
    `)).toBe(true);
  });

  it("window.fetch in effect", () => {
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {
          window.fetch('/api/x');
        }, []);
      }
    `)).toBe(true);
  });

  it("globalThis.fetch in effect", () => {
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {
          globalThis.fetch('/api/x');
        }, []);
      }
    `)).toBe(true);
  });

  it("empty cleanup body — abort not called", () => {
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {
          fetch('/api/x');
          return () => {};
        }, []);
      }
    `)).toBe(true);
  });

  it("cleanup clears a timer but not the fetch", () => {
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {
          const id = setInterval(() => {}, 1000);
          fetch('/api/x');
          return () => clearInterval(id);
        }, []);
      }
    `)).toBe(true);
  });
});

// ─── True negatives — rule should NOT fire ──────────────────────────

describe("fetch-no-abort-in-effect — true negatives (should not fire)", () => {
  it("fetch with AbortController, abort() in cleanup", () => {
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {
          const ctrl = new AbortController();
          fetch('/api/x', { signal: ctrl.signal });
          return () => ctrl.abort();
        }, []);
      }
    `)).toBe(false);
  });

  it("fetch with abort called via optional chain in cleanup", () => {
    expect(hasFetchFinding(`
      import { useEffect, useRef } from 'react';
      function C() {
        const ref = useRef<AbortController>();
        useEffect(() => {
          ref.current = new AbortController();
          fetch('/api/x', { signal: ref.current.signal });
          return () => ref.current?.abort();
        }, []);
      }
    `)).toBe(false);
  });

  it("cleanup iterates controllers: forEach(c => c.abort())", () => {
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {
          const controllers: AbortController[] = [];
          for (const url of ['/a', '/b']) {
            const c = new AbortController();
            controllers.push(c);
            fetch(url, { signal: c.signal });
          }
          return () => controllers.forEach(c => c.abort());
        }, []);
      }
    `)).toBe(false);
  });

  it("sdk.fetch(...) — wrapper, not native", () => {
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      declare const sdk: { fetch: (url: string) => Promise<unknown> };
      function C() {
        useEffect(() => {
          sdk.fetch('/api/x');
        }, []);
      }
    `)).toBe(false);
  });

  it("local variable named fetch shadows the global", () => {
    expect(hasFetchFinding(`
      import { useEffect, useState } from 'react';
      function C() {
        const [fetch, setFetch] = useState<any>(null);
        useEffect(() => {
          fetch && fetch('/api/x');
        }, [fetch]);
      }
    `)).toBe(false);
  });

  it("fetch at top level, not in useEffect", () => {
    expect(hasFetchFinding(`
      fetch('/api/x');
    `)).toBe(false);
  });

  it("fetch inside onClick handler, not in useEffect", () => {
    expect(hasFetchFinding(`
      function C() {
        return <button onClick={() => fetch('/api/x')}>go</button>;
      }
    `)).toBe(false);
  });

  it("no fetch in effect at all", () => {
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {
          const id = setInterval(() => {}, 1000);
          return () => clearInterval(id);
        }, []);
      }
    `)).toBe(false);
  });

  it("empty effect body", () => {
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {}, []);
      }
    `)).toBe(false);
  });
});

// ─── Documented limitations — behaviour is intentional ──────────────

describe("fetch-no-abort-in-effect — documented limitations", () => {
  it("LIMITATION: fetch in helper defined OUTSIDE effect is missed", () => {
    // The rule walks the effect body only; calls into outside helpers
    // are opaque. Documented in ast-scanner.ts header.
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      async function load() { await fetch('/api/x'); }
      function C() {
        useEffect(() => { load(); }, []);
      }
    `)).toBe(false);
  });

  it("LIMITATION: indeterminate cleanup (return named fn) suppresses", () => {
    // The rule cannot trace a returned named identifier. It conservatively
    // suppresses. This produces false negatives when the named function
    // does NOT abort — the fetch is unguarded but we stay silent.
    //
    // Note: this only matters for fetches WITH a signal — unsignalled
    // fetches are now flagged unconditionally by the per-fetch signal
    // check. We pass a signal here to exercise the indeterminate-cleanup
    // code path we're actually documenting.
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        function cleanup() { /* intentionally empty */ }
        useEffect(() => {
          const ctrl = new AbortController();
          fetch('/api/x', { signal: ctrl.signal });
          return cleanup;
        }, []);
      }
    `)).toBe(false);
  });

  it("LIMITATION: conditional cleanup is treated as indeterminate", () => {
    // Same caveat as above: signal is present so the indeterminate-cleanup
    // branch is what's actually on trial.
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {
          const ctrl = new AbortController();
          fetch('/api/x', { signal: ctrl.signal });
          return true ? () => {} : undefined;
        }, []);
      }
    `)).toBe(false);
  });

  it("LIMITATION: class component lifecycle not checked", () => {
    expect(hasFetchFinding(`
      import { Component } from 'react';
      class C extends Component {
        componentDidMount() { fetch('/api/x'); }
      }
    `)).toBe(false);
  });

  it("LIMITATION: custom hook wrapping useEffect not checked", () => {
    // useFetchData wraps useEffect internally; we only see useFetchData,
    // which isn't in the EFFECT_HOOKS set.
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function useFetchData(url: string) {
        useEffect(() => { fetch(url); }, [url]);
      }
    `)).toBe(true);
    // ^ actually this IS caught because the scanner walks all calls in
    // the file and the useEffect IS there. Keeping this to pin the
    // behaviour: the wrapping function name doesn't matter.
  });
});

// ─── False positives — the prescriptive-rule risk ──────────────────

describe("fetch-no-abort-in-effect — prescriptive-rule false positives", () => {
  it("FP: fetch with no setState — no state corruption possible", () => {
    // Fire-and-forget analytics ping. The component never reads the
    // response, so there is no stale-data hazard. Rule still flags it
    // because there's no AbortController. Whether this counts as a real
    // FP depends on philosophy: the fetch does still waste network, but
    // UI corruption is impossible.
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {
          fetch('/api/pageview', { method: 'POST', body: '{}' });
        }, []);
      }
    `)).toBe(true);
  });

  it("FP: fetch guarded by isMounted ref (valid alternate pattern)", () => {
    // No AbortController, but the closure never touches state after
    // unmount. Rule has no way to see that and fires anyway.
    expect(hasFetchFinding(`
      import { useEffect, useRef, useState } from 'react';
      function C() {
        const [data, setData] = useState<unknown>(null);
        const mounted = useRef(true);
        useEffect(() => {
          mounted.current = true;
          fetch('/api/x').then(r => r.json()).then(j => {
            if (mounted.current) setData(j);
          });
          return () => { mounted.current = false; };
        }, []);
      }
    `)).toBe(true);
  });

  it("mixed fetches: unsignalled fetch flagged even when sibling is aborted", () => {
    // Previously a FALSE NEGATIVE: the cleanup heuristic cleared every
    // fetch in the effect as long as SOME .abort() appeared. Now each
    // fetch is classified individually — a fetch with no `signal` option
    // cannot be aborted by any cleanup, so it's flagged regardless of
    // what cleanup does. /api/a (signal present) is cleared; /api/b
    // (no options) is flagged.
    const findings = scan(`
      import { useEffect } from 'react';
      function C() {
        useEffect(() => {
          const ctrl = new AbortController();
          fetch('/api/a', { signal: ctrl.signal });
          fetch('/api/b');
          return () => ctrl.abort();
        }, []);
      }
    `);
    const fetchFindings = findings.filter((f) => f.rule === "fetch-no-abort-in-effect");
    expect(fetchFindings.length).toBe(1);
    expect(fetchFindings[0].code).toContain("/api/b");
  });

  it("FP: axios in useEffect without CancelToken — out of scope", () => {
    // The rule is fetch-only. Axios has the same bug class but we do not
    // detect it. That's intentional narrowing, not a bug.
    expect(hasFetchFinding(`
      import { useEffect } from 'react';
      import axios from 'axios';
      function C() {
        useEffect(() => { axios.get('/api/x'); }, []);
      }
    `)).toBe(false);
  });
});

// ─── Finding shape ──────────────────────────────────────────────────

describe("fetch-no-abort-in-effect — finding shape", () => {
  it("populates line, column, code, severity, fix", () => {
    const findings = scan(`
import { useEffect } from 'react';
function C() {
  useEffect(() => {
    fetch('/api/x');
  }, []);
}
`);
    expect(findings.length).toBe(1);
    const f = findings[0];
    expect(f.rule).toBe("fetch-no-abort-in-effect");
    expect(f.severity).toBe("critical");
    expect(f.detector).toBe("after-teardown");
    expect(f.line).toBe(5);
    expect(f.column).toBeGreaterThan(0);
    expect(f.code).toContain("fetch");
    expect(f.fix).toContain("AbortController");
  });
});
