import { MSG } from "../shared/messages.js";

const $ = (id) => document.getElementById(id);
const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, (resp) => { void chrome.runtime.lastError; r(resp); }));

let activeTab = null;
let surface = "generic";

function status(text, kind = "") {
  const s = $("status");
  s.textContent = text;
  s.className = "status" + (kind ? " " + kind : "");
}

function options() {
  return { mediaMode: $("mediaMode").value, consent: $("consentChk") ? $("consentChk").checked : false };
}

async function init() {
  try { $("ver").textContent = "v" + chrome.runtime.getManifest().version; } catch (e) {}
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  if (!tab || /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(tab.url || "")) {
    status("Open a normal web page to capture it.", "warn");
    document.querySelectorAll(".actions button").forEach((b) => (b.disabled = true));
    $("surfaceBadge").textContent = "unsupported page";
    return;
  }
  const det = await send({ type: MSG.DETECT_SURFACE, tabId: tab.id });
  surface = (det && det.surface) || "generic";
  $("surfaceBadge").textContent = surface;
  if (surface === "pdf") { $("btnSource").classList.remove("hidden"); status("This is a PDF — downloading the original is best."); }
  if (surface === "vitalsource") { $("consent").classList.remove("hidden"); status("Reader detected — page-turn capture is experimental."); }
}

async function launch(mode) {
  if (surface === "vitalsource" && (mode === "auto" || mode === "pane" || mode === "record")) {
    if (!$("consentChk").checked) { status("Tick the entitlement box to capture this reader.", "warn"); return; }
  }
  document.querySelectorAll(".actions button").forEach((b) => (b.disabled = true));
  status(mode === "pane" || mode === "record" ? "Choose the pane in the page…" : "Starting…", "busy");
  const resp = await send({ type: MSG.START_CAPTURE, tabId: activeTab.id, mode, options: options() });
  if (mode === "pane" || mode === "record") window.close(); // interaction happens in the page
  if (resp && resp.ok === false) { status(resp.error || "Failed.", "warn"); document.querySelectorAll(".actions button").forEach((b) => (b.disabled = false)); }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === MSG.PROGRESS) status(msg.note || msg.phase + (msg.pct != null ? ` ${msg.pct}%` : ""), "busy");
  else if (msg.type === MSG.COMPLETE) {
    status(msg.partial ? "Done (partial — opened result tab)." : "Done — opened result tab.", "ok");
    document.querySelectorAll(".actions button").forEach((b) => (b.disabled = false));
  } else if (msg.type === MSG.ERROR) {
    status(msg.error || "Failed.", "warn");
    document.querySelectorAll(".actions button").forEach((b) => (b.disabled = false));
  }
});

async function startScroll() {
  if (!activeTab) return;
  status("Starting scroll-capture — scroll the page, then click Done.", "busy");
  await send({ type: MSG.SCROLLCAP_START, tabId: activeTab.id });
  window.close();
}

$("btnScroll").addEventListener("click", startScroll);
$("btnAuto").addEventListener("click", () => launch("auto"));
$("btnPane").addEventListener("click", () => launch("pane"));
$("btnRecord").addEventListener("click", () => launch("record"));
$("btnSource").addEventListener("click", () => launch("source"));

init();
