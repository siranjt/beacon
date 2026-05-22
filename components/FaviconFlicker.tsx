"use client";

/**
 * FaviconFlicker — makes the browser-tab flame actually flicker in Chrome.
 *
 * Background: SVG favicons with embedded SMIL `<animate>` render animated
 * in Firefox and Safari, but Chrome explicitly ignores favicon animation
 * (security + perf). To get a flickering tab icon in Chrome, we cycle the
 * `<link rel="icon">` href between four pre-baked data-URL SVG frames at
 * ~140ms cadence. Each frame is the same lighthouse-tower-plus-flame mark
 * with slightly different opacity values on the outer ember + inner gold
 * flame, giving an organic candle-flicker feel.
 *
 * Mounted once at the root layout. Pauses while the tab isn't visible
 * (page Visibility API) so we don't waste CPU on background tabs.
 *
 * Falls back gracefully: if the browser doesn't support `<link rel=icon>`
 * mutation (very old engines), the static favicon-32.svg metadata icon
 * stays in place.
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
  // Inline SVG. Same viewBox as favicon-192.svg so it rasterizes cleanly
  // at any size the browser asks for (16/32/48/192).
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

export default function FaviconFlicker() {
  useEffect(() => {
    if (typeof document === "undefined") return;

    // Locate (or create) the favicon link. Next.js metadata.icons typically
    // emits multiple <link rel="icon"> tags; we drive the largest one and
    // remove the rest so the browser doesn't oscillate between sources.
    const head = document.head;
    const existing = Array.from(
      head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'),
    );
    let link: HTMLLinkElement;
    if (existing.length > 0) {
      link = existing[0];
      // Drop sibling icons so the browser binds to ours.
      existing.slice(1).forEach((el) => el.remove());
    } else {
      link = document.createElement("link");
      link.rel = "icon";
      link.type = "image/svg+xml";
      head.appendChild(link);
    }
    link.type = "image/svg+xml";

    let frame = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      frame = (frame + 1) % FRAME_URLS.length;
      link.href = FRAME_URLS[frame];
    };

    const start = () => {
      if (timer !== null) return;
      // Set frame 0 immediately so the icon swaps from the static file to
      // our animated stream on mount.
      link.href = FRAME_URLS[0];
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
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
