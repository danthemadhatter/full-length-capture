// sw.js — service worker: click the toolbar icon, start a scroll-capture
// session, stitch the frames into one seamless PDF, hand it to a viewer tab.
//
// There is exactly one flow. Clicking the icon starts a capture. While one is
// running, the badge shows a live shot count and a SECOND click opens a popup
// with Change area / Done / Cancel — chrome.action.onClicked never fires for a
// tab that has a popup attached, so attaching/detaching the popup per-tab is
// what switches between "start" and "control" behavior. Both the badge and the
// popup are browser UI, never part of the tab's own rendered surface, so
// chrome.tabs.captureVisibleTab never sees them — no hide/show dance, no
// flicker, no matter how long a capture session runs.

import { MSG } from "../shared/messages.js";
import { putBlob, getBlobRecord, deleteBlob } from "./store/state.js";
import { startSession, cancelSession, resetSession, captureFrame, stitchSession } from "./manualCapture.js";

const UNSUPPORTED_URL = /^(chrome|edge|about|chrome-extension|devtools|view-source):/i;

chrome.action.onClicked.addListener((tab) => {
  startCapture(tab).catch((e) => { console.error("[FLC]", e); flashBadge(tab && tab.id, "!"); });
});

async function startCapture(tab) {
  if (!tab || !tab.id || UNSUPPORTED_URL.test(tab.url || "")) {
    flashBadge(tab && tab.id, "×");
    return;
  }
  startSession(tab.id, tab.windowId);
  await chrome.action.setPopup({ tabId: tab.id, popup: "src/popup/popup.html" });
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#ff7a18" });
  await chrome.action.setBadgeText({ tabId: tab.id, text: "0" });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content/scrollcap.js"] });
}

function flashBadge(tabId, text) {
  if (tabId == null) return;
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#ff3b3b" });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), 1500);
}

function broadcast(msg) {
  try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (e) {}
}

// Detach the popup and clear the badge — reverts the icon to "click to start
// a new capture" behavior.
function resetAction(tabId) {
  chrome.action.setPopup({ tabId, popup: "" }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // ---- from the content script (identified by sender.tab — it runs IN the captured tab) ----
  if (msg.type === MSG.SCROLLCAP_FRAME) {
    const tab = sender.tab;
    if (!tab) { sendResponse({ ok: false }); return true; }
    captureFrame(tab.id, tab.windowId, { rect: msg.rect, innerWidth: msg.innerWidth, innerHeight: msg.innerHeight, dpr: msg.dpr })
      .then((r) => {
        sendResponse(r);
        if (r.ok) {
          chrome.action.setBadgeText({ tabId: tab.id, text: String(r.frames) });
          broadcast({ type: MSG.SCROLLCAP_COUNT, tabId: tab.id, frames: r.frames });
        }
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === MSG.SCROLLCAP_RESET) {
    if (sender.tab) resetSession(sender.tab.id);
    return false;
  }

  // ---- from the popup (a bare extension page — carries its own tabId) ----
  if (msg.type === MSG.SCROLLCAP_CHANGE_AREA) {
    chrome.tabs.sendMessage(msg.tabId, { type: MSG.SCROLLCAP_ENTER_PICK }, () => void chrome.runtime.lastError);
    return false;
  }
  if (msg.type === MSG.SCROLLCAP_DONE) {
    // Pause sampling BEFORE stitching reads the frame list — otherwise the
    // content script's still-running timer could push a new frame into the
    // session while stitchSession() is mid-iteration over it.
    chrome.tabs.sendMessage(msg.tabId, { type: MSG.SCROLLCAP_PAUSE }, () => void chrome.runtime.lastError);
    broadcast({ type: MSG.SCROLLCAP_BUILDING, tabId: msg.tabId });
    finishCapture(msg.tabId)
      .then(() => { stopContentScript(msg.tabId); resetAction(msg.tabId); sendResponse({ ok: true }); })
      .catch((e) => {
        chrome.tabs.sendMessage(msg.tabId, { type: MSG.SCROLLCAP_RESUME }, () => void chrome.runtime.lastError);
        broadcast({ type: MSG.SCROLLCAP_FAILED, tabId: msg.tabId, error: e.message });
        sendResponse({ ok: false, error: e.message });
      });
    return true;
  }
  if (msg.type === MSG.SCROLLCAP_CANCEL) {
    cancelSession(msg.tabId);
    stopContentScript(msg.tabId);
    resetAction(msg.tabId);
    return false;
  }

  // ---- from the viewer tab ----
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

function stopContentScript(tabId) {
  chrome.tabs.sendMessage(tabId, { type: MSG.SCROLLCAP_STOP }, () => void chrome.runtime.lastError);
}

function safeName(title) {
  const base = (title || "capture").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "capture";
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${base} — ${stamp}`;
}

async function finishCapture(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const result = await stitchSession(tabId);
  const key = "cap_" + crypto.randomUUID();
  const filename = safeName(tab.title) + ".pdf";
  const meta = { filename, pages: 1, size: result.blob.size, pageUrl: tab.url };
  await putBlob(key, result.blob, meta);
  const viewerUrl = chrome.runtime.getURL("src/viewer/viewer.html") + "?k=" + encodeURIComponent(key);
  await chrome.tabs.create({ url: viewerUrl });
}
