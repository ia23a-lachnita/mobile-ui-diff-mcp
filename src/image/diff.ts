import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

// Stable colors for two-source structural diff; referenced in judge prompts via STRUCTURAL_DIFF_LEGEND.
export const DIFF_COLORS = {
  EXPECTED_ONLY: [255, 0, 128] as [number, number, number],  // magenta — present in expected, absent/changed in actual
  ACTUAL_ONLY:   [0, 200, 255] as [number, number, number],  // cyan — present in actual, absent/changed in expected
  BACKGROUND:    [40,  40,  40] as [number, number, number], // dark gray — shared/unchanged pixels
} as const;

export const STRUCTURAL_DIFF_LEGEND =
  'In the structural diff image, red/magenta marks pixels present in the expected mockup but missing/changed in the actual screenshot; cyan/blue marks pixels present in the actual screenshot but not in the expected mockup; gray marks unchanged/shared regions.';

export function createDiffErrorMask(expected: PNG, actual: PNG, threshold: number): { diffImage: PNG, diffPixels: number, mismatchMask: boolean[][] } {
  const width = expected.width;
  const height = expected.height;

  const diffImage = new PNG({ width, height });
  const maskImage = new PNG({ width, height });

  const mismatchMask: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));

  // Generate diff mask; diffMask:true only colors mismatching pixels (alpha 0 elsewhere).
  const diffPixels = pixelmatch(
    expected.data,
    actual.data,
    maskImage.data,
    width,
    height,
    { threshold, includeAA: true, diffMask: true, diffColor: [255, 0, 0] }
  );

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      if (maskImage.data[idx + 3] !== 0) {
        mismatchMask[y][x] = true;
        // Attribute by luminance: brighter source "owns" the pixel.
        const expLuma = 0.299 * expected.data[idx] + 0.587 * expected.data[idx + 1] + 0.114 * expected.data[idx + 2];
        const actLuma = 0.299 * actual.data[idx]   + 0.587 * actual.data[idx + 1]   + 0.114 * actual.data[idx + 2];
        const [r, g, b] = expLuma >= actLuma ? DIFF_COLORS.EXPECTED_ONLY : DIFF_COLORS.ACTUAL_ONLY;
        diffImage.data[idx]     = r;
        diffImage.data[idx + 1] = g;
        diffImage.data[idx + 2] = b;
        diffImage.data[idx + 3] = 255;
      } else {
        const [r, g, b] = DIFF_COLORS.BACKGROUND;
        diffImage.data[idx]     = r;
        diffImage.data[idx + 1] = g;
        diffImage.data[idx + 2] = b;
        diffImage.data[idx + 3] = 255;
      }
    }
  }

  return { diffImage, diffPixels, mismatchMask };
}
