import { PNG } from 'pngjs';
import { IgnoreRegion } from '../types';

export function applyIgnoreRegions(image: PNG, regions: IgnoreRegion[]): void {
  for (const region of regions) {
    const startX = Math.max(0, region.x);
    const startY = Math.max(0, region.y);
    const endX = Math.min(image.width, region.x + region.width);
    const endY = Math.min(image.height, region.y + region.height);

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = (image.width * y + x) << 2;
        // Make pixel fully transparent
        image.data[idx] = 0;
        image.data[idx + 1] = 0;
        image.data[idx + 2] = 0;
        image.data[idx + 3] = 0;
      }
    }
  }
}
