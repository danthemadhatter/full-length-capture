// tiler.js — OffscreenCanvas image pipeline for the stitched page (service worker).
//
// Responsibilities:
//  - decode a base64 PNG screenshot into an ImageBitmap
//  - crop a screenshot to the capture rect (device px), ALWAYS at the exact
//    requested size (padded with white if the source doesn't fully cover it)
//    so every cropped frame in a session is guaranteed identical dimensions
//  - slice the full stitched image into tiles that respect Canvas/ImageBitmap's
//    hard pixel caps (16384px/side, 256 MP total) — tiles are NOT separate PDF
//    pages, pdfImage.js draws every tile into ONE page's content stream, so
//    these caps are invisible in the output: one continuous page regardless of
//    how long the capture is.

import { CANVAS_MAX_SIDE, CANVAS_MAX_AREA, JPEG_QUALITY } from "../../shared/units.js";

export async function decodePng(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return await createImageBitmap(new Blob([bytes], { type: "image/png" }));
}

/**
 * Crop a device-px rect out of a bitmap. Always returns a bitmap of exactly
 * rectDev's width/height — padded white where the source doesn't cover it —
 * so callers never see a frame-to-frame size mismatch from window resizes,
 * a scrollbar appearing, or any other per-frame jitter.
 */
export async function cropBitmap(bitmap, rectDev) {
  const w = Math.max(1, Math.round(rectDev.width));
  const h = Math.max(1, Math.round(rectDev.height));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const sx = Math.round(rectDev.x);
  const sy = Math.round(rectDev.y);
  const sw = Math.max(0, Math.min(w, bitmap.width - sx));
  const sh = Math.max(0, Math.min(h, bitmap.height - sy));
  if (sw > 0 && sh > 0) ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  return await createImageBitmap(c);
}

/** Downscale a bitmap by `scale` (<=1). Used only when content is wider than
 * the canvas side cap — rare, but keeps a legal single page instead of failing. */
async function scaleBitmap(bitmap, scale) {
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const c = new OffscreenCanvas(w, h);
  c.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  return await createImageBitmap(c);
}
export { scaleBitmap };

async function canvasToJpeg(canvas, quality = JPEG_QUALITY) {
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Slice bands (each an ImageBitmap of full-width content covering a CSS-Y
 * range) into tiles, each within the canvas pixel caps. Tiles are contiguous
 * and non-overlapping in CSS space — coverage from 0..totalCssH is exact —
 * so stacking them on one PDF page (pdfImage.js) is seamless.
 *
 * @param {Array<{bitmap:ImageBitmap, cssTop:number, cssHeight:number}>} bands
 * @param {number} widthDev   content width in device px (shared by all bands; must be <= CANVAS_MAX_SIDE)
 * @param {number} dpr        device-pixel ratio (bitmap px per CSS px)
 * @param {number} totalCssH  full stitched content height, CSS px
 * @returns {Promise<Array<{jpeg:Uint8Array, topPx:number, cssHeight:number, imgW:number, imgH:number}>>}
 */
export async function assembleTiles(bands, widthDev, dpr, totalCssH) {
  const tiles = [];
  const wDev = Math.max(1, Math.round(widthDev));
  const maxBySide = Math.floor(CANVAS_MAX_SIDE / dpr);
  const maxByArea = Math.floor(CANVAS_MAX_AREA / wDev / dpr);
  const tileCssH = Math.max(1, Math.min(maxBySide, maxByArea));

  for (let top = 0; top < totalCssH; top += tileCssH) {
    const cssH = Math.min(tileCssH, totalCssH - top);
    const hDev = Math.max(1, Math.round(cssH * dpr));

    const canvas = new OffscreenCanvas(wDev, hDev);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, wDev, hDev);

    for (const b of bands) {
      const bTop = b.cssTop, bBot = b.cssTop + b.cssHeight;
      const pTop = top, pBot = top + cssH;
      const overTop = Math.max(bTop, pTop), overBot = Math.min(bBot, pBot);
      if (overBot <= overTop) continue; // no overlap with this tile
      const srcY = Math.round((overTop - bTop) * dpr);
      const srcH = Math.min(Math.round((overBot - overTop) * dpr), b.bitmap.height - srcY);
      const dstY = Math.round((overTop - pTop) * dpr);
      if (srcH <= 0) continue;
      ctx.drawImage(b.bitmap, 0, srcY, b.bitmap.width, srcH, 0, dstY, wDev, srcH);
    }
    const jpeg = await canvasToJpeg(canvas);
    tiles.push({ jpeg, topPx: top, cssHeight: cssH, imgW: wDev, imgH: hDev });
  }
  return tiles;
}
