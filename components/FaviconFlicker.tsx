"use client";

/**
 * FaviconFlicker — makes the browser-tab flame flicker in Chrome.
 *
 * Background: SVG favicons with embedded SMIL `<animate>` render animated
 * in Firefox and Safari, but Chrome explicitly ignores favicon animation.
 * To get a flickering tab icon in Chrome, we cycle a `<link rel="icon">`
 * href between four pre-baked data-URL SVG frames at ~140ms cadence. Each
 * frame is the same lighthouse-tower-plus-flame mark with different
 * opacity values on the outer ember + inner gold flame, giving an organic
 * candle-flicker feel.
 *
 * IMPORTANT — DOM ownership:
 *   We APPEND our own <link rel="icon"> node and only mutate THAT one.
 *   We do NOT touch the favicon links Next.js's metadata system injected
 *   (favicon-16/32/48/192.svg). Mutating or removing React-managed DOM
 *   triggered "Cannot read properties of null (reading 'removeChild')"
 *   when Next.js's reconciler ran during route transitions — the earlier
 *   version of this component caused that crash. By owning a separate
 *   link element flagged with data-favicon-flicker, we leave Next.js's
 *   icons alone and the reconciler can't get confused.
 *
 *   Browser favicon selection: our link has `sizes="any"` + type="image/
 *   svg+xml". Per HTML spec, "any" means scalable — modern browsers
 *   (Chrome, Firefox, Safari) prefer it when rendering favicons at any
 *   target size. The static sized links from Next.js remain as a fallback
 *   for legacy / non-data-URL contexts (Apple Touch, manifest, etc.).
 *
 * Lifecycle:
 *   - Mounted once at root layout
 *   - Idempotent: if a previous flicker link is still in the head (e.g.
 *     React fast-refresh in dev), we reuse it instead of stacking duplicates
 *   - Pauses ticking while the tab is hidden (Visibility API) so background
 *     tabs don't burn CPU
 *   - On unmount, removes only its own link
 */

import { useEffect } from "react";

// Four flicker frames. The shape is identical to public/favicon-192.svg
// (4-tier stepped tower + ember outer flame + gold inner flame); only the
// per-layer opacity changes. The browser tab rasterizes each frame to
// 16/32px, and the alpha differences read as the flame breathing.
const FRAMES = [
  // Bright
  { outer: 1.0,  inner: 1.0  },
  // Dipped inner, full outer
  { outer: 0.95, inner: 0.7  },
  // Both dipped
  { outer: 0.85, inner: 0.85 },
  // Inner pops while outer steady
  { outer: 0.92, inner: 0.55 },
];

function buildFrame(outerOpacity: number, innerOpacity: number): string {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 -32 12 32" role="img" aria-label="Beacon">',
    '<rect x="-6" y="-4" width="12" height="4" fill="#0b051d"/>',
    '<rect x="-5" y="-10" width="10" height="4" fill="#0b051d"/>',
    '<rect x="-4" y="-16" width="8" height="4" fill="#0b051d"/>',
    '<rect x="-3" y="-22" width="6" height="4" fill="#0b051d"/>',
    `<path d="M 0 -32 C 4 -28 5 -23 3 -21 L -3 -21 C -5 -23 -4 -28 0 -32 Z" fill="#dc2626" opacity="${outerOpacity}"/>`,
    `<path d="M 0 -27 C 2 -24 3 -21 2 -19 L -2 -19 C -3 -21 -2 -24 0 -27 Z" fill="#facc15" opacity="${innerOpacity}"/>`,
    "</svg>",
  ].join("");
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// Pre-bake the data URLs so we don't allocate strings on every tick.
const FRAME_URLS = FRAMES.map((f) => buildFrame(f.outer, f.inner));

const TICK_MS = 140;
const MARKER_ATTR = "data-favicon-flicker";

export default function FaviconFlicker() {
  useEffect(() => {
    if (typeof document === "undefined") return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let link: HTMLLinkElement | null = null;

    try {
      // Reuse any prior flicker link (dev fast-refresh, double-mount in
      // React Strict Mode); otherwise create our own. Never reuse / remove
      // Next.js's metadata-managed icon links — those belong to React.
      const existing = document.querySelector<HTMLLinkElement>(
        `link[${MARKER_ATTR}]`,
      );
      if (existing) {
        link = existing;
      } else {
        const el = document.createElement("link");
        el.rel = "icon";
        el.type = "image/svg+xml";
        el.setAttribute("sizes", "any");
        el.setAttribute(MARKER_ATTR, "true");
        document.head.appendChild(el);
        link = el;
      }
    } catch {
      // If the DOM rejects (extremely rare), bail silently. Static SVG
      // favicons from Next.js metadata still render fine.
      return;
    }

    const tick = () => {
      if (cancelled || !link) return;
      try {
        // Cycle by reading current href + finding next frame. Cheap closure
        // over `frame` would also work; this is just stateless on `link`.
        const next = (frameIndex.current + 1) % FRAME_URLS.length;
        frameIndex.current = next;
        link.href = FRAME_URLS[next];
      } catch {
        /* swallow — never crash the page if favicon mutation throws */
      }
    };

    // Use a ref-like object so the closure over `tick` reads the latest
    // value without React re-renders.
    const frameIndex = { current: 0 };

    const start = () => {
      if (timer !== null) return;
      try {
        if (link) link.href = FRAME_URLS[0];
      } catch {
        /* ignore */
      }
      timer = setInterval(tick, TICK_MS);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      // Remove ONLY our own link on unmount. Use a defensive check —
      // never call removeChild on a node that's not in the head, otherwise
      // we re-introduce the crash this whole component was rewritten to
      // avoid.
      try {
        if (link && link.parentNode === document.head) {
          document.head.removeChild(link);
        }
      } catch {
        /* ignore */
      }
    };
  }, []);

  return null;
}
