// manualCapture.js — the simple, always-works path: YOU scroll, we screenshot
// the visible tab with chrome.tabs.captureVisibleTab (no debugger, no banner),
// then stitch every frame into one tall PDF by ALIGNING OVERLAPPING PIXELS.
//
// Why pixel-alignment instead of scroll-offset math: for a cross-origin embedded
// reader, the page can't read how far you scrolled inside it — but a screenshot
// still shows the pixels. So we ignore scroll position entirely and stitch like a
// panorama: for each new frame, find the vertical shift where it overlaps the
// previous one, and stack accordingly. This works on ANYTHING you can see.
//
// Capture is sampled on a timer while you scroll; identical frames (you paused)
// are dropped via a perceptual hash, so only real movement adds pages. Scroll
// smoothly top-to-bottom; if you fling past something, scroll back and it fills.

import { decodePng, cropBitmap, assemblePages } from "./assemble/tiler.js";
import { buildImagePdf } from "./assemble/pdfImage.js";

const MIN_GAP_MS = 320; // captureVisibleTab is rate-limited (~2/sec)

// tabId -> { frames: [{dataUrl, rect, innerWidth, dpr}], last, lastHash, windowId }
const sessions = new Map();

export function startSession(tabId, windowId) {
  sessions.set(tabId, { frames: [], last: 0, lastHash: null, windowId });
}
export function cancelSession(tabId) { sessions.delete(tabId); }
export function frameCount(tabId) { const s = sessions.get(tabId); return s ? s.frames.length : 0; }

// ---- perceptual hash (dedupe paused/duplicate frames) ----
async function aHash(bitmap) {
  const c = new OffscreenCanvas(8, 8);
  const ctx = c.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, 8, 8);
  const { data } = ctx.getImageData(0, 0, 8, 8);
  const g = []; let sum = 0;
  for (let i = 0; i < 64; i++) { const v = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]; g.push(v); sum += v; }
  const avg = sum / 64;
  return g.map((v) => (v >= avg ? 1 : 0));
}
function hamming(a, b) { let d = 0; for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++; return d; }

/**
 * Capture one visible-tab screenshot. Throttled to the API rate limit; frames
 * that look identical to the previous one (no scrolling happened) are dropped.
 */
export async function captureFrame(tabId, windowId, meta) {
  const s = sessions.get(tabId);
  if (!s) return { ok: false, frames: 0 };
  const now = Date.now();
  if (now - s.last < MIN_GAP_MS) return { ok: true, frames: s.frames.length };
  s.last = now;

  let dataUrl;
  try { dataUrl = await chrome.tabs.captureVisibleTab(windowId ?? s.windowId, { format: "png" }); }
  catch (e) { return { ok: false, frames: s.frames.length, error: e.message }; }

  const bmp = await decodePng(stripDataUrl(dataUrl));
  const h = await aHash(bmp);
  bmp.close && bmp.close();
  if (s.lastHash && hamming(s.lastHash, h) <= 2) return { ok: true, frames: s.frames.length }; // no change → skip
  s.lastHash = h;
  s.frames.push({ dataUrl, ...meta });
  return { ok: true, frames: s.frames.length };
}

// ---- vertical row profile + best-overlap shift ----
const PROF_BINS = 400;
function rowProfile(imageData, w, h) {
  // Average grayscale across the central columns for each row, binned to PROF_BINS.
  const x0 = Math.floor(w * 0.2), x1 = Math.ceil(w * 0.8), step = Math.max(1, Math.floor((x1 - x0) / 64));
  const full = new Float32Array(h);
  const d = imageData.data;
  for (let y = 0; y < h; y++) {
    let sum = 0, n = 0;
    const row = y * w * 4;
    for (let x = x0; x < x1; x += step) { const i = row + x * 4; sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
    full[y] = n ? sum / n : 0;
  }
  // Bin to fixed length for fast, resolution-independent matching.
  const bins = Math.min(PROF_BINS, h);
  const prof = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    const a = Math.floor((b * h) / bins), c = Math.floor(((b + 1) * h) / bins);
    let sum = 0; for (let y = a; y < Math.max(a + 1, c); y++) sum += full[y];
    prof[b] = sum / Math.max(1, c - a);
  }
  return { prof, bins };
}
// Best downward shift (in device px) between previous frame A and current B.
function bestShift(profA, profB, bins, h) {
  const minBin = Math.max(1, Math.floor(bins * 0.04));
  const maxBin = Math.floor(bins * 0.85);
  let bestErr = Infinity, bestBin = Math.floor(bins * 0.6);
  for (let s = minBin; s <= maxBin; s++) {
    const len = bins - s;
    let err = 0;
    for (let k = 0; k < len; k++) { const dd = profA[s + k] - profB[k]; err += dd < 0 ? -dd : dd; }
    err /= len;
    if (err < bestErr) { bestErr = err; bestBin = s; }
  }
  // Convert bin shift back to device px. If the match is poor (fast scroll, no
  // real overlap), assume ~35% overlap so we still advance without a big gap.
  const good = bestErr < 12;
  const binPx = h / bins;
  return { dy: Math.round((good ? bestBin : bins * 0.65) * binPx), good };
}

// Detect contiguous static bands (sticky header / footer) at top and bottom:
// row bins whose profile value barely changes across ALL frames are fixed UI
// (a toolbar that stays put while content scrolls). We crop those so they don't
// repeat down the stitched page and don't fool the overlap alignment.
function staticBands(profiles, bins) {
  // Need several scrolled frames to tell "static UI" from "similar content".
  if (profiles.length < 4) return { top: 0, bot: 0 };
  const varAt = (b) => {
    let mean = 0; for (const p of profiles) mean += p.prof[b]; mean /= profiles.length;
    let v = 0; for (const p of profiles) { const d = p.prof[b] - mean; v += d * d; } return v / profiles.length;
  };
  const VAR_THRESH = 20; // std ~4.5 grayscale levels
  const maxCrop = Math.floor(bins * 0.28);
  let top = 0; while (top < maxCrop && varAt(top) < VAR_THRESH) top++;
  let bot = 0; while (bot < maxCrop && varAt(bins - 1 - bot) < VAR_THRESH) bot++;
  return { top, bot };
}

/** Stitch all captured frames into one tall raster PDF by pixel alignment. */
export async function stitchSession(tabId) {
  const s = sessions.get(tabId);
  if (!s || s.frames.length === 0) throw new Error("Nothing was captured — scroll the area, then click Done.");

  // Decode + crop every frame to the capture region (device px).
  const first = s.frames[0];
  const innerWidth = first.innerWidth || 1280;
  const probe = await decodePng(stripDataUrl(first.dataUrl));
  const effDpr = probe.width / innerWidth || first.dpr || 1;
  probe.close && probe.close();

  const cropped = [];
  for (const f of s.frames) {
    const bmp = await decodePng(stripDataUrl(f.dataUrl));
    const r = f.rect || { x: 0, y: 0, width: innerWidth, height: bmp.height / effDpr };
    const cut = await cropBitmap(bmp, { x: r.x * effDpr, y: r.y * effDpr, width: r.width * effDpr, height: r.height * effDpr });
    bmp.close && bmp.close();
    cropped.push(cut);
  }

  const W = cropped[0].width, H = cropped[0].height;

  // Row profiles (full height) for static-band detection + overlap matching.
  const profiles = [];
  for (const bmp of cropped) {
    const c = new OffscreenCanvas(W, H);
    const cx = c.getContext("2d");
    cx.drawImage(bmp, 0, 0);
    profiles.push(rowProfile(cx.getImageData(0, 0, W, H), W, H));
  }
  const bins = profiles[0].bins;
  const binPx = H / bins;

  // Crop the sticky toolbar / footer out of every frame → keep the moving band.
  const { top: topBins, bot: botBins } = staticBands(profiles, bins);
  const midTopPx = Math.round(topBins * binPx);
  const midH = Math.max(8, Math.round(H - (topBins + botBins) * binPx));
  const midProf = (p) => p.prof.subarray(topBins, bins - botBins);
  const midBins = bins - topBins - botBins;

  const midBitmaps = [];
  for (const bmp of cropped) {
    const mid = await cropBitmap(bmp, { x: 0, y: midTopPx, width: W, height: midH });
    midBitmaps.push(mid);
    bmp.close && bmp.close();
  }

  // Stack the moving bands by pairwise vertical overlap (device px positions).
  const keep = [midBitmaps[0]];
  const tops = [0];
  let cursor = 0;
  for (let i = 1; i < midBitmaps.length; i++) {
    const { dy } = bestShift(midProf(profiles[i - 1]), midProf(profiles[i]), midBins, midH);
    if (dy < 6) { midBitmaps[i].close && midBitmaps[i].close(); continue; } // duplicate → drop
    cursor += dy;
    tops.push(cursor);
    keep.push(midBitmaps[i]);
  }

  const totalCssH = (cursor + midH) / effDpr;
  const bands = keep.map((bitmap, i) => ({ bitmap, cssTop: tops[i] / effDpr, cssHeight: midH / effDpr }));

  const pages = await assemblePages(bands, W, effDpr, totalCssH);
  for (const b of keep) b.close && b.close();
  sessions.delete(tabId);

  return { blob: buildImagePdf(pages), kind: "raster", pages: pages.length, frames: s.frames.length };
}

function stripDataUrl(d) { const i = d.indexOf(","); return i >= 0 ? d.slice(i + 1) : d; }
