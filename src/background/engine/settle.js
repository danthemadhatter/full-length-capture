// settle.js — wait for a document to be visually stable before measuring or
// capturing it. Runs in a target session via Runtime.evaluate.
//
// Fires web fonts, forces lazy/IntersectionObserver images to load, nudges a
// scroll to trigger lazy content, then waits for a quiet period. Returns the
// document metrics AFTER settling, because forced loads change the height (a
// classic printToPDF bug: measuring before fonts.ready then printing at the
// wrong height).

import { evalIn } from "./cdp.js";

const SETTLE_JS = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    // Kick lazy images: set loading=eager, force decode of in-DOM images.
    const imgs = Array.from(document.images || []);
    for (const im of imgs) { try { im.loading = "eager"; if (im.decode) im.decode().catch(()=>{}); } catch(e){} }
    // Nudge scroll to trip scroll-triggered lazy loaders, then restore.
    const se = document.scrollingElement || document.documentElement;
    const y0 = se ? se.scrollTop : 0;
    if (se) { se.scrollTop = se.scrollHeight; }
    await sleep(120);
    if (se) { se.scrollTop = y0; }
    // Web fonts.
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch(e){} }
    // Two rAFs + a short quiet period for layout to settle.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(200);
  } catch (e) {}
  const de = document.documentElement, b = document.body;
  return {
    scrollWidth:  Math.max(de.scrollWidth,  b ? b.scrollWidth  : 0),
    scrollHeight: Math.max(de.scrollHeight, b ? b.scrollHeight : 0),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  };
})()`;

export async function settle(target, timeoutMs = 20000) {
  const m = await evalIn(target, SETTLE_JS, timeoutMs);
  return (
    m || { scrollWidth: 0, scrollHeight: 0, innerWidth: 0, innerHeight: 0, dpr: 1 }
  );
}
