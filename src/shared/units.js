// units.js — unit conversions and the hard caps that constrain the whole engine.
//
// These numbers are load-bearing. Getting them wrong is how prior attempts
// produced silently-blank or silently-truncated output.

// CSS px -> inches (CSS px are defined as 1/96 inch).
export const pxToIn = (px) => px / 96;
// CSS px -> PDF points (72 pt/inch).
export const pxToPt = (px) => (px / 96) * 72;

// Page.printToPDF MediaBox limit. Chrome/PDF caps a single page at ~200 inches;
// we stay just under. A document taller than this must be PAGINATED, never
// clamped (clamping silently drops everything past the cap).
export const PDF_MAX_IN = 199;
export const PDF_MAX_PX = PDF_MAX_IN * 96; // ~19104 px

// Page.captureScreenshot and OffscreenCanvas both cap a side at 16384 px, and
// the canvas total area caps near 256 MP. Exceeding either yields blank output
// with NO thrown error — so we tile below these and validate dims before draw.
export const SHOT_MAX_PX = 16384;
export const CANVAS_MAX_SIDE = 16384;
export const CANVAS_MAX_AREA = 268435456; // 16384 * 16384

// Validation gate tolerance: a rung's captured extent must reach at least this
// fraction of the independently-measured document height, or it's rejected as a
// partial (silent-truncation) result and the ladder falls through.
export const COVERAGE_MIN = 0.9;

// Page-turn reader safety bound — never loop forever on a reader that won't
// signal end-of-book.
export const MAX_PAGE_TURNS = 3000;

// JPEG quality for raster (image) PDF pages. 0.82 is sharp for text at 2x.
export const JPEG_QUALITY = 0.82;

// Clamp a paper dimension (px) to the PDF page cap.
export const clampPaperPx = (px) => Math.min(Math.max(1, Math.round(px)), PDF_MAX_PX);
