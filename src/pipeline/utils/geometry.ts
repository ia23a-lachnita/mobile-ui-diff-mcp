import { IgnoreRegion, RegionOfInterestConfig } from '../../types';

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function ceilPixel(value: number): number {
  return Math.ceil(value - 1e-9);
}

export function normalizeBox(
  box: { x: number; y: number; width: number; height: number },
  targetWidth: number,
  targetHeight: number,
  coordinateSpace: 'normalized' | 'expected' | 'actual' = 'expected',
  sourceWidth: number = targetWidth,
  sourceHeight: number = targetHeight
) {
  if (coordinateSpace === 'normalized') {
    const left = Math.floor(clamp(box.x, 0, 1) * targetWidth);
    const top = Math.floor(clamp(box.y, 0, 1) * targetHeight);
    const right = ceilPixel(clamp(box.x + box.width, 0, 1) * targetWidth);
    const bottom = ceilPixel(clamp(box.y + box.height, 0, 1) * targetHeight);
    return {
      x: clamp(left, 0, Math.max(0, targetWidth - 1)),
      y: clamp(top, 0, Math.max(0, targetHeight - 1)),
      width: Math.max(1, Math.min(targetWidth - left, right - left)),
      height: Math.max(1, Math.min(targetHeight - top, bottom - top))
    };
  }

  const scaleX = targetWidth / Math.max(1, sourceWidth);
  const scaleY = targetHeight / Math.max(1, sourceHeight);
  const left = Math.floor(box.x * scaleX);
  const top = Math.floor(box.y * scaleY);
  const right = ceilPixel((box.x + box.width) * scaleX);
  const bottom = ceilPixel((box.y + box.height) * scaleY);

  return {
    x: clamp(left, 0, Math.max(0, targetWidth - 1)),
    y: clamp(top, 0, Math.max(0, targetHeight - 1)),
    width: Math.max(1, Math.min(targetWidth - left, right - left)),
    height: Math.max(1, Math.min(targetHeight - top, bottom - top))
  };
}

export function boxesIntersect(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

export function intersectBoxes(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function resolveRoiDynamicSubregionBox(
  subregion: NonNullable<RegionOfInterestConfig['allowedDynamicSubregions']>[number],
  roiBox: { x: number; y: number; width: number; height: number },
  targetWidth: number,
  targetHeight: number,
  actualSourceWidth: number,
  actualSourceHeight: number
) {
  const coordinateSpace = subregion.coordinateSpace ?? 'roiNormalized';
  const resolved = coordinateSpace === 'roiNormalized'
    ? {
      x: roiBox.x + Math.floor(clamp(subregion.box.x, 0, 1) * roiBox.width),
      y: roiBox.y + Math.floor(clamp(subregion.box.y, 0, 1) * roiBox.height),
      width: Math.max(1, ceilPixel(clamp(subregion.box.width, 0, 1) * roiBox.width)),
      height: Math.max(1, ceilPixel(clamp(subregion.box.height, 0, 1) * roiBox.height))
    }
    : normalizeBox(
      subregion.box,
      targetWidth,
      targetHeight,
      coordinateSpace,
      coordinateSpace === 'actual' ? actualSourceWidth : targetWidth,
      coordinateSpace === 'actual' ? actualSourceHeight : targetHeight
    );

  return intersectBoxes(resolved, roiBox);
}

export function isPointInsideAnyBox(x: number, y: number, boxes: Array<{ x: number; y: number; width: number; height: number }>): boolean {
  return boxes.some((box) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height);
}

