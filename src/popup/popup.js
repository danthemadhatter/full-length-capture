// popup.js — capture controls, shown only while a capture is active.
//
// The service worker attaches this as the tab's action popup (via
// chrome.action.setPopup) only once a capture starts, and detaches it again on
// Done/Cancel. Chrome never fires action.onClicked for a tab that has a popup
// set — it opens the popup instead — so a plain click starts a capture, and a
// SECOND click while one is running opens this. A popup is browser UI, not
// part of the tab's rendered surface, so chrome.tabs.captureVisibleTab never
// sees it: no hide/show dance, no flicker, regardless of session length.

import { MSG } from "../shared/messages.js";

const $ = (id) => document.getElementById(id);
let tabId = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  const badge = await chrome.action.getBadgeText({ tabId });
  $("count").textContent = (badge || "0") + " shots";
}

const send = (msg) => chrome.runtime.sendMessage({ ...msg, tabId });

function setStatus(text, isError) {
  const el = $("status");
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.tabId !== tabId) return;
  if (msg.type === MSG.SCROLLCAP_COUNT) $("count").textContent = msg.frames + " shots";
  if (msg.type === MSG.SCROLLCAP_BUILDING) { $("done").disabled = true; $("done").textContent = "Building…"; setStatus(""); }
  if (msg.type === MSG.SCROLLCAP_FAILED) {
    $("done").disabled = false;
    $("done").textContent = "Done — make PDF";
    setStatus(msg.error || "Failed — try again", true);
  }
});

$("area").addEventListener("click", () => { send({ type: MSG.SCROLLCAP_CHANGE_AREA }); window.close(); });
$("done").addEventListener("click", () => {
  $("done").disabled = true;
  $("done").textContent = "Building…";
  send({ type: MSG.SCROLLCAP_DONE });
});
$("cancel").addEventListener("click", () => { send({ type: MSG.SCROLLCAP_CANCEL }); window.close(); });

init();
