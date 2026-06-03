import path from 'path';
import fs from 'fs/promises';
import { PNG } from 'pngjs';
import { ensureDir, resolveAbsolutePath } from '../utils/fs';
import { loadImageAsPng, resizeImageToMatch } from '../image/load';
import { CompareImagesInput } from '../tools/compareImages';
import { IgnoreRegion, RegionOfInterestConfig } from '../types';
import { AnalyzerContext } from './analyzers/IAnalyzer';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function ceilPixel(value: number): number {
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

export class ArtifactBuilder {
  async build(input: CompareImagesInput): Promise<AnalyzerContext> {
    const outputDir = resolveAbsolutePath(input.outputDir);
    const roiDir = path.join(outputDir, 'regions-of-interest');
    const regionsDir = path.join(outputDir, 'regions');

    await ensureDir(outputDir);
    await ensureDir(regionsDir);
    await ensureDir(roiDir);

    const expectedAbsPath = resolveAbsolutePath(input.expectedImage);
    const actualAbsPath = resolveAbsolutePath(input.actualImage);

    const expectedPng = await loadImageAsPng(expectedAbsPath);
    let actualPng = await loadImageAsPng(actualAbsPath);
    const actualSourceWidth = actualPng.width;
    const actualSourceHeight = actualPng.height;

    if (expectedPng.width !== actualPng.width || expectedPng.height !== actualPng.height) {
      const actualRawBuffer = await fs.readFile(actualAbsPath);
      const resizedBuffer = await resizeImageToMatch(actualRawBuffer, expectedPng.width, expectedPng.height);
      const sharp = require('sharp');
      const pngBuffer = await sharp(resizedBuffer).png().toBuffer();
      const { PNG: PNGLib } = require('pngjs');
      actualPng = PNGLib.sync.read(pngBuffer);
    }

    const normalizeRegion = (region: IgnoreRegion): IgnoreRegion => {
      const coordinateSpace = region.coordinateSpace ?? 'expected';
      const sourceWidth = coordinateSpace === 'actual' ? actualSourceWidth : expectedPng.width;
      const sourceHeight = coordinateSpace === 'actual' ? actualSourceHeight : expectedPng.height;
      return {
        ...region,
        ...normalizeBox(region, expectedPng.width, expectedPng.height, coordinateSpace, sourceWidth, sourceHeight),
        coordinateSpace: 'expected' as const
      };
    };

    const ignoreRegions = input.ignoreRegions ?? [];
    const dataRegions = (input.dataRegions ?? []).map((r) => ({ ...r, type: r.type ?? 'data' as const }));
    const explicitMaskRegions = [...ignoreRegions, ...dataRegions];
    const autoMaskedRegions = input.autoMaskedRegions ?? [];
    const normalizedIgnoreRegions = explicitMaskRegions.map(normalizeRegion);
    const normalizedAutoMaskedRegions = autoMaskedRegions.map(normalizeRegion);
    const allMaskRegions = [...normalizedIgnoreRegions, ...normalizedAutoMaskedRegions];

    const normalizedRois = (input.regionsOfInterest ?? []).map((roi) => ({
      ...roi,
      box: normalizeBox(
        roi.box,
        expectedPng.width,
        expectedPng.height,
        roi.coordinateSpace ?? 'expected',
        roi.coordinateSpace === 'actual' ? actualSourceWidth : expectedPng.width,
        roi.coordinateSpace === 'actual' ? actualSourceHeight : expectedPng.height
      )
    }));

    const runId = `run-${Date.now()}`;

    return {
      runId,
      outputDir,
      configDir: input.configDir ?? process.cwd(),
      roiDir,
      regionsDir,
      expectedImagePath: expectedAbsPath,
      actualImagePath: actualAbsPath,
      expectedPng,
      actualPng,
      comparisonPng: actualPng,
      actualSourceWidth,
      actualSourceHeight,
      regionsOfInterest: normalizedRois,
      ignoreRegions: allMaskRegions,
      config: input
    };
  }
}
