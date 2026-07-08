// printToPdf.js — Rung 1: real, selectable-text PDF via Page.printToPDF.
//
// Why it's primary: printToPDF lays out the WHOLE document independent of the
// viewport and composites all Blink-rendered frames (including cross-origin
// OOPIFs) in one top-level call, producing vector text.
//
// Truncation defense: printToPDF PAGINATES — with paperHeight set to the content
// height (capped at the ~199in PDF limit) it emits as many pages as needed to
// cover the document. We never size one page and assume it holds everything.
// The ladder only routes non-virtualized surfaces here (CSS flatten cannot
// un-hide virtualized items), where printToPDF is reliable.
//
// Not for: native PDF plugin (PDFium isn't in the Blink tree — handled by
// sourceBytes), or canvas/WebGL glyphs (no selectable text — falls to scrollStitch).

import { cmd } from "../cdp.js";
import { settle } from "../settle.js";
import { flatten, restoreFlatten } from "../flatten.js";
import { readStreamToBytes } from "../../io/streamReader.js";
import { pxToIn, PDF_MAX_IN, PDF_MAX_PX } from "../../../shared/units.js";
import { PHASE } from "../../../shared/messages.js";

function countPdfPages(bytes) {
  // Best-effort: scan for "/Type /Page" (not "/Pages"). Uncompressed printToPDF
  // output exposes these; if the scan finds none (object streams), return 0 and
  // let the caller fall back to the expected estimate.
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  const m = s.match(/\/Type\s*\/Page(?![s])/g);
  return m ? m.length : 0;
}

export async function printToPdf(ctx) {
  const { top, emit, options } = ctx;
  await cmd(top, "Page.enable", {}, 15000);
  // media:screen defeats @media print rules that hide content (D2L). But it can
  // pull sticky/fixed chrome; the popup exposes this as a toggle.
  if (options.mediaMode !== "print") {
    try { await cmd(top, "Emulation.setEmulatedMedia", { media: "screen" }, 8000); } catch (e) {}
  }

  emit(PHASE.SETTLE, "Loading fonts and lazy content…");
  await settle(top);

  emit(PHASE.FLATTEN, "Un-clipping inner scroll panes…");
  const flat = await flatten(top);
  // Re-measure via settle to catch height changes from flatten + late loads.
  const m2 = await settle(top);
  const sw = Math.max(flat.scrollWidth, m2.scrollWidth, 1);
  const sh = Math.max(flat.scrollHeight, m2.scrollHeight, 1);

  const paperWidthIn = pxToIn(sw);
  const paperHeightIn = Math.min(pxToIn(sh), PDF_MAX_IN);
  const expectedPages = Math.max(1, Math.ceil(sh / PDF_MAX_PX));

  emit(PHASE.RENDER, "Rendering PDF…");
  let bytes;
  try {
    const res = await cmd(
      top,
      "Page.printToPDF",
      {
        paperWidth: paperWidthIn,
        paperHeight: paperHeightIn,
        marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
        printBackground: true,
        preferCSSPageSize: false,
        transferMode: "ReturnAsStream",
      },
      90000
    );
    if (res && res.stream) {
      bytes = await readStreamToBytes(top, res.stream);
    } else if (res && res.data) {
      const bin = atob(res.data);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      throw new Error("printToPDF returned no data");
    }
  } finally {
    await restoreFlatten(top);
    if (options.mediaMode !== "print") {
      try { await cmd(top, "Emulation.setEmulatedMedia", { media: "" }, 8000); } catch (e) {}
    }
  }

  const scanned = countPdfPages(bytes);
  const pages = scanned > 0 ? scanned : expectedPages;
  // capturedPx: pagination means the produced pages cover the whole height.
  // Trust the height when the page scan is consistent; if the scan confidently
  // shows a single page for a multi-page expectation, report the shortfall so
  // the validation gate can fall through.
  const capturedPx = scanned > 0 ? Math.min(sh, scanned * paperHeightIn * 96) : sh;

  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    kind: "vector",
    pages,
    capturedPx,
    expectedPx: sh,
    filenameHint: "page",
  };
}
