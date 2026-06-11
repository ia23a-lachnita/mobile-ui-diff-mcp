import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { createDiffErrorMask, DIFF_COLORS, STRUCTURAL_DIFF_LEGEND } from '../src/image/diff';

function makeSolid(width: number, height: number, r: number, g: number, b: number): PNG {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      png.data[idx]     = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return png;
}

describe('createDiffErrorMask — two-source high-contrast diff', () => {
  it('non-differing pixels are painted with the background color', () => {
    const img = makeSolid(4, 4, 128, 128, 128);
    const { diffImage } = createDiffErrorMask(img, img, 0.1);
    const idx = 0;
    expect(diffImage.data[idx]).toBe(DIFF_COLORS.BACKGROUND[0]);
    expect(diffImage.data[idx + 1]).toBe(DIFF_COLORS.BACKGROUND[1]);
    expect(diffImage.data[idx + 2]).toBe(DIFF_COLORS.BACKGROUND[2]);
    expect(diffImage.data[idx + 3]).toBe(255);
  });

  it('pixel brighter in expected → red/magenta (expected-only)', () => {
    const expected = makeSolid(4, 4, 20, 20, 20);
    const actual   = makeSolid(4, 4, 20, 20, 20);
    // Make (0,0) bright in expected only
    expected.data[0] = 255; expected.data[1] = 255; expected.data[2] = 255;
    actual.data[0]   = 20;  actual.data[1]   = 20;  actual.data[2]   = 20;

    const { diffImage, diffPixels, mismatchMask } = createDiffErrorMask(expected, actual, 0.05);

    expect(diffPixels).toBeGreaterThan(0);
    expect(mismatchMask[0][0]).toBe(true);

    // Should be magenta (expected-only)
    expect(diffImage.data[0]).toBe(DIFF_COLORS.EXPECTED_ONLY[0]);
    expect(diffImage.data[1]).toBe(DIFF_COLORS.EXPECTED_ONLY[1]);
    expect(diffImage.data[2]).toBe(DIFF_COLORS.EXPECTED_ONLY[2]);
  });

  it('pixel brighter in actual → cyan/blue (actual-only)', () => {
    const expected = makeSolid(4, 4, 20, 20, 20);
    const actual   = makeSolid(4, 4, 20, 20, 20);
    // Make (0,0) bright in actual only
    expected.data[0] = 20;  expected.data[1] = 20;  expected.data[2] = 20;
    actual.data[0]   = 255; actual.data[1]   = 255; actual.data[2]   = 255;

    const { diffImage, mismatchMask } = createDiffErrorMask(expected, actual, 0.05);

    expect(mismatchMask[0][0]).toBe(true);

    // Should be cyan (actual-only)
    expect(diffImage.data[0]).toBe(DIFF_COLORS.ACTUAL_ONLY[0]);
    expect(diffImage.data[1]).toBe(DIFF_COLORS.ACTUAL_ONLY[1]);
    expect(diffImage.data[2]).toBe(DIFF_COLORS.ACTUAL_ONLY[2]);
  });

  it('expected-only and actual-only pixels have distinct colors', () => {
    expect(DIFF_COLORS.EXPECTED_ONLY).not.toEqual(DIFF_COLORS.ACTUAL_ONLY);
    // Expected-only is red/magenta (high R, low G)
    expect(DIFF_COLORS.EXPECTED_ONLY[0]).toBeGreaterThan(200);
    expect(DIFF_COLORS.EXPECTED_ONLY[1]).toBeLessThan(50);
    // Actual-only is cyan/blue (low R, high B)
    expect(DIFF_COLORS.ACTUAL_ONLY[0]).toBeLessThan(50);
    expect(DIFF_COLORS.ACTUAL_ONLY[2]).toBeGreaterThan(200);
  });

  it('identical images produce zero diff pixels and all background', () => {
    const img = makeSolid(8, 8, 100, 150, 200);
    const { diffPixels, mismatchMask } = createDiffErrorMask(img, img, 0.1);
    expect(diffPixels).toBe(0);
    expect(mismatchMask.every(row => row.every(v => v === false))).toBe(true);
  });

  it('STRUCTURAL_DIFF_LEGEND mentions both red/magenta and cyan/blue', () => {
    expect(STRUCTURAL_DIFF_LEGEND).toMatch(/red.*magenta/i);
    expect(STRUCTURAL_DIFF_LEGEND).toMatch(/cyan.*blue/i);
    expect(STRUCTURAL_DIFF_LEGEND).toMatch(/expected/i);
    expect(STRUCTURAL_DIFF_LEGEND).toMatch(/actual/i);
  });
});
