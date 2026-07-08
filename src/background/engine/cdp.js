// cdp.js — thin promise wrapper over chrome.debugger.sendCommand.
//
// The single most important detail in this whole extension lives here: a command
// target is a DebuggerSession = { tabId } for the TOP target, or
// { tabId, sessionId } for a child (OOPIF) session. Chrome 125+ "flat sessions"
// route by sessionId; routing a cross-origin child by frameId from the top
// session does NOT work (that was the prior attempts' core failure).
//
// chrome.debugger.sendCommand returns a Promise since Chrome 96, but we still
// funnel through a wrapper so we can (a) surface chrome.runtime.lastError as a
// rejection and (b) enforce a per-call timeout — a wedged child session must
// never hang the whole capture.

export function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout: " + (label || "cdp"))), ms)
    ),
  ]);
}

/**
 * Send a CDP command.
 * @param {{tabId:number, sessionId?:string}} target  DebuggerSession
 * @param {string} method  e.g. "Page.printToPDF"
 * @param {object} [params]
 * @param {number} [timeoutMs]
 */
export function cmd(target, method, params = {}, timeoutMs = 60000) {
  const p = new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(method + ": " + e.message));
      else resolve(result);
    });
  });
  return withTimeout(p, timeoutMs, method);
}

/**
 * Runtime.evaluate an async expression in a given session and return its value.
 * Returns null on any failure (timeout, session gone, throw) so callers can
 * treat an unreachable frame as "nothing here" rather than crashing.
 */
export async function evalIn(target, expression, timeoutMs = 15000) {
  try {
    const r = await cmd(
      target,
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs
    );
    if (r && r.result && r.result.value !== undefined) return r.result.value;
    return null;
  } catch (e) {
    return null;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
