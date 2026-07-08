# Full-Length Capture — extension

Load-unpacked MV3 Chrome extension. No build step, fully local.

It does one thing: click the icon, scroll the page, get one seamless PDF —
however long the page is, the output is a single unbroken page. No page
breaks, no debugger banner, no menu of modes to pick between.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension so the toolbar button is visible.

## Use

1. Click the toolbar icon. It starts capturing immediately — the icon's badge
   shows a live shot count as you scroll.
2. Scroll the area you want captured, top to bottom, at whatever speed feels
   natural — screenshots are sampled automatically as you go (duplicates, from
   pausing, are dropped).
3. Click the toolbar icon **a second time** to open the control popup (Change
   area / Done — make PDF / Cancel). If the wrong region got picked
   automatically, click **Change area** and click the element you actually
   want on the page — this discards whatever was captured so far and starts
   over (frames from a different region can't be merged with the new one).
4. Click **Done — make PDF**. A new tab opens with the finished PDF, previewed
   inline and downloaded automatically.

Clicking the icon starts a capture only when one isn't already running on that
tab; while one is active, the same icon opens the control popup instead (see
below for why).

## How it works

- **Capture**: a content script (`src/content/scrollcap.js`) samples
  `chrome.tabs.captureVisibleTab` on a timer while you scroll. This needs no
  special permission beyond `tabs`/`scripting` and shows no debugger banner —
  it works on anything you can see, including cross-origin embeds, since it
  never depends on reading scroll position from the page itself.
- **Controls live in a popup, not the page**: an earlier version drew the
  shot-count/Done/Cancel controls as an on-page overlay bar. Since
  `captureVisibleTab` captures everything rendered in the tab, that bar had to
  hide itself right before every screenshot and reappear right after — at
  ~3 captures/sec for the whole scroll session, that's a visible strobe with
  no way to shorten away (the eye perceives on/off cycling far below that
  rate). `src/popup/` moves the controls into the toolbar action's popup,
  which the browser renders outside the tab's own surface — structurally
  invisible to `captureVisibleTab`, so there's nothing to hide and nothing to
  flicker. `sw.js` attaches that popup to a tab only once its capture starts
  (`chrome.action.setPopup`) and detaches it on Done/Cancel — Chrome never
  fires `action.onClicked` for a tab that has a popup set, which is what makes
  a single icon serve as both "start" and "open controls" reliably, with no
  custom double-click detection. (An earlier attempt used Chrome's newer Side
  Panel API instead — dropped after it turned out to do nothing at all in
  Comet, likely because Comet ships its own built-in sidebar and doesn't
  implement that particular extension API. The popup approach uses a
  mechanism that's been part of the extension platform since Manifest V2.)
- **Stitch**: frames are aligned by 2D block matching — comparing actual pixel
  layout (word/line shapes) between a downsampled strip of each frame, not by
  scroll-offset math or a 1D row-brightness profile. A 1D profile (collapsing
  each row to one average brightness value) turned out to be fooled by
  text-heavy pages: paragraphs with similar line height can have
  near-identical row-brightness at completely different scroll offsets, which
  produced a genuine zero-error tie and silently duplicated or dropped whole
  sections. 2D matching disambiguates those cases because it looks at where
  the ink actually is, not just how much of it there is per row.
- **Assemble**: the stitched image is sliced into tiles sized to stay under
  Chrome's OffscreenCanvas pixel caps (16384px/side, 256 MP total), but every
  tile is drawn onto the **same** PDF page at its correct vertical offset
  (`src/background/assemble/pdfImage.js`) — one `/Page` object, always,
  regardless of how many tiles a long capture needed. That's the actual
  mechanism behind "no page breaks."
- **Deliver**: the PDF is stashed in IndexedDB (the service worker can't mint
  object URLs) and handed to a viewer tab, which previews it and triggers the
  download.

```
manifest.json
src/
  shared/        message protocol + unit caps
  background/
    sw.js        message router + capture lifecycle (bound to the toolbar icon)
    manualCapture.js  capture session + 2D-block-match stitching
    assemble/    tiler (OffscreenCanvas) + hand-rolled single-page image PDF
    store/       IndexedDB blob store
  content/       scroll-capture sampling loop + region picker (no in-page UI)
  popup/         capture controls — shot count, Change area, Done, Cancel
  viewer/        result preview + download
```

## Honest limits

- A PDF page's physical size (MediaBox) is capped by the spec at ~200 inches
  per side. A capture longer than that gets its page proportionally shrunk —
  every image tile keeps its full source resolution, so nothing is cropped or
  blurred, the page just reports a smaller physical size at a higher
  effective DPI.
- This captures pixels, not text — the output PDF has no selectable text
  layer, only an image.
- It captures whatever is on screen. It does not bypass DRM or paywalls; if a
  reader renders protected content as black boxes, the capture will too.
