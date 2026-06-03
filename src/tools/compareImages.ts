import * as path from 'path';
import { ensureDir, resolveAbsolutePath } from '../utils/fs';
import { loadImageAsPng, writePng, resizeImageToMatch } from '../image/load';
import { applyIgnoreRegions } from '../image/mask';
import { createDiffErrorMask } from '../image/diff';
import { detectRegions } from '../image/regions';
import { cropAndSave } from '../image/crops';
import { runRadialChartDiagnostics } from '../image/radialChartDiagnostics';
import { explainDiffUsingOllama, preflightOllama, resolveOllamaConfig, ResolvedOllamaConfig, VlmPreflightResult } from '../vlm/ollama';
import { ConfigSuggestion, DeviceProfile, IgnoreRegion, RegionReport, DiffReport, VlmSummary, VlmAnalysis, RegionOfInterestConfig, RegionOfInterestReport, QualityFailure, PriorityFinding, VisualAssertionConfig, VisualAssertionResult, FloorDetectionConfig, RunDelta, FloorBlocker, AgentSummary, HotspotDetectionConfig, LocalHotspot, VlmPolicy, VlmAvailability, ActionRequired } from '../types';
import type { ReferenceContextConfig } from '../pipeline/ConflictResolver';
import type { ModelJudgesConfig } from '../pipeline/judges/ModelJudgeAnalyzer';
import fs from 'fs/promises';
import { PNG } from 'pngjs';

export interface CompareImagesInput {
  expectedImage: string;
  actualImage: string;
  outputDir: string;
  configDir?: string;
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
  appliedDeviceProfile?: DeviceProfile | null;
  configSuggestions?: ConfigSuggestion[];
  appContentBounds?: { x: number; y: number; width: number; height: number; coordinateSpace?: 'normalized' | 'expected' | 'actual' };
  regionsOfInterest?: RegionOfInterestConfig[];
  visualAssertions?: VisualAssertionConfig[];
  previousReport?: DiffReport;
  runDelta?: RunDelta;
  floorDetection?: FloorDetectionConfig;
  hotspotDetection?: HotspotDetectionConfig;
  vlmConfig?: ResolvedOllamaConfig;
  vlmPreflight?: VlmPreflightResult;
  referenceContext?: ReferenceContextConfig;
  modelJudges?: ModelJudgesConfig;
  visualAuditMode?: 'visual_parity' | 'metric_only';
  overlapLegibility?: {
    enabled?: boolean;
    regions?: Array<{
      id: string;
      label?: string;
      coordinateSpace?: 'roiNormalized' | 'normalized' | 'expected' | 'actual';
      box: { x: number; y: number; width: number; height: number };
      avoidColors?: string[];
      minClearancePx?: number;
      maxOverlapPercent?: number;
      severity?: 'critical' | 'high' | 'medium' | 'low' | 'warning';
    }>;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function ceilPixel(value: number): number {
  return Math.ceil(value - 1e-9);
}

function normalizeBox(
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

function boxesIntersect(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

function countMaskPixels(mask: boolean[][], box: { x: number; y: number; width: number; height: number }): number {
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

function intersectBoxes(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function resolveRoiDynamicSubregionBox(
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

function countRoiPixelsWithDynamicMask(
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

function isPointInsideAnyBox(x: number, y: number, boxes: Array<{ x: number; y: number; width: number; height: number }>): boolean {
  return boxes.some((box) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height);
}

async function writeStructuralRoiDiffCrop(
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

function regionIntersections(region: { x: number; y: number; width: number; height: number }, rois: Array<{ id: string; label: string; box: { x: number; y: number; width: number; height: number } }>): Array<{ id: string; label: string }> {
  return rois.filter((roi) => boxesIntersect(region, roi.box)).map((roi) => ({ id: roi.id, label: roi.label }));
}

function geometryFallbackLabel(region: { x: number; y: number; width: number; height: number }, canvasWidth: number, canvasHeight: number): string {
  const centerY = region.y + region.height / 2;
  const centerX = region.x + region.width / 2;
  const topBand = canvasHeight * 0.1;
  const bottomBand = canvasHeight * 0.85;
  const leftBand = canvasWidth * 0.15;
  const rightBand = canvasWidth * 0.85;
  const centerHorizontal = centerX >= canvasWidth * 0.25 && centerX <= canvasWidth * 0.75;
  const centerVertical = centerY >= canvasHeight * 0.2 && centerY <= canvasHeight * 0.8;

  if (region.y <= topBand) return 'top/status/header area';
  if (region.y + region.height >= bottomBand) return 'bottom navigation/chrome area';
  if (region.x <= leftBand || region.x + region.width >= rightBand) return 'side/edge area';
  if (centerHorizontal && centerVertical && region.width * region.height > canvasWidth * canvasHeight * 0.08) return 'main content area';
  return 'content region';
}

function geometryFallbackDescription(label: string): string {
  return `This changed region looks like ${label}. Review local component geometry even without VLM.`;
}

function resolveVlmPolicy(input: { includeVlmAnalysis: boolean; requireVlmAnalysis?: boolean; vlmPolicy?: VlmPolicy }): VlmPolicy {
  if (input.vlmPolicy) return input.vlmPolicy;
  if (!input.includeVlmAnalysis) return 'disabled';
  if (input.requireVlmAnalysis === true) return 'required';
  return 'ask_user';
}

function buildVlmUnavailableActionRequired(): ActionRequired {
  return {
    type: 'vlm_unavailable',
    severity: 'blocking',
    message: 'VLM analysis was requested but no usable local model is available.',
    recommendedUserPrompt: 'VLM analysis is unavailable. Do you want me to continue with pixel/ROI-only analysis, or stop and help set up a working VLM model?',
    suggestedFixes: [
      'Start Ollama with `ollama serve`',
      'Run the `vlm_health` MCP tool',
      'Pull or configure a smaller vision model',
      "Set includeVlmAnalysis:false or vlmPolicy:'disabled' to proceed without VLM",
      "Set vlmPolicy:'optional' to allow non-semantic fallback"
    ]
  };
}

function buildInvalidCaptureActionRequired(): ActionRequired {
  return {
    type: 'invalid_capture',
    severity: 'blocking',
    message: 'Actual screenshot appears invalid or asleep.',
    recommendedUserPrompt: 'Wake and unlock the device or simulator, navigate to the target screen, and recapture before judging visual quality.',
    suggestedFixes: [
      'Wake/unlock the device or simulator and rerun capture.',
      'Verify the app is foregrounded on the target screen.',
      'If this was an intentional all-black screen, provide a valid actualImage artifact after confirming the expected UI state.'
    ]
  };
}

function detectInvalidActualCapture(png: PNG): { invalid: boolean; reason?: string } {
  const totalPixels = Math.max(1, png.width * png.height);
  let luminanceSum = 0;
  let luminanceSqSum = 0;
  let visiblePixels = 0;
  let brightPixels = 0;

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2;
      const alpha = png.data[idx + 3] / 255;
      const luminance = (
        0.2126 * png.data[idx]
        + 0.7152 * png.data[idx + 1]
        + 0.0722 * png.data[idx + 2]
      ) * alpha;
      luminanceSum += luminance;
      luminanceSqSum += luminance * luminance;
      if (luminance > 16) visiblePixels++;
      if (luminance > 32) brightPixels++;
    }
  }

  const mean = luminanceSum / totalPixels;
  const variance = Math.max(0, (luminanceSqSum / totalPixels) - mean * mean);
  const standardDeviation = Math.sqrt(variance);
  const visibleRatio = visiblePixels / totalPixels;
  const brightRatio = brightPixels / totalPixels;

  if (mean <= 8 && standardDeviation <= 6 && brightRatio < 0.002) {
    return { invalid: true, reason: 'near-black screenshot with almost no visible detail' };
  }
  if (visibleRatio < 0.005 && standardDeviation <= 8) {
    return { invalid: true, reason: 'screenshot has too few visible pixels to trust' };
  }

  return { invalid: false };
}

function evaluateFloorState(input: {
  floorDetection?: FloorDetectionConfig;
  runDelta?: RunDelta;
  previousReport?: DiffReport;
  currentDiffPercent: number;
  qualityStatus: 'pass' | 'fail' | 'not_evaluated';
  criticalFailures: QualityFailure[];
  criticalAssertionFailures: QualityFailure[];
}): { atFloor: boolean | null; floorBlockedBy: FloorBlocker[]; floorReason?: string } {
  const floorDetection = input.floorDetection;
  if (!floorDetection?.enabled) {
    return { atFloor: null, floorBlockedBy: [], floorReason: 'Floor detection disabled.' };
  }

  if (input.qualityStatus === 'not_evaluated') {
    return {
      atFloor: false,
      floorBlockedBy: [{ type: 'quality_not_evaluated', message: 'Critical UI quality was not evaluated.' }],
      floorReason: 'Critical UI quality was not evaluated.'
    };
  }

  const blockers: FloorBlocker[] = [
    ...input.criticalFailures.map((failure) => ({ type: 'critical_roi_failed' as const, roiId: failure.roiId, label: failure.label })),
    ...input.criticalAssertionFailures.map((failure) => ({ type: 'critical_visual_assertion_failed' as const, assertionId: failure.assertionId, label: failure.label }))
  ];

  if (blockers.length > 0) {
    return {
      atFloor: false,
      floorBlockedBy: blockers,
      floorReason: 'Global diff is stable, but critical visual regions are still failing.'
    };
  }

  if (input.qualityStatus === 'fail') {
    return {
      atFloor: false,
      floorBlockedBy: [{ type: 'quality_failed', message: 'Local UI quality gates failed.' }],
      floorReason: 'Local UI quality gates failed.'
    };
  }

  if (!input.previousReport) {
    return { atFloor: null, floorBlockedBy: [], floorReason: 'No floor history available.' };
  }

  const threshold = floorDetection.deltaThreshold ?? 0.0001;
  const consecutiveRuns = Math.min(Math.max(floorDetection.consecutiveRuns ?? 2, 1), 2);
  const currentDelta = input.currentDiffPercent - input.previousReport.diffPercent;
  const currentDeltaOk = Math.abs(currentDelta) < threshold;
  const previousDelta = input.runDelta?.diffPercentDelta ?? input.previousReport.delta?.diffPercentDelta;
  const previousDeltaOk = typeof previousDelta === 'number' ? Math.abs(previousDelta) < threshold : null;

  if (!currentDeltaOk) {
    return { atFloor: false, floorBlockedBy: [], floorReason: 'Global diff still moving.' };
  }

  if (consecutiveRuns <= 1) {
    return { atFloor: true, floorBlockedBy: [], floorReason: 'Global diff stable across current run.' };
  }

  if (previousDeltaOk === true) {
    return { atFloor: true, floorBlockedBy: [], floorReason: 'Global diff stable across consecutive runs.' };
  }

  return { atFloor: false, floorBlockedBy: [], floorReason: 'waiting for consecutive stable run' };
}

function buildAgentSummary(input: {
  status: DiffReport['status'];
  qualityStatus: 'pass' | 'fail' | 'not_evaluated';
  diffPercent: number;
  criticalFailures: QualityFailure[];
  criticalAssertionFailures: QualityFailure[];
  qualityFailures: QualityFailure[];
  roiReports: RegionOfInterestReport[];
  priorityFindings: PriorityFinding[];
  localHotspots: LocalHotspot[];
  actionRequired: ActionRequired | null;
}): AgentSummary {
  if (input.actionRequired) {
    return {
      verdict: input.actionRequired.message,
      globalDiffPercent: input.diffPercent,
      qualityStatus: input.qualityStatus,
      topAction: input.actionRequired.recommendedUserPrompt,
      canStopIterating: false
    };
  }

  if (input.criticalFailures.length > 0) {
    const label = input.criticalFailures[0].label ?? 'critical region';
    const structural = input.criticalFailures[0].structuralRoiDiffPercent ?? input.criticalFailures[0].diffPercent;
    const structuralText = typeof structural === 'number' ? ` Structural ROI diff is ${(structural * 100).toFixed(2)}%, likely a layout, styling, or rendering issue.` : '';
    return {
      verdict: `Do not accept. Critical ${label} region still differs significantly from mockup.${structuralText}`,
      globalDiffPercent: input.diffPercent,
      qualityStatus: input.qualityStatus,
      topAction: `Fix ${label} before considering full-screen floor.`,
      canStopIterating: false
    };
  }

  if (input.criticalAssertionFailures.length > 0) {
    const label = input.criticalAssertionFailures[0].label ?? 'critical visual assertion';
    return {
      verdict: `Do not accept. Critical visual assertion failed for ${label}.`,
      globalDiffPercent: input.diffPercent,
      qualityStatus: input.qualityStatus,
      topAction: `Fix ${label} before considering full-screen floor.`,
      canStopIterating: false
    };
  }

  if (input.qualityStatus === 'fail') {
    const excessiveMaskFailure = input.qualityFailures.find((failure) => failure.type === 'excessive_dynamic_masking');
    if (excessiveMaskFailure) {
      const label = excessiveMaskFailure.label ?? excessiveMaskFailure.roiId ?? 'critical ROI';
      const masked = excessiveMaskFailure.dynamicMaskedPercentOfRoi ?? 0;
      return {
        verdict: `Do not accept. Dynamic masking covers ${(masked * 100).toFixed(1)}% of ${label}, so the quality gate is not trustworthy.`,
        globalDiffPercent: input.diffPercent,
        qualityStatus: input.qualityStatus,
        topAction: `Narrow dynamic subregions in ${label}, or explicitly allow broad dynamic masking only after review.`,
        canStopIterating: false
      };
    }

    return {
      verdict: 'Do not accept. Local visual quality gates failed.',
      globalDiffPercent: input.diffPercent,
      qualityStatus: input.qualityStatus,
      topAction: input.priorityFindings[0]?.message ?? 'Review failed ROI and visual assertion details.',
      canStopIterating: false
    };
  }

  const likelyDataVariance = input.roiReports.find((roi) =>
    roi.resolvedDynamicSubregions.length > 0
    && roi.rawRoiDiffPercent > roi.maxDiffPercent
    && roi.structuralRoiDiffPercent <= roi.maxDiffPercent
  );

  if (input.status === 'fail') {
    const topAction = input.priorityFindings[0]?.message ?? 'Reduce global diff until report passes.';
    const varianceText = likelyDataVariance
      ? ` ${likelyDataVariance.label} has high raw ROI diff but passes structurally after narrow dynamic masking, which points to data variance; still review global diff before accepting.`
      : '';
    return {
      verdict: `Global diff still above threshold.${varianceText}`,
      globalDiffPercent: input.diffPercent,
      qualityStatus: input.qualityStatus,
      topAction,
      canStopIterating: false
    };
  }

  if (input.qualityStatus === 'not_evaluated') {
    const largestHotspot = input.localHotspots[0];
    const hotspotWarning = largestHotspot
      ? ` Global pass may be misleading: largest changed region covers ${largestHotspot.area} pixels in ${largestHotspot.fallbackLabel}.`
      : '';
    return {
      verdict: `Global pixel gate passed, but critical UI quality was not evaluated.${hotspotWarning}`,
      globalDiffPercent: input.diffPercent,
      qualityStatus: input.qualityStatus,
      topAction: 'Configure regionsOfInterest / visualAssertions for important components before accepting the screen.',
      canStopIterating: false
    };
  }

  if (likelyDataVariance) {
    return {
      verdict: `Screen acceptable by structural gates. ${likelyDataVariance.label} has high raw ROI diff but passes after narrow dynamic masking, so the remaining mismatch is likely data variance.`,
      globalDiffPercent: input.diffPercent,
      qualityStatus: input.qualityStatus,
      topAction: 'Keep iterating only if unmasked ROI geometry, typography, or spacing still looks wrong in the artifacts.',
      canStopIterating: true
    };
  }

  return {
    verdict: 'Screen acceptable by global and local gates.',
    globalDiffPercent: input.diffPercent,
    qualityStatus: input.qualityStatus,
    topAction: 'No blocking visual issues detected.',
    canStopIterating: true
  };
}

export async function compareImages(input: CompareImagesInput): Promise<DiffReport> {
  const { runPipeline } = await import('../pipeline/RunOrchestrator');
  return runPipeline(input);
}

/** @deprecated Use compareImages (which now delegates to runPipeline internally) */
async function _compareImagesLegacy(input: CompareImagesInput): Promise<DiffReport> {
  const pixelmatchThreshold = input.pixelmatchThreshold ?? input.threshold ?? 0.1;
  const maxDiffPercent = input.maxDiffPercent ?? 0.001;
  const maxRegions = input.maxRegions ?? 50;
  const maxVlmRegions = input.maxVlmRegions ?? 10;
  const includeVlmAnalysis = input.includeVlmAnalysis ?? false;
  const requireVlmAnalysis = input.requireVlmAnalysis ?? false;
  const vlmPolicy = resolveVlmPolicy({ includeVlmAnalysis, requireVlmAnalysis, vlmPolicy: input.vlmPolicy });
  const shouldUseVlm = includeVlmAnalysis && vlmPolicy !== 'disabled';
  const ignoreRegions = input.ignoreRegions ?? [];
  const dataRegions = (input.dataRegions ?? []).map((region) => ({ ...region, type: region.type ?? 'data' as const }));
  const explicitMaskRegions = [...ignoreRegions, ...dataRegions];
  const autoMaskedRegions = input.autoMaskedRegions ?? [];
  const configSuggestions: ConfigSuggestion[] = [...(input.configSuggestions ?? [])];
  const regionsOfInterestInput = input.regionsOfInterest ?? [];
  const visualAssertionsInput = input.visualAssertions ?? [];
  const previousReport = input.previousReport;
  const runDelta = input.runDelta;
  const floorDetection = input.floorDetection;
  const hotspotDetection = {
    enabled: input.hotspotDetection?.enabled ?? true,
    maxHotspots: input.hotspotDetection?.maxHotspots ?? 3,
    minAreaPercent: input.hotspotDetection?.minAreaPercent ?? 0.02,
    minDiffDensity: input.hotspotDetection?.minDiffDensity ?? 0.10
  };
  const outputDir = resolveAbsolutePath(input.outputDir);
  const regionsDir = path.join(outputDir, 'regions');
  const roiDir = path.join(outputDir, 'regions-of-interest');
  const warnings: string[] = [];
  let vlmSummary: VlmSummary | undefined;
  let vlmPreflight = input.vlmPreflight;
  const vlmConfig = input.vlmConfig ?? resolveOllamaConfig();
  const vlmUnavailableWarning = 'VLM analysis was requested but unavailable. Region analysis fell back to error/fallback statuses. Run vlm_health or start Ollama.';
  let actionRequired: ActionRequired | null = null;
  let vlmAvailability: VlmAvailability = {
    requested: shouldUseVlm,
    usable: false,
    selectedModel: shouldUseVlm ? vlmConfig.model : null
  };

  await ensureDir(outputDir);
  await ensureDir(regionsDir);
  await ensureDir(roiDir);

  const expectedAbsPath = resolveAbsolutePath(input.expectedImage);
  const actualAbsPath = resolveAbsolutePath(input.actualImage);

  const expectedPng = await loadImageAsPng(expectedAbsPath);
  let actualPng = await loadImageAsPng(actualAbsPath);
  const actualSourceWidth = actualPng.width;
  const actualSourceHeight = actualPng.height;
  const invalidCapture = detectInvalidActualCapture(actualPng);
  if (invalidCapture.invalid) {
    actionRequired = buildInvalidCaptureActionRequired();
  }

  if (shouldUseVlm && !invalidCapture.invalid) {
    if (!vlmPreflight) {
      vlmPreflight = await preflightOllama(vlmConfig, true);
    }
    vlmAvailability = {
      requested: true,
      usable: vlmPreflight.available,
      selectedModel: vlmPreflight.selectedModel ?? vlmConfig.model,
      reason: vlmPreflight.available ? undefined : (vlmPreflight.failureReason ?? 'unknown'),
      message: vlmPreflight.available ? undefined : (vlmPreflight.failureMessage ?? 'VLM analysis was requested but no usable local model is available.')
    };
    vlmSummary = {
      requested: true,
      required: vlmPolicy === 'required',
      provider: 'ollama',
      baseUrl: vlmPreflight.baseUrl,
      selectedModel: vlmPreflight.selectedModel,
      fallbackUsed: vlmPreflight.fallbackUsed,
      healthStatus: vlmPreflight.healthStatus,
      warnings: [...vlmPreflight.warnings]
    };
    warnings.push(...vlmPreflight.warnings);
    if (!vlmPreflight.available) {
      if (vlmPolicy === 'required') {
        throw new Error('VLM analysis is required but no configured Ollama model could be loaded. Run vlm_health for details.');
      }
      if (vlmPolicy === 'ask_user') {
        actionRequired = buildVlmUnavailableActionRequired();
      } else {
        warnings.push(vlmUnavailableWarning);
      }
      vlmSummary.warnings.push(vlmUnavailableWarning);
    }
  }

  if (expectedPng.width !== actualPng.width || expectedPng.height !== actualPng.height) {
    // Resize actual image
    const actualRawBuffer = await fs.readFile(actualAbsPath);
    const resizedBuffer = await resizeImageToMatch(actualRawBuffer, expectedPng.width, expectedPng.height);
    const sharp = require('sharp');
    const pngBuffer = await sharp(resizedBuffer).png().toBuffer();
    const { PNG } = require('pngjs');
    actualPng = PNG.sync.read(pngBuffer);
  }

  const normalizeRegion = (region: IgnoreRegion) => {
    const coordinateSpace = region.coordinateSpace ?? 'expected';
    const sourceWidth = coordinateSpace === 'actual' ? actualSourceWidth : expectedPng.width;
    const sourceHeight = coordinateSpace === 'actual' ? actualSourceHeight : expectedPng.height;
    return {
      ...region,
      ...normalizeBox(region, expectedPng.width, expectedPng.height, coordinateSpace, sourceWidth, sourceHeight),
      coordinateSpace: 'expected' as const
    };
  };
  const normalizedIgnoreRegions = explicitMaskRegions.map(normalizeRegion);
  const normalizedAutoMaskedRegions = autoMaskedRegions.map(normalizeRegion);
  const allMaskRegions = [...normalizedIgnoreRegions, ...normalizedAutoMaskedRegions];

  applyIgnoreRegions(expectedPng, allMaskRegions);
  applyIgnoreRegions(actualPng, allMaskRegions);

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
  
  // Sort regions by area descending, effectively keeping the largest ones
  rawRegions.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  
  if (rawRegions.length > maxRegions) {
    rawRegions = rawRegions.slice(0, maxRegions);
  }

  const vlmCandidates = new Set(rawRegions.slice(0, maxVlmRegions));

  // Sort back to top-to-bottom, left-to-right for reporting readability
  rawRegions.sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });

  const normalizedRois = regionsOfInterestInput.map((roi) => ({
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
  const normalizedAppContentBounds = input.appContentBounds
    ? normalizeBox(
      input.appContentBounds,
      expectedPng.width,
      expectedPng.height,
      input.appContentBounds.coordinateSpace ?? 'expected',
      input.appContentBounds.coordinateSpace === 'actual' ? actualSourceWidth : expectedPng.width,
      input.appContentBounds.coordinateSpace === 'actual' ? actualSourceHeight : expectedPng.height
    )
    : null;

  for (const dataMask of normalizedIgnoreRegions.filter((region) => region.type === 'data')) {
    const dataMaskBox = dataMask;
    for (const roi of normalizedRois.filter((roi) => roi.critical)) {
      if (boxesIntersect(dataMaskBox, roi.box)) {
        warnings.push(`Data mask overlaps critical ROI '${roi.label}'. Verify this is intentional.`);
      }
    }
  }

  for (const autoMask of normalizedAutoMaskedRegions) {
    for (const roi of normalizedRois.filter((candidate) => candidate.critical)) {
      if (boxesIntersect(autoMask, roi.box)) {
        warnings.push(`Auto mask overlaps critical ROI '${roi.label}'. Review autoIgnore settings before accepting this run.`);
      }
    }
  }

  const regions: RegionReport[] = [];

  const roiCropArtifacts: RegionOfInterestReport[] = [];
  const localHotspotCandidates: LocalHotspot[] = [];
  const dynamicMaskQualityFailures: QualityFailure[] = [];
  const dynamicMaskQualityWarnings: string[] = [];
  const nonCriticalRoiQualityWarnings: string[] = [];

  for (let i = 0; i < rawRegions.length; i++) {
    const box = rawRegions[i];
    const regionId = `region-${(i + 1).toString().padStart(3, '0')}`;
    const expCrop = path.join(regionsDir, `${regionId}-expected.png`);
    const actCrop = path.join(regionsDir, `${regionId}-actual.png`);
    const diffCrop = path.join(regionsDir, `${regionId}-diff.png`);

    await cropAndSave(processedExpectedPath, box, expCrop);
    await cropAndSave(processedActualPath, box, actCrop);
    await cropAndSave(diffAbsPath, box, diffCrop);

    const intersectingRois = regionIntersections(box, normalizedRois);
    const classification: 'app' | 'artifact' = normalizedAppContentBounds && !boxesIntersect(box, normalizedAppContentBounds)
      ? 'artifact'
      : 'app';
    const actionable = classification === 'app';
    const fallbackLabel = intersectingRois[0]?.label ?? geometryFallbackLabel(box, expectedPng.width, expectedPng.height);
    const fallbackDescription = intersectingRois.length > 0
      ? `This changed region intersects the configured ROI '${intersectingRois[0].label}'. Local component diff should be reviewed even without VLM.`
      : geometryFallbackDescription(fallbackLabel);

    let analysis: VlmAnalysis | null = null;
    let analysisStatus: "skipped" | "ok" | "fallback" | "error" = "skipped";
    
    if (shouldUseVlm && !invalidCapture.invalid && vlmCandidates.has(box)) {
     if (vlmPreflight?.available && vlmPreflight.selectedModel) {
       const ollamaResult = await explainDiffUsingOllama(expCrop, actCrop, diffCrop, {
         baseUrl: vlmConfig.baseUrl,
         model: vlmPreflight.selectedModel,
         timeoutMs: vlmConfig.timeoutMs,
         keepAlive: vlmConfig.keepAlive
       });
       analysis = ollamaResult.analysis;
       analysisStatus = ollamaResult.status;
     } else {
       analysis = {
         type: 'unknown',
         severity: 'medium',
         description: vlmPreflight?.failureMessage ?? 'VLM unavailable. Inspect the crop manually.',
         likelyFix: 'Inspect the crop manually.'
       };
       analysisStatus = "fallback";
     }
    }

    regions.push({
      id: regionId,
      box,
      area: box.width * box.height,
      actionable,
      classification,
      cropPaths: {
        expected: expCrop,
        actual: actCrop,
        diff: diffCrop
      },
      analysisStatus,
      analysis,
      fallbackLabel,
      fallbackDescription,
      intersectingRois: intersectingRois.map((roi) => roi.id)
    });

    const area = box.width * box.height;
    const diffDensity = countMaskPixels(mismatchMask, box) / Math.max(1, area);
    const areaPercent = area / Math.max(1, totalPixels);
    if (actionable && hotspotDetection.enabled && areaPercent >= hotspotDetection.minAreaPercent && diffDensity >= hotspotDetection.minDiffDensity) {
      localHotspotCandidates.push({
        regionId,
        area,
        box,
        diffDensity,
        fallbackLabel,
        message: 'Large local mismatch remains despite global status.'
      });
    }
  }

  const localHotspots = localHotspotCandidates
    .sort((a, b) => {
      const areaDelta = b.area - a.area;
      if (areaDelta !== 0) return areaDelta;
      return b.diffDensity - a.diffDensity;
    })
    .slice(0, hotspotDetection.maxHotspots);
  const artifactRegions = regions.filter((region) => region.actionable === false || region.classification === 'artifact');
  const actionableRegionCount = regions.filter((region) => region.actionable !== false).length;

  for (const roi of normalizedRois) {
    const roiRegionId = `roi-${roi.id}`;
    const expCrop = path.join(roiDir, `${roi.id}-expected.png`);
    const actCrop = path.join(roiDir, `${roi.id}-actual.png`);
    const diffCrop = path.join(roiDir, `${roi.id}-diff.png`);
    const structuralDiffCrop = path.join(roiDir, `${roi.id}-structural-diff.png`);
    await cropAndSave(processedExpectedPath, roi.box, expCrop);
    await cropAndSave(processedActualPath, roi.box, actCrop);
    await cropAndSave(diffAbsPath, roi.box, diffCrop);

    const resolvedDynamicSubregions = (roi.allowedDynamicSubregions ?? [])
      .map((subregion) => {
        const box = resolveRoiDynamicSubregionBox(
          subregion,
          roi.box,
          expectedPng.width,
          expectedPng.height,
          actualSourceWidth,
          actualSourceHeight
        );
        if (!box) return null;
        return {
          id: subregion.id,
          label: subregion.label,
          reason: subregion.reason,
          coordinateSpace: 'expected' as const,
          box
        };
      })
      .filter((subregion): subregion is NonNullable<typeof subregion> => subregion !== null);
    const resolvedDynamicBoxes = resolvedDynamicSubregions.map((subregion) => subregion.box);
    await writeStructuralRoiDiffCrop(diffImage, roi.box, resolvedDynamicBoxes, structuralDiffCrop);
    const roiDynamicBoxes = resolvedDynamicBoxes.map((box) => ({
      x: box.x - roi.box.x,
      y: box.y - roi.box.y,
      width: box.width,
      height: box.height
    }));
    const totalPixelsInRoiRaw = Math.max(1, roi.box.width * roi.box.height);
    const roiPixelCounts = countRoiPixelsWithDynamicMask(
      mismatchMask,
      roi.box,
      resolvedDynamicBoxes
    );
    const diffPixelsInRoi = roiPixelCounts.structuralDiffPixels;
    const totalPixelsInRoi = roiPixelCounts.structuralTotalPixels;
    const rawRoiDiffPercent = roiPixelCounts.rawDiffPixels / totalPixelsInRoiRaw;
    const structuralRoiDiffPercent = diffPixelsInRoi / totalPixelsInRoi;
    const dynamicMaskedPercentOfRoi = roiPixelCounts.dynamicMaskedPixels / totalPixelsInRoiRaw;
    const intersectingRegionIds = regions.filter((region) => boxesIntersect(region.box, roi.box)).map((region) => region.id);
    const maxDiffPercentForRoi = roi.maxDiffPercent ?? maxDiffPercent;
    const status: 'pass' | 'fail' = structuralRoiDiffPercent <= maxDiffPercentForRoi ? 'pass' : 'fail';
    if ((roi.critical ?? false) === false && status === 'fail') {
      nonCriticalRoiQualityWarnings.push(`Non-critical ROI '${roi.label}' failed local diff threshold while qualityStatus remains pass. Review the ROI before accepting visual parity.`);
    }
    const diagnostics = status === 'fail'
      ? [
          'Structural ROI diff exceeds maxDiffPercent.',
          `Large unmasked local mismatch in ${roi.label} even though global diff may be stable.`
        ]
      : ['ROI within local diff threshold.'];
    if (resolvedDynamicSubregions.length > 0) {
      diagnostics.push(`Raw ROI diff ${(rawRoiDiffPercent * 100).toFixed(2)}%; structural ROI diff ${(structuralRoiDiffPercent * 100).toFixed(2)}% after dynamic subregion masking.`);
      if (rawRoiDiffPercent > maxDiffPercentForRoi && structuralRoiDiffPercent <= maxDiffPercentForRoi) {
        diagnostics.push('High raw ROI diff with passing structural diff suggests live data variance rather than structural UI drift.');
      }
    }
    if ((roi.critical ?? false) && dynamicMaskedPercentOfRoi > 0.25) {
      const warning = `Dynamic subregions mask ${(dynamicMaskedPercentOfRoi * 100).toFixed(1)}% of critical ROI '${roi.label}'. Keep masks narrow so structural defects remain visible.`;
      diagnostics.push(warning);
      warnings.push(warning);
      dynamicMaskQualityWarnings.push(warning);
    }
    if (dynamicMaskedPercentOfRoi > 0.40) {
      const roiImportance = (roi.critical ?? false) ? 'critical' : 'non-critical';
      const warning = `Excessive dynamic masking covers ${(dynamicMaskedPercentOfRoi * 100).toFixed(1)}% of ${roiImportance} ROI '${roi.label}'. Quality gate is not trustworthy without allowBroadDynamicSubregions:true.`;
      diagnostics.push(warning);
      warnings.push(warning);
      dynamicMaskQualityWarnings.push(warning);
      if ((roi.critical ?? false) && roi.allowBroadDynamicSubregions !== true) {
        dynamicMaskQualityFailures.push({
          type: 'excessive_dynamic_masking',
          roiId: roi.id,
          label: roi.label,
          diffPercent: structuralRoiDiffPercent,
          rawRoiDiffPercent,
          structuralRoiDiffPercent,
          dynamicMaskedPercentOfRoi,
          maxDiffPercent: maxDiffPercentForRoi
        });
      }
    }

    let geometryDiagnostics: RegionOfInterestReport['geometryDiagnostics'];
    if (roi.geometryDiagnostics?.type === 'radialChart' && roi.geometryDiagnostics.enabled) {
      try {
        geometryDiagnostics = await runRadialChartDiagnostics({
          roiId: roi.id,
          expectedCropPath: expCrop,
          actualCropPath: actCrop,
          outputDir: roiDir,
          config: roi.geometryDiagnostics,
          dynamicSubregions: roiDynamicBoxes
        });
        diagnostics.push(`Radial chart geometry diagnostics ${geometryDiagnostics.status}: ${geometryDiagnostics.verdict}. ${geometryDiagnostics.agentHint}`);
        for (const warning of geometryDiagnostics.warnings) {
          warnings.push(`ROI '${roi.label}' radial geometry warning: ${warning}`);
        }
      } catch (err: any) {
        const warning = `ROI '${roi.label}' radial geometry diagnostics failed: ${err?.message ?? String(err)}`;
        warnings.push(warning);
        diagnostics.push(warning);
      }
    }
    const geometryArtifacts = geometryDiagnostics?.artifacts;

    roiCropArtifacts.push({
      id: roi.id,
      label: roi.label,
      type: roi.type,
      critical: roi.critical ?? false,
      weight: roi.weight ?? 1,
      box: roi.box,
      status,
      diffPixels: diffPixelsInRoi,
      totalPixels: totalPixelsInRoi,
      diffPercent: structuralRoiDiffPercent,
      rawRoiDiffPercent,
      structuralRoiDiffPercent,
      dynamicMaskedPercentOfRoi,
      resolvedDynamicSubregions,
      diffDensity: structuralRoiDiffPercent,
      maxDiffPercent: maxDiffPercentForRoi,
      intersectingRegionIds,
      diagnostics,
      geometryDiagnostics,
      weightedScore: structuralRoiDiffPercent * (roi.weight ?? 1),
      artifacts: {
        expected: expCrop,
        actual: actCrop,
        diff: diffCrop,
        structuralDiff: structuralDiffCrop,
        geometryOverlay: geometryArtifacts?.geometryOverlay,
        edgeOverlay: geometryArtifacts?.edgeOverlay,
        expectedArcMask: geometryArtifacts?.expectedArcMask,
        actualArcMask: geometryArtifacts?.actualArcMask,
        polarSummary: geometryArtifacts?.polarSummary
      }
    });
  }

  const criticalRoiFailures: QualityFailure[] = roiCropArtifacts
    .map((roi, index) => ({ roi, index }))
    .filter(({ roi }) => roi.critical && roi.status === 'fail')
    .sort((a, b) => {
      const weightDelta = b.roi.weight - a.roi.weight;
      if (weightDelta !== 0) return weightDelta;
      return a.index - b.index;
    })
    .map(({ roi }) => roi)
    .map((roi) => ({
      type: 'critical_roi_failed',
      roiId: roi.id,
      label: roi.label,
      diffPercent: roi.diffPercent,
      rawRoiDiffPercent: roi.rawRoiDiffPercent,
      structuralRoiDiffPercent: roi.structuralRoiDiffPercent,
      dynamicMaskedPercentOfRoi: roi.dynamicMaskedPercentOfRoi,
      maxDiffPercent: roi.maxDiffPercent
    }));

  const visualAssertions: VisualAssertionResult[] = visualAssertionsInput.map((assertion) => {
    if (assertion.type !== 'roiMaxDiffPercent') {
      return {
        id: assertion.id,
        status: 'pass',
        severity: assertion.severity,
        message: assertion.message,
        maxDiffPercent: assertion.maxDiffPercent
      };
    }

    const roi = roiCropArtifacts.find((candidate) => candidate.id === assertion.roiId);
    if (!roi) {
      warnings.push(`Visual assertion '${assertion.id}' references unknown ROI '${assertion.roiId}'.`);
      return {
        id: assertion.id,
        status: 'fail',
        severity: assertion.severity,
        message: assertion.message,
        maxDiffPercent: assertion.maxDiffPercent
      };
    }

    const actualDiffPercent = roi.diffPercent;
    const status: 'pass' | 'fail' = actualDiffPercent <= assertion.maxDiffPercent ? 'pass' : 'fail';
    return {
      id: assertion.id,
      status,
      severity: assertion.severity,
      message: assertion.message,
      actualDiffPercent,
      metricUsed: 'structuralRoiDiffPercent',
      rawRoiDiffPercent: roi.rawRoiDiffPercent,
      structuralRoiDiffPercent: roi.structuralRoiDiffPercent,
      dynamicMaskedPercentOfRoi: roi.dynamicMaskedPercentOfRoi,
      maxDiffPercent: assertion.maxDiffPercent
    };
  });

  const criticalAssertionFailures: QualityFailure[] = visualAssertions
    .filter((assertion) => assertion.severity === 'critical' && assertion.status === 'fail')
    .map((assertion) => {
      const roiId = visualAssertionsInput.find((candidate) => candidate.id === assertion.id)?.roiId;
      const roi = roiCropArtifacts.find((candidate) => candidate.id === roiId);
      return {
        type: 'critical_visual_assertion_failed',
        assertionId: assertion.id,
        label: roiId,
        diffPercent: assertion.actualDiffPercent,
        rawRoiDiffPercent: roi?.rawRoiDiffPercent,
        structuralRoiDiffPercent: roi?.structuralRoiDiffPercent,
        dynamicMaskedPercentOfRoi: roi?.dynamicMaskedPercentOfRoi,
        maxDiffPercent: assertion.maxDiffPercent
      };
    });

  const invalidCaptureQualityFailures: QualityFailure[] = invalidCapture.invalid
    ? [{
      type: 'invalid_capture',
      label: 'actual screenshot',
      diffPercent
    }]
    : [];

  const qualityFailures: QualityFailure[] = [
    ...invalidCaptureQualityFailures,
    ...criticalRoiFailures,
    ...criticalAssertionFailures,
    ...dynamicMaskQualityFailures
  ];

  const hasQualityEvaluationConfig = regionsOfInterestInput.length > 0 || visualAssertionsInput.length > 0;
  const qualityWarnings = hasQualityEvaluationConfig
    ? []
    : ['No regionsOfInterest or visualAssertions configured. Global pixel status does not prove visual parity.'];
  qualityWarnings.push(...dynamicMaskQualityWarnings);
  if (invalidCapture.invalid) {
    qualityWarnings.push('Actual screenshot appears invalid or asleep. Recapture before trusting ROI, VLM, or quality analysis.');
  }
  if (actionRequired?.type === 'vlm_unavailable') {
    qualityWarnings.push('VLM analysis was requested but unavailable. Ask the user whether to continue without semantic analysis.');
  }
  const qualityStatus: 'pass' | 'fail' | 'not_evaluated' = invalidCapture.invalid
    ? 'fail'
    : !hasQualityEvaluationConfig
    ? 'not_evaluated'
    : (qualityFailures.length > 0 ? 'fail' : 'pass');
  if (qualityStatus === 'pass') {
    qualityWarnings.push(...nonCriticalRoiQualityWarnings);
  }

  const priorityFindings: PriorityFinding[] = [];
  for (const failure of criticalRoiFailures) {
    priorityFindings.push({
      priority: priorityFindings.length + 1,
      kind: 'critical_roi_failed',
      label: failure.label ?? failure.roiId ?? 'critical ROI',
      message: `Critical ROI '${failure.label ?? failure.roiId}' failed local diff threshold. Do not treat global diff floor as acceptable.`,
      artifactPaths: failure.roiId ? [
        path.join(roiDir, `${failure.roiId}-expected.png`),
        path.join(roiDir, `${failure.roiId}-actual.png`),
        path.join(roiDir, `${failure.roiId}-diff.png`)
      ] : []
    });
  }
  if (criticalRoiFailures.length === 0) {
    for (const failure of criticalAssertionFailures) {
      const assertion = visualAssertions.find((candidate) => candidate.id === failure.assertionId);
      const roiId = failure.label;
      priorityFindings.push({
        priority: priorityFindings.length + 1,
        kind: 'critical_visual_assertion_failed',
        label: failure.assertionId ?? 'critical visual assertion',
        message: assertion?.message ?? `Critical visual assertion '${failure.assertionId}' failed.`,
        artifactPaths: roiId ? [
          path.join(roiDir, `${roiId}-expected.png`),
          path.join(roiDir, `${roiId}-actual.png`),
          path.join(roiDir, `${roiId}-diff.png`)
        ] : []
      });
    }
  }
  for (const failure of dynamicMaskQualityFailures) {
    priorityFindings.push({
      priority: priorityFindings.length + 1,
      kind: 'excessive_dynamic_masking',
      label: failure.label ?? failure.roiId ?? 'critical ROI',
      message: `Excessive dynamic mask coverage in '${failure.label ?? failure.roiId}' makes the ROI quality gate untrustworthy.`,
      artifactPaths: failure.roiId ? [
        path.join(roiDir, `${failure.roiId}-expected.png`),
        path.join(roiDir, `${failure.roiId}-actual.png`),
        path.join(roiDir, `${failure.roiId}-diff.png`)
      ] : []
    });
  }

  const rankedRegions = regions.filter((region) => region.actionable !== false)
    .map((region) => ({
      region,
      intersectingRois: normalizedRois.filter((roi) => boxesIntersect(region.box, roi.box))
    }))
    .sort((a, b) => {
      const aScore = (a.region.area * (a.intersectingRois.reduce((sum, roi) => sum + (roi.weight ?? 1), 0) || 1));
      const bScore = (b.region.area * (b.intersectingRois.reduce((sum, roi) => sum + (roi.weight ?? 1), 0) || 1));
      return bScore - aScore;
    });

  for (const item of rankedRegions.slice(0, 3)) {
    priorityFindings.push({
      priority: priorityFindings.length + 1,
      kind: 'high_diff_region',
      label: item.region.fallbackLabel ?? item.region.id,
      message: item.region.fallbackDescription ?? `Changed region ${item.region.id} is visually important.`,
      artifactPaths: [item.region.cropPaths.expected, item.region.cropPaths.actual, item.region.cropPaths.diff]
    });
  }

  const floorState = evaluateFloorState({
    floorDetection,
    runDelta,
    previousReport,
    currentDiffPercent: diffPercent,
    qualityStatus,
    criticalFailures: criticalRoiFailures,
    criticalAssertionFailures
  });

  const hasCriticalFailure = qualityFailures.length > 0;
  const canSuggestMaxDiffPercent = diffPercent > maxDiffPercent && qualityStatus === 'pass' && floorState.atFloor === true && !hasCriticalFailure;
  const suggestedMaxDiffPercent = canSuggestMaxDiffPercent ? Math.round(diffPercent * 1.1 * 10000) / 10000 : null;
  const suggestionBlockers = !canSuggestMaxDiffPercent
    ? [
      ...(qualityStatus === 'not_evaluated'
        ? ['Critical UI quality was not evaluated. Configure ROIs or visualAssertions first.']
        : []),
      ...qualityFailures.map((failure) => {
        if (failure.type === 'critical_roi_failed') {
          return `Critical ROI '${failure.label ?? failure.roiId}' failed.`;
        }
        if (failure.type === 'excessive_dynamic_masking') {
          return `Critical ROI '${failure.label ?? failure.roiId}' has excessive dynamic masking.`;
        }
        if (failure.type === 'invalid_capture') {
          return 'Actual screenshot appears invalid or asleep; recapture before adjusting thresholds.';
        }
        return `Critical visual assertion '${failure.assertionId}' failed.`;
      })
    ]
    : [];

  if (qualityWarnings.length > 0) {
    warnings.push(...qualityWarnings);
  }

  if (diffPercent <= maxDiffPercent && localHotspots.length > 0) {
    warnings.push('Global pass does not mean local visual parity; large local hotspots remain.');
  }

  if (qualityStatus === 'not_evaluated' && diffPercent <= maxDiffPercent && localHotspots.length > 0) {
    const largestHotspot = localHotspots[0];
    warnings.push(`Global pass may be misleading: largest changed region covers ${largestHotspot.area} pixels in ${largestHotspot.fallbackLabel}.`);
  }

  if (criticalRoiFailures.length > 0) {
    const failure = criticalRoiFailures[0];
    const structural = typeof failure.structuralRoiDiffPercent === 'number'
      ? ` Structural ROI diff: ${(failure.structuralRoiDiffPercent * 100).toFixed(2)}%.`
      : '';
    warnings.push(`Critical region '${failure.label}' failed structural local diff threshold.${structural} Do not treat global diff floor as acceptable.`);
  }

  if (suggestedMaxDiffPercent !== null) {
    configSuggestions.push({
      kind: 'ignoreRegion',
      confidence: 0.55,
      reason: 'Global diff appears stable and local quality gates pass, so a threshold update may be appropriate.',
      risk: 'Medium. Raising thresholds can hide visual regressions; review artifacts first.',
      suggestedPatch: {
        maxDiffPercent: suggestedMaxDiffPercent
      }
    });
  }

  const reportStatus: DiffReport['status'] = invalidCapture.invalid
    ? 'fail'
    : (diffPercent <= maxDiffPercent ? 'pass' : 'fail');

  const agentSummary = buildAgentSummary({
    status: reportStatus,
    qualityStatus,
    diffPercent,
    criticalFailures: criticalRoiFailures,
    criticalAssertionFailures,
    qualityFailures,
    roiReports: roiCropArtifacts,
    priorityFindings,
    localHotspots,
    actionRequired
  });

  const report: DiffReport = {
    status: reportStatus,
    diffPixels,
    totalPixels,
    diffPercent,
    pixelmatchThreshold,
    maxDiffPercent,
    regions,
    artifactRegions: artifactRegions.length ? artifactRegions : undefined,
    actionableRegionCount,
    regionsOfInterest: roiCropArtifacts,
    qualityStatus,
    qualityFailures,
    qualityWarnings,
    priorityFindings,
    localHotspots,
    visualAssertions,
    imageSizes: {
      expected: { width: expectedPng.width, height: expectedPng.height },
      actualSource: { width: actualSourceWidth, height: actualSourceHeight },
      comparison: { width: expectedPng.width, height: expectedPng.height }
    },
    atFloor: floorState.atFloor,
    floorBlockedBy: floorState.floorBlockedBy.length ? floorState.floorBlockedBy : undefined,
    floorReason: floorState.floorReason,
    maskedRegions: explicitMaskRegions,
    autoMaskedRegions: autoMaskedRegions.length ? autoMaskedRegions : undefined,
    appliedDeviceProfile: input.appliedDeviceProfile ?? undefined,
    configSuggestions: configSuggestions.length ? configSuggestions : undefined,
    agentSummary,
    suggestedMaxDiffPercent,
    maxDiffPercentSuggestionBlockedBy: suggestionBlockers.length ? suggestionBlockers : undefined,
    vlmPolicy,
    vlmAvailability,
    actionRequired,
    artifacts: {
      expected: processedExpectedPath,
      actual: processedActualPath,
      diff: diffAbsPath,
      regionsDir
    },
    warnings: warnings.length ? warnings : undefined,
    vlm: vlmSummary
  };

  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
