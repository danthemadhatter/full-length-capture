// pdfImage.js — build a multi-page PDF from JPEG page images by hand.
//
// No external library: each page is a /DCTDecode image XObject drawn to fill a
// MediaBox sized from the image's CSS dimensions at 96 px/in. This is the raster
// output path (glyphs-as-pixels); the vector path uses Chrome's own printToPDF.
//
// Runs in the service worker — pure Uint8Array assembly, no DOM.

import { pxToPt } from "../../shared/units.js";

/**
 * @param {Array<{jpeg:Uint8Array, wPx:number, hPx:number, imgW:number, imgH:number}>} pages
 *        wPx/hPx  = CSS pixel size the page should occupy (drives the MediaBox).
 *        imgW/imgH = the JPEG's actual pixel dimensions (drives /Width /Height).
 * @returns {Blob} application/pdf
 */
export function buildImagePdf(pages) {
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

  // Header. (We keep it ASCII — a binary-marker comment written through
  // TextEncoder would be UTF-8-inflated and corrupt those bytes.)
  out("%PDF-1.4\n");
  const n = pages.length;

  // 1: Catalog, 2: Pages, then per page: Page, Content, Image (3 objs each).
  startObj();
  out("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  let kids = "";
  for (let i = 0; i < n; i++) kids += 3 + i * 3 + " 0 R ";
  startObj();
  out("2 0 obj\n<< /Type /Pages /Count " + n + " /Kids [ " + kids + "] >>\nendobj\n");

  for (let i = 0; i < n; i++) {
    const p = pages[i];
    const pageNum = 3 + i * 3;
    const contentNum = pageNum + 1;
    const imgNum = pageNum + 2;
    const wPt = pxToPt(p.wPx).toFixed(2);
    const hPt = pxToPt(p.hPx).toFixed(2);
    const content = "q " + wPt + " 0 0 " + hPt + " 0 0 cm /Im0 Do Q";

    startObj();
    out(
      pageNum +
        " 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + wPt + " " + hPt + "]" +
        " /Resources << /XObject << /Im0 " + imgNum + " 0 R >> >>" +
        " /Contents " + contentNum + " 0 R >>\nendobj\n"
    );

    startObj();
    out(contentNum + " 0 obj\n<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream\nendobj\n");

    startObj();
    out(
      imgNum +
        " 0 obj\n<< /Type /XObject /Subtype /Image /Width " + p.imgW + " /Height " + p.imgH +
        " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + p.jpeg.length + " >>\nstream\n"
    );
    out(p.jpeg);
    out("\nendstream\nendobj\n");
  }

  const xrefStart = length;
  const totalObjs = 2 + n * 3;
  let xref = "xref\n0 " + (totalObjs + 1) + "\n0000000000 65535 f \n";
  for (const off of offsets) xref += String(off).padStart(10, "0") + " 00000 n \n";
  out(xref);
  out("trailer\n<< /Size " + (totalObjs + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF");

  const total = new Uint8Array(length);
  let o = 0;
  for (const part of parts) { total.set(part, o); o += part.length; }
  return new Blob([total], { type: "application/pdf" });
}
