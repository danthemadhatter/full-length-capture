// scrollcap.js — manual scroll-capture UI (content script, no debugger).
//
// Shows a small REC bar, samples the visible tab on a timer while you scroll,
// and reports the capture region's rect so the service worker can crop + stitch.
// Sampling on a timer (not scroll events) is what makes this work on cross-origin
// panes: the top page never sees their scroll events, but a screenshot still sees
// their pixels.

(() => {
  if (window.__flcScrollcap) { return; } // already active
  window.__flcScrollcap = true;

  const MSG = {
    SCROLLCAP_BEGIN: "SCROLLCAP_BEGIN", SCROLLCAP_FRAME: "SCROLLCAP_FRAME",
    SCROLLCAP_DONE: "SCROLLCAP_DONE", SCROLLCAP_CANCEL: "SCROLLCAP_CANCEL",
  };
  const send = (m) => new Promise((r) => { try { chrome.runtime.sendMessage(m, (resp) => { void chrome.runtime.lastError; r(resp); }); } catch (e) { r(null); } });

  let lockedEl = null;   // element to crop to, or null = whole viewport
  let outline, bar, timer, picking = false, busy = false, frames = 0, started = false;

  // ---- region selection ----
  function autoRegion() {
    let best = null, bestArea = 0;
    const consider = (el, kind) => {
      try {
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 200) return;
        if (r.bottom < 0 || r.top > innerHeight) return;
        const scrolls = kind === "iframe" || (el.scrollHeight > el.clientHeight + 4);
        if (!scrolls) return;
        const area = Math.min(r.width, innerWidth) * Math.min(r.height, innerHeight);
        if (area > bestArea) { bestArea = area; best = el; }
      } catch (e) {}
    };
    const walk = (root) => {
      let all; try { all = root.querySelectorAll("*"); } catch (e) { return; }
      for (const el of all) {
        if (el.tagName === "IFRAME") consider(el, "iframe");
        else consider(el, "el");
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return best; // may be null → whole viewport
  }
  function regionRect() {
    if (!lockedEl) return { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const r = lockedEl.getBoundingClientRect();
    const x = Math.max(0, r.left), y = Math.max(0, r.top);
    return { x, y, width: Math.min(r.width, innerWidth - x), height: Math.min(r.height, innerHeight - y) };
  }
  function drawOutline() {
    if (!outline) {
      outline = document.createElement("div");
      outline.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #ff7a18;box-shadow:0 0 0 100000px rgba(0,0,0,.12);border-radius:2px;display:none;";
      document.documentElement.appendChild(outline);
    }
    const r = regionRect();
    Object.assign(outline.style, { left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px", display: "block" });
  }
  // Show the region outline briefly, then hide it — a PERSISTENT outline would be
  // baked into every screenshot (those orange lines). We only flash it.
  let flashTimer = null;
  function flashOutline(ms) {
    drawOutline();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (outline) outline.style.display = "none"; }, ms || 1200);
  }

  // ---- REC bar ----
  function makeBar() {
    bar = document.createElement("div");
    bar.className = "flc-recpanel";
    bar.style.pointerEvents = "auto";
    bar.innerHTML =
      '<span class="flc-dot"></span><span id="flc-sc-count">0 shots</span>' +
      '<button id="flc-sc-area">Change area</button>' +
      '<button id="flc-sc-done">Done — make PDF</button>' +
      '<button id="flc-sc-cancel">Cancel</button>';
    document.documentElement.appendChild(bar);
    bar.querySelector("#flc-sc-area").addEventListener("click", startPick);
    bar.querySelector("#flc-sc-done").addEventListener("click", finish);
    bar.querySelector("#flc-sc-cancel").addEventListener("click", cancel);
  }
  function setCount(n) { const c = bar && bar.querySelector("#flc-sc-count"); if (c) c.textContent = n + " shots"; }

  // ---- capture loop ----
  async function tick() {
    if (busy || picking) return;
    busy = true;
    // Hide our own overlays so they're never captured into the screenshot.
    const outWasShown = outline && outline.style.display !== "none";
    if (outline) outline.style.display = "none";
    if (bar) bar.style.visibility = "hidden";
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const resp = await send({ type: MSG.SCROLLCAP_FRAME, rect: regionRect(), innerWidth, innerHeight, dpr: window.devicePixelRatio || 1 });
      if (resp && typeof resp.frames === "number") { frames = resp.frames; setCount(frames); }
    } finally {
      if (bar) bar.style.visibility = "visible";
      if (outWasShown && outline) outline.style.display = "block";
      busy = false;
    }
  }

  // ---- change-area picker ----
  let hoverEl = null;
  const onMove = (e) => {
    const stack = document.elementsFromPoint(e.clientX, e.clientY);
    hoverEl = stack.find((el) => el !== outline && el !== bar && !bar.contains(el)) || null;
    if (hoverEl) { const r = hoverEl.getBoundingClientRect();
      Object.assign(outline.style, { left: Math.max(0, r.left) + "px", top: Math.max(0, r.top) + "px", width: r.width + "px", height: r.height + "px", display: "block" }); }
  };
  const onPick = (e) => {
    e.preventDefault(); e.stopPropagation();
    lockedEl = hoverEl && hoverEl !== document.body && hoverEl !== document.documentElement ? hoverEl : null;
    stopPick();
  };
  const onPickKey = (e) => { if (e.key === "Escape") stopPick(); };
  function startPick() {
    picking = true;
    document.documentElement.style.cursor = "crosshair";
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onPick, true);
    document.addEventListener("keydown", onPickKey, true);
  }
  function stopPick() {
    picking = false;
    document.documentElement.style.cursor = "";
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onPick, true);
    document.removeEventListener("keydown", onPickKey, true);
    flashOutline(1200);
  }

  // ---- lifecycle ----
  function begin() {
    if (started) return;
    started = true;
    lockedEl = autoRegion();
    makeBar();
    flashOutline(1400); // show the region briefly; not baked into captures
    tick(); // grab the starting view immediately
    timer = setInterval(tick, 360);
  }
  function teardown() {
    clearInterval(timer);
    stopPick();
    if (outline && outline.parentNode) outline.remove();
    if (bar && bar.parentNode) bar.remove();
    window.__flcScrollcap = false;
  }
  async function finish() {
    clearInterval(timer);
    if (bar) bar.querySelector("#flc-sc-done").textContent = "Building…";
    await send({ type: MSG.SCROLLCAP_DONE });
    teardown();
  }
  async function cancel() {
    await send({ type: MSG.SCROLLCAP_CANCEL });
    teardown();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === MSG.SCROLLCAP_BEGIN) begin();
  });
  // The SW injects this script and then sends BEGIN; if BEGIN already raced, start.
  begin();
})();
