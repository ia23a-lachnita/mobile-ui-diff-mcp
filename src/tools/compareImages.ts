import * as path from 'path';
import { ensureDir, resolveAbsolutePath } from '../utils/fs';
import { loadImageAsPng, writePng, resizeImageToMatch } from '../image/load';
import { applyIgnoreRegions } from '../image/mask';
import { createDiffErrorMask } from '../image/diff';
import { detectRegions } from '../image/regions';
import { cropAndSave } from '../image/crops';
import { explainDiffUsingOllama } from '../vlm/ollama';
import { IgnoreRegion, RegionReport, DiffReport } from '../types';
import fs from 'fs/promises';

export interface CompareImagesInput {
  expectedImage: string;
  actualImage: string;
  outputDir: string;
  threshold?: number;
  pixelmatchThreshold?: number;
  maxDiffPercent?: number;
  maxRegions?: number;
  maxVlmRegions?: number;
  includeVlmAnalysis?: boolean;
  ignoreRegions?: IgnoreRegion[];
}

export async function compareImages(input: CompareImagesInput): Promise<DiffReport> {
  const pixelmatchThreshold = input.pixelmatchThreshold ?? input.threshold ?? 0.1;
  const maxDiffPercent = input.maxDiffPercent ?? 0.001;
  const maxRegions = input.maxRegions ?? 50;
  const maxVlmRegions = input.maxVlmRegions ?? 10;
  const includeVlmAnalysis = input.includeVlmAnalysis ?? false;
  const ignoreRegions = input.ignoreRegions ?? [];
  const outputDir = resolveAbsolutePath(input.outputDir);
  const regionsDir = path.join(outputDir, 'regions');

  await ensureDir(outputDir);
  await ensureDir(regionsDir);

  const expectedAbsPath = resolveAbsolutePath(input.expectedImage);
  const actualAbsPath = resolveAbsolutePath(input.actualImage);

  const expectedPng = await loadImageAsPng(expectedAbsPath);
  let actualPng = await loadImageAsPng(actualAbsPath);

  if (expectedPng.width !== actualPng.width || expectedPng.height !== actualPng.height) {
    // Resize actual image
    const actualRawBuffer = await fs.readFile(actualAbsPath);
    const resizedBuffer = await resizeImageToMatch(actualRawBuffer, expectedPng.width, expectedPng.height);
    const sharp = require('sharp');
    const pngBuffer = await sharp(resizedBuffer).png().toBuffer();
    const { PNG } = require('pngjs');
    actualPng = PNG.sync.read(pngBuffer);
  }

  // Mask ignore regions
  applyIgnoreRegions(expectedPng, ignoreRegions);
  applyIgnoreRegions(actualPng, ignoreRegions);

  const { diffImage, diffPixels, mismatchMask } = createDiffErrorMask(expectedPng, actualPng, pixelmatchThreshold);

  const totalPixels = expectedPng.width * expectedPng.height;
  const diffPercent = diffPixels / totalPixels;

  const diffAbsPath = path.join(outputDir, 'diff.png');
  await writePng(diffImage, diffAbsPath);
  
  // Create an explicit copy of expected and actual mapped to their original states but identical sizes
  const processedExpectedPath = path.join(outputDir, 'expected.png');
  const processedActualPath = path.join(outputDir, 'actual.png');
  await writePng(expectedPng, processedExpectedPath);
  await writePng(actualPng, processedActualPath);

  let rawRegions = detectRegions(mismatchMask);
  
  if (rawRegions.length > maxRegions) {
    rawRegions = rawRegions.slice(0, maxRegions);
  }

  const sortedByArea = [...rawRegions].sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const vlmCandidates = new Set(sortedByArea.slice(0, maxVlmRegions));

  const regions: RegionReport[] = [];

  for (let i = 0; i < rawRegions.length; i++) {
    const box = rawRegions[i];
    const regionId = `region-${(i + 1).toString().padStart(3, '0')}`;
    const expCrop = path.join(regionsDir, `${regionId}-expected.png`);
    const actCrop = path.join(regionsDir, `${regionId}-actual.png`);
    const diffCrop = path.join(regionsDir, `${regionId}-diff.png`);

    await cropAndSave(processedExpectedPath, box, expCrop);
    await cropAndSave(processedActualPath, box, actCrop);
    await cropAndSave(diffAbsPath, box, diffCrop);

    let analysis = null;
    let analysisStatus: "analyzed" | "skipped" = "skipped";
    
    if (includeVlmAnalysis && vlmCandidates.has(box)) {
      analysisStatus = "analyzed";
      analysis = await explainDiffUsingOllama(expCrop, actCrop, diffCrop);
    }

    regions.push({
      id: regionId,
      box,
      area: box.width * box.height,
      cropPaths: {
        expected: expCrop,
        actual: actCrop,
        diff: diffCrop
      },
      analysisStatus,
      analysis
    });
  }

  return {
    status: diffPercent <= maxDiffPercent ? "pass" : "fail",
    diffPixels,
    totalPixels,
    diffPercent,
    pixelmatchThreshold,
    maxDiffPercent,
    regions,
    artifacts: {
      expected: processedExpectedPath,
      actual: processedActualPath,
      diff: diffAbsPath,
      regionsDir
    }
  };
}