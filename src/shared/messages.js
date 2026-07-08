// messages.js — single source of truth for the message protocol between the
// four execution contexts (popup, content script, service worker, viewer tab).
//
// Every message is { type: MSG.X, ...payload }. Keeping the constants here means
// a typo is a ReferenceError at load time instead of a silently-dropped message.

export const MSG = {
  // popup -> service worker
  DETECT_SURFACE: "DETECT_SURFACE", // { tabId } -> { surface, flags }
  START_CAPTURE: "START_CAPTURE", // { tabId, mode, target?, options } mode: "auto"|"pane"|"record"|"source"
  CANCEL_CAPTURE: "CANCEL_CAPTURE", // { tabId }

  // popup -> content script (relayed by SW via chrome.tabs.sendMessage)
  BEGIN_PICK: "BEGIN_PICK", // { mode: "pane"|"record" }

  // content script -> service worker
  PANE_PICKED: "PANE_PICKED", // { target } target = { domPath, rect, docMetrics, framePath }
  RECORD_RESULT: "RECORD_RESULT", // { target }
  PICK_CANCELLED: "PICK_CANCELLED", // {}

  // service worker -> popup (broadcast; popup listens while open)
  PROGRESS: "PROGRESS", // { phase, note, done?, total?, pct? }
  COMPLETE: "COMPLETE", // { viewerUrl?, kind, bytes, pages }
  ERROR: "ERROR", // { error }

  // service worker <-> viewer tab
  GET_CAPTURE: "GET_CAPTURE", // viewer -> SW { key } -> { ok, meta }  (blob comes from IDB directly)
  DOWNLOAD_DONE: "DOWNLOAD_DONE", // viewer -> SW { key }

  // Manual scroll-capture (debugger-free: plain tab screenshots you drive by
  // scrolling). popup -> SW starts it; content <-> SW stream frames; then stitch.
  SCROLLCAP_START: "SCROLLCAP_START", // popup -> SW { tabId }
  SCROLLCAP_BEGIN: "SCROLLCAP_BEGIN", // SW -> content (start the REC bar)
  SCROLLCAP_FRAME: "SCROLLCAP_FRAME", // content -> SW { offset, rect, innerWidth, clientHeight, scrollHeight, dpr } -> { ok, frames }
  SCROLLCAP_DONE: "SCROLLCAP_DONE", // content -> SW (stitch + save)
  SCROLLCAP_CANCEL: "SCROLLCAP_CANCEL", // content -> SW
};

// Capture phases, used for progress reporting and resumable state.
export const PHASE = {
  CLASSIFY: "classify",
  ATTACH: "attach",
  SETTLE: "settle",
  FLATTEN: "flatten",
  MEASURE: "measure",
  RENDER: "render",
  SCROLL: "scroll",
  PAGETURN: "pageturn",
  ASSEMBLE: "assemble",
  HANDOFF: "handoff",
  DONE: "done",
};

// Strategy identifiers (rungs of the ladder).
export const STRATEGY = {
  SOURCE_BYTES: "sourceBytes", // rung 0
  PRINT_TO_PDF: "printToPdf", // rung 1
  SCROLL_STITCH: "scrollStitch", // rung 2
  PAGE_TURN: "pageTurnReader", // rung 3
  WHOLE_PAGE: "wholePage", // rung 4
};

// Surface classes the ladder branches on.
export const SURFACE = {
  PDF: "pdf",
  VIRTUALIZED: "virtualized",
  WIKIPEDIA: "wikipedia",
  D2L: "d2l",
  VITALSOURCE: "vitalsource",
  GENERIC: "generic",
};
