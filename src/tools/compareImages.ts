import * as path from 'path';
import { ensureDir, resolveAbsolutePath } from '../utils/fs';
import { loadImageAsPng, writePng, resizeImageToMatch } from '../image/load';
import { applyIgnoreRegions } from '../image/mask';
import { createDiffErrorMask } from '../image/diff';
import { detectRegions } from '../image/regions';
import { cropAndSave } from '../image/crops';
import { explainDiffUsingOllama, preflightOllama, resolveOllamaConfig, ResolvedOllamaConfig, VlmPreflightResult } from '../vlm/ollama';
import { IgnoreRegion, RegionReport, DiffReport, VlmSummary, VlmAnalysis, RegionOfInterestConfig, RegionOfInterestReport, QualityFailure, PriorityFinding, VisualAssertionConfig, VisualAssertionResult, FloorDetectionConfig, RunDelta, PreCaptureResult, FloorBlocker, AgentSummary } from '../types';
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
  requireVlmAnalysis?: boolean;
  ignoreRegions?: IgnoreRegion[];
  regionsOfInterest?: RegionOfInterestConfig[];
  visualAssertions?: VisualAssertionConfig[];
  previousReport?: DiffReport;
  runDelta?: RunDelta;
  floorDetection?: FloorDetectionConfig;
  vlmConfig?: ResolvedOllamaConfig;
  vlmPreflight?: VlmPreflightResult;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeBox(box: { x: number; y: number; width: number; height: number }, width: number, height: number, coordinateSpace: 'normalized' | 'expected' | 'actual' = 'expected') {
  if (coordinateSpace === 'normalized') {
    const left = Math.floor(clamp(box.x, 0, 1) * width);
    const top = Math.floor(clamp(box.y, 0, 1) * height);
    const right = Math.ceil(clamp(box.x + box.width, 0, 1) * width);
    const bottom = Math.ceil(clamp(box.y + box.height, 0, 1) * height);
    const normalizedWidth = Math.max(1, right - left);
    const normalizedHeight = Math.max(1, bottom - top);
    return {
      x: clamp(left, 0, Math.max(0, width - 1)),
      y: clamp(top, 0, Math.max(0, height - 1)),
      width: clamp(normalizedWidth, 1, width - clamp(left, 0, Math.max(0, width - 1))),
      height: clamp(normalizedHeight, 1, height - clamp(top, 0, Math.max(0, height - 1)))
    };
  }

  const left = clamp(Math.floor(box.x), 0, Math.max(0, width - 1));
  const top = clamp(Math.floor(box.y), 0, Math.max(0, height - 1));
  const right = clamp(Math.ceil(box.x + box.width), left + 1, width);
  const bottom = clamp(Math.ceil(box.y + box.height), top + 1, height);
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
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

function evaluateFloorState(input: {
  floorDetection?: FloorDetectionConfig;
  runDelta?: RunDelta;
  previousReport?: DiffReport;
  currentDiffPercent: number;
  criticalFailures: QualityFailure[];
  criticalAssertionFailures: QualityFailure[];
}): { atFloor: boolean | null; floorBlockedBy: FloorBlocker[]; floorReason?: string } {
  const floorDetection = input.floorDetection;
  if (!floorDetection?.enabled) {
    return { atFloor: null, floorBlockedBy: [], floorReason: 'Floor detection disabled.' };
  }

  if (!input.previousReport) {
    return { atFloor: null, floorBlockedBy: [], floorReason: 'No floor history available.' };
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

  const threshold = floorDetection.deltaThreshold ?? 0.0001;
  const deltaValue = input.runDelta?.diffPercentDelta ?? (input.currentDiffPercent - (input.previousReport.diffPercent ?? input.currentDiffPercent));
  const deltaOk = Math.abs(deltaValue) < threshold;
  const needed = floorDetection.consecutiveRuns ?? 2;
  const previousAtFloor = input.previousReport.atFloor;

  if (!deltaOk) {
    return { atFloor: false, floorBlockedBy: [], floorReason: 'Global diff still moving.' };
  }

  if (needed <= 1) {
    return { atFloor: true, floorBlockedBy: [], floorReason: 'Global diff stable across current run.' };
  }

  if (previousAtFloor === true) {
    return { atFloor: true, floorBlockedBy: [], floorReason: 'Global diff stable across consecutive runs.' };
  }

  return { atFloor: null, floorBlockedBy: [], floorReason: 'No floor history available.' };
}

function buildAgentSummary(input: {
  status: DiffReport['status'];
  qualityStatus: 'pass' | 'fail';
  diffPercent: number;
  criticalFailures: QualityFailure[];
  criticalAssertionFailures: QualityFailure[];
  priorityFindings: PriorityFinding[];
}): AgentSummary {
  if (input.criticalFailures.length > 0) {
    const label = input.criticalFailures[0].label ?? 'critical region';
    return {
      verdict: `Do not accept. Critical ${label} region still differs significantly from mockup.`,
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

  if (input.status === 'fail') {
    const topAction = input.priorityFindings[0]?.message ?? 'Reduce global diff until report passes.';
    return {
      verdict: 'Global diff still above threshold.',
      globalDiffPercent: input.diffPercent,
      qualityStatus: input.qualityStatus,
      topAction,
      canStopIterating: false
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
  const pixelmatchThreshold = input.pixelmatchThreshold ?? input.threshold ?? 0.1;
  const maxDiffPercent = input.maxDiffPercent ?? 0.001;
  const maxRegions = input.maxRegions ?? 50;
  const maxVlmRegions = input.maxVlmRegions ?? 10;
  const includeVlmAnalysis = input.includeVlmAnalysis ?? false;
  const requireVlmAnalysis = input.requireVlmAnalysis ?? false;
  const ignoreRegions = input.ignoreRegions ?? [];
  const regionsOfInterestInput = input.regionsOfInterest ?? [];
  const visualAssertionsInput = input.visualAssertions ?? [];
  const previousReport = input.previousReport;
  const runDelta = input.runDelta;
  const floorDetection = input.floorDetection;
  const outputDir = resolveAbsolutePath(input.outputDir);
  const regionsDir = path.join(outputDir, 'regions');
  const roiDir = path.join(outputDir, 'regions-of-interest');
  const warnings: string[] = [];
  let vlmSummary: VlmSummary | undefined;
  let vlmPreflight = input.vlmPreflight;
  const vlmConfig = input.vlmConfig ?? resolveOllamaConfig();
  const vlmUnavailableWarning = 'VLM analysis was requested but unavailable. Region analysis fell back to error/fallback statuses. Run vlm_health or start Ollama.';
  const vlmDisabledWarning = 'VLM analysis disabled. Enable includeVlmAnalysis for semantic region explanations.';

  if (!includeVlmAnalysis) {
    warnings.push(vlmDisabledWarning);
  } else {
    if (!vlmPreflight) {
      vlmPreflight = await preflightOllama(vlmConfig, true);
    }
    vlmSummary = {
      requested: true,
      required: requireVlmAnalysis,
      provider: 'ollama',
      baseUrl: vlmPreflight.baseUrl,
      selectedModel: vlmPreflight.selectedModel,
      fallbackUsed: vlmPreflight.fallbackUsed,
      healthStatus: vlmPreflight.healthStatus,
      warnings: [...vlmPreflight.warnings]
    };
    warnings.push(...vlmPreflight.warnings);
    if (!vlmPreflight.available) {
      if (requireVlmAnalysis) {
        throw new Error('VLM analysis is required but no configured Ollama model could be loaded. Run vlm_health for details.');
      }
      warnings.push(vlmUnavailableWarning);
      vlmSummary.warnings.push(vlmUnavailableWarning);
    }
  }

  await ensureDir(outputDir);
  await ensureDir(regionsDir);
  await ensureDir(roiDir);

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
    box: normalizeBox(roi.box, expectedPng.width, expectedPng.height, roi.coordinateSpace ?? 'expected')
  }));

  for (const dataMask of ignoreRegions.filter((region) => region.type === 'data')) {
    const dataMaskBox = normalizeBox(dataMask, expectedPng.width, expectedPng.height, 'expected');
    for (const roi of normalizedRois.filter((roi) => roi.critical)) {
      if (boxesIntersect(dataMaskBox, roi.box)) {
        warnings.push(`Data mask overlaps critical ROI '${roi.label}'. Verify this is intentional.`);
      }
    }
  }

  const regions: RegionReport[] = [];

  const roiCropArtifacts: RegionOfInterestReport[] = [];

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
    const fallbackLabel = intersectingRois[0]?.label ?? geometryFallbackLabel(box, expectedPng.width, expectedPng.height);
    const fallbackDescription = intersectingRois.length > 0
      ? `This changed region intersects the configured ROI '${intersectingRois[0].label}'. Local component diff should be reviewed even without VLM.`
      : geometryFallbackDescription(fallbackLabel);

    let analysis: VlmAnalysis | null = null;
    let analysisStatus: "skipped" | "ok" | "fallback" | "error" = "skipped";
    
    if (includeVlmAnalysis && vlmCandidates.has(box)) {
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
  }

  for (const roi of normalizedRois) {
    const roiRegionId = `roi-${roi.id}`;
    const expCrop = path.join(roiDir, `${roi.id}-expected.png`);
    const actCrop = path.join(roiDir, `${roi.id}-actual.png`);
    const diffCrop = path.join(roiDir, `${roi.id}-diff.png`);
    await cropAndSave(processedExpectedPath, roi.box, expCrop);
    await cropAndSave(processedActualPath, roi.box, actCrop);
    await cropAndSave(diffAbsPath, roi.box, diffCrop);

    const diffPixelsInRoi = countMaskPixels(mismatchMask, roi.box);
    const totalPixelsInRoi = Math.max(1, roi.box.width * roi.box.height);
    const diffPercentInRoi = diffPixelsInRoi / totalPixelsInRoi;
    const intersectingRegionIds = regions.filter((region) => boxesIntersect(region.box, roi.box)).map((region) => region.id);
    const maxDiffPercentForRoi = roi.maxDiffPercent ?? maxDiffPercent;
    const status: 'pass' | 'fail' = diffPercentInRoi <= maxDiffPercentForRoi ? 'pass' : 'fail';
    const diagnostics = status === 'fail'
      ? [
          'Critical ROI exceeds maxDiffPercent.',
          `Large local mismatch in ${roi.label} even though global diff may be stable.`
        ]
      : ['ROI within local diff threshold.'];

    roiCropArtifacts.push({
      id: roi.id,
      label: roi.label,
      type: roi.type,
      critical: roi.critical ?? false,
      weight: roi.weight ?? 1,
      status,
      diffPixels: diffPixelsInRoi,
      totalPixels: totalPixelsInRoi,
      diffPercent: diffPercentInRoi,
      diffDensity: diffPercentInRoi,
      maxDiffPercent: maxDiffPercentForRoi,
      intersectingRegionIds,
      diagnostics,
      weightedScore: diffPercentInRoi * (roi.weight ?? 1),
      artifacts: {
        expected: expCrop,
        actual: actCrop,
        diff: diffCrop
      }
    });
  }

  const criticalRoiFailures: QualityFailure[] = roiCropArtifacts
    .filter((roi) => roi.critical && roi.status === 'fail')
    .map((roi) => ({
      type: 'critical_roi_failed',
      roiId: roi.id,
      label: roi.label,
      diffPercent: roi.diffPercent,
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
    const actualDiffPercent = roi?.diffPercent ?? 0;
    const status: 'pass' | 'fail' = actualDiffPercent <= assertion.maxDiffPercent ? 'pass' : 'fail';
    return {
      id: assertion.id,
      status,
      severity: assertion.severity,
      message: assertion.message,
      actualDiffPercent,
      maxDiffPercent: assertion.maxDiffPercent
    };
  });

  const criticalAssertionFailures: QualityFailure[] = visualAssertions
    .filter((assertion) => assertion.severity === 'critical' && assertion.status === 'fail')
    .map((assertion) => ({
      type: 'critical_visual_assertion_failed',
      assertionId: assertion.id,
      label: visualAssertionsInput.find((candidate) => candidate.id === assertion.id)?.roiId,
      diffPercent: assertion.actualDiffPercent,
      maxDiffPercent: assertion.maxDiffPercent
    }));

  const qualityFailures: QualityFailure[] = [
    ...criticalRoiFailures,
    ...criticalAssertionFailures
  ];

  const qualityStatus: 'pass' | 'fail' = regionsOfInterestInput.length === 0
    ? (diffPercent <= maxDiffPercent ? 'pass' : 'fail')
    : (qualityFailures.length > 0 || diffPercent > maxDiffPercent ? 'fail' : 'pass');

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

  const rankedRegions = [...regions]
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
    criticalFailures: criticalRoiFailures,
    criticalAssertionFailures
  });

  const hasCriticalFailure = qualityFailures.length > 0;
  const canSuggestMaxDiffPercent = diffPercent > maxDiffPercent && floorState.atFloor === true && !hasCriticalFailure;
  const suggestedMaxDiffPercent = canSuggestMaxDiffPercent ? diffPercent * 1.1 : null;
  const maxDiffPercentSuggestionBlockedBy = !canSuggestMaxDiffPercent && hasCriticalFailure
    ? qualityFailures.map((failure) => {
        if (failure.type === 'critical_roi_failed') {
          return `Critical ROI '${failure.label ?? failure.roiId}' failed.`;
        }
        return `Critical visual assertion '${failure.assertionId}' failed.`;
      })
    : undefined;

  if (criticalRoiFailures.length > 0) {
    warnings.push(`Critical region '${criticalRoiFailures[0].label}' failed local diff threshold. Do not treat global diff floor as acceptable.`);
  }

  const agentSummary = buildAgentSummary({
    status: diffPercent <= maxDiffPercent ? 'pass' : 'fail',
    qualityStatus,
    diffPercent,
    criticalFailures: criticalRoiFailures,
    criticalAssertionFailures,
    priorityFindings
  });

  return {
    status: diffPercent <= maxDiffPercent ? "pass" : "fail",
    diffPixels,
    totalPixels,
    diffPercent,
    pixelmatchThreshold,
    maxDiffPercent,
    regions,
    regionsOfInterest: roiCropArtifacts,
    qualityStatus,
    qualityFailures,
    priorityFindings,
    visualAssertions,
    atFloor: floorState.atFloor,
    floorBlockedBy: floorState.floorBlockedBy.length ? floorState.floorBlockedBy : undefined,
    floorReason: floorState.floorReason,
    maskedRegions: ignoreRegions,
    agentSummary,
    suggestedMaxDiffPercent,
    maxDiffPercentSuggestionBlockedBy,
    artifacts: {
      expected: processedExpectedPath,
      actual: processedActualPath,
      diff: diffAbsPath,
      regionsDir
    },
    warnings: warnings.length ? warnings : undefined,
    vlm: vlmSummary
  };
}