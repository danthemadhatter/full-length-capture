// scrollcap.js — the in-page half of scroll-capture (content script, no debugger).
//
// Samples the visible tab on a timer while you scroll, and reports the capture
// region's rect so the service worker can crop + stitch. Sampling on a timer
// (not scroll events) is what makes this work on cross-origin panes: the top
// page never sees their scroll events, but a screenshot still sees their pixels.
//
// The controls (shot count, Change area, Done, Cancel) live in the toolbar
// action's popup (src/popup/), NOT here. A control bar injected into the page
// would need to hide itself before every single screenshot and reappear after —
// at ~3 captures/sec for the whole scroll session, that's a visible strobe with
// no way to shorten it away (the human eye perceives on/off cycling far below
// that rate). The popup is rendered by the browser's own chrome outside the
// page's surface, so chrome.tabs.captureVisibleTab structurally never sees it —
// nothing to hide, so nothing to flicker. The service worker attaches that
// popup to this tab only once a capture starts (see sw.js), so a plain click
// starts a capture and a second click — once the popup is attached — opens
// the controls instead.

(() => {
  if (window.__flcScrollcap) { return; } // already active
  window.__flcScrollcap = true;

  const MSG = {
    SCROLLCAP_FRAME: "SCROLLCAP_FRAME", SCROLLCAP_RESET: "SCROLLCAP_RESET",
    SCROLLCAP_ENTER_PICK: "SCROLLCAP_ENTER_PICK",
    SCROLLCAP_PAUSE: "SCROLLCAP_PAUSE", SCROLLCAP_RESUME: "SCROLLCAP_RESUME", SCROLLCAP_STOP: "SCROLLCAP_STOP",
    SCROLLCAP_AUTO_APPLY: "SCROLLCAP_AUTO_APPLY", SCROLLCAP_END_DETECTED: "SCROLLCAP_END_DETECTED",
  };
  const send = (m) => new Promise((r) => { try { chrome.runtime.sendMessage(m, (resp) => { void chrome.runtime.lastError; r(resp); }); } catch (e) { r(null); } });

  const SPEEDS = {
    slow: { ratio: 0.5, pause: 600 },
    medium: { ratio: 0.65, pause: 400 },
    fast: { ratio: 0.8, pause: 250 },
  };
  const END_DUP_STREAK = 8;

  let lockedEl = null;   // element to crop to, or null = whole viewport
  let outline, timer, scrollTimer, picking = false, busy = false;
  let autoEnabled = false, autoSpeed = "medium", dupStreak = 0, lastFrames = 0;

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
  // baked into every screenshot (those orange lines). We only flash it, once, at
  // the start and after picking a new area — never on a per-capture cadence.
  let flashTimer = null;
  function flashOutline(ms) {
    drawOutline();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (outline) outline.style.display = "none"; }, ms || 1200);
  }

  // ---- auto-scroll assist (optional; manual scroll still works) ----
  function scrollTarget() {
    if (lockedEl) return lockedEl;
    return document.scrollingElement || document.documentElement;
  }
  function tryScrollStep(step) {
    const el = scrollTarget();
    if (!el) return;
    try {
      if (typeof el.scrollBy === "function") {
        el.scrollBy({ top: step, left: 0, behavior: "instant" });
        return;
      }
    } catch (e) {}
    try {
      const win = el.contentWindow || (el.tagName === "IFRAME" ? el.contentWindow : null);
      if (win && typeof win.scrollBy === "function") {
        win.scrollBy(0, step);
        return;
      }
    } catch (e) {}
    try {
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : regionRect();
      const cx = r.left + r.width / 2, cy = r.top + Math.min(r.height * 0.6, r.height - 8);
      el.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, deltaMode: 0, deltaY: step, clientX: cx, clientY: cy,
      }));
    } catch (e) {}
  }
  function scrollStep() {
    if (!autoEnabled || picking || busy) return;
    const h = regionRect().height;
    tryScrollStep(Math.max(40, Math.round(h * (SPEEDS[autoSpeed] || SPEEDS.medium).ratio)));
  }
  function startAutoScroll() {
    stopAutoScroll();
    dupStreak = 0;
    const pause = (SPEEDS[autoSpeed] || SPEEDS.medium).pause;
    scrollTimer = setInterval(scrollStep, pause);
  }
  function stopAutoScroll() {
    clearInterval(scrollTimer);
    scrollTimer = null;
  }
  function applyAutoScroll(enabled, speed) {
    autoEnabled = !!enabled;
    autoSpeed = SPEEDS[speed] ? speed : "medium";
    dupStreak = 0;
    if (autoEnabled) startAutoScroll();
    else stopAutoScroll();
  }
  function noteCaptureResult(resp) {
    if (!resp || !resp.ok) return;
    if (resp.duplicate) {
      dupStreak++;
      if (autoEnabled && dupStreak >= END_DUP_STREAK) {
        stopAutoScroll();
        send({ type: MSG.SCROLLCAP_END_DETECTED });
      }
      return;
    }
    if (!resp.throttled && resp.frames > lastFrames) dupStreak = 0;
    lastFrames = resp.frames;
  }

  // ---- capture loop ----
  async function tick() {
    if (busy || picking) return;
    busy = true;
    // The outline only needs hiding on the rare tick where it's still mid-flash.
    const outWasShown = outline && outline.style.display !== "none";
    if (outline) outline.style.display = "none";
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const resp = await send({ type: MSG.SCROLLCAP_FRAME, rect: regionRect(), innerWidth, innerHeight, dpr: window.devicePixelRatio || 1 });
      noteCaptureResult(resp);
    } finally {
      if (outWasShown && outline) outline.style.display = "block";
      busy = false;
    }
  }

  // ---- change-area picker ----
  let hoverEl = null;
  const onMove = (e) => {
    const stack = document.elementsFromPoint(e.clientX, e.clientY);
    hoverEl = stack.find((el) => el !== outline) || null;
    if (hoverEl) { const r = hoverEl.getBoundingClientRect();
      Object.assign(outline.style, { left: Math.max(0, r.left) + "px", top: Math.max(0, r.top) + "px", width: r.width + "px", height: r.height + "px", display: "block" }); }
  };
  const onPick = (e) => {
    e.preventDefault(); e.stopPropagation();
    lockedEl = hoverEl && hoverEl !== document.body && hoverEl !== document.documentElement ? hoverEl : null;
    stopPick();
    // A different region means every earlier screenshot is of the WRONG
    // content — it can never be stitched with what comes next, so start over.
    send({ type: MSG.SCROLLCAP_RESET });
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
    lockedEl = autoRegion();
    flashOutline(1400); // show the region briefly; not baked into captures
    tick(); // grab the starting view immediately
    timer = setInterval(tick, 360);
  }
  function teardown() {
    clearInterval(timer);
    stopAutoScroll();
    stopPick();
    if (outline && outline.parentNode) outline.remove();
    window.__flcScrollcap = false;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === MSG.SCROLLCAP_ENTER_PICK) startPick();
    if (msg.type === MSG.SCROLLCAP_PAUSE) { clearInterval(timer); stopAutoScroll(); }
    if (msg.type === MSG.SCROLLCAP_RESUME) {
      timer = setInterval(tick, 360);
      if (autoEnabled) startAutoScroll();
    }
    if (msg.type === MSG.SCROLLCAP_AUTO_APPLY) applyAutoScroll(msg.enabled, msg.speed);
    if (msg.type === MSG.SCROLLCAP_STOP) teardown();
  });

  begin();
})();
