import type { PulseEvent } from "./types";
type PulseHandler = (event: PulseEvent) => void;

let _isDevCached: boolean | undefined;
const isDev = (): boolean => {
  if (_isDevCached !== undefined) return _isDevCached;
  try { if (typeof process !== "undefined" && process.env?.NODE_ENV) return (_isDevCached = process.env.NODE_ENV !== "production"); } catch (_) {}
  if (typeof window !== "undefined") return (_isDevCached = !(window as any).__TW_PRODUCTION__);
  return (_isDevCached = true);
};

class PulseRegistry {
  private handlers = new Set<PulseHandler>();
  private _buf: (PulseEvent | undefined)[];
  private _head = 0; private _count = 0; private _cap: number;
  private _enabled = true; private _winCap = 500;

  constructor(capacity = 10_000) { this._cap = capacity; this._buf = new Array(capacity); }

  configure(opts: { enabled?: boolean; maxTrace?: number }): void {
    if (opts.enabled !== undefined) this._enabled = opts.enabled;
    if (opts.maxTrace !== undefined) { this._cap = opts.maxTrace; this._buf = new Array(opts.maxTrace); this._head = 0; this._count = 0; }
  }

  on(handler: PulseHandler): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }

  emit(event: PulseEvent): void {
    if (!isDev() && !event.public) return;
    if (!this._enabled) return;
    this._buf[this._head] = event;
    this._head = (this._head + 1) % this._cap;
    if (this._count < this._cap) this._count++;
    for (const h of this.handlers) { try { h(event); } catch (e) { if (isDev()) console.warn("[pulscheck] handler error:", e); } }
    if (typeof window !== "undefined") {
      let arr: unknown[] = (window as any).__tw_pulses__ ?? [];
      arr.push({ label: event.label, ts: event.beat, lane: event.lane, correlationId: event.correlationId, meta: event.meta });
      // Batch trim at 2× capacity instead of per-emit splice(0,...) — amortized O(1)
      if (arr.length > this._winCap * 2) arr = arr.slice(-this._winCap);
      (window as any).__tw_pulses__ = arr;
    }
  }

  get trace(): readonly PulseEvent[] {
    if (this._count < this._cap) return this._buf.slice(0, this._count) as PulseEvent[];
    return [...this._buf.slice(this._head), ...this._buf.slice(0, this._head)] as PulseEvent[];
  }

  /** Zero-alloc iteration over the ring buffer. No array created. */
  forEach(fn: (event: PulseEvent, index: number) => void | false): void {
    if (this._count === 0) return;
    const start = this._count < this._cap ? 0 : this._head;
    for (let i = 0; i < this._count; i++) {
      const idx = (start + i) % this._cap;
      const result = fn(this._buf[idx]!, i);
      if (result === false) break;
    }
  }

  /** Zero-alloc: find first event matching predicate */
  find(fn: (event: PulseEvent) => boolean): PulseEvent | undefined {
    let found: PulseEvent | undefined;
    this.forEach((e) => {
      if (fn(e)) { found = e; return false; }
    });
    return found;
  }

  get length(): number { return this._count; }

  clear(): void { this._head = 0; this._count = 0; }
}

export const registry = new PulseRegistry();
