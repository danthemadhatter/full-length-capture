# Full-Length Capture — extension

Load-unpacked MV3 Chrome extension. No build step, fully local.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this **`extension/`** folder.
4. Pin the extension so the toolbar button is visible.

Requires Chrome 125+ (flat debugger sessions are used to reach cross-origin
frames). Uses the `debugger` permission — Chrome shows a non-dismissible
"started debugging this browser" banner while a capture runs.

## Use

Click the toolbar icon. The popup shows the detected surface and four actions:

- **Capture full page** — hands-free; picks the best method for the whole page.
- **Pick a pane…** — hover to highlight a scroll pane; **wheel** to step through
  nested panes, **Shift** to force-pick a JS-driven pane, click to capture it,
  **Esc** to cancel.
- **Record while I scroll…** — no aiming: just scroll the pane you want top to
  bottom (as fast as you like — nothing is captured while you scroll), then click
  **Stop & capture**. It locks onto the pane you actually scrolled (weighted so a
  narrow table-of-contents sidebar loses to the real reading pane).
- **Download original PDF** — shown on native PDF tabs; grabs the source file
  with no capture and no banner.

Under **Options**, *Print styling* toggles between capturing the page as
displayed (screen) or via its print stylesheet.

The result opens in a new tab, previews inline, and downloads automatically.

## Before capturing

- **Close DevTools on the target tab** — only one debugger can attach at a time,
  and opening DevTools mid-capture will stop the run.
- On very long pages the capture can take a while; leave the tab focused.

## How it works

The service worker attaches `chrome.debugger`, classifies the surface, and runs a
fallback ladder (rungs 0–4; see the repo root `README.md`). A validation gate
after each rung rejects a partial/truncated result and falls through to the next
method. Output is assembled entirely in the service worker (OffscreenCanvas +
a hand-rolled image-PDF writer, or Chrome's own `printToPDF` for vector text),
stashed in IndexedDB, and handed to the viewer tab for preview + download.

```
manifest.json
src/
  shared/        message protocol + unit caps
  background/
    sw.js        message router + capture lifecycle
    engine/      attach, flat sessions, flatten, settle, frameRect, validate, ladder
      strategies/  sourceBytes, printToPdf, scrollStitch, pageTurnReader, wholePage
    io/          printToPDF stream reader
    assemble/    tiler (OffscreenCanvas) + hand-rolled image PDF
    store/       chrome.storage progress + IndexedDB blob store
  content/       pane picker + record-while-you-scroll (identifies target only)
  popup/         control panel
  viewer/        result preview + download
```

## Known limits

See the repo root `README.md` → **Honest limits**. In short: the debugger banner
is unavoidable; Chrome's native PDF viewer isn't scrapeable (rung 0 downloads the
file instead); and the page-turn reader rung is **experimental**, image-only, and
does not bypass DRM.
