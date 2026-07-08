// content.js — pane picker + record-while-you-scroll. Injected on demand.
//
// This script does NOT capture anything (the service worker does that via CDP).
// Its only job is to let the user IDENTIFY which scroller to capture, then report
// that scroller's on-screen rect (top-document CSS px) back to the SW, which
// re-resolves the scroller in the page's main world using the rect as a hint.

(() => {
  const FLC_VERSION = "4.0.0";
  if (window.__flcInjected === FLC_VERSION) {
    // Already present — the SW's BEGIN_PICK message (below) will drive it.
    return;
  }
  window.__flcInjected = FLC_VERSION;

  const MSG = {
    BEGIN_PICK: "BEGIN_PICK", PANE_PICKED: "PANE_PICKED",
    RECORD_RESULT: "RECORD_RESULT", PICK_CANCELLED: "PICK_CANCELLED",
  };
  const send = (m) => { try { chrome.runtime.sendMessage(m); } catch (e) {} };

  const overflowScrolls = (el) => {
    try { const oy = getComputedStyle(el).overflowY; return oy === "auto" || oy === "scroll" || oy === "overlay"; }
    catch (e) { return false; }
  };
  const hasOverflow = (el) => el.scrollHeight > el.clientHeight + 4;

  // ---------- picker overlay ----------
  let overlay, label, picking = false, forceMode = false, climb = 0, hovered = null;
  let lastPt = { x: 0, y: 0 };

  const mkOverlay = () => {
    overlay = document.createElement("div"); overlay.className = "flc-overlay";
    label = document.createElement("div"); label.className = "flc-label";
    document.documentElement.append(overlay, label);
  };
  const rectOf = (el) => el.getBoundingClientRect();
  const place = (target) => {
    if (!overlay) mkOverlay();
    const hint = "  ·  wheel: other pane  ·  Shift: force  ·  Esc: cancel";
    if (!target) {
      Object.assign(overlay.style, { display: "block", left: "0px", top: "0px", width: innerWidth + "px", height: innerHeight + "px" });
      overlay.classList.add("flc-page");
      label.textContent = "Whole page" + hint;
    } else {
      const r = rectOf(target);
      Object.assign(overlay.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      overlay.classList.remove("flc-page");
      label.textContent = `Pane · ${Math.round(target.scrollHeight)}px tall${forceMode ? " (forced)" : ""}` + hint;
    }
    Object.assign(label.style, { left: "8px", top: "8px", maxWidth: innerWidth - 16 + "px", display: "block" });
  };
  const hide = () => { if (overlay) overlay.style.display = "none"; if (label) label.style.display = "none"; };

  const elementUnder = (x, y) => {
    if (overlay) overlay.style.pointerEvents = "none";
    if (label) label.style.pointerEvents = "none";
    for (const el of document.elementsFromPoint(x, y)) if (el !== overlay && el !== label) return el;
    return null;
  };
  const resolveTarget = (x, y) => {
    const base = elementUnder(x, y); if (!base) return null;
    if (forceMode) {
      let node = base, best = null;
      while (node && node !== document.documentElement) {
        if (node !== document.body && hasOverflow(node) && (!best || node.scrollHeight > best.scrollHeight)) best = node;
        node = node.parentElement;
      }
      return best || base;
    }
    const chain = [];
    let node = base;
    while (node && node !== document.documentElement) {
      if (node !== document.body && overflowScrolls(node) && hasOverflow(node)) chain.push(node);
      node = node.parentElement;
    }
    if (!chain.length) return null;
    return chain[Math.min(climb, chain.length - 1)];
  };
  const refresh = () => { hovered = resolveTarget(lastPt.x, lastPt.y); place(hovered); };

  const onMove = (e) => { if (!picking) return; lastPt = { x: e.clientX, y: e.clientY }; climb = 0; refresh(); };
  const onWheel = (e) => { if (!picking) return; e.preventDefault(); climb = Math.max(0, climb + (e.deltaY > 0 ? 1 : -1)); refresh(); };
  const onKeyDown = (e) => { if (e.key === "Escape") stopPick(true); else if (e.key === "Shift" && !forceMode) { forceMode = true; refresh(); } };
  const onKeyUp = (e) => { if (e.key === "Shift" && forceMode) { forceMode = false; refresh(); } };
  const onClick = (e) => {
    if (!picking) return; e.preventDefault(); e.stopPropagation();
    const t = hovered; stopPick(false);
    reportTarget(t);
  };

  const beginPick = () => {
    if (picking) return; picking = true; hovered = null; climb = 0; forceMode = false;
    if (!overlay) mkOverlay();
    document.documentElement.classList.add("flc-picking");
    overlay.style.display = "block";
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
  };
  const stopPick = (cancelled) => {
    picking = false;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    document.removeEventListener("wheel", onWheel, { capture: true });
    document.documentElement.classList.remove("flc-picking");
    hide();
    if (cancelled) send({ type: MSG.PICK_CANCELLED });
  };

  const reportTarget = (el) => {
    if (!el) { // whole page
      send({ type: MSG.PANE_PICKED, target: { rect: null, scrollHeight: document.documentElement.scrollHeight } });
      return;
    }
    const r = rectOf(el);
    send({ type: MSG.PANE_PICKED, target: {
      rect: { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: r.height },
      scrollHeight: el.scrollHeight,
    } });
  };

  // ---------- record mode ----------
  let rec = null;
  const collectScrollers = () => {
    const out = [];
    const walk = (root) => {
      let all; try { all = root.querySelectorAll("*"); } catch (e) { return; }
      for (const el of all) {
        try {
          if (el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 40) out.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
          if (el.tagName === "IFRAME") { let d = null; try { d = el.contentDocument; } catch (e) {} if (d) walk(d); }
        } catch (e) {}
      }
    };
    walk(document);
    return out;
  };
  const readingScore = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return 0;
      const area = (r.width * r.height) / (innerWidth * innerHeight);
      const centered = 1 - Math.min(1, Math.abs(r.left + r.width / 2 - innerWidth / 2) / (innerWidth / 2));
      const wf = Math.min(1, r.width / innerWidth);
      const leftHug = r.left < innerWidth * 0.15 && wf < 0.4 ? 0.25 : 1;
      return (area * 2 + centered + wf) * leftHug;
    } catch (e) { return 0; }
  };
  const startRecorder = () => {
    rec = { tracks: new Map(), lastSeen: new Map(), lastWin: scrollY, panel: null };
    const WIN = window;
    const note = (key, pos) => {
      let t = rec.tracks.get(key);
      if (!t) { t = { el: key === WIN ? null : key, min: pos, max: pos, travel: 0 }; rec.tracks.set(key, t); }
      t.min = Math.min(t.min, pos); t.max = Math.max(t.max, pos); t.travel = t.max - t.min;
    };
    rec.onScroll = (e) => {
      const el = e.target;
      if (!el || el === document || el === document.documentElement || el === document.body) note(WIN, scrollY);
      else if (el.nodeType === 1 && el.scrollHeight > el.clientHeight + 4) note(el, el.scrollTop);
    };
    document.addEventListener("scroll", rec.onScroll, { capture: true, passive: true });
    for (const el of collectScrollers()) rec.lastSeen.set(el, el.scrollTop);
    rec.poll = setInterval(() => {
      for (const el of collectScrollers()) {
        const prev = rec.lastSeen.has(el) ? rec.lastSeen.get(el) : el.scrollTop;
        if (Math.abs(el.scrollTop - prev) > 1) note(el, el.scrollTop);
        rec.lastSeen.set(el, el.scrollTop);
      }
      if (Math.abs(scrollY - rec.lastWin) > 1) note(WIN, scrollY);
      rec.lastWin = scrollY;
      updateCount();
    }, 150);
    rec.panel = makeRecPanel();
    rec.onKey = (e) => { if (e.key === "Escape") finishRecorder(true); };
    document.addEventListener("keydown", rec.onKey, true);
  };
  const updateCount = () => {
    if (!rec || !rec.panel) return;
    let lead = null;
    for (const t of rec.tracks.values()) if (!lead || t.travel > lead.travel) lead = t;
    const c = rec.panel.querySelector("#flc-reccount");
    if (!c) return;
    if (!lead || lead.travel < 1) { c.textContent = "scroll to start"; return; }
    const client = lead.el ? lead.el.clientHeight : innerHeight;
    c.textContent = "~" + Math.max(1, Math.ceil((lead.travel + client) / Math.max(1, client))) + " screens";
  };
  const makeRecPanel = () => {
    const p = document.createElement("div");
    p.className = "flc-recpanel";
    p.innerHTML = '<span class="flc-dot"></span><span id="flc-reccount">scroll to start</span>' +
      '<button id="flc-stop">Stop &amp; capture</button><button id="flc-cancel">Cancel</button>';
    document.documentElement.appendChild(p);
    p.querySelector("#flc-stop").addEventListener("click", () => finishRecorder(false));
    p.querySelector("#flc-cancel").addEventListener("click", () => finishRecorder(true));
    return p;
  };
  const finishRecorder = (cancelled) => {
    if (!rec) return;
    document.removeEventListener("scroll", rec.onScroll, { capture: true });
    document.removeEventListener("keydown", rec.onKey, true);
    clearInterval(rec.poll);
    // Winner = argmax(travel × readingScore); window scored as an ideal pane.
    let best = null, bestScore = -1;
    for (const t of rec.tracks.values()) {
      if (t.travel < 1) continue;
      const score = t.travel * (t.el ? readingScore(t.el) : 4);
      if (score > bestScore) { bestScore = score; best = t; }
    }
    if (rec.panel && rec.panel.parentNode) rec.panel.remove();
    const done = rec; rec = null;
    if (cancelled || !best) { send({ type: MSG.PICK_CANCELLED }); return; }
    if (best.el) {
      const r = best.el.getBoundingClientRect();
      send({ type: MSG.RECORD_RESULT, target: {
        rect: { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: r.height },
        scrollHeight: best.el.scrollHeight } });
    } else {
      send({ type: MSG.RECORD_RESULT, target: { rect: null, scrollHeight: document.documentElement.scrollHeight } });
    }
  };

  // ---------- entry ----------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === MSG.BEGIN_PICK) {
      if (msg.mode === "record") startRecorder(); else beginPick();
    }
  });
})();
