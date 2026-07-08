// sessions.js — flat-session manager for one attached tab.
//
// Enables Target.setAutoAttach{flatten:true} on the root and RE-ISSUES it on
// every child session as it attaches (auto-attach does NOT cascade to
// grandchildren). Maintains a live sessionId -> frame map so a nested
// cross-origin (OOPIF) frame — e.g. VitalSource's wrapper->provider book iframe
// — can be addressed by { tabId, sessionId }.
//
// Everything a child session gives us (Runtime.evaluate, Input.*, DOM.*) works;
// only Page.captureScreenshot is top-level-only. We exploit that asymmetry
// elsewhere (read counts/detect end in the child, capture pixels from the top).

import { cmd } from "./cdp.js";

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "iframe" }, { type: "page" }],
};

export class SessionManager {
  constructor(tabId) {
    this.tabId = tabId;
    // sessionId -> { sessionId, targetId, type, url, parentSessionId }
    this.frames = new Map();
    this._onEvent = this._handleEvent.bind(this);
  }

  async start() {
    chrome.debugger.onEvent.addListener(this._onEvent);
    // Arm auto-attach on the root target. Children arrive via onEvent below.
    await cmd({ tabId: this.tabId }, "Target.setAutoAttach", AUTO_ATTACH, 15000);
  }

  stop() {
    chrome.debugger.onEvent.removeListener(this._onEvent);
    this.frames.clear();
  }

  _handleEvent(source, method, params) {
    if (!source || source.tabId !== this.tabId) return;
    if (method === "Target.attachedToTarget") {
      const info = params.targetInfo || {};
      const sid = params.sessionId;
      this.frames.set(sid, {
        sessionId: sid,
        targetId: info.targetId,
        type: info.type,
        url: info.url || "",
        parentSessionId: source.sessionId || null, // null => attached under root
      });
      // Re-arm auto-attach on this child so ITS cross-origin children attach too.
      cmd({ tabId: this.tabId, sessionId: sid }, "Target.setAutoAttach", AUTO_ATTACH, 15000)
        .catch(() => {}); // some targets reject; harmless
    } else if (method === "Target.detachedFromTarget") {
      this.frames.delete(params.sessionId);
    }
  }

  /** All tracked child sessions (does not include the root/top target). */
  all() {
    return [...this.frames.values()];
  }

  /** A child session by sessionId. */
  get(sessionId) {
    return this.frames.get(sessionId) || null;
  }

  /**
   * Heuristic: the most likely "content" frame among cross-origin children —
   * the deepest-nested iframe with a real http(s) URL. Used as the book frame
   * for the page-turn reader. Callers can override via the picked target.
   */
  bestContentFrame() {
    const depth = (f) => {
      let d = 0, cur = f;
      while (cur && cur.parentSessionId) { d++; cur = this.frames.get(cur.parentSessionId); }
      return d;
    };
    let best = null, bestDepth = -1;
    for (const f of this.frames.values()) {
      if (f.type !== "iframe") continue;
      if (!/^https?:/.test(f.url)) continue;
      const d = depth(f);
      if (d > bestDepth) { best = f; bestDepth = d; }
    }
    return best;
  }
}
