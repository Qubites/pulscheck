/**
 * instrument.ts — Auto-instrumentation layer
 *
 * Patches browser/Node globals (fetch, timers, events, WebSocket)
 * to emit pulses automatically. Combined with tw.scope(), enables
 * the analyzer to detect race conditions without manual pulse placement.
 *
 * @example
 *   import { instrument } from 'pulscheck'
 *   const cleanup = instrument()           // patches all globals
 *   // ... app runs, pulses auto-emitted ...
 *   cleanup()                              // restores originals
 */

import { tw } from "./tw";
import { currentScope } from "./scope";

// ─── Types ──────────────────────────────────────────────────────────

export interface EventInstrumentOptions {
  /** Only instrument these event types (overrides default list) */
  include?: string[];
  /** Exclude these event types from instrumentation */
  exclude?: string[];
}

export interface InstrumentOptions {
  /** Instrument globalThis.fetch. Default: true */
  fetch?: boolean;
  /** Instrument setTimeout / setInterval. Default: true */
  timers?: boolean;
  /** Instrument addEventListener. Default: true. Pass object to customize. */
  events?: boolean | EventInstrumentOptions;
  /** Instrument WebSocket. Default: true */
  websocket?: boolean;
}

// ─── Sentinel to prevent double-patching ────────────────────────────

const PATCHED = Symbol.for("tw.patched");

function isPatched(fn: unknown): boolean {
  return typeof fn === "function" && (fn as any)[PATCHED] === true;
}

function markPatched(fn: Function): void {
  (fn as any)[PATCHED] = true;
}

// ─── Native references (captured before any patching) ───────────────
// Used by reporter.ts and internally to avoid self-instrumentation.

export const _nativeSetTimeout = globalThis.setTimeout;
export const _nativeSetInterval = globalThis.setInterval;
export const _nativeClearTimeout = globalThis.clearTimeout;
export const _nativeClearInterval = globalThis.clearInterval;

// ─── Timer tracking ────────────────────────────────────────────────
// Maps timer IDs to correlation info for clearTimeout/clearInterval patches.

interface TimerEntry { correlationId: string; parentId?: string }
const activeTimeouts = new Map<ReturnType<typeof setTimeout>, TimerEntry>();
const activeIntervals = new Map<ReturnType<typeof setInterval>, TimerEntry>();

// ─── Default event allowlist ────────────────────────────────────────
// Only events that are meaningful for race detection.
// High-frequency events (scroll, mousemove, etc.) excluded by default.

const DEFAULT_EVENTS = new Set([
  "click", "dblclick", "submit", "change", "input",
  "focus", "blur", "keydown", "keyup",
  "popstate", "hashchange", "beforeunload",
  "visibilitychange", "online", "offline",
  "error", "unhandledrejection",
]);

// ─── Cleanup registry ───────────────────────────────────────────────

const cleanups: Array<() => void> = [];

// ─── Generation tracking ───────────────────────────────────────────
// Tracks per-endpoint request generation for sink-awareness.
// When a new request fires for an endpoint, its generation increments.
// On response, we stamp whether this was the latest or stale.
// This lets the analyzer distinguish "responses overlapped" (warning)
// from "stale response was last to resolve" (critical — app used it).

const endpointGeneration = new Map<string, number>();

function nextGeneration(endpoint: string): number {
  const gen = (endpointGeneration.get(endpoint) ?? 0) + 1;
  endpointGeneration.set(endpoint, gen);
  return gen;
}

function currentGeneration(endpoint: string): number {
  return endpointGeneration.get(endpoint) ?? 0;
}

// ─── Fetch patch ────────────────────────────────────────────────────

function patchFetch(): void {
  if (typeof globalThis.fetch !== "function") return;
  if (isPatched(globalThis.fetch)) return;

  const original = globalThis.fetch;

  const patched: typeof fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
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
      callSite,
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
        meta: { url: fullUrl, method, status: response.status, generation: gen, latestGeneration: latestGen },
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
        meta: { url: fullUrl, method, error: String(error), generation: gen, latestGeneration: latestGen },
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

// ─── Timer patches ──────────────────────────────────────────────────

function patchTimers(): void {
  patchTimerSet("setTimeout", "delay", "timer-end", "setTimeout:fire", true, activeTimeouts);
  patchTimerSet("setInterval", "interval", "timer-tick", "setInterval:tick", false, activeIntervals);
  patchTimerClear("clearTimeout", "setTimeout", activeTimeouts);
  patchTimerClear("clearInterval", "setInterval", activeIntervals);
}

function patchTimerSet(
  name: "setTimeout" | "setInterval",
  metaKey: string,
  fireKind: string,
  fireLabel: string,
  removeOnFire: boolean,
  activeMap: Map<ReturnType<typeof setTimeout>, TimerEntry>,
): void {
  const original = globalThis[name];
  if (isPatched(original)) return;

  const patched = function (handler: TimerHandler, timeout?: number, ...args: unknown[]) {
    if (typeof handler !== "function") return original(handler as string, timeout);

    const scope = currentScope();
    const callSite = captureCallSite();
    const correlationId = tw.pulse(`${name}:start`, {
      lane: "ui", kind: "timer-start", source: "auto",
      parentId: scope?.correlationId,
      meta: { [metaKey]: timeout ?? 0 },
      callSite,
    }).correlationId;

    const id = original(() => {
      if (removeOnFire) activeMap.delete(id);
      tw.pulse(fireLabel, {
        lane: "ui", kind: fireKind as any, source: "auto",
        correlationId, parentId: scope?.correlationId,
        meta: { [metaKey]: timeout ?? 0 },
      });
      (handler as Function)(...args);
    }, timeout);

    activeMap.set(id, { correlationId, parentId: scope?.correlationId });
    return id;
  };

  markPatched(patched);
  (globalThis as any)[name] = patched;
  cleanups.push(() => { (globalThis as any)[name] = original; activeMap.clear(); });
}

function patchTimerClear(
  name: "clearTimeout" | "clearInterval",
  setName: "setTimeout" | "setInterval",
  activeMap: Map<ReturnType<typeof setTimeout>, TimerEntry>,
): void {
  const original = globalThis[name];
  if (isPatched(original)) return;

  const patched = function (id?: ReturnType<typeof setTimeout>) {
    if (id != null) {
      const entry = activeMap.get(id);
      if (entry) {
        activeMap.delete(id);
        tw.pulse(`${setName}:clear`, {
          lane: "ui", kind: "timer-clear", source: "auto",
          correlationId: entry.correlationId, parentId: entry.parentId,
        });
      }
    }
    return original(id);
  };

  markPatched(patched);
  (globalThis as any)[name] = patched;
  cleanups.push(() => { (globalThis as any)[name] = original; });
}

// ─── Event listener patch ───────────────────────────────────────────

function patchEvents(opts?: EventInstrumentOptions): void {
  if (typeof EventTarget === "undefined") return;

  const origAdd = EventTarget.prototype.addEventListener;
  const origRemove = EventTarget.prototype.removeEventListener;

  if (isPatched(origAdd)) return;

  // Build the set of event types to instrument
  const allowed = opts?.include
    ? new Set(opts.include)
    : new Set(DEFAULT_EVENTS);
  if (opts?.exclude) {
    for (const ex of opts.exclude) allowed.delete(ex);
  }

  // Map original handlers to wrapped handlers for proper removeEventListener.
  // Also stores the correlationId from listener:add so listener:remove can reference it.
  interface ListenerEntry { wrapped: EventListener; correlationId?: string }
  const wrapperMap = new WeakMap<
    EventListenerOrEventListenerObject,
    Map<string, ListenerEntry>
  >();

  const patchedAdd = function addEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (!listener || !allowed.has(type)) {
      return origAdd.call(this, type, listener, options);
    }

    const scope = currentScope();
    const isOnce = typeof options === "object" && options?.once === true;

    // Emit listener:add when inside an active scope (and not {once: true} which auto-removes)
    let addCid: string | undefined;
    if (scope && !isOnce) {
      addCid = tw.pulse(`listener:${type}:add`, {
        lane: "ui",
        kind: "listener-add",
        source: "auto",
        parentId: scope.correlationId,
        meta: { type },
      }).correlationId;
    }

    const target = this;
    const wrapped: EventListener = function (event: Event) {
      tw.pulse(`event:${type}`, {
        lane: "ui",
        kind: "dom-event",
        source: "auto",
        parentId: scope?.correlationId,
        meta: {
          type,
          target: (event.target as Element)?.tagName ?? "unknown",
        },
      });
      if (typeof listener === "function") {
        listener.call(target, event);
      } else {
        listener.handleEvent(event);
      }
    };

    // Store mapping so removeEventListener can find the wrapper and its correlationId
    if (!wrapperMap.has(listener)) wrapperMap.set(listener, new Map());
    wrapperMap.get(listener)!.set(type, { wrapped, correlationId: addCid });

    return origAdd.call(this, type, wrapped, options);
  };

  const patchedRemove = function removeEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (!listener) return origRemove.call(this, type, listener, options);

    const mappings = wrapperMap.get(listener);
    const entry = mappings?.get(type);

    if (entry) {
      mappings!.delete(type);

      // Emit listener:remove with the same correlationId as the add
      if (entry.correlationId) {
        tw.pulse(`listener:${type}:remove`, {
          lane: "ui",
          kind: "listener-remove",
          source: "auto",
          correlationId: entry.correlationId,
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

// ─── WebSocket patch ────────────────────────────────────────────────

function patchWebSocket(): void {
  if (typeof WebSocket === "undefined") return;

  const OrigWebSocket = globalThis.WebSocket;
  if (isPatched(OrigWebSocket)) return;

  const origDescriptors = Object.getOwnPropertyDescriptors(OrigWebSocket);
  const origProto = OrigWebSocket.prototype;

  function PatchedWebSocket(
    this: WebSocket,
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    const ws = new OrigWebSocket(url, protocols);
    const urlStr = String(url);
    const scope = currentScope();

    const correlationId = tw.pulse("ws:open:start", {
      lane: "ws",
      kind: "request",
      source: "auto",
      parentId: scope?.correlationId,
      meta: { url: truncateUrl(urlStr) },
    }).correlationId;

    ws.addEventListener("open", () => {
      tw.pulse("ws:open:done", {
        lane: "ws",
        kind: "response",
        source: "auto",
        correlationId,
        parentId: scope?.correlationId,
        meta: { url: truncateUrl(urlStr) },
      });
    });

    ws.addEventListener("message", () => {
      tw.pulse("ws:message", {
        lane: "ws",
        kind: "message",
        source: "auto",
        correlationId,
        parentId: scope?.correlationId,
        meta: { url: truncateUrl(urlStr) },
      });
    });

    ws.addEventListener("close", (e: CloseEvent) => {
      tw.pulse("ws:close", {
        lane: "ws",
        kind: "close",
        source: "auto",
        correlationId,
        parentId: scope?.correlationId,
        meta: { url: truncateUrl(urlStr), code: e.code },
      });
    });

    ws.addEventListener("error", () => {
      tw.pulse("ws:error", {
        lane: "ws",
        kind: "error",
        source: "auto",
        correlationId,
        parentId: scope?.correlationId,
        meta: { url: truncateUrl(urlStr) },
      });
    });

    return ws;
  }

  // Preserve static properties (CONNECTING, OPEN, CLOSING, CLOSED)
  PatchedWebSocket.prototype = origProto;
  for (const [key, desc] of Object.entries(origDescriptors)) {
    if (key !== "prototype" && key !== "length" && key !== "name") {
      Object.defineProperty(PatchedWebSocket, key, desc);
    }
  }

  markPatched(PatchedWebSocket);
  (globalThis as any).WebSocket = PatchedWebSocket;

  cleanups.push(() => {
    (globalThis as any).WebSocket = OrigWebSocket;
  });
}

// ─── Call site capture ──────────────────────────────────────────────
// Captures the file:line where the original call happened.
// Walks up the stack past pulscheck internals to find user code.

function captureCallSite(): string | undefined {
  const err: { stack?: string } = {};
  Error.captureStackTrace?.(err, captureCallSite);
  const stack = err.stack ?? new Error().stack;
  if (!stack) return undefined;

  const lines = stack.split("\n");
  for (const line of lines) {
    // Skip pulscheck internals, node_modules, and empty lines
    if (!line || line.includes("pulscheck") || line.includes("node_modules")) continue;
    if (line.includes("instrument.ts") || line.includes("tw.ts") || line.includes("registry.ts")) continue;
    if (line.includes("devMode.ts") || line.includes("scope.ts") || line.includes("reporter.ts")) continue;

    // Browser Vite URLs: "at useFaq (http://localhost:8080/src/hooks/useFaq.ts?t=123:12:5)"
    const browserMatch = line.match(/https?:\/\/[^/]+\/(src\/[^?:]+|[^/?:]+\.[jt]sx?)[^:]*:(\d+)/);
    if (browserMatch) {
      return `${browserMatch[1]}:${browserMatch[2]}`;
    }

    // Node.js paths: "at func (/abs/path/src/file.ts:12:5)" or "at /abs/path/src/file.ts:12:5"
    const nodeMatch = line.match(/(?:at\s+(?:.*?\s+\()?)((?:\/|[A-Z]:\\).*?):(\d+)(?::(\d+))?/);
    if (nodeMatch) {
      const file = nodeMatch[1];
      const lineNum = nodeMatch[2];
      const short = file.replace(/^.*?\/src\//, "src/").replace(/^.*\/([^/]+)$/, "$1");
      return `${short}:${lineNum}`;
    }
  }
  return undefined;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Extract pathname from URL for pulse labels (no query strings, max 120 chars) */
function truncateUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://placeholder");
    return parsed.pathname.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}

/** Preserve full URL for meta comparison (query params matter for dedup) */
function metaUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://placeholder");
    return (parsed.pathname + parsed.search).slice(0, 300);
  } catch {
    return url.slice(0, 300);
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Patch browser/Node globals to auto-emit pulses at async boundaries.
 * Returns a cleanup function that restores all originals.
 *
 * @example
 *   import { instrument } from 'pulscheck'
 *
 *   // Instrument everything (default)
 *   const cleanup = instrument()
 *
 *   // Or selectively
 *   const cleanup = instrument({ fetch: true, timers: true, events: false })
 */
export function instrument(options: InstrumentOptions = {}): () => void {
  const {
    fetch: doFetch = true,
    timers: doTimers = true,
    events: doEvents = true,
    websocket: doWebSocket = true,
  } = options;

  if (doFetch) patchFetch();
  if (doTimers) patchTimers();
  if (doEvents) {
    const eventOpts = typeof doEvents === "object" ? doEvents : undefined;
    patchEvents(eventOpts);
  }
  if (doWebSocket) patchWebSocket();

  return restore;
}

/**
 * Remove all patches and restore original globals. Idempotent.
 */
export function restore(): void {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try { fn?.(); } catch (_) { /* swallow — original might already be restored */ }
  }
  endpointGeneration.clear();
}
