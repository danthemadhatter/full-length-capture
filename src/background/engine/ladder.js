// ladder.js — surface classifier + fallback runner with the validation gate.
//
// classifySurface probes the top document and URL to route into the right rung
// order. runLadder tries each rung, and after each one that returns output it
// runs the validation gate: a rung that DIDN'T THROW but under-captured (the
// silent-truncation failure) is rejected and the ladder falls through.

import { evalIn } from "./cdp.js";
import { validateCoverage } from "./validate.js";
import { SURFACE, STRATEGY, PHASE } from "../../shared/messages.js";

import { sourceBytes } from "./strategies/sourceBytes.js";
import { printToPdf } from "./strategies/printToPdf.js";
import { scrollStitch } from "./strategies/scrollStitch.js";
import { pageTurnReader } from "./strategies/pageTurnReader.js";
import { wholePage } from "./strategies/wholePage.js";

const RUNNERS = {
  [STRATEGY.SOURCE_BYTES]: sourceBytes,
  [STRATEGY.PRINT_TO_PDF]: printToPdf,
  [STRATEGY.SCROLL_STITCH]: scrollStitch,
  [STRATEGY.PAGE_TURN]: pageTurnReader,
  [STRATEGY.WHOLE_PAGE]: wholePage,
};

const PROBE_JS = `(() => {
  const host = location.hostname || "";
  const virtual = !!document.querySelector(
    "cdk-virtual-scroll-viewport,[data-virtualized],.ReactVirtualized__Grid,.rv-grid,[class*='virtual-scroll']"
  );
  let iframeCount = 0, bigIframe = false;
  try { document.querySelectorAll("iframe").forEach(f => { iframeCount++;
    const r = f.getBoundingClientRect(); if (r.width>300 && r.height>300) bigIframe = true; }); } catch(e){}
  return {
    host,
    contentType: document.contentType || "",
    virtual, iframeCount, bigIframe,
  };
})()`;

export async function classifySurface(ctx) {
  const url = ctx.tabUrl || "";
  const probe = (await evalIn(ctx.top, PROBE_JS, 8000)) || { host: "", contentType: "", virtual: false, bigIframe: false };
  const host = probe.host || "";

  if (probe.contentType === "application/pdf" || /\.pdf($|\?)/i.test(url)) {
    return { surface: SURFACE.PDF, flags: probe };
  }
  if (/vitalsource|bookshelf/i.test(host)) return { surface: SURFACE.VITALSOURCE, flags: probe };
  if (/wikipedia\.org/i.test(host)) return { surface: SURFACE.WIKIPEDIA, flags: probe };
  if (/brightspace|d2l|desire2learn/i.test(host)) return { surface: SURFACE.D2L, flags: probe };
  if (probe.virtual) return { surface: SURFACE.VIRTUALIZED, flags: probe };
  return { surface: SURFACE.GENERIC, flags: probe };
}

/** Ordered rung list for a surface + mode. */
export function planLadder(surface, mode, hasTarget) {
  if (mode === "source") return [STRATEGY.SOURCE_BYTES, STRATEGY.WHOLE_PAGE];
  // A specifically-picked pane is best served by scroll-stitch (printToPDF is
  // whole-document), so try it first when the user pointed at something.
  if ((mode === "pane" || mode === "record") && hasTarget) {
    return [STRATEGY.SCROLL_STITCH, STRATEGY.PRINT_TO_PDF, STRATEGY.WHOLE_PAGE];
  }
  switch (surface) {
    case SURFACE.PDF:
      return [STRATEGY.SOURCE_BYTES, STRATEGY.WHOLE_PAGE];
    case SURFACE.VITALSOURCE:
      return [STRATEGY.PAGE_TURN, STRATEGY.SCROLL_STITCH, STRATEGY.WHOLE_PAGE];
    case SURFACE.VIRTUALIZED:
      // CSS flatten can't un-hide virtualized items — skip printToPdf.
      return [STRATEGY.SOURCE_BYTES, STRATEGY.SCROLL_STITCH, STRATEGY.WHOLE_PAGE];
    case SURFACE.WIKIPEDIA:
    case SURFACE.D2L:
    case SURFACE.GENERIC:
    default:
      return [STRATEGY.PRINT_TO_PDF, STRATEGY.SCROLL_STITCH, STRATEGY.WHOLE_PAGE];
  }
}

export async function runLadder(ctx, plan) {
  let fallback = null;
  for (const name of plan) {
    if (ctx.isAborted()) throw new Error("Capture cancelled.");
    const run = RUNNERS[name];
    if (!run) continue;
    ctx.emit(PHASE.RENDER, `Trying ${name}…`);
    let result;
    try {
      result = await run(ctx);
    } catch (e) {
      ctx.log(`${name} failed: ${e.message}`);
      continue;
    }
    if (!result) continue; // strategy declined (e.g. sourceBytes on a non-file)

    const gate = validateCoverage(result.capturedPx, result.expectedPx);
    if (gate.ok) {
      result.strategy = name;
      result.coverage = gate.coverage;
      return result;
    }
    ctx.log(`${name}: ${gate.reason}`);
    // Keep the best partial as a last resort but keep trying better rungs.
    if (!fallback || (result.capturedPx || 0) > (fallback.capturedPx || 0)) {
      fallback = result; fallback.strategy = name; fallback.coverage = gate.coverage; fallback.partial = true;
    }
  }
  if (fallback) return fallback;
  throw new Error("No capture strategy succeeded on this page.");
}
