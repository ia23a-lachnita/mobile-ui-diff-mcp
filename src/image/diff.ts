import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export function createDiffErrorMask(expected: PNG, actual: PNG, threshold: number): { diffImage: PNG, diffPixels: number, mismatchMask: boolean[][] } {
  const width = expected.width;
  const height = expected.height;
  
  const diffImage = new PNG({ width, height });
  const maskImage = new PNG({ width, height });
  
  const mismatchMask: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  
  // First run: generate the user-facing diff image
  const diffPixels = pixelmatch(
    expected.data,
    actual.data,
    diffImage.data,
    width,
    height,
    { threshold, includeAA: true }
  );

  // Second run: generate pure diff mask to accurately isolate mismatches
  pixelmatch(
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
      // When diffMask is true, only differing pixels are colored, others are transparent (alpha 0)
      if (maskImage.data[idx+3] !== 0) {
        mismatchMask[y][x] = true;
      }
    }
  }

  return { diffImage, diffPixels, mismatchMask };
}
