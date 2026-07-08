// tiler.js — OffscreenCanvas image pipeline for the raster path (service worker).
//
// Responsibilities:
//  - decode a base64 PNG screenshot into an ImageBitmap
//  - crop a screenshot to the capture rect (device px)
//  - assemble a set of vertically-stacked bands into one or more PDF page images,
//    each kept within the 16384/side and 256 MP canvas caps (exceeding either
//    silently yields a blank canvas — so we validate before every draw).

import { CANVAS_MAX_SIDE, CANVAS_MAX_AREA, JPEG_QUALITY } from "../../shared/units.js";

export async function decodePng(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return await createImageBitmap(new Blob([bytes], { type: "image/png" }));
}

/** Crop a device-px rect out of a bitmap into a new bitmap. */
export async function cropBitmap(bitmap, rectDev) {
  const w = Math.max(1, Math.min(Math.round(rectDev.width), bitmap.width - Math.round(rectDev.x)));
  const h = Math.max(1, Math.min(Math.round(rectDev.height), bitmap.height - Math.round(rectDev.y)));
  const c = new OffscreenCanvas(w, h);
  c.getContext("2d").drawImage(bitmap, Math.round(rectDev.x), Math.round(rectDev.y), w, h, 0, 0, w, h);
  const out = await createImageBitmap(c);
  return out;
}

async function canvasToJpeg(canvas, quality = JPEG_QUALITY) {
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Assemble bands (each an ImageBitmap of full pane width covering a CSS-Y range)
 * into PDF page images. Splits into multiple pages so no canvas exceeds the caps.
 *
 * @param {Array<{bitmap:ImageBitmap, cssTop:number, cssHeight:number}>} bands
 * @param {number} widthDev   pane width in device px (all bands share it)
 * @param {number} dpr        device-pixel ratio (bitmap px per CSS px)
 * @param {number} totalCssH  full content height in CSS px
 * @returns {Promise<Array<{jpeg:Uint8Array, wPx:number, hPx:number, imgW:number, imgH:number}>>}
 */
export async function assemblePages(bands, widthDev, dpr, totalCssH) {
  const pages = [];
  // Largest CSS height a single page may span, honoring side & area caps.
  const maxByside = Math.floor(CANVAS_MAX_SIDE / dpr);
  const maxByArea = Math.floor(CANVAS_MAX_AREA / Math.max(1, widthDev) / dpr);
  const pageCssH = Math.max(200, Math.min(maxByside, maxByArea));

  for (let top = 0; top < totalCssH; top += pageCssH) {
    const cssH = Math.min(pageCssH, totalCssH - top);
    const wDev = Math.max(1, Math.round(widthDev));
    const hDev = Math.max(1, Math.round(cssH * dpr));
    if (wDev > CANVAS_MAX_SIDE || hDev > CANVAS_MAX_SIDE || wDev * hDev > CANVAS_MAX_AREA) {
      // Should not happen given pageCssH, but never draw past a cap.
      continue;
    }
    const canvas = new OffscreenCanvas(wDev, hDev);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, wDev, hDev);

    for (const b of bands) {
      const bTop = b.cssTop;
      const bBot = b.cssTop + b.cssHeight;
      const pTop = top;
      const pBot = top + cssH;
      const overTop = Math.max(bTop, pTop);
      const overBot = Math.min(bBot, pBot);
      if (overBot <= overTop) continue; // no overlap with this page
      const srcY = Math.round((overTop - bTop) * dpr);
      const srcH = Math.round((overBot - overTop) * dpr);
      const dstY = Math.round((overTop - pTop) * dpr);
      if (srcH <= 0) continue;
      ctx.drawImage(
        b.bitmap,
        0, srcY, b.bitmap.width, Math.min(srcH, b.bitmap.height - srcY),
        0, dstY, wDev, srcH
      );
    }
    const jpeg = await canvasToJpeg(canvas);
    pages.push({ jpeg, wPx: widthDev / dpr, hPx: cssH, imgW: wDev, imgH: hDev });
  }
  return pages;
}

/** Wrap a single full bitmap as one-or-more page images (whole-page fallback). */
export async function bitmapToPages(bitmap, dpr) {
  const totalCssH = bitmap.height / dpr;
  const band = { bitmap, cssTop: 0, cssHeight: totalCssH };
  return assemblePages([band], bitmap.width, dpr, totalCssH);
}
