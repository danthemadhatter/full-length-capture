// sourceBytes.js — Rung 0: when the tab IS a file (native PDF) or a pane is
// PDF-backed, the best capture is the original bytes — selectable text, all
// pages, no quality loss, and (crucially) NO debugger attach, so no banner.
//
// v1 uses a plain credentialed fetch, which covers directly-opened PDFs and
// most same-site PDF sources. If the file was delivered by POST or a one-time
// token, fetch won't reproduce it; we return null and let the ladder fall
// through (a CDP Network.getResponseBody recovery is a documented next step).

export async function sourceBytes(ctx) {
  const url = ctx.tabUrl || "";
  if (!/^https?:/i.test(url)) return null;

  try {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) return null;
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    const blob = await resp.blob();
    // Only claim success for an actual PDF (or when the tab is unmistakably one).
    const looksPdf = ct.includes("application/pdf") || /\.pdf($|\?)/i.test(url) || blob.type.includes("pdf");
    if (!looksPdf) return null;

    return {
      blob: blob.type ? blob : new Blob([blob], { type: "application/pdf" }),
      kind: "file",
      pages: 0,
      capturedPx: 1,
      expectedPx: 1, // the original file — validation trivially passes
      filenameHint: "document",
    };
  } catch (e) {
    return null;
  }
}
