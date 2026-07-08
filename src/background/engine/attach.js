// attach.js — chrome.debugger attach/detach lifecycle.
//
// Rules verified against the debugger API docs:
//  - Register onDetach BEFORE attaching and treat it as an authoritative hard
//    stop (opening DevTools on the tab, or closing the tab, force-detaches us).
//  - Only one debugger client per tab: attach() fails via lastError if DevTools
//    or another extension is already attached.
//  - An active debugger keeps the MV3 service worker alive, so a multi-minute
//    capture survives the idle timer without alarms — but the SW still dies on
//    detach, so real progress must be persisted elsewhere (store/state.js).
//  - Detaching the root {tabId} tears down all child sessions. Detaching an
//    already-detached target throws "Debugger is not attached" — swallow it.

const PROTOCOL = "1.3";

// tabId -> { onDetach } so we can clean up listeners on release.
const attached = new Map();

/**
 * Attach to a tab. Rejects with a friendly message if a debugger is already
 * present (the usual cause: DevTools open on the tab).
 * @param {number} tabId
 * @param {(reason:string)=>void} onDetachCb  called if Chrome force-detaches us
 */
export function attach(tabId, onDetachCb) {
  return new Promise((resolve, reject) => {
    const onDetach = (source, reason) => {
      if (source && source.tabId === tabId) {
        try { onDetachCb && onDetachCb(reason); } catch (e) {}
      }
    };
    chrome.debugger.onDetach.addListener(onDetach);
    attached.set(tabId, { onDetach });

    chrome.debugger.attach({ tabId }, PROTOCOL, () => {
      const e = chrome.runtime.lastError;
      if (e) {
        chrome.debugger.onDetach.removeListener(onDetach);
        attached.delete(tabId);
        const msg = /already attached|cannot attach|devtools/i.test(e.message)
          ? "Can't attach — close DevTools on this tab (only one debugger can attach at a time) and try again."
          : e.message;
        reject(new Error(msg));
        return;
      }
      resolve();
    });
  });
}

/** Detach from a tab. Idempotent; swallows "not attached". */
export function detach(tabId) {
  return new Promise((resolve) => {
    const rec = attached.get(tabId);
    if (rec) {
      chrome.debugger.onDetach.removeListener(rec.onDetach);
      attached.delete(tabId);
    }
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError; // ignore "not attached"
      resolve();
    });
  });
}

export function isAttached(tabId) {
  return attached.has(tabId);
}
