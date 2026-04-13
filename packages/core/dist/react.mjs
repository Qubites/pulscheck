import { useEffect, useRef, useLayoutEffect } from 'react';

// src/react.ts

// src/registry.ts
var _isDevCached;
var isDev = () => {
  if (_isDevCached !== void 0) return _isDevCached;
  try {
    if (typeof process !== "undefined" && process.env?.NODE_ENV) return _isDevCached = process.env.NODE_ENV !== "production";
  } catch (_) {
  }
  if (typeof window !== "undefined") return _isDevCached = !window.__TW_PRODUCTION__;
  return _isDevCached = true;
};
var PulseRegistry = class {
  constructor(capacity = 1e4) {
    this.handlers = /* @__PURE__ */ new Set();
    this._head = 0;
    this._count = 0;
    this._enabled = true;
    this._winCap = 500;
    this._cap = capacity;
    this._buf = new Array(capacity);
  }
  configure(opts) {
    if (opts.enabled !== void 0) this._enabled = opts.enabled;
    if (opts.maxTrace !== void 0) {
      this._cap = opts.maxTrace;
      this._buf = new Array(opts.maxTrace);
      this._head = 0;
      this._count = 0;
    }
  }
  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(event) {
    if (!isDev() && !event.public) return;
    if (!this._enabled) return;
    this._buf[this._head] = event;
    this._head = (this._head + 1) % this._cap;
    if (this._count < this._cap) this._count++;
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (e) {
        if (isDev()) console.warn("[pulscheck] handler error:", e);
      }
    }
    if (typeof window !== "undefined") {
      let arr = window.__tw_pulses__ ?? [];
      arr.push({ label: event.label, ts: event.beat, lane: event.lane, correlationId: event.correlationId, meta: event.meta });
      if (arr.length > this._winCap * 2) arr = arr.slice(-this._winCap);
      window.__tw_pulses__ = arr;
    }
  }
  get trace() {
    if (this._count < this._cap) return this._buf.slice(0, this._count);
    return [...this._buf.slice(this._head), ...this._buf.slice(0, this._head)];
  }
  /** Zero-alloc iteration over the ring buffer. No array created. */
  forEach(fn) {
    if (this._count === 0) return;
    const start = this._count < this._cap ? 0 : this._head;
    for (let i = 0; i < this._count; i++) {
      const idx = (start + i) % this._cap;
      const result = fn(this._buf[idx], i);
      if (result === false) break;
    }
  }
  /** Zero-alloc: find first event matching predicate */
  find(fn) {
    let found;
    this.forEach((e) => {
      if (fn(e)) {
        found = e;
        return false;
      }
    });
    return found;
  }
  get length() {
    return this._count;
  }
  clear() {
    this._head = 0;
    this._count = 0;
  }
};
var registry = new PulseRegistry();

// src/scope.ts
var scopeStack = [];
function currentScope() {
  return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : void 0;
}
var _seq = 0;
function scopeId() {
  return `scope_${Date.now().toString(36)}_${(++_seq).toString(36)}`;
}
function createScope(name, opts, deps) {
  const correlationId = scopeId();
  const lane = opts.lane ?? "ui";
  deps.pulse(`${name}:start`, {
    ...opts,
    lane,
    correlationId,
    kind: "scope-start",
    source: "scope"
  });
  let _active = true;
  function removeFromStack() {
    const idx = scopeStack.lastIndexOf(scope);
    if (idx >= 0) scopeStack.splice(idx, 1);
  }
  const scope = {
    get correlationId() {
      return correlationId;
    },
    get name() {
      return name;
    },
    get lane() {
      return lane;
    },
    get active() {
      return _active;
    },
    deactivate() {
      removeFromStack();
    },
    end() {
      if (!_active) return;
      _active = false;
      deps.pulse(`${name}:teardown`, { ...opts, lane, correlationId, kind: "scope-end", source: "scope" });
      removeFromStack();
    }
  };
  scopeStack.push(scope);
  return scope;
}

// src/tw.ts
var _seq2 = 0;
function uid() {
  return `pw_${Date.now().toString(36)}_${(++_seq2).toString(36)}`;
}
function now() {
  if (typeof performance !== "undefined") return performance.now();
  if (typeof process !== "undefined") {
    const [s, ns] = process.hrtime();
    return s * 1e3 + ns / 1e6;
  }
  return Date.now();
}
function buildEvent(label, opts, correlationId) {
  const lane = opts.lane ?? "ui";
  const event = {
    label,
    lane,
    beat: now(),
    ts: Date.now(),
    public: opts.public ?? false,
    correlationId: correlationId ?? opts.correlationId ?? uid(),
    parentId: opts.parentId,
    meta: opts.meta,
    kind: opts.kind,
    source: opts.source ?? "manual"
  };
  if (opts.callSite) event.callSite = opts.callSite;
  return event;
}
var tw = {
  pulse(label, opts = {}) {
    if (opts.sample !== void 0 && Math.random() > opts.sample) {
      return { label, lane: opts.lane ?? "ui", beat: 0, ts: 0, public: false, dna: "", correlationId: opts.correlationId ?? uid(), source: opts.source ?? "manual" };
    }
    const event = buildEvent(label, opts);
    registry.emit(event);
    return event;
  },
  measure(label, opts = {}) {
    const correlationId = opts.correlationId ?? uid();
    const startEvent = buildEvent(`${label}:start`, opts, correlationId);
    registry.emit(startEvent);
    let stopped = false;
    return {
      startEvent,
      stop() {
        if (stopped) return 0;
        stopped = true;
        const duration = now() - startEvent.beat;
        const endEvent = buildEvent(`${label}:end`, {
          ...opts,
          meta: { ...opts.meta, durationMs: duration, startBeat: startEvent.beat }
        }, correlationId);
        registry.emit(endEvent);
        return duration;
      }
    };
  },
  checkpoint(label, step, opts = {}) {
    return tw.pulse(label, { ...opts, meta: { ...opts.meta, step } });
  },
  /**
   * Create a correlation scope. All auto-instrumented events that fire
   * while this scope is active get its correlationId as their parentId.
   * Call scope.end() to emit a teardown event and close the scope.
   *
   * @example
   *   useEffect(() => {
   *     const scope = tw.scope("checkout");
   *     fetch("/api/pay"); // auto-pulsed with parentId = scope.correlationId
   *     return () => scope.end(); // emits "checkout:teardown"
   *   }, []);
   */
  scope(name, opts = {}) {
    return createScope(name, opts, { pulse: tw.pulse });
  },
  on(handler) {
    return registry.on(handler);
  },
  configure(opts) {
    registry.configure(opts);
  },
  get trace() {
    return registry.trace;
  },
  clearTrace() {
    registry.clear();
  }
};

// src/instrument.ts
var PATCHED = /* @__PURE__ */ Symbol.for("tw.patched");
function isPatched(fn) {
  return typeof fn === "function" && fn[PATCHED] === true;
}
function markPatched(fn) {
  fn[PATCHED] = true;
}
var _nativeSetInterval = globalThis.setInterval;
var _nativeClearInterval = globalThis.clearInterval;
var activeTimeouts = /* @__PURE__ */ new Map();
var activeIntervals = /* @__PURE__ */ new Map();
var DEFAULT_EVENTS = /* @__PURE__ */ new Set([
  "click",
  "dblclick",
  "submit",
  "change",
  "input",
  "focus",
  "blur",
  "keydown",
  "keyup",
  "popstate",
  "hashchange",
  "beforeunload",
  "visibilitychange",
  "online",
  "offline",
  "error",
  "unhandledrejection"
]);
var cleanups = [];
var endpointGeneration = /* @__PURE__ */ new Map();
function nextGeneration(endpoint) {
  const gen = (endpointGeneration.get(endpoint) ?? 0) + 1;
  endpointGeneration.set(endpoint, gen);
  return gen;
}
function currentGeneration(endpoint) {
  return endpointGeneration.get(endpoint) ?? 0;
}
function patchFetch() {
  if (typeof globalThis.fetch !== "function") return;
  if (isPatched(globalThis.fetch)) return;
  const original = globalThis.fetch;
  const patched = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const resource = truncateUrl(url);
    const scope = currentScope();
    const callSite = captureCallSite();
    const fullUrl = metaUrl(url);
    const gen = nextGeneration(resource);
    const correlationId = tw.pulse(`fetch:${resource}:start`, {
      lane: "api",
      kind: "request",
      source: "auto",
      parentId: scope?.correlationId,
      meta: { url: fullUrl, method, generation: gen },
      callSite
    }).correlationId;
    try {
      const response = await original.call(globalThis, input, init);
      const latestGen = currentGeneration(resource);
      tw.pulse(`fetch:${resource}:done`, {
        lane: "api",
        kind: "response",
        source: "auto",
        correlationId,
        parentId: scope?.correlationId,
        meta: { url: fullUrl, method, status: response.status, generation: gen, latestGeneration: latestGen }
      });
      return response;
    } catch (error) {
      const latestGen = currentGeneration(resource);
      tw.pulse(`fetch:${resource}:error`, {
        lane: "api",
        kind: "error",
        source: "auto",
        correlationId,
        parentId: scope?.correlationId,
        meta: { url: fullUrl, method, error: String(error), generation: gen, latestGeneration: latestGen }
      });
      throw error;
    }
  };
  markPatched(patched);
  globalThis.fetch = patched;
  cleanups.push(() => {
    globalThis.fetch = original;
  });
}
function patchTimers() {
  patchTimerSet("setTimeout", "delay", "timer-end", "setTimeout:fire", true, activeTimeouts);
  patchTimerSet("setInterval", "interval", "timer-tick", "setInterval:tick", false, activeIntervals);
  patchTimerClear("clearTimeout", "setTimeout", activeTimeouts);
  patchTimerClear("clearInterval", "setInterval", activeIntervals);
}
function patchTimerSet(name, metaKey, fireKind, fireLabel, removeOnFire, activeMap) {
  const original = globalThis[name];
  if (isPatched(original)) return;
  const patched = function(handler, timeout, ...args) {
    if (typeof handler !== "function") return original(handler, timeout);
    const scope = currentScope();
    const callSite = captureCallSite();
    const correlationId = tw.pulse(`${name}:start`, {
      lane: "ui",
      kind: "timer-start",
      source: "auto",
      parentId: scope?.correlationId,
      meta: { [metaKey]: timeout ?? 0 },
      callSite
    }).correlationId;
    const id = original(() => {
      if (removeOnFire) activeMap.delete(id);
      tw.pulse(fireLabel, {
        lane: "ui",
        kind: fireKind,
        source: "auto",
        correlationId,
        parentId: scope?.correlationId,
        meta: { [metaKey]: timeout ?? 0 }
      });
      handler(...args);
    }, timeout);
    activeMap.set(id, { correlationId, parentId: scope?.correlationId });
    return id;
  };
  markPatched(patched);
  globalThis[name] = patched;
  cleanups.push(() => {
    globalThis[name] = original;
    activeMap.clear();
  });
}
function patchTimerClear(name, setName, activeMap) {
  const original = globalThis[name];
  if (isPatched(original)) return;
  const patched = function(id) {
    if (id != null) {
      const entry = activeMap.get(id);
      if (entry) {
        activeMap.delete(id);
        tw.pulse(`${setName}:clear`, {
          lane: "ui",
          kind: "timer-clear",
          source: "auto",
          correlationId: entry.correlationId,
          parentId: entry.parentId
        });
      }
    }
    return original(id);
  };
  markPatched(patched);
  globalThis[name] = patched;
  cleanups.push(() => {
    globalThis[name] = original;
  });
}
function patchEvents(opts) {
  if (typeof EventTarget === "undefined") return;
  const origAdd = EventTarget.prototype.addEventListener;
  const origRemove = EventTarget.prototype.removeEventListener;
  if (isPatched(origAdd)) return;
  const allowed = opts?.include ? new Set(opts.include) : new Set(DEFAULT_EVENTS);
  if (opts?.exclude) {
    for (const ex of opts.exclude) allowed.delete(ex);
  }
  const wrapperMap = /* @__PURE__ */ new WeakMap();
  const patchedAdd = function addEventListener(type, listener, options) {
    if (!listener || !allowed.has(type)) {
      return origAdd.call(this, type, listener, options);
    }
    const scope = currentScope();
    const isOnce = typeof options === "object" && options?.once === true;
    let addCid;
    if (scope && !isOnce) {
      addCid = tw.pulse(`listener:${type}:add`, {
        lane: "ui",
        kind: "listener-add",
        source: "auto",
        parentId: scope.correlationId,
        meta: { type }
      }).correlationId;
    }
    const target = this;
    const wrapped = function(event) {
      tw.pulse(`event:${type}`, {
        lane: "ui",
        kind: "dom-event",
        source: "auto",
        parentId: scope?.correlationId,
        meta: {
          type,
          target: event.target?.tagName ?? "unknown"
        }
      });
      if (typeof listener === "function") {
        listener.call(target, event);
      } else {
        listener.handleEvent(event);
      }
    };
    if (!wrapperMap.has(listener)) wrapperMap.set(listener, /* @__PURE__ */ new Map());
    wrapperMap.get(listener).set(type, { wrapped, correlationId: addCid });
    return origAdd.call(this, type, wrapped, options);
  };
  const patchedRemove = function removeEventListener(type, listener, options) {
    if (!listener) return origRemove.call(this, type, listener, options);
    const mappings = wrapperMap.get(listener);
    const entry = mappings?.get(type);
    if (entry) {
      mappings.delete(type);
      if (entry.correlationId) {
        tw.pulse(`listener:${type}:remove`, {
          lane: "ui",
          kind: "listener-remove",
          source: "auto",
          correlationId: entry.correlationId
        });
      }
      return origRemove.call(this, type, entry.wrapped, options);
    }
    return origRemove.call(this, type, listener, options);
  };
  markPatched(patchedAdd);
  EventTarget.prototype.addEventListener = patchedAdd;
  EventTarget.prototype.removeEventListener = patchedRemove;
  cleanups.push(() => {
    EventTarget.prototype.addEventListener = origAdd;
    EventTarget.prototype.removeEventListener = origRemove;
  });
}
function patchWebSocket() {
  if (typeof WebSocket === "undefined") return;
  const OrigWebSocket = globalThis.WebSocket;
  if (isPatched(OrigWebSocket)) return;
  const origDescriptors = Object.getOwnPropertyDescriptors(OrigWebSocket);
  const origProto = OrigWebSocket.prototype;
  function PatchedWebSocket(url, protocols) {
    const ws = new OrigWebSocket(url, protocols);
    const urlStr = String(url);
    const scope = currentScope();
    const correlationId = tw.pulse("ws:open:start", {
      lane: "ws",
      kind: "request",
      source: "auto",
      parentId: scope?.correlationId,
      meta: { url: truncateUrl(urlStr) }
    }).correlationId;
    ws.addEventListener("open", () => {
      tw.pulse("ws:open:done", {
        lane: "ws",
        kind: "response",
        source: "auto",
        correlationId,
        parentId: scope?.correlationId,
        meta: { url: truncateUrl(urlStr) }
      });
    });
    ws.addEventListener("message", () => {
      tw.pulse("ws:message", {
        lane: "ws",
        kind: "message",
        source: "auto",
        correlationId,
        parentId: scope?.correlationId,
        meta: { url: truncateUrl(urlStr) }
      });
    });
    ws.addEventListener("close", (e) => {
      tw.pulse("ws:close", {
        lane: "ws",
        kind: "close",
        source: "auto",
        correlationId,
        parentId: scope?.correlationId,
        meta: { url: truncateUrl(urlStr), code: e.code }
      });
    });
    ws.addEventListener("error", () => {
      tw.pulse("ws:error", {
        lane: "ws",
        kind: "error",
        source: "auto",
        correlationId,
        parentId: scope?.correlationId,
        meta: { url: truncateUrl(urlStr) }
      });
    });
    return ws;
  }
  PatchedWebSocket.prototype = origProto;
  for (const [key, desc] of Object.entries(origDescriptors)) {
    if (key !== "prototype" && key !== "length" && key !== "name") {
      Object.defineProperty(PatchedWebSocket, key, desc);
    }
  }
  markPatched(PatchedWebSocket);
  globalThis.WebSocket = PatchedWebSocket;
  cleanups.push(() => {
    globalThis.WebSocket = OrigWebSocket;
  });
}
function captureCallSite() {
  const err = {};
  Error.captureStackTrace?.(err, captureCallSite);
  const stack = err.stack ?? new Error().stack;
  if (!stack) return void 0;
  const lines = stack.split("\n");
  for (const line of lines) {
    if (!line || line.includes("pulscheck") || line.includes("node_modules")) continue;
    if (line.includes("instrument.ts") || line.includes("tw.ts") || line.includes("registry.ts")) continue;
    if (line.includes("devMode.ts") || line.includes("scope.ts") || line.includes("reporter.ts")) continue;
    const browserMatch = line.match(/https?:\/\/[^/]+\/(src\/[^?:]+|[^/?:]+\.[jt]sx?)[^:]*:(\d+)/);
    if (browserMatch) {
      return `${browserMatch[1]}:${browserMatch[2]}`;
    }
    const nodeMatch = line.match(/(?:at\s+(?:.*?\s+\()?)((?:\/|[A-Z]:\\).*?):(\d+)(?::(\d+))?/);
    if (nodeMatch) {
      const file = nodeMatch[1];
      const lineNum = nodeMatch[2];
      const short = file.replace(/^.*?\/src\//, "src/").replace(/^.*\/([^/]+)$/, "$1");
      return `${short}:${lineNum}`;
    }
  }
  return void 0;
}
function truncateUrl(url) {
  try {
    const parsed = new URL(url, "https://placeholder");
    return parsed.pathname.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}
function metaUrl(url) {
  try {
    const parsed = new URL(url, "https://placeholder");
    return (parsed.pathname + parsed.search).slice(0, 300);
  } catch {
    return url.slice(0, 300);
  }
}
function instrument(options = {}) {
  const {
    fetch: doFetch = true,
    timers: doTimers = true,
    events: doEvents = true,
    websocket: doWebSocket = true
  } = options;
  if (doFetch) patchFetch();
  if (doTimers) patchTimers();
  if (doEvents) {
    const eventOpts = typeof doEvents === "object" ? doEvents : void 0;
    patchEvents(eventOpts);
  }
  if (doWebSocket) patchWebSocket();
  return restore;
}
function restore() {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try {
      fn?.();
    } catch (_) {
    }
  }
  endpointGeneration.clear();
}

// src/analyze.ts
var TEARDOWN_SIGNALS = [
  "unmount",
  "dispose",
  "destroy",
  "cleanup",
  "close",
  "disconnect",
  "teardown",
  "unsubscribe",
  "detach",
  "remove"
];
var RECOVERY_SIGNALS = [
  "reconnect",
  "retry",
  "recover",
  "restart",
  "resume",
  "resubscribe",
  "reattach",
  "reopen",
  "fallback"
];
var REQUEST_SIGNALS = ["request", "fetch", "call", "send", "query", "start"];
var RESPONSE_SIGNALS = ["response", "result", "complete", "receive", "done", "end"];
var RENDER_SIGNALS = ["render", "update", "display", "show", "paint", "setState"];
function matchesAny(label, signals) {
  const lower = label.toLowerCase();
  return signals.some((s) => lower.includes(s));
}
function labelBase(label) {
  const parts = label.split(":");
  if (parts.length <= 1) return label;
  return parts.slice(0, -1).join(":");
}
function normalizeFetchLabel(label) {
  if (!label.startsWith("fetch:")) return label;
  const parts = label.split(":");
  if (parts.length < 3) return label;
  const path = parts[1];
  const suffix = parts.slice(2).join(":");
  const normalized = path.replace(
    /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]+|[0-9a-f]{24,})/gi,
    "/:id"
  );
  return `fetch:${normalized}:${suffix}`;
}
function isRequest(e) {
  if (e.kind) return e.kind === "request";
  return matchesAny(e.label, REQUEST_SIGNALS) && !matchesAny(e.label, RESPONSE_SIGNALS);
}
function isResponse(e) {
  if (e.kind) return e.kind === "response";
  return matchesAny(e.label, RESPONSE_SIGNALS);
}
function isTeardown(e) {
  if (e.kind) return e.kind === "scope-end";
  return matchesAny(e.label, TEARDOWN_SIGNALS);
}
function isRecovery(e) {
  return matchesAny(e.label, RECOVERY_SIGNALS);
}
function isRender(e) {
  if (e.kind) return e.kind === "render" || e.kind === "state-write";
  return matchesAny(e.label, RENDER_SIGNALS);
}
function isOperationStart(e) {
  if (e.kind) return e.kind === "request" || e.kind === "timer-start" || e.kind === "listener-add";
  return e.label.endsWith(":start") || matchesAny(e.label, REQUEST_SIGNALS) && !matchesAny(e.label, RESPONSE_SIGNALS);
}
function isOperationEnd(e) {
  if (e.kind) {
    return e.kind === "response" || e.kind === "timer-end" || e.kind === "timer-clear" || e.kind === "timer-tick" || e.kind === "error" || e.kind === "listener-remove";
  }
  return matchesAny(e.label, ["end", "complete", "response", "done", "fire", "clear", "tick"]);
}
function detectAfterTeardown(trace) {
  const findings = [];
  const groups = groupByCorrelation(trace);
  const parentIndex = /* @__PURE__ */ new Map();
  for (const e of trace) {
    if (e.parentId) {
      const arr = parentIndex.get(e.parentId) ?? [];
      arr.push(e);
      parentIndex.set(e.parentId, arr);
    }
  }
  for (const [cid, events] of groups) {
    const children = parentIndex.get(cid) ?? [];
    const merged = [...events, ...children];
    const seen = /* @__PURE__ */ new Set();
    const unique = merged.filter((e) => {
      if (seen.has(e)) return false;
      seen.add(e);
      return true;
    });
    const sorted = unique.sort((a, b) => a.beat - b.beat);
    const teardown = sorted.find(isTeardown);
    if (!teardown) continue;
    const afterTeardown = sorted.filter(
      (e) => e.beat > teardown.beat && e !== teardown
    );
    const recovery = afterTeardown.find(isRecovery);
    for (const stale of afterTeardown) {
      if (isTeardown(stale)) continue;
      if (isRecovery(stale)) continue;
      if (recovery && stale.beat >= recovery.beat) continue;
      findings.push({
        pattern: "after-teardown",
        severity: isRender(stale) ? "critical" : "warning",
        fix: "Add cleanup: clear timers, abort fetches (AbortController), unsubscribe listeners in useEffect return. A ref guard (if (!mountedRef.current) return) prevents late setState.",
        summary: `"${stale.label}" fired after "${teardown.label}" (cid: ${cid})`,
        detail: `Event "${stale.label}" at beat ${stale.beat.toFixed(2)} occurred ${(stale.beat - teardown.beat).toFixed(2)}ms after teardown "${teardown.label}" at beat ${teardown.beat.toFixed(2)}. This often means a callback, timer, or subscription wasn't cleaned up before disposal.` + (recovery ? ` (Note: recovery event "${recovery.label}" found \u2014 events after recovery are excluded.)` : ""),
        events: [teardown, stale],
        beatRange: [teardown.beat, stale.beat]
      });
    }
  }
  return findings;
}
function detectResponseReorder(sorted) {
  const findings = [];
  const requests = [];
  const responses = [];
  for (const e of sorted) {
    if (isRequest(e)) {
      requests.push(e);
    } else if (isResponse(e)) {
      responses.push(e);
    }
  }
  const requestsByBase = /* @__PURE__ */ new Map();
  for (const r of requests) {
    const base = labelBase(normalizeFetchLabel(r.label));
    const arr = requestsByBase.get(base) ?? [];
    arr.push(r);
    requestsByBase.set(base, arr);
  }
  for (const [base, reqs] of requestsByBase) {
    if (reqs.length < 2) continue;
    const pairs = [];
    for (const req of reqs) {
      const res = responses.find((r) => r.correlationId === req.correlationId);
      if (res) pairs.push({ req, res });
    }
    if (pairs.length < 2) continue;
    const reqOrder = pairs.map((p) => p.req.correlationId);
    const resByResponseTime = [...pairs].sort((a, b) => a.res.beat - b.res.beat);
    const resOrder = resByResponseTime.map((p) => p.req.correlationId);
    if (JSON.stringify(reqOrder) !== JSON.stringify(resOrder)) {
      const lastToResolve = resByResponseTime[resByResponseTime.length - 1];
      const lastResolveGen = lastToResolve.res.meta?.generation;
      const latestGen = lastToResolve.res.meta?.latestGeneration;
      const staleLastResolve = lastResolveGen != null && latestGen != null && lastResolveGen < latestGen;
      findings.push({
        pattern: "response-reorder",
        severity: staleLastResolve ? "critical" : "warning",
        fix: staleLastResolve ? "CONFIRMED STALE: The oldest request resolved last \u2014 its data overwrote the fresh result. Use AbortController to cancel superseded requests, or check a generation/sequence number before calling setState." : "Cancel stale requests with AbortController when a new request starts. Or stamp each request with an ID and discard responses from older requests before calling setState.",
        summary: staleLastResolve ? `Stale response for "${base}" resolved last \u2014 confirmed data corruption` : `Responses for "${base}" arrived out of request order`,
        detail: `Requests were sent in order [${reqOrder.join(", ")}] but responses arrived as [${resOrder.join(", ")}]. ` + (staleLastResolve ? `Generation tracking confirms the stale response (gen ${lastResolveGen}) resolved after the fresh one (latest gen ${latestGen}). Without cancellation, the UI now shows outdated data.` : `The last response to arrive may overwrite the correct (more recent) result.`),
        events: pairs.flatMap((p) => [p.req, p.res]),
        beatRange: [pairs[0].req.beat, pairs[pairs.length - 1].res.beat]
      });
    }
  }
  return findings;
}
function detectDoubleTrigger(sorted) {
  const findings = [];
  const starts = sorted.filter(isOperationStart);
  const byLabel = /* @__PURE__ */ new Map();
  for (const s of starts) {
    const key = normalizeFetchLabel(s.label);
    const arr = byLabel.get(key) ?? [];
    arr.push(s);
    byLabel.set(key, arr);
  }
  for (const [label, events] of byLabel) {
    if (events.length < 2) continue;
    const isGenericTimer = label === "setTimeout:start" || label === "setInterval:start";
    if (isGenericTimer) continue;
    for (let i = 0; i < events.length - 1; i++) {
      const first = events[i];
      const second = events[i + 1];
      const firstEnd = sorted.find(
        (e) => e.correlationId === first.correlationId && isOperationEnd(e)
      );
      const isOverlapping = !firstEnd || second.beat < firstEnd.beat;
      if (isOverlapping) {
        const sameParams = metaEqual(first.meta, second.meta);
        findings.push({
          pattern: "double-trigger",
          severity: sameParams ? "critical" : "info",
          fix: sameParams ? "Guard against duplicate triggers: check a loading flag before starting, debounce the action, or disable the trigger element until completion." : "Different parameters suggest intentional concurrency. If not intended, add deduplication by operation key.",
          summary: sameParams ? `"${label}" triggered twice concurrently with same parameters` : `"${label}" triggered twice concurrently (different parameters \u2014 likely intentional)`,
          detail: `Operation "${label}" was started at beat ${first.beat.toFixed(2)} (cid: ${first.correlationId}) and again at beat ${second.beat.toFixed(2)} (cid: ${second.correlationId}) ${firstEnd ? `before the first completed at beat ${firstEnd.beat.toFixed(2)}` : "and the first hasn't completed yet"}. ` + (sameParams ? `Both have identical parameters \u2014 this often indicates a missing mutex, debounce, or deduplication.` : `Parameters differ, so this may be intentional concurrency rather than a bug.`),
          events: [first, second, ...firstEnd ? [firstEnd] : []],
          beatRange: [first.beat, (firstEnd ?? second).beat]
        });
      }
    }
  }
  return findings;
}
function detectSequenceGap(trace) {
  const findings = [];
  const groups = /* @__PURE__ */ new Map();
  for (const e of trace) {
    if (!e.meta || typeof e.meta.seq !== "number") continue;
    const key = `${e.correlationId}::${e.label}`;
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }
  for (const [key, events] of groups) {
    const sorted = [...events].sort(
      (a, b) => a.meta.seq - b.meta.seq
    );
    if (sorted.length < 2) continue;
    const cid = sorted[0].correlationId;
    const label = sorted[0].label;
    const seqs = sorted.map((e) => e.meta.seq);
    for (let i = 1; i < seqs.length; i++) {
      const gap = seqs[i] - seqs[i - 1];
      if (gap > 1) {
        findings.push({
          pattern: "sequence-gap",
          severity: "critical",
          fix: "Handle reconnection gaps: re-fetch missed data after WebSocket reconnect, or request a replay of the missing sequence range from the server.",
          summary: `Sequence gap in "${label}": ${gap - 1} missing between seq ${seqs[i - 1]} and ${seqs[i]} (cid: ${cid})`,
          detail: `"${label}" events with correlationId "${cid}" have sequence numbers [${seqs.join(", ")}]. ${gap - 1} item(s) are missing between positions ${seqs[i - 1]} and ${seqs[i]}. This often indicates dropped messages, lost events, or a reconnect gap.`,
          events: [sorted[i - 1], sorted[i]],
          beatRange: [sorted[i - 1].beat, sorted[i].beat]
        });
      }
    }
  }
  return findings;
}
function detectStaleOverwrite(sorted) {
  const findings = [];
  const renders = sorted.filter(isRender);
  if (renders.length < 2) return findings;
  const byBase = /* @__PURE__ */ new Map();
  for (const r of renders) {
    const base = labelBase(r.label);
    const arr = byBase.get(base) ?? [];
    arr.push(r);
    byBase.set(base, arr);
  }
  for (const [base, renderEvents] of byBase) {
    if (renderEvents.length < 2) continue;
    for (let i = 0; i < renderEvents.length - 1; i++) {
      const earlier = renderEvents[i];
      const later = renderEvents[i + 1];
      const earlierReq = sorted.find(
        (e) => e.correlationId === earlier.correlationId && isRequest(e)
      );
      const laterReq = sorted.find(
        (e) => e.correlationId === later.correlationId && isRequest(e)
      );
      if (earlierReq && laterReq && laterReq.beat < earlierReq.beat) {
        findings.push({
          pattern: "stale-overwrite",
          severity: "critical",
          fix: "Check data freshness before rendering: track the most recent request timestamp and discard responses from older requests. AbortController also prevents this by canceling the slow request entirely.",
          summary: `Stale overwrite at "${base}": render from older request (${later.correlationId}) overwrote newer (${earlier.correlationId})`,
          detail: `Render at beat ${later.beat.toFixed(2)} is from request "${later.correlationId}" (sent at beat ${laterReq.beat.toFixed(2)}), which is OLDER than the previous render's request "${earlier.correlationId}" (sent at beat ${earlierReq.beat.toFixed(2)}). The UI now shows stale data. Fix: abort older requests, or check sequence before rendering.`,
          events: [laterReq, earlierReq, earlier, later],
          beatRange: [laterReq.beat, later.beat]
        });
      }
    }
  }
  return findings;
}
function groupByCorrelation(trace) {
  const groups = /* @__PURE__ */ new Map();
  for (const e of trace) {
    const arr = groups.get(e.correlationId) ?? [];
    arr.push(e);
    groups.set(e.correlationId, arr);
  }
  return groups;
}
var INTERNAL_META_KEYS = /* @__PURE__ */ new Set(["generation", "latestGeneration"]);
function metaEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const keysA = Object.keys(a).filter((k) => !INTERNAL_META_KEYS.has(k));
  const keysB = Object.keys(b).filter((k) => !INTERNAL_META_KEYS.has(k));
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}
function isDanglingResolved(start, completionKinds) {
  const kinds = completionKinds.get(start.correlationId);
  if (!kinds) return false;
  if (start.kind === "request" && start.label.startsWith("fetch:")) {
    return kinds.has("response") || kinds.has("error");
  }
  if (start.kind === "request" && start.label.startsWith("ws:")) {
    return kinds.has("response") || kinds.has("error") || kinds.has("close");
  }
  if (start.kind === "timer-start" && start.label.includes("setInterval")) {
    return kinds.has("timer-clear");
  }
  if (start.kind === "timer-start") {
    return kinds.has("timer-end") || kinds.has("timer-clear");
  }
  if (start.kind === "listener-add") {
    return kinds.has("listener-remove");
  }
  return kinds.has("response") || kinds.has("error") || kinds.has("timer-end") || kinds.has("timer-clear") || kinds.has("listener-remove") || kinds.has("close");
}
function detectDanglingAsync(trace) {
  const findings = [];
  const scopeTeardown = /* @__PURE__ */ new Map();
  for (const e of trace) {
    if (isTeardown(e)) {
      scopeTeardown.set(e.correlationId, e.beat);
    }
  }
  if (scopeTeardown.size === 0) return findings;
  const completionKinds = /* @__PURE__ */ new Map();
  for (const e of trace) {
    if (!e.kind) continue;
    let kinds = completionKinds.get(e.correlationId);
    if (!kinds) {
      kinds = /* @__PURE__ */ new Set();
      completionKinds.set(e.correlationId, kinds);
    }
    kinds.add(e.kind);
  }
  for (const e of trace) {
    if (!isOperationStart(e)) continue;
    if (!e.parentId) continue;
    const teardownAt = scopeTeardown.get(e.parentId);
    if (teardownAt === void 0) continue;
    if (e.beat >= teardownAt) continue;
    if (isDanglingResolved(e, completionKinds)) continue;
    const isInterval = e.label.includes("setInterval");
    const isTimer = e.kind === "timer-start";
    const isFetchOp = e.kind === "request" && e.label.startsWith("fetch:");
    const isWs = e.kind === "request" && e.label.startsWith("ws:");
    const isListener = e.kind === "listener-add";
    const opType = isFetchOp ? "fetch" : isWs ? "WebSocket" : isInterval ? "setInterval" : isTimer ? "setTimeout" : isListener ? "event listener" : "async operation";
    findings.push({
      pattern: "dangling-async",
      severity: "warning",
      summary: `${opType} "${e.label}" started but never completed (scope tore down)`,
      detail: isListener ? `Event listener "${e.label}" at beat ${e.beat.toFixed(2)} was added within a scope that tore down at beat ${teardownAt.toFixed(2)}, but removeEventListener was never called. The listener's closure retains references to component state, preventing garbage collection.` : `Operation "${e.label}" at beat ${e.beat.toFixed(2)} was started within a scope that tore down at beat ${teardownAt.toFixed(2)}, but no completion event (response, error, fire, or clear) was ever recorded. The ${opType} was abandoned and may resolve later, attempting to update state that no longer exists.`,
      fix: isFetchOp ? "Add AbortController: const ctrl = new AbortController(); fetch(url, {signal: ctrl.signal}); return () => ctrl.abort();" : isInterval ? "Clear interval in cleanup: return () => clearInterval(id);" : isTimer ? "Clear timeout in cleanup: return () => clearTimeout(id);" : isWs ? "Close WebSocket in cleanup: return () => ws.close();" : isListener ? "Remove listener in cleanup: return () => target.removeEventListener(type, handler);" : "Clean up the async operation in the useEffect return function.",
      events: [e],
      beatRange: [e.beat, teardownAt]
    });
  }
  return findings;
}
function fingerprint(f) {
  const labels = f.events.map((e) => e.label).sort().join(",");
  const site = f.events.find((e) => e.callSite)?.callSite;
  return site ? `${f.pattern}::${labels}::${site}` : `${f.pattern}::${labels}`;
}
function analyze(trace, opts = {}) {
  const suppress = new Set(opts.suppress ?? []);
  const minSev = opts.minSeverity ?? "info";
  const sorted = [...trace].sort((a, b) => a.beat - b.beat);
  const detectors = [
    ["after-teardown", () => detectAfterTeardown(trace)],
    ["response-reorder", () => detectResponseReorder(sorted)],
    ["double-trigger", () => detectDoubleTrigger(sorted)],
    ["sequence-gap", () => detectSequenceGap(trace)],
    ["stale-overwrite", () => detectStaleOverwrite(sorted)],
    ["dangling-async", () => detectDanglingAsync(trace)]
  ];
  const severityOrder = {
    critical: 0,
    warning: 1,
    info: 2
  };
  let findings = [];
  for (const [pattern, detect] of detectors) {
    if (suppress.has(pattern)) continue;
    findings.push(...detect());
  }
  const minOrder = severityOrder[minSev];
  findings = findings.filter((f) => severityOrder[f.severity] <= minOrder);
  if (opts.filter) {
    findings = findings.filter(opts.filter);
  }
  findings.sort((a, b) => {
    const sev = severityOrder[a.severity] - severityOrder[b.severity];
    if (sev !== 0) return sev;
    return a.beatRange[0] - b.beatRange[0];
  });
  return findings;
}

// src/reporter.ts
var SEVERITY_ICON = {
  critical: "\u{1F6D1}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F"
};
function formatFinding(entry, log) {
  const f = entry.finding;
  const icon = SEVERITY_ICON[f.severity];
  const countStr = entry.count > 1 ? ` (x${entry.count})` : "";
  log(`${icon} [${f.severity.toUpperCase()}] ${f.summary}${countStr}`);
  log(`   Pattern: ${f.pattern}`);
  log(`   ${f.detail}`);
  const sites = f.events.filter((e) => e.callSite).map((e) => ({ label: e.label, site: e.callSite }));
  if (sites.length > 0) {
    const unique = [...new Map(sites.map((s) => [s.site, s])).values()];
    if (unique.length === 1) {
      log(`   Location: ${unique[0].site}`);
    } else {
      log(`   Locations:`);
      for (const s of unique) {
        log(`     \u2192 ${s.site}  (${s.label})`);
      }
    }
  }
  if (f.fix) {
    log(`   Fix: ${f.fix}`);
  }
  log("");
}
function createReporter(options = {}) {
  const {
    intervalMs = 5e3,
    minSeverity = "warning",
    suppress,
    log = (msg) => console.log(msg),
    quiet = false
  } = options;
  let intervalId = null;
  const seen = /* @__PURE__ */ new Map();
  function check() {
    const trace = registry.trace;
    if (trace.length === 0) return [];
    return analyze(trace, { minSeverity, suppress });
  }
  function report() {
    const findings = check();
    if (findings.length === 0) return;
    let newFindings = 0;
    for (const f of findings) {
      const fp = fingerprint(f);
      const existing = seen.get(fp);
      if (existing) {
        existing.count++;
        existing.lastBeat = f.beatRange[1];
        existing.finding = f;
      } else {
        seen.set(fp, {
          finding: f,
          count: 1,
          firstBeat: f.beatRange[0],
          lastBeat: f.beatRange[1]
        });
        newFindings++;
      }
    }
    if (newFindings === 0) return;
    const toPrint = [...seen.values()].filter((e) => e.count === 1);
    if (toPrint.length === 0) return;
    log(`
[pulscheck] ${toPrint.length} new finding(s):
`);
    for (const entry of toPrint) {
      formatFinding(entry, log);
    }
    const recurring = [...seen.values()].filter((e) => e.count > 1);
    if (recurring.length > 0) {
      log(`[pulscheck] ${recurring.length} recurring issue(s) suppressed (use reporter.reset() to re-report)`);
      log("");
    }
  }
  return {
    start() {
      if (intervalId) return;
      if (!quiet) {
        log("[pulscheck] Reporter started \u2014 monitoring for race conditions\n");
      }
      report();
      intervalId = _nativeSetInterval(report, intervalMs);
    },
    stop() {
      if (!intervalId) return;
      _nativeClearInterval(intervalId);
      intervalId = null;
      if (!quiet) {
        log("[pulscheck] Reporter stopped\n");
      }
    },
    check,
    reset() {
      seen.clear();
    }
  };
}

// src/devMode.ts
function devMode(options = {}) {
  const { reporter: reporterOpts, ...instrumentOpts } = options;
  const restoreGlobals = instrument(instrumentOpts);
  const reporter = createReporter(reporterOpts);
  reporter.start();
  console.log(
    "%c[pulscheck]%c active \u2014 monitoring fetch, timers, events, WebSocket for race conditions",
    "color: #e94560; font-weight: bold",
    "color: inherit"
  );
  return () => {
    reporter.stop();
    restoreGlobals();
  };
}

// src/react.ts
function usePulse(label, opts = {}) {
  useEffect(() => {
    tw.pulse(label, opts);
  });
}
function usePulseRender(label, opts = {}) {
  tw.pulse(label, opts);
}
function usePulseMount(label, opts = {}) {
  useEffect(() => {
    tw.pulse(`${label}:mount`, opts);
    return () => {
      tw.pulse(`${label}:unmount`, opts);
    };
  }, []);
}
function usePulseMeasure(label, opts = {}) {
  const lastBeat = useRef(null);
  const count = useRef(0);
  useEffect(() => {
    count.current++;
    const now2 = performance?.now?.() ?? Date.now();
    if (lastBeat.current !== null) {
      tw.pulse(label, { ...opts, meta: { ...opts.meta, durationMs: now2 - lastBeat.current, renderCount: count.current } });
    }
    lastBeat.current = now2;
  });
}
function inferComponentName() {
  try {
    const stack = new Error().stack ?? "";
    const lines = stack.split("\n");
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.includes("node_modules")) continue;
      if (line.includes("inferComponentName")) continue;
      if (line.includes("useScopedEffect")) continue;
      if (line.includes("useScopedLayoutEffect")) continue;
      const match = line.match(/at\s+(\w+)/);
      if (match && match[1] !== "Object" && match[1] !== "Module" && match[1] !== "eval") {
        return match[1];
      }
    }
  } catch {
  }
  return "unknown";
}
function useScopedEffect(effect, deps, name) {
  const nameRef = useRef(name);
  if (nameRef.current === void 0 && name === void 0) {
    nameRef.current = inferComponentName();
  }
  useEffect(() => {
    const scope = tw.scope(nameRef.current ?? name ?? "unknown");
    const cleanup = effect();
    scope.deactivate();
    return () => {
      if (typeof cleanup === "function") cleanup();
      scope.end();
    };
  }, deps);
}
function useScopedLayoutEffect(effect, deps, name) {
  const nameRef = useRef(name);
  if (nameRef.current === void 0 && name === void 0) {
    nameRef.current = inferComponentName();
  }
  useLayoutEffect(() => {
    const scope = tw.scope(nameRef.current ?? name ?? "unknown");
    const cleanup = effect();
    scope.deactivate();
    return () => {
      if (typeof cleanup === "function") cleanup();
      scope.end();
    };
  }, deps);
}
function TwProvider({ children, options }) {
  const cleanupRef = useRef(null);
  useEffect(() => {
    cleanupRef.current = devMode(options);
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);
  return children;
}

export { TwProvider, usePulse, usePulseMeasure, usePulseMount, usePulseRender, useScopedEffect, useScopedLayoutEffect };
