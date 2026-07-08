// scrollStitch.js — Rung 2: scroll the target and tile top-target screenshots.
//
// Used when printToPDF can't produce faithful output: canvas/WebGL glyphs,
// clipping that survives flatten, or a virtualized scroller (scrolling reveals
// new DOM that CSS flatten can't un-hide). Drives the scroller by Runtime.evaluate
// and captures pixels from the TOP target (child sessions can't screenshot).
//
// Geometry: the scroller is stashed on window.__flcScroller (main-world global,
// persists across our Runtime.evaluate calls). We clip each screenshot to the
// pane's on-screen rect, then place bands by absolute scroll offset onto tall
// page canvases — so bands abut exactly with no seam math.

import { cmd, evalIn, sleep } from "../cdp.js";
import { decodePng, assemblePages } from "../../assemble/tiler.js";
import { buildImagePdf } from "../../assemble/pdfImage.js";
import { PHASE } from "../../../shared/messages.js";
import { SHOT_MAX_PX } from "../../../shared/units.js";

// Pick the scroller in the main world. rectHint (from the picked pane, in top
// CSS px) biases selection; null => auto-pick the dominant scroller or window.
const PICK_SCROLLER_JS = (rectHint) => `(() => {
  const hint = ${rectHint ? JSON.stringify(rectHint) : "null"};
  const scrollableY = (el) => {
    try { const cs = getComputedStyle(el);
      return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 60;
    } catch(e){ return false; }
  };
  let best = null, bestScore = -1;
  const consider = (el) => {
    if (!scrollableY(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) return;
    let score = (r.width*r.height);
    if (hint) { const dx=(r.left-hint.x), dy=(r.top-hint.y); score -= Math.abs(dx)+Math.abs(dy); }
    if (score > bestScore) { bestScore = score; best = el; }
  };
  const walk = (root) => { let all; try { all = root.querySelectorAll('*'); } catch(e){ return; }
    for (const el of all) { try { consider(el); } catch(e){}
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.tagName==='IFRAME'){ let d=null; try{d=el.contentDocument;}catch(e){} if(d) walk(d); } } };
  walk(document);
  window.__flcScroller = best; // null => scroll window
  const pageH = Math.max(document.documentElement.scrollHeight, document.body?document.body.scrollHeight:0);
  if (!best) {
    return { isWindow:true, rect:{x:0,y:0,width:innerWidth,height:innerHeight},
             scrollHeight: pageH, clientHeight: innerHeight, dpr: devicePixelRatio||1 };
  }
  const r = best.getBoundingClientRect();
  const left=Math.max(0,r.left), top=Math.max(0,r.top);
  return { isWindow:false,
    rect:{x:left,y:top,width:Math.min(r.width,innerWidth-left),height:Math.min(r.height,innerHeight-top)},
    scrollHeight: best.scrollHeight, clientHeight: best.clientHeight, dpr: devicePixelRatio||1 };
})()`;

const SET_SCROLL_JS = (pos) => `(() => { const s = window.__flcScroller;
  if (s) { s.scrollTop = ${pos}; return s.scrollTop; }
  window.scrollTo(0, ${pos}); return window.scrollY; })()`;

const RESET_SCROLL_JS = `(() => { const s = window.__flcScroller;
  if (s) s.scrollTop = 0; else window.scrollTo(0,0); return true; })()`;

export async function scrollStitch(ctx) {
  const { top, target, emit } = ctx;
  await cmd(top, "Page.enable", {}, 15000);
  try { await cmd(top, "Emulation.setEmulatedMedia", { media: "screen" }, 8000); } catch (e) {}

  const info = await evalIn(top, PICK_SCROLLER_JS(target && target.rect), 15000);
  if (!info) throw new Error("scrollStitch: no scroller found");

  const rect = info.rect;
  const totalCssH = Math.max(info.scrollHeight, rect.height);
  const clientH = Math.max(60, info.clientHeight || rect.height);
  const maxScroll = Math.max(0, totalCssH - clientH);
  const step = clientH; // place by absolute offset → bands abut exactly

  const positions = [];
  for (let p = 0; p <= maxScroll; p += step) positions.push(p);
  if (positions.length === 0 || positions[positions.length - 1] < maxScroll) positions.push(maxScroll);

  const bands = [];
  let effDpr = info.dpr || 1;
  let widthDev = Math.round(rect.width * effDpr);

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const actual = await evalIn(top, SET_SCROLL_JS(pos), 6000);
    await sleep(Math.max(140, (ctx.options && ctx.options.delay) || 220));
    let shot;
    try {
      shot = await cmd(
        top, "Page.captureScreenshot",
        { format: "png", fromSurface: true, captureBeyondViewport: false,
          clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } },
        30000
      );
    } catch (e) { continue; }
    if (!shot || !shot.data) continue;
    const bmp = await decodePng(shot.data);
    if (i === 0) { effDpr = bmp.width / rect.width || effDpr; widthDev = bmp.width; }
    const cssTop = typeof actual === "number" ? actual : pos;
    const cssHeight = Math.min(rect.height, totalCssH - cssTop);
    if (cssHeight <= 0) { bmp.close && bmp.close(); continue; }
    bands.push({ bitmap: bmp, cssTop, cssHeight });
    emit(PHASE.SCROLL, "Capturing…", i + 1, positions.length);
    if (cssTop >= maxScroll) break;
  }

  try { await evalIn(top, RESET_SCROLL_JS, 5000); } catch (e) {}
  if (!bands.length) throw new Error("scrollStitch: captured nothing");

  emit(PHASE.ASSEMBLE, "Assembling PDF…");
  const capturedPx = Math.min(totalCssH, bands[bands.length - 1].cssTop + bands[bands.length - 1].cssHeight);
  const pages = await assemblePages(bands, widthDev, effDpr, capturedPx);
  for (const b of bands) b.bitmap.close && b.bitmap.close();

  return {
    blob: buildImagePdf(pages),
    kind: "raster",
    pages: pages.length,
    capturedPx,
    expectedPx: totalCssH,
    filenameHint: "capture",
  };
}
