import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export function createDiffErrorMask(expected: PNG, actual: PNG, threshold: number): { diffImage: PNG, diffPixels: number, mismatchMask: boolean[][] } {
  const width = expected.width;
  const height = expected.height;
  
  const diffImage = new PNG({ width, height });
  
  // Custom pixelmatch wrapper to also track exact mismatch locations
  const mismatchMask: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  
  // We run standard pixelmatch first to get the diff image colored nicely
  const diffPixels = pixelmatch(
    expected.data,
    actual.data,
    diffImage.data,
    width,
    height,
    { threshold, includeAA: true }
  );

  // Re-evaluate quickly to build mask (pixelmatch doesn't output the mask directly)
  // Or we can just look at diffImage.data (pixelmatch paints diff as red: 255, 0, 0, 255 typically)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      // pixelmatch defaults: diffColor = [255, 0, 0]
      const r = diffImage.data[idx];
      const g = diffImage.data[idx+1];
      const b = diffImage.data[idx+2];
      const a = diffImage.data[idx+3];
      if (r === 255 && g === 0 && b === 0 && a === 255) {
        mismatchMask[y][x] = true;
      }
    }
  }

  return { diffImage, diffPixels, mismatchMask };
}
