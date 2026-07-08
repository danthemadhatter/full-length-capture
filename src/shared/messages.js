// messages.js — single source of truth for the message protocol between the
// three execution contexts (content script, service worker, viewer tab).
//
// Every message is { type: MSG.X, ...payload }. Keeping the constants here means
// a typo is a ReferenceError at load time instead of a silently-dropped message.

export const MSG = {
  // content script -> service worker (the content script self-starts on
  // injection — no "begin" message needed, chrome.scripting.executeScript
  // running the file IS the start signal)
  SCROLLCAP_FRAME: "SCROLLCAP_FRAME", // { rect, innerWidth, innerHeight, dpr } -> { ok, frames }
  SCROLLCAP_RESET: "SCROLLCAP_RESET", // "Change area" picked a new region — discard frames captured so far

  // side panel -> service worker. The controls live in the side panel (not the
  // page), so these carry an explicit tabId — a side panel isn't "attached" to
  // a tab the way a content script's sender.tab is.
  SCROLLCAP_DONE: "SCROLLCAP_DONE", // { tabId } -> stitch + save -> { ok, error? }
  SCROLLCAP_CANCEL: "SCROLLCAP_CANCEL", // { tabId } -> abandon the session
  SCROLLCAP_CHANGE_AREA: "SCROLLCAP_CHANGE_AREA", // { tabId } -> tell the content script to enter pick mode

  // service worker -> content script
  SCROLLCAP_ENTER_PICK: "SCROLLCAP_ENTER_PICK", // enter "click to pick a region" mode
  SCROLLCAP_PAUSE: "SCROLLCAP_PAUSE", // stop sampling WITHOUT tearing down — stitching is about to read the frame list, so nothing may be appended to it mid-read
  SCROLLCAP_RESUME: "SCROLLCAP_RESUME", // stitching failed — resume sampling so the user can keep scrolling and retry
  SCROLLCAP_STOP: "SCROLLCAP_STOP", // stitching succeeded (or cancelled) — full teardown

  // service worker -> side panel (broadcast; the panel filters by its own tabId)
  SCROLLCAP_COUNT: "SCROLLCAP_COUNT", // { tabId, frames }
  SCROLLCAP_BUILDING: "SCROLLCAP_BUILDING", // { tabId } — stitching in progress
  SCROLLCAP_FAILED: "SCROLLCAP_FAILED", // { tabId, error }

  // viewer tab <-> service worker
  GET_CAPTURE: "GET_CAPTURE", // { key } -> { ok, meta } (the blob itself comes from IndexedDB directly)
  DOWNLOAD_DONE: "DOWNLOAD_DONE", // { key }
};
