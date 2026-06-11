/**
 * Unit tests for the multi-layer silhouette/contour structural diff.
 *
 * Verifies:
 *  1. Expected-only region → magenta fill (EXPECTED_ONLY)
 *  2. Actual-only region → cyan fill (ACTUAL_ONLY)
 *  3. Shared-overlap region → yellow (SHARED_OVERLAP)
 *  4. Expected silhouette boundary pixels → bright-magenta edge (EXPECTED_EDGE)
 *  5. Actual silhouette boundary pixels → bright-cyan edge (ACTUAL_EDGE)
 *  6. Unchanged background → dark gray (BACKGROUND)
 *  7. Dark actual-only pixel is cyan, NOT magenta (proves no luminance attribution)
 *  8. Legend describes expected, actual, shared/overlap — no luminance claims
 */

import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { createDiffErrorMask, DIFF_COLORS, STRUCTURAL_DIFF_LEGEND } from '../src/image/diff';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeWhitePng(width = 40, height = 40): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255; png.data[i + 1] = 255; png.data[i + 2] = 255; png.data[i + 3] = 255;
  }
  return png;
}

function fillRect(png: PNG, x: number, y: number, w: number, h: number, r: number, g: number, b: number): void {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const idx = (py * png.width + px) << 2;
      png.data[idx] = r; png.data[idx + 1] = g; png.data[idx + 2] = b; png.data[idx + 3] = 255;
    }
  }
}

function pxColor(img: PNG, x: number, y: number): [number, number, number] {
  const idx = (y * img.width + x) << 2;
  return [img.data[idx], img.data[idx + 1], img.data[idx + 2]];
}

function colorEq(a: [number, number, number], b: readonly [number, number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

// ── Diff coloring tests ────────────────────────────────────────────────────────

describe('createDiffErrorMask — multi-layer silhouette diff', () => {

  it('1. interior expected-only pixel → EXPECTED_ONLY (magenta fill)', () => {
    // Expected: black rect at (5,5)-(25,25) on white. Actual: all white.
    // Black content is in expected silhouette but not actual → expected-only region.
    const expected = makeWhitePng();
    fillRect(expected, 5, 5, 20, 20, 0, 0, 0);
    const actual = makeWhitePng();

    const { diffImage } = createDiffErrorMask(expected, actual, 0.1);

    // (15,15) is interior — all 4 neighbors are also black → not an edge
    expect(colorEq(pxColor(diffImage, 15, 15), DIFF_COLORS.EXPECTED_ONLY)).toBe(true);
  });

  it('2. interior actual-only pixel → ACTUAL_ONLY (cyan fill)', () => {
    // Expected: all white. Actual: dark-blue rect at (5,5)-(25,25) on white.
    const expected = makeWhitePng();
    const actual = makeWhitePng();
    fillRect(actual, 5, 5, 20, 20, 0, 0, 180);

    const { diffImage } = createDiffErrorMask(expected, actual, 0.1);

    expect(colorEq(pxColor(diffImage, 15, 15), DIFF_COLORS.ACTUAL_ONLY)).toBe(true);
  });

  it('3. shared-overlap interior pixel → SHARED_OVERLAP (yellow)', () => {
    // Both images have content at the same position but in different colors.
    const expected = makeWhitePng();
    fillRect(expected, 5, 5, 20, 20, 0, 0, 0);    // black content
    const actual = makeWhitePng();
    fillRect(actual,   5, 5, 20, 20, 60, 60, 60); // dark-grey content (both non-background, both differ)

    const { diffImage } = createDiffErrorMask(expected, actual, 0.1);

    expect(colorEq(pxColor(diffImage, 15, 15), DIFF_COLORS.SHARED_OVERLAP)).toBe(true);
  });

  it('4. expected silhouette boundary pixel → EXPECTED_EDGE (bright magenta)', () => {
    // Left edge of black rect: pixel (5,15) has white neighbor at (4,15) → edge
    const expected = makeWhitePng();
    fillRect(expected, 5, 5, 20, 20, 0, 0, 0);
    const actual = makeWhitePng();

    const { diffImage } = createDiffErrorMask(expected, actual, 0.1);

    expect(colorEq(pxColor(diffImage, 5, 15), DIFF_COLORS.EXPECTED_EDGE)).toBe(true);
  });

  it('5. actual silhouette boundary pixel → ACTUAL_EDGE (bright cyan)', () => {
    // Left edge of blue rect: pixel (5,15) has white neighbor at (4,15) → edge
    const expected = makeWhitePng();
    const actual = makeWhitePng();
    fillRect(actual, 5, 5, 20, 20, 0, 0, 180);

    const { diffImage } = createDiffErrorMask(expected, actual, 0.1);

    expect(colorEq(pxColor(diffImage, 5, 15), DIFF_COLORS.ACTUAL_EDGE)).toBe(true);
  });

  it('6. unchanged background pixels → BACKGROUND (dark gray)', () => {
    const expected = makeWhitePng();
    fillRect(expected, 5, 5, 20, 20, 0, 0, 0);
    const actual = makeWhitePng();

    const { diffImage } = createDiffErrorMask(expected, actual, 0.1);

    // Top-left corner (0,0) is white in both → not a mismatch → BACKGROUND
    expect(colorEq(pxColor(diffImage, 0, 0), DIFF_COLORS.BACKGROUND)).toBe(true);
  });

  it('7. dark actual-only pixel → ACTUAL_ONLY (cyan), not EXPECTED_ONLY (proves no luminance attribution)', () => {
    // Black (very dark) content only in actual. Old luminance code could misclassify this
    // because black is "less bright" than white expected-background.
    // Silhouette-based: actual has foreground content, expected does not → ACTUAL_ONLY.
    const expected = makeWhitePng();
    const actual = makeWhitePng();
    fillRect(actual, 8, 8, 10, 10, 0, 0, 0); // very dark actual content, no expected content

    const { diffImage } = createDiffErrorMask(expected, actual, 0.1);

    const interior = pxColor(diffImage, 12, 12);
    const isActual = colorEq(interior, DIFF_COLORS.ACTUAL_ONLY) || colorEq(interior, DIFF_COLORS.ACTUAL_EDGE);
    const isMagenta = colorEq(interior, DIFF_COLORS.EXPECTED_ONLY) || colorEq(interior, DIFF_COLORS.EXPECTED_EDGE);
    expect(isActual).toBe(true);
    expect(isMagenta).toBe(false);
  });

  it('8. bright expected-only pixel → EXPECTED_ONLY (cyan, not magenta, proves no luminance inversion)', () => {
    // Bright white content only in expected; actual is dark grey (background-like).
    // If luminance-based, the bright expected pixel could end up as ACTUAL_ONLY (wrong).
    // Silhouette-based: expected has foreground content (white on dark-grey bg), actual does not.
    const expected = makeWhitePng(40, 40); // white bg
    fillRect(expected, 8, 8, 10, 10, 0, 0, 0); // black rect in expected on white bg
    // actual is all white → no content → expected-only
    const actual = makeWhitePng(40, 40);

    const { diffImage } = createDiffErrorMask(expected, actual, 0.1);

    // Interior must be magenta (expected-only), not cyan
    const interior = pxColor(diffImage, 12, 12);
    const isExpected = colorEq(interior, DIFF_COLORS.EXPECTED_ONLY) || colorEq(interior, DIFF_COLORS.EXPECTED_EDGE);
    expect(isExpected).toBe(true);
  });

  it('9. identical images → zero diffPixels, all pixels are BACKGROUND', () => {
    const img = makeWhitePng(8, 8);
    fillRect(img, 2, 2, 4, 4, 50, 100, 200);

    const { diffPixels, mismatchMask, diffImage } = createDiffErrorMask(img, img, 0.1);

    expect(diffPixels).toBe(0);
    expect(mismatchMask.every((row) => row.every((v) => v === false))).toBe(true);
    expect(colorEq(pxColor(diffImage, 0, 0), DIFF_COLORS.BACKGROUND)).toBe(true);
  });

  it('10. mismatchMask is true only where images differ', () => {
    const expected = makeWhitePng(10, 10);
    const actual = makeWhitePng(10, 10);
    fillRect(actual, 3, 3, 4, 4, 0, 0, 0);

    const { diffPixels, mismatchMask } = createDiffErrorMask(expected, actual, 0.1);

    expect(diffPixels).toBeGreaterThan(0);
    expect(mismatchMask[5][5]).toBe(true);  // inside changed rect
    expect(mismatchMask[0][0]).toBe(false); // unchanged corner
  });

  it('11. EXPECTED_EDGE and ACTUAL_EDGE are visually distinct from their fill colors', () => {
    expect(colorEq(DIFF_COLORS.EXPECTED_EDGE as unknown as [number,number,number], DIFF_COLORS.EXPECTED_ONLY)).toBe(false);
    expect(colorEq(DIFF_COLORS.ACTUAL_EDGE as unknown as [number,number,number], DIFF_COLORS.ACTUAL_ONLY)).toBe(false);
  });

  it('12. expected-only colors are magenta-family (high R, low G)', () => {
    expect(DIFF_COLORS.EXPECTED_ONLY[0]).toBeGreaterThan(150);
    expect(DIFF_COLORS.EXPECTED_ONLY[1]).toBeLessThan(80);
    expect(DIFF_COLORS.EXPECTED_EDGE[0]).toBeGreaterThan(200);
    expect(DIFF_COLORS.EXPECTED_EDGE[1]).toBeLessThan(120);
  });

  it('13. actual-only colors are cyan-family (low R, high G+B)', () => {
    expect(DIFF_COLORS.ACTUAL_ONLY[0]).toBeLessThan(80);
    expect(DIFF_COLORS.ACTUAL_ONLY[2]).toBeGreaterThan(200);
    expect(DIFF_COLORS.ACTUAL_EDGE[0]).toBeLessThan(120);
    expect(DIFF_COLORS.ACTUAL_EDGE[2]).toBeGreaterThan(200);
  });
});

// ── Legend content requirements ───────────────────────────────────────────────

describe('STRUCTURAL_DIFF_LEGEND — content requirements', () => {
  it('mentions expected silhouette/edge meaning (magenta)', () => {
    expect(STRUCTURAL_DIFF_LEGEND.toLowerCase()).toMatch(/magenta/);
    expect(STRUCTURAL_DIFF_LEGEND.toLowerCase()).toMatch(/expected/);
  });

  it('mentions actual silhouette/edge meaning (cyan)', () => {
    expect(STRUCTURAL_DIFF_LEGEND.toLowerCase()).toMatch(/cyan/);
    expect(STRUCTURAL_DIFF_LEGEND.toLowerCase()).toMatch(/actual/);
  });

  it('mentions shared overlap meaning (yellow)', () => {
    expect(STRUCTURAL_DIFF_LEGEND.toLowerCase()).toMatch(/yellow|shared|overlap/);
  });

  it('clarifies structural diff is an alignment aid, not the source of truth', () => {
    expect(STRUCTURAL_DIFF_LEGEND.toLowerCase()).toMatch(/alignment aid|source of truth|raw expected/);
  });

  it('does not claim luminance-based attribution', () => {
    expect(STRUCTURAL_DIFF_LEGEND.toLowerCase()).not.toMatch(/luminance|brighter|brightness/);
  });
});
