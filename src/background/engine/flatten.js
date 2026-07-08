// flatten.js — un-clip inner scroll containers so a page's full content flows
// top-to-bottom for printToPDF / whole-page capture.
//
// Corrections baked in from the red-team:
//  - overflow-Y ONLY (leave overflow-x) so wide tables/timelines aren't clipped
//    at the MediaBox edge.
//  - Recurse shadow roots AND same-origin iframe contentDocuments (D2L renders
//    topic content inside a same-origin iframe; without this its inner scroller
//    is never flattened and the capture is silently short).
//  - Reversible: we tag mutated elements and inject one <style>; restore removes
//    both. (Cross-origin child frames are flattened separately by calling this
//    on their own session — a frame can always style its own document.)

import { evalIn } from "./cdp.js";

const FLATTEN_JS = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const MARK = "__flc_flat";
  const clips = (cs) => /(auto|scroll|hidden)/.test(cs.overflowY) || (cs.maxHeight && cs.maxHeight !== "none");
  const tagIfClipping = (el, root) => {
    try {
      if (!el || el.nodeType !== 1) return;
      const cs = getComputedStyle(el);
      if (!clips(cs)) return;
      if (el.scrollHeight <= el.clientHeight + 4) return; // not actually overflowing
      el.setAttribute(MARK, "1");
    } catch (e) {}
  };
  const walk = (root) => {
    let all; try { all = root.querySelectorAll("*"); } catch (e) { return; }
    for (const el of all) {
      tagIfClipping(el, root);
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.tagName === "IFRAME") {
        let doc = null; try { doc = el.contentDocument; } catch (e) { doc = null; }
        if (doc) walk(doc); // same-origin only; cross-origin throws and is skipped
      }
    }
  };
  // A few passes: flattening a parent can reveal a child scroller.
  for (let p = 0; p < 3; p++) { walk(document); await sleep(60); }

  // One stylesheet, high specificity, overflow-Y + height only.
  const injectStyle = (doc) => {
    if (doc.getElementById("__flc_flat_style")) return;
    const st = doc.createElement("style");
    st.id = "__flc_flat_style";
    st.textContent = "[" + MARK + "]{overflow-y:visible !important;height:auto !important;max-height:none !important;}";
    (doc.head || doc.documentElement).appendChild(st);
  };
  const injectAll = (doc) => {
    injectStyle(doc);
    let frames; try { frames = doc.querySelectorAll("iframe"); } catch (e) { frames = []; }
    for (const f of frames) { let d=null; try { d=f.contentDocument; } catch(e){} if (d) injectAll(d); }
  };
  injectAll(document);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await sleep(100);

  const de = document.documentElement, b = document.body;
  return {
    scrollWidth:  Math.max(de.scrollWidth,  b ? b.scrollWidth  : 0),
    scrollHeight: Math.max(de.scrollHeight, b ? b.scrollHeight : 0),
  };
})()`;

const RESTORE_JS = `(() => {
  try {
    const MARK = "__flc_flat";
    const clean = (doc) => {
      try {
        doc.querySelectorAll("[" + MARK + "]").forEach(el => el.removeAttribute(MARK));
        const st = doc.getElementById("__flc_flat_style"); if (st) st.remove();
        doc.querySelectorAll("iframe").forEach(f => { let d=null; try { d=f.contentDocument; } catch(e){} if (d) clean(d); });
      } catch (e) {}
    };
    clean(document);
  } catch (e) {}
  return true;
})()`;

export async function flatten(target, timeoutMs = 20000) {
  const m = await evalIn(target, FLATTEN_JS, timeoutMs);
  return m || { scrollWidth: 0, scrollHeight: 0 };
}

export async function restoreFlatten(target) {
  try { await evalIn(target, RESTORE_JS, 8000); } catch (e) {}
}
