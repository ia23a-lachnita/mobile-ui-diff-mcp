import * as path from 'path';
import { ensureDir, resolveAbsolutePath } from '../utils/fs';
import { compareImages } from './compareImages';
import { captureAndroidScreenshot } from './captureAndroid';
import { captureIosSimulatorScreenshot } from './captureIosSimulator';
import { DiffReport, IgnoreRegion, PreCaptureResult, PreCaptureStep, FloorDetectionConfig, RunDelta, RegionOfInterestConfig, VisualAssertionConfig } from '../types';
import { ResolvedOllamaConfig, VlmPreflightResult } from '../vlm/ollama';
import { runPreCaptureSteps } from './preCapture';

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
  preCapture?: PreCaptureStep[];
  previousReport?: DiffReport;
  runDelta?: RunDelta;
  floorDetection?: FloorDetectionConfig;
  regionsOfInterest?: RegionOfInterestConfig[];
  visualAssertions?: VisualAssertionConfig[];
  vlmConfig?: ResolvedOllamaConfig;
  vlmPreflight?: VlmPreflightResult;
}

export async function runMobileUiDiff(input: RunMobileUiDiffInput): Promise<DiffReport> {
  const outputDir = resolveAbsolutePath(input.outputDir);
  await ensureDir(outputDir);

  let actualImagePath = input.actualImage;
  let preCaptureResults: PreCaptureResult[] | undefined;

  if (!actualImagePath) {
    if (input.platform === 'android') {
      if (input.preCapture?.length) {
        preCaptureResults = await runPreCaptureSteps(input.preCapture);
      }
      const { outputPath } = await captureAndroidScreenshot(path.join(outputDir, 'android-current.png'));
      actualImagePath = outputPath;
    } else if (input.platform === 'ios') {
      if (input.preCapture?.length) {
        preCaptureResults = await runPreCaptureSteps(input.preCapture);
      }
      const { outputPath } = await captureIosSimulatorScreenshot(path.join(outputDir, 'ios-current.png'));
      actualImagePath = outputPath;
    } else {
      throw new Error(`actualImage is required when platform is '${input.platform}'.`);
    }
  }

  const report = await compareImages({
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
    ignoreRegions: input.ignoreRegions,
    previousReport: input.previousReport,
    runDelta: input.runDelta,
    floorDetection: input.floorDetection,
    regionsOfInterest: input.regionsOfInterest,
    visualAssertions: input.visualAssertions
  });

  if (preCaptureResults?.length) {
    report.preCapture = preCaptureResults;
  }

  return report;
}