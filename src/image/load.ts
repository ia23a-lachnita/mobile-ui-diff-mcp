import sharp from 'sharp';
import fs from 'fs/promises';
import { PNG } from 'pngjs';

export async function loadImageAsPng(imagePath: string): Promise<PNG> {
  const fileBuffer = await fs.readFile(imagePath);
  const pngBuffer = await sharp(fileBuffer).png().toBuffer();
  return PNG.sync.read(pngBuffer);
}

export async function resizeImageToMatch(actual: Buffer, expectedWidth: number, expectedHeight: number): Promise<Buffer> {
  return await sharp(actual).resize(expectedWidth, expectedHeight, { fit: 'fill' }).png().toBuffer();
}

export async function writePng(png: PNG, outputPath: string): Promise<void> {
  const buffer = PNG.sync.write(png);
  await fs.writeFile(outputPath, buffer);
}
