import sharp from 'sharp';
import fs from 'fs/promises';
import { Box } from './regions';

export async function cropAndSave(
  inputImagePath: string,
  box: Box,
  outputPath: string
): Promise<void> {
  const metadata = await sharp(inputImagePath).metadata();
  
  // Need to ensure the box fits within the image boundaries
  const extractBox = {
    left: Math.max(0, box.x),
    top: Math.max(0, box.y),
    width: Math.min(box.width, (metadata.width || box.x + box.width) - box.x),
    height: Math.min(box.height, (metadata.height || box.y + box.height) - box.y)
  };
  
  // Guard against 0 width/height due to boundaries
  if (extractBox.width <= 0 || extractBox.height <= 0) {
      // Just write a 1x1 empty png? Or skip. We'll simply ignore and not save or save 1x1.
      await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
          .png().toFile(outputPath);
      return;
  }

  await sharp(inputImagePath)
    .extract(extractBox)
    .png()
    .toFile(outputPath);
}
