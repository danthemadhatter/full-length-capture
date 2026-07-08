// units.js — unit conversions and the hard caps that constrain the whole engine.
//
// These numbers are load-bearing. Getting them wrong is how prior attempts
// produced silently-blank or silently-truncated output.

// CSS px -> PDF points (72 pt/inch; CSS px are defined as 1/96 inch).
export const pxToPt = (px) => (px / 96) * 72;

// PDF MediaBox limit. The spec (and every real renderer) caps a single page at
// 14400pt = 200in per side; we stay just under. A capture taller than this gets
// its PAGE physically shrunk (both axes, aspect ratio preserved) — every image
// tile keeps its full source resolution, so nothing is cropped or resampled
// away, the page just renders at a higher effective DPI.
export const PDF_MAX_IN = 199;

// OffscreenCanvas / ImageBitmap both cap a side at 16384px, and total area caps
// near 256 MP. Exceeding either yields blank output with NO thrown error — so
// we tile strictly below these and never draw past a cap.
export const CANVAS_MAX_SIDE = 16384;
export const CANVAS_MAX_AREA = 268435456; // 16384 * 16384

// JPEG quality for the stitched page's image tiles. 0.82 is sharp for text at 2x.
export const JPEG_QUALITY = 0.82;
