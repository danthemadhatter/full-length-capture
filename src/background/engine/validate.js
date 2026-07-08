// validate.js — the mandatory anti-truncation gate.
//
// The red-team's #1 finding: runLadder only catches THROWN errors, but the
// worst failures don't throw — a printToPDF of a virtualized viewer returns a
// perfectly valid PDF containing only the 2 rendered pages of a 300-page doc.
// So after every rung we independently check that the captured extent actually
// reaches the measured document height. A rung that "didn't throw" is NOT
// success; it must clear this gate or the ladder falls through to the next rung.

import { COVERAGE_MIN } from "../../shared/units.js";

/**
 * @param {number} capturedPx  total rendered height the rung actually produced
 * @param {number} expectedPx  independently-measured document scrollHeight
 * @returns {{ok:boolean, coverage:number, reason?:string}}
 */
export function validateCoverage(capturedPx, expectedPx) {
  if (!expectedPx || expectedPx <= 0) {
    // We couldn't measure an expectation — accept but flag low confidence.
    return { ok: true, coverage: 1, reason: "no expectation measured" };
  }
  const coverage = capturedPx / expectedPx;
  if (coverage >= COVERAGE_MIN) return { ok: true, coverage };
  return {
    ok: false,
    coverage,
    reason:
      `captured ${Math.round(capturedPx)}px of ~${Math.round(expectedPx)}px ` +
      `(${Math.round(coverage * 100)}%) — looks truncated, trying next strategy`,
  };
}

/**
 * Page-count sanity for the reader path: did we capture roughly as many pages
 * as the document claims to have? Accept if we have no claimed total.
 */
export function validatePageCount(capturedPages, claimedTotal) {
  if (!claimedTotal || claimedTotal <= 0) return { ok: true };
  const coverage = capturedPages / claimedTotal;
  if (coverage >= COVERAGE_MIN) return { ok: true, coverage };
  return { ok: false, coverage, reason: `captured ${capturedPages}/${claimedTotal} pages` };
}
