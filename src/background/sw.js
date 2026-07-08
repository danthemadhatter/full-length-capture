// sw.js — service worker: message router + capture lifecycle orchestration.
//
// Owns the whole run: attach (or skip it for the source fast-path), start flat
// sessions, classify, run the ladder, hand the resulting Blob to a viewer tab
// via IndexedDB, and always detach in a finally. onDetach is authoritative — if
// Chrome force-detaches (DevTools opened / tab closed) the run aborts cleanly.

import { MSG, PHASE } from "../shared/messages.js";
import { attach, detach } from "./engine/attach.js";
import { SessionManager } from "./engine/sessions.js";
import { classifySurface, planLadder, runLadder } from "./engine/ladder.js";
import { sourceBytes } from "./engine/strategies/sourceBytes.js";
import { putBlob, getBlobRecord, deleteBlob, saveSettings, loadSettings } from "./store/state.js";
import { startSession, cancelSession, captureFrame, stitchSession } from "./manualCapture.js";

// tabId -> run control ({ aborted })
const runs = new Map();
// tabId -> pending pick capture request awaiting a target from the content script
const pendingPick = new Map();

// ---- messaging helpers ----
function broadcast(msg) {
  // Popup listens while open; ignore "no receiver" errors.
  try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (e) {}
}
function setStatus(text) { chrome.storage.local.set({ lastStatus: text }); }

function makeEmit(tabId) {
  return (phase, note, done, total) => {
    const pct = total ? Math.round((done / total) * 100) : undefined;
    setStatus(note || phase);
    broadcast({ type: MSG.PROGRESS, tabId, phase, note, done, total, pct });
  };
}

// ---- router ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === MSG.DETECT_SURFACE) {
    detectSurface(msg.tabId).then((r) => sendResponse(r)).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === MSG.START_CAPTURE) {
    startCapture(msg).then(() => sendResponse({ ok: true })).catch((e) => {
      broadcast({ type: MSG.ERROR, tabId: msg.tabId, error: e.message });
      sendResponse({ ok: false, error: e.message });
    });
    return true;
  }
  if (msg.type === MSG.CANCEL_CAPTURE) {
    const r = runs.get(msg.tabId); if (r) r.aborted = true;
    pendingPick.delete(msg.tabId);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === MSG.PANE_PICKED || msg.type === MSG.RECORD_RESULT) {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    const pend = pendingPick.get(tabId);
    pendingPick.delete(tabId);
    if (pend) runCapture(pend.tabId, pend.mode, msg.target, pend.options).catch((e) =>
      broadcast({ type: MSG.ERROR, tabId: pend.tabId, error: e.message }));
    return false;
  }
  if (msg.type === MSG.PICK_CANCELLED) {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    pendingPick.delete(tabId);
    broadcast({ type: MSG.ERROR, tabId, error: "Cancelled." });
    return false;
  }
  // ---- manual scroll-capture (debugger-free) ----
  if (msg.type === MSG.SCROLLCAP_START) {
    startScrollcap(msg.tabId).then(() => sendResponse({ ok: true })).catch((e) => {
      broadcast({ type: MSG.ERROR, tabId: msg.tabId, error: e.message }); sendResponse({ ok: false, error: e.message });
    });
    return true;
  }
  if (msg.type === MSG.SCROLLCAP_FRAME) {
    const tab = sender.tab;
    if (!tab) { sendResponse({ ok: false }); return true; }
    captureFrame(tab.id, tab.windowId, {
      rect: msg.rect, innerWidth: msg.innerWidth, innerHeight: msg.innerHeight, dpr: msg.dpr,
    }).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === MSG.SCROLLCAP_DONE) {
    const tab = sender.tab;
    finishScrollcap(tab).then(() => sendResponse({ ok: true })).catch((e) => {
      broadcast({ type: MSG.ERROR, tabId: tab && tab.id, error: e.message }); sendResponse({ ok: false, error: e.message });
    });
    return true;
  }
  if (msg.type === MSG.SCROLLCAP_CANCEL) {
    if (sender.tab) cancelSession(sender.tab.id);
    return false;
  }

  if (msg.type === MSG.GET_CAPTURE) {
    getBlobRecord(msg.key).then((rec) =>
      sendResponse(rec ? { ok: true, meta: rec.meta } : { ok: false })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === MSG.DOWNLOAD_DONE) {
    deleteBlob(msg.key).catch(() => {});
    return false;
  }
});

async function startScrollcap(tabId) {
  const tab = await chrome.tabs.get(tabId);
  startSession(tabId, tab.windowId);
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content/picker.css"] }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content/scrollcap.js"] });
  // scrollcap.js self-starts on injection; BEGIN is a harmless nudge if it raced.
  chrome.tabs.sendMessage(tabId, { type: MSG.SCROLLCAP_BEGIN }, () => void chrome.runtime.lastError);
}

async function finishScrollcap(tab) {
  if (!tab) throw new Error("no tab");
  const emit = makeEmit(tab.id);
  emit(PHASE.ASSEMBLE, "Stitching your PDF…");
  const result = await stitchSession(tab.id);
  result.strategy = "manual scroll-capture";
  await finalize(tab.id, tab, result, emit);
}

async function detectSurface(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || "";
  // Lightweight, attach-free classification for the popup badge.
  if (/\.pdf($|\?)/i.test(url)) return { surface: "pdf", url };
  if (/vitalsource|bookshelf/i.test(url)) return { surface: "vitalsource", url };
  if (/wikipedia\.org/i.test(url)) return { surface: "wikipedia", url };
  if (/brightspace|d2l|desire2learn/i.test(url)) return { surface: "d2l", url };
  return { surface: "generic", url };
}

async function startCapture(msg) {
  const { tabId, mode, options = {} } = msg;
  await saveSettings(options);

  // Pane / record modes: hand off to the content script to choose a target,
  // then runCapture fires when PANE_PICKED / RECORD_RESULT comes back.
  if (mode === "pane" || mode === "record") {
    pendingPick.set(tabId, { tabId, mode, options });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content/picker.css"] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content/content.js"] });
    await chrome.tabs.sendMessage(tabId, { type: MSG.BEGIN_PICK, mode });
    return;
  }
  await runCapture(tabId, mode, null, options);
}

async function runCapture(tabId, mode, target, options) {
  const emit = makeEmit(tabId);
  const control = { aborted: false };
  runs.set(tabId, control);
  const tab = await chrome.tabs.get(tabId);
  const tabUrl = tab.url || "";

  // Source fast-path: try to grab the original file with NO debugger attach
  // (no banner) for native PDFs or explicit "download original" mode.
  if (mode === "source" || /\.pdf($|\?)/i.test(tabUrl)) {
    emit(PHASE.CLASSIFY, "Fetching original file…");
    const r = await sourceBytes({ tabUrl });
    if (r) { await finalize(tabId, tab, r, emit); runs.delete(tabId); return; }
    if (mode === "source") emit(PHASE.CLASSIFY, "Original not fetchable — capturing instead…");
  }

  let sessions = null;
  try {
    emit(PHASE.ATTACH, "Attaching…");
    await attach(tabId, (reason) => {
      control.aborted = true;
      broadcast({ type: MSG.ERROR, tabId, error: reason === "canceled_by_user"
        ? "Stopped — DevTools was opened on this tab (only one debugger can attach)."
        : "Stopped — the tab was closed or navigated." });
    });
    sessions = new SessionManager(tabId);
    await sessions.start();

    const ctx = {
      tabId, top: { tabId }, sessions, tabUrl, target, mode, options,
      emit, log: (m) => { console.log("[FLC]", m); setStatus(m); },
      isAborted: () => control.aborted,
    };

    emit(PHASE.CLASSIFY, "Analyzing page…");
    const { surface } = await classifySurface(ctx);
    ctx.surface = surface;
    const plan = planLadder(surface, mode, !!target);
    const result = await runLadder(ctx, plan);
    await finalize(tabId, tab, result, emit);
  } finally {
    if (sessions) sessions.stop();
    await detach(tabId);
    runs.delete(tabId);
  }
}

function safeName(title) {
  const base = (title || "capture").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "capture";
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${base} — ${stamp}`;
}

async function finalize(tabId, tab, result, emit) {
  emit(PHASE.HANDOFF, "Preparing download…");
  const key = "cap_" + Date.now();
  const filename = safeName(tab.title) + (result.kind === "file" ? ".pdf" : ".pdf");
  const meta = {
    filename, kind: result.kind, pages: result.pages, strategy: result.strategy,
    partial: !!result.partial, coverage: result.coverage, size: result.blob.size,
    pageUrl: tab.url,
  };
  await putBlob(key, result.blob, meta);
  const viewerUrl = chrome.runtime.getURL("src/viewer/viewer.html") + "?k=" + encodeURIComponent(key);
  await chrome.tabs.create({ url: viewerUrl });
  emit(PHASE.DONE, result.partial
    ? `Done (partial: ${Math.round((result.coverage || 0) * 100)}% via ${result.strategy}).`
    : `Done — ${result.pages || ""} page(s) via ${result.strategy}.`);
  broadcast({ type: MSG.COMPLETE, tabId, kind: result.kind, pages: result.pages, bytes: result.blob.size, partial: !!result.partial });
}
