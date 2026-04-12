/**
 * dom.ts — data-tw-pulse DOM attribute scanner
 *
 * Scans the DOM for elements with data-tw-pulse attributes and fires
 * pulse events when they become visible (IntersectionObserver) or
 * on DOMContentLoaded.
 *
 * Usage in JSX/HTML:
 *   <Skeleton data-tw-pulse="hero:loading" data-tw-lane="ui" data-tw-max="600" />
 *   <div data-tw-pulse="cart:visible" data-tw-public="true" />
 */

import type { PulseOptions } from "./types";
import { tw } from "./tw";

const ATTR_PULSE  = "data-tw-pulse";
const ATTR_LANE   = "data-tw-lane";
const ATTR_MAX    = "data-tw-max";
const ATTR_PUBLIC = "data-tw-public";
const ATTR_DOC    = "data-tw-doc";

function pulseElement(el: Element): void {
  const label = el.getAttribute(ATTR_PULSE);
  if (!label) return;

  const opts: PulseOptions = {
    lane:   (el.getAttribute(ATTR_LANE) ?? "ui") as PulseOptions["lane"],
    public: el.getAttribute(ATTR_PUBLIC) === "true",
    doc:    el.getAttribute(ATTR_DOC) ?? undefined,
    maxMs:  el.hasAttribute(ATTR_MAX)
              ? parseInt(el.getAttribute(ATTR_MAX)!, 10)
              : undefined,
    meta:   { element: el.tagName.toLowerCase(), id: el.id || undefined },
  };

  tw.pulse(label, opts);
}

/**
 * Scan the document for data-tw-pulse elements and fire pulses.
 * Call once after DOMContentLoaded, or after dynamic content renders.
 */
export function scanDom(root: Element | Document = document): void {
  if (typeof document === "undefined") return;
  const els = root.querySelectorAll(`[${ATTR_PULSE}]`);
  els.forEach(pulseElement);
}

/**
 * Observe data-tw-pulse elements and fire when they enter the viewport.
 * Returns a cleanup function.
 */
export function observeDom(root: Element | Document = document): () => void {
  if (typeof IntersectionObserver === "undefined" || typeof document === "undefined") {
    scanDom(root);
    return () => {};
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        pulseElement(entry.target);
        observer.unobserve(entry.target);
      }
    }
  }, { threshold: 0.1 });

  const els = root.querySelectorAll(`[${ATTR_PULSE}]`);
  els.forEach((el) => observer.observe(el));

  return () => observer.disconnect();
}

/**
 * Auto-initialize: scan on DOMContentLoaded and observe all pulse elements.
 * Call this once in your app entry point.
 *
 * @example
 * // In main.tsx / app entry
 * import { initDomPulse } from 'pulscheck'
 * initDomPulse()
 */
export function initDomPulse(): () => void {
  if (typeof document === "undefined") return () => {};

  let cleanup = () => {};

  if (document.readyState === "loading") {
    const onReady = () => {
      cleanup = observeDom(document);
      document.removeEventListener("DOMContentLoaded", onReady);
    };
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    cleanup = observeDom(document);
  }

  return cleanup;
}
