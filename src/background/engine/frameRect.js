// frameRect.js — find an embedded reader's on-screen rectangle in TOP-document
// CSS pixels, so the top-target screenshot can be cropped to just the book.
//
// Key insight that keeps this simple and robust: even when a book renders in a
// nested CROSS-ORIGIN iframe we can't read INTO, that iframe still occupies a
// visible box in the top document, and the top document CAN measure that box's
// position. So we don't need to descend the cross-origin boundary for the RECT
// (we only descend, via sessionId, to read page counters). We pick the largest
// content-area iframe in the top document and return its border-box rect.
//
// For deeply-nested wrapper->provider layouts, the OUTERMOST book wrapper's rect
// is what's visually on screen, which is exactly what we want to crop.

import { evalIn } from "./cdp.js";

const BIGGEST_IFRAME_RECT_JS = `(() => {
  let best = null, bestArea = 0;
  const consider = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) return;
      // Must be at least partly on-screen.
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = r; }
    } catch (e) {}
  };
  document.querySelectorAll("iframe").forEach(consider);
  if (!best) return null;
  return {
    x: Math.max(0, best.left),
    y: Math.max(0, best.top),
    width: Math.min(best.width, innerWidth - Math.max(0, best.left)),
    height: Math.min(best.height, innerHeight - Math.max(0, best.top)),
    dpr: window.devicePixelRatio || 1,
  };
})()`;

/**
 * Rect (top-document CSS px) of the largest visible content iframe, or null.
 * @param {{tabId:number}} topTarget  the TOP session (no sessionId)
 */
export async function biggestFrameRect(topTarget) {
  return await evalIn(topTarget, BIGGEST_IFRAME_RECT_JS, 8000);
}
