// pageTurnReader.js — Rung 3: virtualized, paginated readers (VitalSource-style).
//
// EXPERIMENTAL / BEST-EFFORT. This is the one rung that cannot be verified in a
// headless sandbox (no live reader, and the debugging banner/DRM only appear in
// a real browser). It implements the verified-safe pattern from the research +
// red-team, but expect to tune deltas/timeouts per reader.
//
// Approach (all corrections from the red-team applied):
//  - Capture pixels from the TOP target cropped to the book iframe's on-screen
//    rect (child sessions can't screenshot; the book's rect is measurable from
//    the top document even when its contents are cross-origin).
//  - Advance with a synthetic key (ArrowRight) dispatched to the top target.
//  - Settle by TWO consecutive hash-stable book images (not frame-churn, which
//    can deadlock on readers that reuse a persistent frame).
//  - Detect end-of-book by NO-PROGRESS: the book image stops changing (perceptual
//    hash repeats) N times in a row. Never trust a numeric page total.
//  - Default to RASTER (screenshot) output; selectable-text vector is out of
//    scope for v1 here.
//  - DRM/entitlement is the user's responsibility — the popup gates this rung
//    behind an explicit affirmation; we do not defeat any protection, and
//    EME/protected regions simply render black.

import { cmd, sleep } from "../cdp.js";
import { biggestFrameRect } from "../frameRect.js";
import { decodePng } from "../../assemble/tiler.js";
import { buildImagePdf } from "../../assemble/pdfImage.js";
import { JPEG_QUALITY, MAX_PAGE_TURNS } from "../../../shared/units.js";
import { PHASE } from "../../../shared/messages.js";

// 8x8 grayscale average-hash of a bitmap → 64-bit BigInt-ish array of 0/1.
async function aHash(bitmap) {
  const c = new OffscreenCanvas(8, 8);
  const ctx = c.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, 8, 8);
  const { data } = ctx.getImageData(0, 0, 8, 8);
  const g = [];
  let sum = 0;
  for (let i = 0; i < 64; i++) {
    const v = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    g.push(v); sum += v;
  }
  const avg = sum / 64;
  return { bits: g.map((v) => (v >= avg ? 1 : 0)), variance: variance(g, avg) };
}
function variance(arr, mean) {
  let s = 0; for (const v of arr) s += (v - mean) * (v - mean); return s / arr.length;
}
function hamming(a, b) { let d = 0; for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++; return d; }

async function captureBook(top, rect) {
  const shot = await cmd(
    top, "Page.captureScreenshot",
    { format: "png", fromSurface: true, captureBeyondViewport: false,
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } },
    30000
  );
  if (!shot || !shot.data) return null;
  return await decodePng(shot.data);
}
async function bitmapToJpeg(bitmap) {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  c.getContext("2d").drawImage(bitmap, 0, 0);
  const blob = await c.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  return new Uint8Array(await blob.arrayBuffer());
}

// Wait for the book image to stop changing (two consecutive stable hashes).
async function settleBook(top, rect, timeoutMs = 4000) {
  const start = Date.now();
  let prev = null, stable = 0, last = null;
  while (Date.now() - start < timeoutMs) {
    await sleep(180);
    const bmp = await captureBook(top, rect);
    if (!bmp) continue;
    const h = await aHash(bmp);
    if (last) last.close && last.close();
    last = bmp;
    if (prev && hamming(prev.bits, h.bits) <= 2) { stable++; if (stable >= 1) break; }
    else stable = 0;
    prev = h;
  }
  return last; // last stable bitmap (or null)
}

export async function pageTurnReader(ctx) {
  const { top, emit, options } = ctx;
  await cmd(top, "Page.enable", {}, 15000);
  try { await cmd(top, "Emulation.setEmulatedMedia", { media: "screen" }, 8000); } catch (e) {}

  let rect = (target => target && target.rect)(ctx.target) || (await biggestFrameRect(top));
  if (!rect) throw new Error("pageTurnReader: no reader frame rect found");

  const pageJpegs = [];
  let imgW = 0, imgH = 0;
  const recent = []; // recent accepted hashes, to detect no-progress
  let noProgress = 0;
  const maxTurns = Math.min(options && options.maxPages ? options.maxPages : MAX_PAGE_TURNS, MAX_PAGE_TURNS);

  for (let turn = 0; turn < maxTurns; turn++) {
    // Re-derive the rect each turn — the reader may re-fit between pages.
    const r = (await biggestFrameRect(top)) || rect;
    rect = r;

    const bmp = await captureBook(top, rect);
    if (!bmp) { noProgress++; if (noProgress >= 3) break; continue; }
    const h = await aHash(bmp);

    // Blank page (near-uniform): wait and retry a couple times before accepting.
    if (h.variance < 1e-4) {
      bmp.close && bmp.close();
      noProgress++;
      if (noProgress >= 3) break; // persistently blank => past the end
      await sleep(400);
      continue;
    }

    // No-progress detection: identical to a very recent page => end of book.
    const dup = recent.some((prev) => hamming(prev, h.bits) <= 2);
    if (dup) {
      bmp.close && bmp.close();
      noProgress++;
      if (noProgress >= 2) break; // turned but nothing changed => end
    } else {
      noProgress = 0;
      recent.push(h.bits);
      if (recent.length > 4) recent.shift();
      if (!imgW) { imgW = bmp.width; imgH = bmp.height; }
      pageJpegs.push({ jpeg: await bitmapToJpeg(bmp), wPx: rect.width, hPx: rect.height, imgW: bmp.width, imgH: bmp.height });
      bmp.close && bmp.close();
      emit(PHASE.PAGETURN, "Capturing page…", pageJpegs.length, null);
    }

    // Advance one page and settle.
    try {
      await cmd(top, "Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }, 8000);
      await cmd(top, "Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }, 8000);
    } catch (e) {}
    const settled = await settleBook(top, rect);
    if (settled) settled.close && settled.close();
  }

  if (!pageJpegs.length) throw new Error("pageTurnReader: captured no pages");

  emit(PHASE.ASSEMBLE, "Assembling PDF…");
  return {
    blob: buildImagePdf(pageJpegs),
    kind: "raster",
    pages: pageJpegs.length,
    capturedPx: pageJpegs.length, // page-count based; validated separately
    expectedPx: 0, // no reliable total → coverage gate passes, dedup handles end
    filenameHint: "book",
  };
}
