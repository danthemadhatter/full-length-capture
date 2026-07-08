// wholePage.js — Rung 4: terminal fallback. Grab whatever the compositor holds
// for the top target in one shot (captureBeyondViewport), tiled if taller than
// the screenshot cap, wrapped as a raster PDF. No scrolling, no frame walking —
// this only runs when every smarter rung has failed, so that a capture always
// produces *something* rather than nothing.

import { cmd, evalIn } from "../cdp.js";
import { decodePng, bitmapToPages } from "../../assemble/tiler.js";
import { buildImagePdf } from "../../assemble/pdfImage.js";
import { PHASE } from "../../../shared/messages.js";

export async function wholePage(ctx) {
  const { top, emit } = ctx;
  await cmd(top, "Page.enable", {}, 15000);
  emit(PHASE.RENDER, "Capturing visible layout…");

  const m = (await evalIn(top, `({dpr:devicePixelRatio||1})`, 5000)) || { dpr: 1 };
  const shot = await cmd(
    top, "Page.captureScreenshot",
    { format: "png", fromSurface: true, captureBeyondViewport: true },
    45000
  );
  if (!shot || !shot.data) throw new Error("wholePage: capture failed");

  const bmp = await decodePng(shot.data);
  emit(PHASE.ASSEMBLE, "Assembling PDF…");
  const pages = await bitmapToPages(bmp, m.dpr || 1);
  bmp.close && bmp.close();

  return {
    blob: buildImagePdf(pages),
    kind: "raster",
    pages: pages.length,
    capturedPx: 1,
    expectedPx: 1, // terminal fallback: we accept whatever we got
    filenameHint: "capture",
  };
}
