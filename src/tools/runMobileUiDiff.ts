import * as path from 'path';
import { ensureDir, resolveAbsolutePath } from '../utils/fs';
import { compareImages } from './compareImages';
import { captureAndroidScreenshot } from './captureAndroid';
import { captureIosSimulatorScreenshot } from './captureIosSimulator';
import { DiffReport, IgnoreRegion } from '../types';
import { ResolvedOllamaConfig, VlmPreflightResult } from '../vlm/ollama';

export interface RunMobileUiDiffInput {
  platform: 'android' | 'ios' | 'none';
  expectedImage: string;
  actualImage?: string;
  outputDir: string;
  threshold?: number;
  pixelmatchThreshold?: number;
  maxDiffPercent?: number;
  maxRegions?: number;
  maxVlmRegions?: number;
  includeVlmAnalysis?: boolean;
  requireVlmAnalysis?: boolean;
  ignoreRegions?: IgnoreRegion[];
  vlmConfig?: ResolvedOllamaConfig;
  vlmPreflight?: VlmPreflightResult;
}

export async function runMobileUiDiff(input: RunMobileUiDiffInput): Promise<DiffReport> {
  const outputDir = resolveAbsolutePath(input.outputDir);
  await ensureDir(outputDir);

  let actualImagePath = input.actualImage;

  if (!actualImagePath) {
    if (input.platform === 'android') {
      const { outputPath } = await captureAndroidScreenshot(path.join(outputDir, 'android-current.png'));
      actualImagePath = outputPath;
    } else if (input.platform === 'ios') {
      const { outputPath } = await captureIosSimulatorScreenshot(path.join(outputDir, 'ios-current.png'));
      actualImagePath = outputPath;
    } else {
      throw new Error(`actualImage is required when platform is '${input.platform}'.`);
    }
  }

  return await compareImages({
    expectedImage: input.expectedImage,
    actualImage: actualImagePath,
    outputDir: input.outputDir,
    threshold: input.threshold,
    pixelmatchThreshold: input.pixelmatchThreshold,
    maxDiffPercent: input.maxDiffPercent,
    maxRegions: input.maxRegions,
    maxVlmRegions: input.maxVlmRegions,
    includeVlmAnalysis: input.includeVlmAnalysis,
    requireVlmAnalysis: input.requireVlmAnalysis,
    vlmConfig: input.vlmConfig,
    vlmPreflight: input.vlmPreflight,
    ignoreRegions: input.ignoreRegions
  });
}