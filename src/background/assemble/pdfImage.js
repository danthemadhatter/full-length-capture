// pdfImage.js — build a ONE-PAGE PDF from JPEG tiles by hand.
//
// No external library: every tile is a /DCTDecode image XObject drawn into the
// SAME page's content stream at its own vertical offset. However many tiles a
// long capture needed (to stay under the canvas pixel caps), the PDF has
// exactly one /Page object — no pagination, no seams, no page breaks.
//
// A capture taller than the PDF spec's ~200in MediaBox cap gets its PAGE
// physically shrunk (both axes, aspect ratio preserved); every tile keeps its
// full source resolution, so the page just renders at a higher effective DPI —
// nothing is cropped or resampled away.
//
// Runs in the service worker — pure Uint8Array assembly, no DOM.

import { pxToPt, PDF_MAX_IN } from "../../shared/units.js";

const PDF_MAX_PT = PDF_MAX_IN * 72;

/**
 * @param {Array<{jpeg:Uint8Array, topPx:number, cssHeight:number, imgW:number, imgH:number}>} tiles
 *        ordered top-to-bottom, contiguous, non-overlapping in CSS px.
 * @param {number} totalWidthPx  full page width, CSS px (shared by every tile)
 * @param {number} totalHeightPx full page height, CSS px
 * @returns {Blob} application/pdf, exactly one page
 */
export function buildImagePdf(tiles, totalWidthPx, totalHeightPx) {
  const enc = new TextEncoder();
  const parts = [];
  let length = 0;
  const offsets = [];
  const out = (d) => {
    const b = typeof d === "string" ? enc.encode(d) : d;
    parts.push(b);
    length += b.length;
  };
  const startObj = () => offsets.push(length);

  const rawWPt = pxToPt(totalWidthPx);
  const rawHPt = pxToPt(totalHeightPx);
  const scale = Math.min(1, PDF_MAX_PT / rawWPt, PDF_MAX_PT / rawHPt);
  const pageWPt = rawWPt * scale;
  const pageHPt = rawHPt * scale;

  // Header. (We keep it ASCII — a binary-marker comment written through
  // TextEncoder would be UTF-8-inflated and corrupt those bytes.)
  out("%PDF-1.4\n");
  const n = tiles.length;

  // 1: Catalog, 2: Pages, 3: the (one) Page, 4: its Contents, 5..: one Image XObject per tile.
  startObj();
  out("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  startObj();
  out("2 0 obj\n<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>\nendobj\n");

  let xobjDict = "";
  let content = "";
  const wPt = pxToPt(totalWidthPx) * scale;
  for (let i = 0; i < n; i++) {
    const t = tiles[i];
    const imgNum = 5 + i;
    const hPt = pxToPt(t.cssHeight) * scale;
    // Flip Y: PDF origin is bottom-left; topPx is measured from the visual top.
    const yPt = pageHPt - pxToPt(t.topPx + t.cssHeight) * scale;
    xobjDict += "/Im" + i + " " + imgNum + " 0 R ";
    content += "q " + wPt.toFixed(2) + " 0 0 " + hPt.toFixed(2) + " 0 " + yPt.toFixed(2) + " cm /Im" + i + " Do Q\n";
  }

  startObj();
  out(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + pageWPt.toFixed(2) + " " + pageHPt.toFixed(2) + "]" +
      " /Resources << /XObject << " + xobjDict + ">> >>" +
      " /Contents 4 0 R >>\nendobj\n"
  );

  startObj();
  out("4 0 obj\n<< /Length " + content.length + " >>\nstream\n" + content + "endstream\nendobj\n");

  for (let i = 0; i < n; i++) {
    const t = tiles[i];
    const imgNum = 5 + i;
    startObj();
    out(
      imgNum +
        " 0 obj\n<< /Type /XObject /Subtype /Image /Width " + t.imgW + " /Height " + t.imgH +
        " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + t.jpeg.length + " >>\nstream\n"
    );
    out(t.jpeg);
    out("\nendstream\nendobj\n");
  }

  const xrefStart = length;
  const totalObjs = 4 + n;
  let xref = "xref\n0 " + (totalObjs + 1) + "\n0000000000 65535 f \n";
  for (const off of offsets) xref += String(off).padStart(10, "0") + " 00000 n \n";
  out(xref);
  out("trailer\n<< /Size " + (totalObjs + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF");

  const total = new Uint8Array(length);
  let o = 0;
  for (const part of parts) { total.set(part, o); o += part.length; }
  return new Blob([total], { type: "application/pdf" });
}
