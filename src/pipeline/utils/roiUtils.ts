import { PNG } from 'pngjs';
import { isPointInsideAnyBox } from './geometry';

export function countMaskPixels(mask: boolean[][], box: { x: number; y: number; width: number; height: number }): number {
  let count = 0;
  const maxY = Math.min(mask.length, box.y + box.height);
  for (let y = Math.max(0, box.y); y < maxY; y++) {
    const row = mask[y];
    const maxX = Math.min(row.length, box.x + box.width);
    for (let x = Math.max(0, box.x); x < maxX; x++) {
      if (row[x]) count++;
    }
  }
  return count;
}

export function countRoiPixelsWithDynamicMask(
  mask: boolean[][],
  roiBox: { x: number; y: number; width: number; height: number },
  dynamicBoxes: Array<{ x: number; y: number; width: number; height: number }>
): { rawDiffPixels: number; structuralDiffPixels: number; dynamicMaskedPixels: number; structuralTotalPixels: number } {
  let rawDiffPixels = 0;
  let structuralDiffPixels = 0;
  let dynamicMaskedPixels = 0;
  const maxY = Math.min(mask.length, roiBox.y + roiBox.height);

  for (let y = Math.max(0, roiBox.y); y < maxY; y++) {
    const row = mask[y];
    const maxX = Math.min(row.length, roiBox.x + roiBox.width);
    for (let x = Math.max(0, roiBox.x); x < maxX; x++) {
      const isDynamic = dynamicBoxes.some((box) =>
        x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height
      );
      if (row[x]) {
        rawDiffPixels++;
        if (!isDynamic) structuralDiffPixels++;
      }
      if (isDynamic) dynamicMaskedPixels++;
    }
  }

  const roiArea = Math.max(1, roiBox.width * roiBox.height);
  return {
    rawDiffPixels,
    structuralDiffPixels,
    dynamicMaskedPixels,
    structuralTotalPixels: Math.max(1, roiArea - dynamicMaskedPixels)
  };
}

// Re-using writePng from image/load - need to adjust import or copy function
// For now, I'll copy the writePng function here as it's a small utility.
// In a real refactor, I'd expose it from image/load or a more general fs utility.
import { writePng } from '../../image/load'; // Assuming writePng is accessible here

export async function writeStructuralRoiDiffCrop(
  diffImage: PNG,
  roiBox: { x: number; y: number; width: number; height: number },
  dynamicBoxes: Array<{ x: number; y: number; width: number; height: number }>,
  outputPath: string
): Promise<void> {
  const crop = new PNG({ width: roiBox.width, height: roiBox.height });
  for (let y = 0; y < roiBox.height; y++) {
    for (let x = 0; x < roiBox.width; x++) {
      const sourceX = roiBox.x + x;
      const sourceY = roiBox.y + y;
      const targetIdx = (crop.width * y + x) << 2;
      if (isPointInsideAnyBox(sourceX, sourceY, dynamicBoxes)) {
        crop.data[targetIdx] = 0;
        crop.data[targetIdx + 1] = 0;
        crop.data[targetIdx + 2] = 0;
        crop.data[targetIdx + 3] = 0;
        continue;
      }
      const sourceIdx = (diffImage.width * sourceY + sourceX) << 2;
      crop.data[targetIdx] = diffImage.data[sourceIdx];
      crop.data[targetIdx + 1] = diffImage.data[sourceIdx + 1];
      crop.data[targetIdx + 2] = diffImage.data[sourceIdx + 2];
      crop.data[targetIdx + 3] = diffImage.data[sourceIdx + 3];
    }
  }
  await writePng(crop, outputPath);
}
