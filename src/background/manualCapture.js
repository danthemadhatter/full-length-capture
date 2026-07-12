// manualCapture.js — the capture engine: YOU scroll, we screenshot the visible
// tab with chrome.tabs.captureVisibleTab (no debugger, no banner), then stitch
// every frame into one seamless, single-page PDF by ALIGNING OVERLAPPING PIXELS.
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

import { decodePng, cropBitmap, scaleBitmap, assembleTiles } from "./assemble/tiler.js";
import { buildImagePdf } from "./assemble/pdfImage.js";
import { CANVAS_MAX_SIDE } from "../shared/units.js";

const MIN_GAP_MS = 320; // captureVisibleTab is rate-limited (~2/sec)

// tabId -> { frames: [{dataUrl, rect, innerWidth, dpr}], last, lastHash, windowId }
const sessions = new Map();

export function startSession(tabId, windowId) {
  sessions.set(tabId, { frames: [], last: 0, lastHash: null, windowId });
}
export function cancelSession(tabId) { sessions.delete(tabId); }

/** "Change area" picked a different region — old frames are of the WRONG
 * content and can never be stitched with the new region's pixels, so the only
 * correct move is to discard them and start the accumulation over. */
export function resetSession(tabId) {
  const s = sessions.get(tabId);
  if (s) { s.frames = []; s.lastHash = null; }
}

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
  if (now - s.last < MIN_GAP_MS) return { ok: true, frames: s.frames.length, throttled: true };
  s.last = now;

  let dataUrl;
  try { dataUrl = await chrome.tabs.captureVisibleTab(windowId ?? s.windowId, { format: "png" }); }
  catch (e) { return { ok: false, frames: s.frames.length, error: e.message }; }

  const bmp = await decodePng(stripDataUrl(dataUrl));
  const h = await aHash(bmp);
  bmp.close && bmp.close();
  if (s.lastHash && hamming(s.lastHash, h) <= 2) return { ok: true, frames: s.frames.length, duplicate: true };
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
//
// This compares real 2D pixel content (a narrow-but-full-height grayscale strip),
// not a 1D row-brightness profile. A 1D profile collapses each row to one average
// value, which throws away WHERE on the row the ink is — so two different
// paragraphs with similar line height and text density (common on any page of
// justified academic prose) can produce near-identical profiles at completely
// wrong shift offsets. That false match is what caused whole blocks of content to
// get duplicated or skipped: the stitcher believed frame B barely overlapped
// frame A's tail, stacked it almost on top instead of further down, and a chunk
// of real page content got redrawn instead of advanced past.
const PATCH_W = 32; // columns of real pixel signal kept per row — enough to tell
// paragraphs/equations apart by shape, cheap enough to correlate at full height.

async function downsampleGray(bitmap, srcW, srcH) {
  const w = Math.max(4, Math.min(PATCH_W, srcW));
  const c = new OffscreenCanvas(w, srcH); // keep full vertical resolution — shift accuracy depends on it
  const ctx = c.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, srcH);
  const { data } = ctx.getImageData(0, 0, w, srcH);
  const gray = new Float32Array(w * srcH);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return { gray, w, h: srcH };
}

function bestShift(gA, gB, h) {
  const w = gA.w;
  // minRow used to floor at 4% of h to avoid degenerate near-zero matches on
  // repetitive content. With real 2D block matching that floor became actively
  // harmful: if two consecutive frames have genuinely NOT moved yet (you
  // haven't started scrolling — a brief pause after clicking the icon is
  // enough, especially if the page has any sub-pixel rendering jitter that
  // dodges the perceptual-hash duplicate filter upstream), the true best shift
  // is ~0, which the 4% floor made unreachable — forcing the algorithm to
  // report at least that floor as "forward motion" and duplicate the opening
  // content. Searching all the way down to 1px lets a real zero-motion pair
  // be correctly found near zero and dropped by the dy<6 duplicate check
  // below, while genuine motion (2D matching is discriminating enough) is
  // still found correctly regardless of how low the floor is.
  const minRow = 1;
  const maxRow = Math.floor(h * 0.85);
  let bestErr = Infinity, bestRow = Math.floor(h * 0.6);
  for (let s = minRow; s <= maxRow; s++) {
    const len = h - s;
    let err = 0, n = 0;
    for (let y = 0; y < len; y += 2) { // every other row — full-width-per-row signal makes this still plenty precise
      const rowA = (s + y) * w, rowB = y * w;
      for (let x = 0; x < w; x++) { const dd = gA.gray[rowA + x] - gB.gray[rowB + x]; err += dd < 0 ? -dd : dd; n++; }
    }
    err /= Math.max(1, n);
    if (err < bestErr) { bestErr = err; bestRow = s; }
  }
  // If the match is poor (fast scroll, no real overlap), assume ~35% overlap so
  // we still advance without a big gap.
  const good = bestErr < 10;
  return { dy: good ? bestRow : Math.round(h * 0.65), good };
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

/** Stitch all captured frames into one seamless, single-page PDF by pixel alignment. */
export async function stitchSession(tabId) {
  const s = sessions.get(tabId);
  if (!s || s.frames.length === 0) throw new Error("Nothing was captured — scroll the area, then click Done.");

  // Canonical crop rect (device px), fixed from the FIRST frame and applied to
  // EVERY frame regardless of later jitter (a scrollbar appearing, a reflow,
  // a window resize) — cropBitmap always returns exactly this size, so every
  // cropped bitmap is guaranteed identical W x H. Without this, a later frame
  // that decodes even slightly smaller/larger silently misaligns everything
  // after it (the row-profile math below assumes uniform frame dimensions).
  const first = s.frames[0];
  const innerWidth = first.innerWidth || 1280;
  const probe = await decodePng(stripDataUrl(first.dataUrl));
  const effDpr = probe.width / innerWidth || first.dpr || 1;
  probe.close && probe.close();

  const r0 = first.rect || { x: 0, y: 0, width: innerWidth, height: probe.height / effDpr };
  const cropRectDev = {
    x: Math.round(r0.x * effDpr), y: Math.round(r0.y * effDpr),
    width: Math.round(r0.width * effDpr), height: Math.round(r0.height * effDpr),
  };

  let cropped = [];
  for (const f of s.frames) {
    const bmp = await decodePng(stripDataUrl(f.dataUrl));
    const cut = await cropBitmap(bmp, cropRectDev);
    bmp.close && bmp.close();
    cropped.push(cut);
  }

  let W = cropRectDev.width, H = cropRectDev.height;
  let widthScale = 1;

  // Content wider than the canvas hard cap (only possible on a very large
  // custom-picked region at high DPI) — downscale uniformly rather than
  // silently producing a blank/dropped tile later.
  if (W > CANVAS_MAX_SIDE) {
    widthScale = CANVAS_MAX_SIDE / W;
    const scaled = [];
    for (const bmp of cropped) { scaled.push(await scaleBitmap(bmp, widthScale)); bmp.close && bmp.close(); }
    cropped = scaled;
    W = Math.round(W * widthScale);
    H = Math.round(H * widthScale);
  }
  const effDprScaled = effDpr * widthScale;

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

  const midBitmaps = [];
  const midGray = [];
  for (const bmp of cropped) {
    const mid = await cropBitmap(bmp, { x: 0, y: midTopPx, width: W, height: midH });
    midBitmaps.push(mid);
    midGray.push(await downsampleGray(mid, W, midH));
    bmp.close && bmp.close();
  }

  // Stack the moving bands by pairwise vertical overlap (device px positions).
  const keep = [midBitmaps[0]];
  const tops = [0];
  let cursor = 0;
  for (let i = 1; i < midBitmaps.length; i++) {
    const { dy } = bestShift(midGray[i - 1], midGray[i], midH);
    if (dy < 6) { midBitmaps[i].close && midBitmaps[i].close(); continue; } // duplicate → drop
    cursor += dy;
    tops.push(cursor);
    keep.push(midBitmaps[i]);
  }

  const totalCssH = (cursor + midH) / effDprScaled;
  const totalCssW = W / effDprScaled;
  const bands = keep.map((bitmap, i) => ({ bitmap, cssTop: tops[i] / effDprScaled, cssHeight: midH / effDprScaled }));

  const tiles = await assembleTiles(bands, W, effDprScaled, totalCssH);
  for (const b of keep) b.close && b.close();
  sessions.delete(tabId);

  return { blob: buildImagePdf(tiles, totalCssW, totalCssH), frames: s.frames.length };
}

function stripDataUrl(d) { const i = d.indexOf(","); return i >= 0 ? d.slice(i + 1) : d; }
