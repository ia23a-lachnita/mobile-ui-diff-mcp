import * as path from 'path';
import { ensureDir, resolveAbsolutePath } from '../utils/fs';
import { compareImages } from './compareImages';
import { captureAndroidScreenshot } from './captureAndroid';
import { captureIosSimulatorScreenshot } from './captureIosSimulator';
import { ConfigSuggestion, DeviceProfile, DeviceSize, DiffReport, IgnoreRegion, PreCaptureResult, PreCaptureStep, FloorDetectionConfig, RunDelta, RegionOfInterestConfig, VisualAssertionConfig, HotspotDetectionConfig, VlmPolicy } from '../types';
import { ResolvedOllamaConfig, VlmPreflightResult } from '../vlm/ollama';
import { runPreCaptureSteps } from './preCapture';
import fs from 'fs/promises';
import type { ReferenceContextConfig } from '../pipeline/ConflictResolver';
import type { ModelJudgesConfig } from '../pipeline/judges/ModelJudgeAnalyzer';

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
  vlmPolicy?: VlmPolicy;
  ignoreRegions?: IgnoreRegion[];
  dataRegions?: IgnoreRegion[];
  autoMaskedRegions?: IgnoreRegion[];
  preCapture?: PreCaptureStep[];
  preCaptureDeviceSize?: DeviceSize;
  deviceId?: string;
  appliedDeviceProfile?: DeviceProfile | null;
  configSuggestions?: ConfigSuggestion[];
  appContentBounds?: { x: number; y: number; width: number; height: number; coordinateSpace?: 'normalized' | 'expected' | 'actual' };
  previousReport?: DiffReport;
  runDelta?: RunDelta;
  floorDetection?: FloorDetectionConfig;
  hotspotDetection?: HotspotDetectionConfig;
  regionsOfInterest?: RegionOfInterestConfig[];
  visualAssertions?: VisualAssertionConfig[];
  vlmConfig?: ResolvedOllamaConfig;
  vlmPreflight?: VlmPreflightResult;
  referenceContext?: ReferenceContextConfig;
  modelJudges?: ModelJudgesConfig;
}

export async function runMobileUiDiff(input: RunMobileUiDiffInput): Promise<DiffReport> {
  const outputDir = resolveAbsolutePath(input.outputDir);
  await ensureDir(outputDir);

  let actualImagePath = input.actualImage;
  let preCaptureResults: PreCaptureResult[] | undefined;

  if (!actualImagePath) {
    if (input.platform === 'android') {
      if (input.preCapture?.length) {
        preCaptureResults = await runPreCaptureSteps(input.preCapture, {
          deviceSize: input.preCaptureDeviceSize,
          deviceId: input.deviceId
        });
      }
      const { outputPath } = await captureAndroidScreenshot(path.join(outputDir, 'android-current.png'), input.deviceId);
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
    vlmPolicy: input.vlmPolicy,
    vlmConfig: input.vlmConfig,
    vlmPreflight: input.vlmPreflight,
    ignoreRegions: input.ignoreRegions,
    dataRegions: input.dataRegions,
    autoMaskedRegions: input.autoMaskedRegions,
    appliedDeviceProfile: input.appliedDeviceProfile,
    configSuggestions: input.configSuggestions,
    appContentBounds: input.appContentBounds,
    previousReport: input.previousReport,
    runDelta: input.runDelta,
    floorDetection: input.floorDetection,
    hotspotDetection: input.hotspotDetection,
    regionsOfInterest: input.regionsOfInterest,
    visualAssertions: input.visualAssertions,
    referenceContext: input.referenceContext,
    modelJudges: input.modelJudges
  });

  if (preCaptureResults?.length) {
    report.preCapture = preCaptureResults;
  }

  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
