// viewer.js — result tab. Runs in the extension origin, so it can read the Blob
// straight out of the same IndexedDB the service worker wrote to, mint an object
// URL locally (the SW can't), preview it, and trigger the download.

import { getBlobRecord, deleteBlob } from "../background/store/state.js";
import { MSG } from "../shared/messages.js";

const $ = (id) => document.getElementById(id);
const key = new URLSearchParams(location.search).get("k");

let objUrl = null;
let meta = null;

async function load() {
  if (!key) { $("status").textContent = "No capture key."; return; }
  let rec = null;
  for (let i = 0; i < 4 && !rec; i++) {
    rec = await getBlobRecord(key);
    if (!rec) await new Promise((r) => setTimeout(r, 200));
  }
  if (!rec) { $("status").textContent = "Capture not found (it may have expired — capture again)."; return; }

  meta = rec.meta || {};
  objUrl = URL.createObjectURL(rec.blob);

  const sizeMb = (meta.size || rec.blob.size) / (1024 * 1024);
  $("meta").textContent = `1 continuous page · ${sizeMb.toFixed(1)} MB`;

  const emb = document.createElement("embed");
  emb.type = "application/pdf";
  emb.src = objUrl;
  $("preview").appendChild(emb);

  $("status").textContent = "Ready.";
  $("dl").disabled = false;
  // Auto-download once.
  download();
}

async function download() {
  if (!objUrl) return;
  try {
    await chrome.downloads.download({ url: objUrl, filename: (meta.filename || "capture") + "", saveAs: false });
    $("status").textContent = "Saved to Downloads.";
    // Let the SW free the IDB entry.
    try { chrome.runtime.sendMessage({ type: MSG.DOWNLOAD_DONE, key }); } catch (e) {}
    deleteBlob(key).catch(() => {});
  } catch (e) {
    $("status").textContent = "Download failed: " + e.message;
  }
}

$("dl").addEventListener("click", download);
load();
