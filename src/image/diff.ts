import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

// Stable colors for multi-layer silhouette diff; referenced in judge prompts via STRUCTURAL_DIFF_LEGEND.
export const DIFF_COLORS = {
  EXPECTED_ONLY:  [200,   0, 120] as [number, number, number], // magenta fill — expected silhouette, absent in actual
  EXPECTED_EDGE:  [255,  60, 200] as [number, number, number], // bright magenta outline — expected content boundary
  ACTUAL_ONLY:    [  0, 160, 240] as [number, number, number], // cyan fill — actual silhouette, absent in expected
  ACTUAL_EDGE:    [ 60, 230, 255] as [number, number, number], // bright cyan outline — actual content boundary
  SHARED_OVERLAP: [255, 215,   0] as [number, number, number], // yellow — both have content but they differ
  BACKGROUND:     [ 40,  40,  40] as [number, number, number], // dark gray — unchanged/shared
} as const;

export const STRUCTURAL_DIFF_LEGEND =
  'In the structural diff image: magenta fill and bright-magenta outlines mark regions present in the expected mockup silhouette but absent in the actual screenshot; cyan fill and bright-cyan outlines mark regions present in the actual screenshot but absent in the expected design; yellow marks shared overlap where both images have content but they disagree; dark gray is unchanged background. The structural diff is an alignment aid only — raw expected and raw actual remain the source of truth.';

function colorDistSq(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

function estimateBackgroundColor(png: PNG): [number, number, number] {
  const { width: w, height: h, data } = png;
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  let rSum = 0, gSum = 0, bSum = 0;
  for (const [x, y] of corners) {
    const idx = (y * w + x) << 2;
    rSum += data[idx]; gSum += data[idx + 1]; bSum += data[idx + 2];
  }
  return [Math.round(rSum / 4), Math.round(gSum / 4), Math.round(bSum / 4)];
}

function buildSilhouetteMask(png: PNG, bg: [number, number, number], threshold: number): boolean[][] {
  const { width, height, data } = png;
  const tSq = threshold * threshold;
  const mask: boolean[][] = Array.from({ length: height }, () => new Array(width).fill(false));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      if (colorDistSq(data[idx], data[idx + 1], data[idx + 2], bg[0], bg[1], bg[2]) > tSq) {
        mask[y][x] = true;
      }
    }
  }
  return mask;
}

function buildEdgeMask(mask: boolean[][], width: number, height: number): boolean[][] {
  const edge: boolean[][] = Array.from({ length: height }, () => new Array(width).fill(false));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y][x]) continue;
      if (
        (y > 0 && !mask[y - 1][x]) ||
        (y < height - 1 && !mask[y + 1][x]) ||
        (x > 0 && !mask[y][x - 1]) ||
        (x < width - 1 && !mask[y][x + 1])
      ) {
        edge[y][x] = true;
      }
    }
  }
  return edge;
}

export function createDiffErrorMask(expected: PNG, actual: PNG, threshold: number): { diffImage: PNG, diffPixels: number, mismatchMask: boolean[][] } {
  const width = expected.width;
  const height = expected.height;

  const diffImage = new PNG({ width, height });
  const maskImage = new PNG({ width, height });

  const mismatchMask: boolean[][] = Array.from({ length: height }, () => new Array(width).fill(false));

  // Find mismatching pixels via pixelmatch (diffMask mode: alpha=0 for matching, alpha>0 for mismatching)
  const diffPixels = pixelmatch(
    expected.data,
    actual.data,
    maskImage.data,
    width,
    height,
    { threshold, includeAA: true, diffMask: true, diffColor: [255, 0, 0] }
  );

  // Per-image silhouette masks: pixel is foreground when its color is far enough from the image background.
  // Background is estimated from the 4 corners (handles both light and dark UI themes).
  const BG_THRESHOLD = 30;
  const expectedBg = estimateBackgroundColor(expected);
  const actualBg = estimateBackgroundColor(actual);
  const expectedMask = buildSilhouetteMask(expected, expectedBg, BG_THRESHOLD);
  const actualMask   = buildSilhouetteMask(actual, actualBg, BG_THRESHOLD);

  // Edge masks: foreground pixels that have at least one background neighbor (4-connectivity)
  const expectedEdge = buildEdgeMask(expectedMask, width, height);
  const actualEdge   = buildEdgeMask(actualMask, width, height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const isMismatch = maskImage.data[idx + 3] !== 0;
      mismatchMask[y][x] = isMismatch;

      let r: number, g: number, b: number;
      if (!isMismatch) {
        [r, g, b] = DIFF_COLORS.BACKGROUND;
      } else {
        const inExpected = expectedMask[y][x];
        const inActual   = actualMask[y][x];

        if (inExpected && !inActual) {
          [r, g, b] = expectedEdge[y][x] ? DIFF_COLORS.EXPECTED_EDGE : DIFF_COLORS.EXPECTED_ONLY;
        } else if (inActual && !inExpected) {
          [r, g, b] = actualEdge[y][x] ? DIFF_COLORS.ACTUAL_EDGE : DIFF_COLORS.ACTUAL_ONLY;
        } else {
          // Both have content or both match background but differ subtly — shared overlap
          [r, g, b] = DIFF_COLORS.SHARED_OVERLAP;
        }
      }

      diffImage.data[idx]     = r;
      diffImage.data[idx + 1] = g;
      diffImage.data[idx + 2] = b;
      diffImage.data[idx + 3] = 255;
    }
  }

  return { diffImage, diffPixels, mismatchMask };
}
