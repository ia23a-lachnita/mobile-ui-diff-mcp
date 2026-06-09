import path from 'path';
import fs from 'fs/promises';
import { PNG } from 'pngjs';
import { ArtifactBuilder, normalizeBox } from './ArtifactBuilder';
import { EvidenceGraph } from './EvidenceGraph';
import { EvidenceBundleBuilder } from './EvidenceBundleBuilder';
import { ConflictResolver } from './ConflictResolver';
import { VerdictEngine } from './VerdictEngine';
import { ModelJudgeAnalyzer, ModelJudgesConfig } from './judges/ModelJudgeAnalyzer';
import { CriterionJudgeAnalyzer, buildCriterionProvider } from './judges/CriterionJudgeAnalyzer';
import { ReferenceContextAnalyzer } from './analyzers/ReferenceContextAnalyzer';
import { IAnalyzer } from './analyzers/IAnalyzer';
import { InvalidCaptureAnalyzer } from './analyzers/InvalidCaptureAnalyzer';
import { PixelDiffAnalyzer, PIXEL_DIFF_KEY, PixelDiffResult } from './analyzers/PixelDiffAnalyzer';
import { DynamicMaskAnalyzer } from './analyzers/DynamicMaskAnalyzer';
import { RadialGeometryAnalyzer } from './analyzers/RadialGeometryAnalyzer';
import { ColorSamplerAnalyzer } from './analyzers/ColorSamplerAnalyzer';
import { TextOcrAnalyzer } from './analyzers/TextOcrAnalyzer';
import { OverlapLegibilityAnalyzer } from './analyzers/OverlapLegibilityAnalyzer';
import { cropAndSave } from '../image/crops';
import { writePng } from '../image/load';
import { runRadialChartDiagnostics } from '../image/radialChartDiagnostics';
import { detectRegions } from '../image/regions';
import { CompareImagesInput } from '../tools/compareImages';
import {
  DiffReport,
  QualityFailure,
  PriorityFinding,
  LocalHotspot,
  RegionOfInterestReport,
  RegionOfInterestConfig,
  VisualAssertionResult,
  FloorBlocker,
  RunDelta,
  FloorDetectionConfig,
  ConfigSuggestion,
  ActionRequired,
  VlmAvailability,
  VlmPolicy,
  VlmAnalysisStatus,
  IgnoreRegion,
  BoxLike,
  AgentSummary,
  VisualAuditStatus,
  AcceptanceStatus,
  VisualCaveat,
  RunTimings,
  ModelJudgesSummary,
  ModelJudgesProviderSummary,
  CriterionJudgesSummary,
  CriterionJudgeSummaryEntry
} from '../types';

// ---- helpers (ported directly from original compareImages.ts) ----

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function ceilPixel(value: number): number {
  return Math.ceil(value - 1e-9);
}

function boxesIntersect(a: BoxLike, b: BoxLike): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

function intersectBoxes(a: BoxLike, b: BoxLike): BoxLike | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function countMaskPixels(mask: boolean[][], box: BoxLike): number {
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

function isPointInsideAnyBox(x: number, y: number, boxes: BoxLike[]): boolean {
  return boxes.some((box) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height);
}

function countRoiPixelsWithDynamicMask(
  mask: boolean[][],
  roiBox: BoxLike,
  dynamicBoxes: BoxLike[]
): { rawDiffPixels: number; structuralDiffPixels: number; dynamicMaskedPixels: number; structuralTotalPixels: number } {
  let rawDiffPixels = 0;
  let structuralDiffPixels = 0;
  let dynamicMaskedPixels = 0;
  const maxY = Math.min(mask.length, roiBox.y + roiBox.height);
  for (let y = Math.max(0, roiBox.y); y < maxY; y++) {
    const row = mask[y];
    const maxX = Math.min(row.length, roiBox.x + roiBox.width);
    for (let x = Math.max(0, roiBox.x); x < maxX; x++) {
      const isDynamic = dynamicBoxes.some((box) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height);
      if (row[x]) {
        rawDiffPixels++;
        if (!isDynamic) structuralDiffPixels++;
      }
      if (isDynamic) dynamicMaskedPixels++;
    }
  }
  const roiArea = Math.max(1, roiBox.width * roiBox.height);
  return { rawDiffPixels, structuralDiffPixels, dynamicMaskedPixels, structuralTotalPixels: Math.max(1, roiArea - dynamicMaskedPixels) };
}

async function writeStructuralRoiDiffCrop(diffImage: PNG, roiBox: BoxLike, dynamicBoxes: BoxLike[], outputPath: string): Promise<void> {
  const crop = new PNG({ width: roiBox.width, height: roiBox.height });
  for (let y = 0; y < roiBox.height; y++) {
    for (let x = 0; x < roiBox.width; x++) {
      const sourceX = roiBox.x + x;
      const sourceY = roiBox.y + y;
      const targetIdx = (crop.width * y + x) << 2;
      if (isPointInsideAnyBox(sourceX, sourceY, dynamicBoxes)) {
        crop.data[targetIdx] = 0; crop.data[targetIdx + 1] = 0; crop.data[targetIdx + 2] = 0; crop.data[targetIdx + 3] = 0;
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

function resolveRoiDynamicSubregionBox(
  subregion: NonNullable<RegionOfInterestConfig['allowedDynamicSubregions']>[number],
  roiBox: BoxLike,
  targetWidth: number,
  targetHeight: number,
  actualSourceWidth: number,
  actualSourceHeight: number
): BoxLike | null {
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

function geometryFallbackLabel(region: BoxLike, canvasWidth: number, canvasHeight: number): string {
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
  if (!floorDetection?.enabled) return { atFloor: null, floorBlockedBy: [], floorReason: 'Floor detection disabled.' };
  if (input.qualityStatus === 'not_evaluated') {
    return { atFloor: false, floorBlockedBy: [{ type: 'quality_not_evaluated', message: 'Critical UI quality was not evaluated.' }], floorReason: 'Critical UI quality was not evaluated.' };
  }
  const blockers: FloorBlocker[] = [
    ...input.criticalFailures.map((f) => ({ type: 'critical_roi_failed' as const, roiId: f.roiId, label: f.label })),
    ...input.criticalAssertionFailures.map((f) => ({ type: 'critical_visual_assertion_failed' as const, assertionId: f.assertionId, label: f.label }))
  ];
  if (blockers.length > 0) return { atFloor: false, floorBlockedBy: blockers, floorReason: 'Global diff is stable, but critical visual regions are still failing.' };
  if (input.qualityStatus === 'fail') return { atFloor: false, floorBlockedBy: [{ type: 'quality_failed', message: 'Local UI quality gates failed.' }], floorReason: 'Local UI quality gates failed.' };
  if (!input.previousReport) return { atFloor: null, floorBlockedBy: [], floorReason: 'No floor history available.' };
  const threshold = floorDetection.deltaThreshold ?? 0.0001;
  const consecutiveRuns = Math.min(Math.max(floorDetection.consecutiveRuns ?? 2, 1), 2);
  const currentDelta = input.currentDiffPercent - input.previousReport.diffPercent;
  const currentDeltaOk = Math.abs(currentDelta) < threshold;
  const previousDelta = input.runDelta?.diffPercentDelta ?? input.previousReport.delta?.diffPercentDelta;
  const previousDeltaOk = typeof previousDelta === 'number' ? Math.abs(previousDelta) < threshold : null;
  if (!currentDeltaOk) return { atFloor: false, floorBlockedBy: [], floorReason: 'Global diff still moving.' };
  if (consecutiveRuns <= 1) return { atFloor: true, floorBlockedBy: [], floorReason: 'Global diff stable across current run.' };
  if (previousDeltaOk === true) return { atFloor: true, floorBlockedBy: [], floorReason: 'Global diff stable across consecutive runs.' };
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
    return { verdict: input.actionRequired.message, globalDiffPercent: input.diffPercent, qualityStatus: input.qualityStatus, topAction: input.actionRequired.recommendedUserPrompt, canStopIterating: false };
  }
  if (input.criticalFailures.length > 0) {
    const label = input.criticalFailures[0].label ?? 'critical region';
    const structural = input.criticalFailures[0].structuralRoiDiffPercent ?? input.criticalFailures[0].diffPercent;
    const structuralText = typeof structural === 'number' ? ` Structural ROI diff is ${(structural * 100).toFixed(2)}%, likely a layout, styling, or rendering issue.` : '';
    return { verdict: `Do not accept. Critical ${label} region still differs significantly from mockup.${structuralText}`, globalDiffPercent: input.diffPercent, qualityStatus: input.qualityStatus, topAction: `Fix ${label} before considering full-screen floor.`, canStopIterating: false };
  }
  if (input.criticalAssertionFailures.length > 0) {
    const label = input.criticalAssertionFailures[0].label ?? 'critical visual assertion';
    return { verdict: `Do not accept. Critical visual assertion failed for ${label}.`, globalDiffPercent: input.diffPercent, qualityStatus: input.qualityStatus, topAction: `Fix ${label} before considering full-screen floor.`, canStopIterating: false };
  }
  if (input.qualityStatus === 'fail') {
    const excessiveMaskFailure = input.qualityFailures.find((f) => f.type === 'excessive_dynamic_masking');
    if (excessiveMaskFailure) {
      const label = excessiveMaskFailure.label ?? excessiveMaskFailure.roiId ?? 'critical ROI';
      const masked = excessiveMaskFailure.dynamicMaskedPercentOfRoi ?? 0;
      return { verdict: `Do not accept. Dynamic masking covers ${(masked * 100).toFixed(1)}% of ${label}, so the quality gate is not trustworthy.`, globalDiffPercent: input.diffPercent, qualityStatus: input.qualityStatus, topAction: `Narrow dynamic subregions in ${label}, or explicitly allow broad dynamic masking only after review.`, canStopIterating: false };
    }
    return { verdict: 'Do not accept. Local visual quality gates failed.', globalDiffPercent: input.diffPercent, qualityStatus: input.qualityStatus, topAction: input.priorityFindings[0]?.message ?? 'Review failed ROI and visual assertion details.', canStopIterating: false };
  }
  const likelyDataVariance = input.roiReports.find((roi) => roi.resolvedDynamicSubregions.length > 0 && roi.rawRoiDiffPercent > roi.maxDiffPercent && roi.structuralRoiDiffPercent <= roi.maxDiffPercent);
  if (input.status === 'fail') {
    const topAction = input.priorityFindings[0]?.message ?? 'Reduce global diff until report passes.';
    const varianceText = likelyDataVariance ? ` ${likelyDataVariance.label} has high raw ROI diff but passes structurally after narrow dynamic masking, which points to data variance; still review global diff before accepting.` : '';
    return { verdict: `Global diff still above threshold.${varianceText}`, globalDiffPercent: input.diffPercent, qualityStatus: input.qualityStatus, topAction, canStopIterating: false };
  }
  if (input.qualityStatus === 'not_evaluated') {
    const largestHotspot = input.localHotspots[0];
    const hotspotWarning = largestHotspot ? ` Global pass may be misleading: largest changed region covers ${largestHotspot.area} pixels in ${largestHotspot.fallbackLabel}.` : '';
    return { verdict: `Global pixel gate passed, but critical UI quality was not evaluated.${hotspotWarning}`, globalDiffPercent: input.diffPercent, qualityStatus: input.qualityStatus, topAction: 'Configure regionsOfInterest / visualAssertions for important components before accepting the screen.', canStopIterating: false };
  }
  if (likelyDataVariance) {
    return { verdict: `Screen acceptable by structural gates. ${likelyDataVariance.label} has high raw ROI diff but passes after narrow dynamic masking, so the remaining mismatch is likely data variance.`, globalDiffPercent: input.diffPercent, qualityStatus: input.qualityStatus, topAction: 'Keep iterating only if unmasked ROI geometry, typography, or spacing still looks wrong in the artifacts.', canStopIterating: true };
  }
  return { verdict: 'Screen acceptable by global and local gates.', globalDiffPercent: input.diffPercent, qualityStatus: input.qualityStatus, topAction: 'No blocking visual issues detected.', canStopIterating: true };
}

function buildInvalidCaptureActionRequired(): ActionRequired {
  return {
    type: 'invalid_capture', severity: 'blocking',
    message: 'Actual screenshot appears invalid or asleep.',
    recommendedUserPrompt: 'Wake and unlock the device or simulator, navigate to the target screen, and recapture before judging visual quality.',
    suggestedFixes: [
      'Wake/unlock the device or simulator and rerun capture.',
      'Verify the app is foregrounded on the target screen.',
      'If this was an intentional all-black screen, provide a valid actualImage artifact after confirming the expected UI state.'
    ]
  };
}

function buildVlmUnavailableActionRequired(): ActionRequired {
  return {
    type: 'vlm_unavailable', severity: 'blocking',
    message: 'VLM analysis was requested but no usable local model is available.',
    recommendedUserPrompt: 'VLM analysis is unavailable. Do you want me to continue with pixel/ROI-only analysis, or stop and help set up a working VLM model?',
    suggestedFixes: [
      'Start Ollama with `ollama serve`', 'Run the `vlm_health` MCP tool', 'Pull or configure a smaller vision model',
      "Set includeVlmAnalysis:false or vlmPolicy:'disabled' to proceed without VLM",
      "Set vlmPolicy:'optional' to allow non-semantic fallback"
    ]
  };
}

// ---- Main pipeline ----

export async function runPipeline(input: CompareImagesInput): Promise<DiffReport> {
  const pipelineStart = Date.now();
  const pixelmatchThreshold = input.pixelmatchThreshold ?? input.threshold ?? 0.1;
  const maxDiffPercent = input.maxDiffPercent ?? 0.001;
  const maxRegions = input.maxRegions ?? 50;
  const maxVlmRegions = input.maxVlmRegions ?? 10;
  const includeVlmAnalysis = input.includeVlmAnalysis ?? false;
  const requireVlmAnalysis = input.requireVlmAnalysis ?? false;
  const vlmPolicy = resolveVlmPolicy({ includeVlmAnalysis, requireVlmAnalysis, vlmPolicy: input.vlmPolicy });
  const shouldUseVlm = includeVlmAnalysis && vlmPolicy !== 'disabled';
  const ignoreRegions = input.ignoreRegions ?? [];
  const dataRegions = (input.dataRegions ?? []).map((r) => ({ ...r, type: r.type ?? 'data' as const }));
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
  const warnings: string[] = [];
  const vlmUnavailableWarning = 'VLM analysis was requested but unavailable. Region analysis fell back to error/fallback statuses. Run vlm_health or start Ollama.';
  let actionRequired: ActionRequired | null = null;

  // ---- Stage 0: ArtifactBuilder (image loading, resize, dir setup) ----
  const artifactBuilder = new ArtifactBuilder();
  const ctx = await artifactBuilder.build(input);
  const graph = new EvidenceGraph();

  const actualSourceWidth = ctx.actualSourceWidth;
  const actualSourceHeight = ctx.actualSourceHeight;
  const targetWidth = ctx.expectedPng.width;
  const targetHeight = ctx.expectedPng.height;

  // VLM availability (legacy VLM path — preserved for backward compat)
  let vlmAvailability: VlmAvailability = {
    requested: shouldUseVlm,
    usable: false,
    selectedModel: shouldUseVlm ? (input.vlmConfig?.model ?? null) : null
  };
  let vlmPreflight = input.vlmPreflight;
  let vlmSummary: import('../types').VlmSummary | undefined;
  let resolvedVlmConfig: import('../vlm/ollama').ResolvedOllamaConfig | undefined;

  if (shouldUseVlm) {
    const { preflightOllama, resolveOllamaConfig } = await import('../vlm/ollama');
    resolvedVlmConfig = input.vlmConfig ?? resolveOllamaConfig();
    if (!vlmPreflight) vlmPreflight = await preflightOllama(resolvedVlmConfig, true);
    vlmAvailability = {
      requested: true,
      usable: vlmPreflight.available,
      selectedModel: vlmPreflight.selectedModel ?? resolvedVlmConfig.model,
      reason: vlmPreflight.available ? undefined : (vlmPreflight.failureReason ?? 'unknown'),
      message: vlmPreflight.available ? undefined : (vlmPreflight.failureMessage ?? 'VLM analysis was requested but no usable local model is available.')
    };
    vlmSummary = {
      requested: true, required: vlmPolicy === 'required', provider: 'ollama' as const,
      baseUrl: vlmPreflight.baseUrl, selectedModel: vlmPreflight.selectedModel, fallbackUsed: vlmPreflight.fallbackUsed,
      healthStatus: vlmPreflight.healthStatus, warnings: [...vlmPreflight.warnings]
    };
    warnings.push(...vlmPreflight.warnings);
    if (!vlmPreflight.available) {
      if (vlmPolicy === 'required') throw new Error('VLM analysis is required but no configured Ollama model could be loaded. Run vlm_health for details.');
      if (vlmPolicy === 'ask_user') { actionRequired = buildVlmUnavailableActionRequired(); }
      else { warnings.push(vlmUnavailableWarning); }
      vlmSummary.warnings.push(vlmUnavailableWarning);
    }
  }

  // Normalize regions
  const normalizeRegion = (region: IgnoreRegion): IgnoreRegion => {
    const coordinateSpace = region.coordinateSpace ?? 'expected';
    const sourceWidth = coordinateSpace === 'actual' ? actualSourceWidth : targetWidth;
    const sourceHeight = coordinateSpace === 'actual' ? actualSourceHeight : targetHeight;
    return {
      ...region,
      ...normalizeBox(region, targetWidth, targetHeight, coordinateSpace, sourceWidth, sourceHeight),
      coordinateSpace: 'expected' as const
    };
  };
  const normalizedIgnoreRegions = explicitMaskRegions.map(normalizeRegion);
  const normalizedAutoMaskedRegions = autoMaskedRegions.map(normalizeRegion);

  const normalizedRois = regionsOfInterestInput.map((roi) => ({
    ...roi,
    box: normalizeBox(
      roi.box, targetWidth, targetHeight,
      roi.coordinateSpace ?? 'expected',
      roi.coordinateSpace === 'actual' ? actualSourceWidth : targetWidth,
      roi.coordinateSpace === 'actual' ? actualSourceHeight : targetHeight
    ),
    coordinateSpace: 'expected' as const
  }));
  const normalizedAppContentBounds = input.appContentBounds
    ? normalizeBox(input.appContentBounds, targetWidth, targetHeight, input.appContentBounds.coordinateSpace ?? 'expected', input.appContentBounds.coordinateSpace === 'actual' ? actualSourceWidth : targetWidth, input.appContentBounds.coordinateSpace === 'actual' ? actualSourceHeight : targetHeight)
    : null;

  // Data mask / auto mask overlap warnings (original logic)
  for (const dataMask of normalizedIgnoreRegions.filter((r) => r.type === 'data')) {
    for (const roi of normalizedRois.filter((roi) => roi.critical)) {
      if (boxesIntersect(dataMask, roi.box)) {
        warnings.push(`Data mask overlaps critical ROI '${roi.label}'. Verify this is intentional.`);
      }
    }
  }
  for (const autoMask of normalizedAutoMaskedRegions) {
    for (const roi of normalizedRois.filter((roi) => roi.critical)) {
      if (boxesIntersect(autoMask, roi.box)) {
        warnings.push(`Auto mask overlaps critical ROI '${roi.label}'. Review autoIgnore settings before accepting this run.`);
      }
    }
  }

  // ---- Stage 0.5: ReferenceContextAnalyzer (load source facts before any deterministic analysis) ----
  const referenceContextInput = input.referenceContext;
  const refCtxAnalyzer = new ReferenceContextAnalyzer(referenceContextInput);
  const refCtxResult = await refCtxAnalyzer.run(ctx, graph) as any;
  warnings.push(...(refCtxResult.warnings ?? []));
  const referenceContextSummary = refCtxResult.referenceContextSummary;

  // ---- Stage 0.75: Flutter anchor resolution ----
  // Loads the semantic target map and anchor dump, resolves targets to physical
  // pixel rects, and injects flutter_anchor rects as overlapLegibility regions.
  // Must run before Stage 1c so OverlapLegibilityAnalyzer sees the injected regions.
  let targetResolutionSummary: import('../flutter/types').TargetResolutionSummary | undefined;
  if (input.targetMapPath || input.flutterAnchorsPath) {
    try {
      const { parseFlutterAnchorDump } = await import('../flutter/anchorDumpParser');
      const { resolveTargets } = await import('../flutter/targetResolver');
      const { semanticTargetMapSchema } = await import('../flutter/semanticTargetMap');
      const { waitForAnchorArtifact } = await import('../flutter/anchorArtifactReader');
      const { resolveAbsolutePath: resolveAbs } = await import('../utils/fs');

      let targetMap: import('../flutter/semanticTargetMap').SemanticTargetMapParsed | null = null;
      if (input.targetMapPath) {
        const raw = JSON.parse(await fs.readFile(resolveAbs(input.targetMapPath), 'utf-8'));
        const result = semanticTargetMapSchema.safeParse(raw);
        if (!result.success) {
          warnings.push(`targetMapPath: invalid semantic target map — ${result.error.issues[0]?.message ?? 'schema error'}. Flutter anchor resolution skipped.`);
        } else {
          targetMap = result.data;
        }
      }

      let anchorDump: import('../flutter/types').ParsedAnchorDump | null = null;
      if (input.flutterAnchorsPath && targetMap) {
        const artifact = await waitForAnchorArtifact({
          artifactDir: resolveAbs(input.flutterAnchorsPath),
          timeoutMs: 30000,
          pollIntervalMs: 500
        });
        if (artifact.status !== 'ready' || !artifact.parsed) {
          warnings.push(`flutterAnchorsPath: anchor artifact not ready (${artifact.status}). Flutter anchor resolution skipped.`);
        } else {
          anchorDump = artifact.parsed;
        }
      }

      if (targetMap && anchorDump) {
        const resolution = resolveTargets(targetMap, anchorDump);
        targetResolutionSummary = resolution;

        const anchorOverlapRegions: NonNullable<CompareImagesInput['overlapLegibility']>['regions'] = [];
        for (const resolved of resolution.results) {
          if (resolved.source !== 'flutter_anchor' || !resolved.rect) continue;
          const target = targetMap.targets.find((t) => t.id === resolved.targetId);
          if (!target) continue;
          for (const criterion of target.criteria) {
            if (criterion.domain !== 'legibility.overlap') continue;
            anchorOverlapRegions!.push({
              id: criterion.id,
              box: resolved.rect,
              coordinateSpace: 'expected',
              avoidColors: criterion.avoidColors,
              minClearancePx: criterion.minClearancePx,
              maxOverlapPercent: criterion.maxOverlapPercent,
              severity: criterion.severity
            });
          }
        }

        if (anchorOverlapRegions.length > 0) {
          const existingOverlap = ctx.config.overlapLegibility ?? {};
          const existingRegions = existingOverlap.regions ?? [];
          (ctx.config as any).overlapLegibility = {
            ...existingOverlap,
            enabled: true,
            regions: [...existingRegions, ...anchorOverlapRegions]
          };
        }
      }
    } catch (err: any) {
      warnings.push(`Flutter anchor resolution failed: ${err?.message ?? String(err)}`);
    }
  }

  // ---- Stage 1a: InvalidCaptureAnalyzer (must run first to gate everything) ----
  const invalidCaptureAnalyzer = new InvalidCaptureAnalyzer();
  const invalidCaptureResult = await invalidCaptureAnalyzer.run(ctx, graph);
  warnings.push(...invalidCaptureResult.warnings);
  const isInvalidCapture = graph.getAll().some((e) => e.source === 'invalidCapture' && e.claimId === 'invalid-capture-detected' && !e.blocked);
  if (isInvalidCapture) actionRequired = buildInvalidCaptureActionRequired();

  // ---- Stage 1b: PixelDiffAnalyzer (must run before ROI analyzers) ----
  const pixelDiffStart = Date.now();
  const pixelDiffAnalyzer = new PixelDiffAnalyzer();
  const pixelDiffResult = await pixelDiffAnalyzer.run(ctx, graph);
  const pixelDiffMs = Date.now() - pixelDiffStart;
  warnings.push(...pixelDiffResult.warnings);
  const pixelDiff = (ctx as any)[PIXEL_DIFF_KEY] as PixelDiffResult;
  if (!pixelDiff) throw new Error('PixelDiffAnalyzer did not produce results');

  // ---- Stage 1b.5: Generate ROI crops so Stage 1c analyzers can read them ----
  for (const roi of normalizedRois) {
    const expCrop = path.join(ctx.roiDir, `${roi.id}-expected.png`);
    const actCrop = path.join(ctx.roiDir, `${roi.id}-actual.png`);
    const diffCrop = path.join(ctx.roiDir, `${roi.id}-diff.png`);
    await Promise.all([
      cropAndSave(pixelDiff.processedExpectedPath, roi.box, expCrop),
      cropAndSave(pixelDiff.processedActualPath, roi.box, actCrop),
      cropAndSave(pixelDiff.diffAbsPath, roi.box, diffCrop)
    ]);
  }

  // ---- Stage 1c: Remaining deterministic analyzers in parallel ----
  const stage1cStart = Date.now();
  const remainingStage1: IAnalyzer[] = [
    new DynamicMaskAnalyzer(),
    new RadialGeometryAnalyzer(),
    new ColorSamplerAnalyzer(),
    new TextOcrAnalyzer(),
    new OverlapLegibilityAnalyzer()
  ];
  const visualCaveats: VisualCaveat[] = [];
  let overlapLegibilitySummary: import('../types').OverlapLegibilitySummary | undefined;
  const remainingResults = await Promise.all(remainingStage1.map((a) => a.run(ctx, graph)));
  const perAnalyzerMs: Record<string, number> = {};
  for (let i = 0; i < remainingStage1.length; i++) {
    perAnalyzerMs[remainingStage1[i].name] = remainingResults[i].durationMs;
  }
  let criterionAuditBundles: import('../types').CriterionAuditBundle[] = [];
  let criterionJudgesSummaryData: CriterionJudgesSummary | undefined;
  for (const r of remainingResults) {
    warnings.push(...r.warnings);
    if (r.visualCaveats) visualCaveats.push(...r.visualCaveats);
    if (r.overlapLegibilitySummary) overlapLegibilitySummary = r.overlapLegibilitySummary;
    if (r.criterionAuditBundles) criterionAuditBundles.push(...r.criterionAuditBundles);
  }

  // ---- Inline ROI quality analysis (faithful port from original compareImages.ts) ----
  const roiCropArtifacts: RegionOfInterestReport[] = [];
  const dynamicMaskQualityFailures: QualityFailure[] = [];
  const dynamicMaskQualityWarnings: string[] = [];
  const nonCriticalRoiQualityWarnings: string[] = [];

  for (const roi of normalizedRois) {
    const expCrop = path.join(ctx.roiDir, `${roi.id}-expected.png`);
    const actCrop = path.join(ctx.roiDir, `${roi.id}-actual.png`);
    const diffCrop = path.join(ctx.roiDir, `${roi.id}-diff.png`);
    const structuralDiffCrop = path.join(ctx.roiDir, `${roi.id}-structural-diff.png`);
    // Basic ROI crops already written in Stage 1b.5 — only write structural diff here

    const resolvedDynamicSubregions = (roi.allowedDynamicSubregions ?? [])
      .map((subregion) => {
        const box = resolveRoiDynamicSubregionBox(subregion, roi.box, targetWidth, targetHeight, actualSourceWidth, actualSourceHeight);
        if (!box) return null;
        return { id: subregion.id, label: subregion.label, reason: subregion.reason, coordinateSpace: 'expected' as const, box };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    const resolvedDynamicBoxes = resolvedDynamicSubregions.map((s) => s.box);
    await writeStructuralRoiDiffCrop(pixelDiff.diffImage, roi.box, resolvedDynamicBoxes, structuralDiffCrop);

    const roiDynamicBoxes = resolvedDynamicBoxes.map((box) => ({ x: box.x - roi.box.x, y: box.y - roi.box.y, width: box.width, height: box.height }));
    const totalPixelsInRoiRaw = Math.max(1, roi.box.width * roi.box.height);
    const roiPixelCounts = countRoiPixelsWithDynamicMask(pixelDiff.mismatchMask, roi.box, resolvedDynamicBoxes);
    const diffPixelsInRoi = roiPixelCounts.structuralDiffPixels;
    const totalPixelsInRoi = roiPixelCounts.structuralTotalPixels;
    const rawRoiDiffPercent = roiPixelCounts.rawDiffPixels / totalPixelsInRoiRaw;
    const structuralRoiDiffPercent = diffPixelsInRoi / totalPixelsInRoi;
    const dynamicMaskedPercentOfRoi = roiPixelCounts.dynamicMaskedPixels / totalPixelsInRoiRaw;
    const intersectingRegionIds: string[] = [];
    const maxDiffPercentForRoi = roi.maxDiffPercent ?? maxDiffPercent;
    const status: 'pass' | 'fail' = structuralRoiDiffPercent <= maxDiffPercentForRoi ? 'pass' : 'fail';

    if ((roi.critical ?? false) === false && status === 'fail') {
      nonCriticalRoiQualityWarnings.push(`Non-critical ROI '${roi.label}' failed local diff threshold while qualityStatus remains pass. Review the ROI before accepting visual parity.`);
    }

    const diagnostics = status === 'fail'
      ? ['Structural ROI diff exceeds maxDiffPercent.', `Large unmasked local mismatch in ${roi.label} even though global diff may be stable.`]
      : ['ROI within local diff threshold.'];

    if (resolvedDynamicSubregions.length > 0) {
      diagnostics.push(`Raw ROI diff ${(rawRoiDiffPercent * 100).toFixed(2)}%; structural ROI diff ${(structuralRoiDiffPercent * 100).toFixed(2)}% after dynamic subregion masking.`);
      if (rawRoiDiffPercent > maxDiffPercentForRoi && structuralRoiDiffPercent <= maxDiffPercentForRoi) {
        diagnostics.push('High raw ROI diff with passing structural diff suggests live data variance rather than structural UI drift.');
      }
    }

    if ((roi.critical ?? false) && dynamicMaskedPercentOfRoi > 0.25) {
      const warning = `Dynamic subregions mask ${(dynamicMaskedPercentOfRoi * 100).toFixed(1)}% of critical ROI '${roi.label}'. Keep masks narrow so structural defects remain visible.`;
      diagnostics.push(warning); warnings.push(warning); dynamicMaskQualityWarnings.push(warning);
    }
    if (dynamicMaskedPercentOfRoi > 0.40) {
      const roiImportance = (roi.critical ?? false) ? 'critical' : 'non-critical';
      const warning = `Excessive dynamic masking covers ${(dynamicMaskedPercentOfRoi * 100).toFixed(1)}% of ${roiImportance} ROI '${roi.label}'. Quality gate is not trustworthy without allowBroadDynamicSubregions:true.`;
      diagnostics.push(warning); warnings.push(warning); dynamicMaskQualityWarnings.push(warning);
      if ((roi.critical ?? false) && roi.allowBroadDynamicSubregions !== true) {
        dynamicMaskQualityFailures.push({ type: 'excessive_dynamic_masking', roiId: roi.id, label: roi.label, diffPercent: structuralRoiDiffPercent, rawRoiDiffPercent, structuralRoiDiffPercent, dynamicMaskedPercentOfRoi, maxDiffPercent: maxDiffPercentForRoi });
      }
    }

    // Radial geometry diagnostics (run inline for full result including artifacts)
    let geometryDiagnostics: RegionOfInterestReport['geometryDiagnostics'];
    if (roi.geometryDiagnostics?.type === 'radialChart' && roi.geometryDiagnostics.enabled) {
      try {
        geometryDiagnostics = await runRadialChartDiagnostics({
          roiId: roi.id, expectedCropPath: expCrop, actualCropPath: actCrop,
          outputDir: ctx.roiDir, config: roi.geometryDiagnostics, dynamicSubregions: roiDynamicBoxes
        });
        diagnostics.push(`Radial chart geometry diagnostics ${geometryDiagnostics.status}: ${geometryDiagnostics.verdict}. ${geometryDiagnostics.agentHint}`);
        for (const w of geometryDiagnostics.warnings) warnings.push(`ROI '${roi.label}' radial geometry warning: ${w}`);
      } catch (err: any) {
        const w = `ROI '${roi.label}' radial geometry diagnostics failed: ${err?.message ?? String(err)}`;
        warnings.push(w); diagnostics.push(w);
      }
    }
    const geometryArtifacts = geometryDiagnostics?.artifacts;

    // Emit ROI quality evidence to graph
    graph.add({
      source: 'roiQuality', claimId: `roi-quality-${roi.id}`, subject: `roi:${roi.id}`,
      claim: `ROI '${roi.label}' structural diff is ${(structuralRoiDiffPercent * 100).toFixed(4)}% (${status})`,
      confidence: 1.0, authority: 'deterministic',
      measurements: { roiId: roi.id, structuralRoiDiffPercent, rawRoiDiffPercent, dynamicMaskedPercentOfRoi, maxDiffPercent: maxDiffPercentForRoi, status, critical: roi.critical ?? false }
    });

    roiCropArtifacts.push({
      id: roi.id, label: roi.label, type: roi.type, critical: roi.critical ?? false, weight: roi.weight ?? 1,
      box: roi.box, status, diffPixels: diffPixelsInRoi, totalPixels: totalPixelsInRoi,
      diffPercent: structuralRoiDiffPercent, rawRoiDiffPercent, structuralRoiDiffPercent, dynamicMaskedPercentOfRoi,
      resolvedDynamicSubregions, diffDensity: structuralRoiDiffPercent, maxDiffPercent: maxDiffPercentForRoi,
      intersectingRegionIds, diagnostics, geometryDiagnostics, weightedScore: structuralRoiDiffPercent * (roi.weight ?? 1),
      artifacts: {
        expected: expCrop, actual: actCrop, diff: diffCrop, structuralDiff: structuralDiffCrop,
        geometryOverlay: geometryArtifacts?.geometryOverlay, edgeOverlay: geometryArtifacts?.edgeOverlay,
        expectedArcMask: geometryArtifacts?.expectedArcMask, actualArcMask: geometryArtifacts?.actualArcMask,
        polarSummary: geometryArtifacts?.polarSummary
      }
    });
  }

  // ---- Build regions from raw pixel diff ----
  let rawRegions = detectRegions(pixelDiff.mismatchMask);
  rawRegions.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const vlmCandidates = new Set(rawRegions.slice(0, maxVlmRegions));
  if (rawRegions.length > maxRegions) rawRegions = rawRegions.slice(0, maxRegions);
  rawRegions.sort((a, b) => { if (a.y !== b.y) return a.y - b.y; return a.x - b.x; });

  const regions: DiffReport['regions'] = [];
  const localHotspotCandidates: LocalHotspot[] = [];

  for (let i = 0; i < rawRegions.length; i++) {
    const box = rawRegions[i];
    const regionId = `region-${(i + 1).toString().padStart(3, '0')}`;
    const expCrop = path.join(ctx.regionsDir, `${regionId}-expected.png`);
    const actCrop = path.join(ctx.regionsDir, `${regionId}-actual.png`);
    const diffCrop = path.join(ctx.regionsDir, `${regionId}-diff.png`);

    await cropAndSave(pixelDiff.processedExpectedPath, box, expCrop);
    await cropAndSave(pixelDiff.processedActualPath, box, actCrop);
    await cropAndSave(pixelDiff.diffAbsPath, box, diffCrop);

    const intersectingRois = normalizedRois.filter((roi) => boxesIntersect(box, roi.box)).map((roi) => ({ id: roi.id, label: roi.label }));
    const classification: 'app' | 'artifact' = normalizedAppContentBounds && !boxesIntersect(box, normalizedAppContentBounds) ? 'artifact' : 'app';
    const actionable = classification === 'app';
    const fallbackLabel = intersectingRois[0]?.label ?? geometryFallbackLabel(box, targetWidth, targetHeight);
    const fallbackDescription = intersectingRois.length > 0
      ? `This changed region intersects the configured ROI '${intersectingRois[0].label}'. Local component diff should be reviewed even without VLM.`
      : geometryFallbackDescription(fallbackLabel);

    // VLM analysis (legacy path — only runs if shouldUseVlm and preflight available)
    let analysis: import('../types').VlmAnalysis | null = null;
    let analysisStatus: 'skipped' | 'ok' | 'fallback' | 'error' = 'skipped';

    if (shouldUseVlm && !isInvalidCapture && vlmCandidates.has(box) && vlmPreflight) {
      const { explainDiffUsingOllama, resolveOllamaConfig } = await import('../vlm/ollama');
      const vlmConfig = resolvedVlmConfig ?? input.vlmConfig ?? resolveOllamaConfig();
      if (vlmPreflight.available && vlmPreflight.selectedModel) {
        const ollamaResult = await explainDiffUsingOllama(expCrop, actCrop, diffCrop, {
          baseUrl: vlmConfig.baseUrl, model: vlmPreflight.selectedModel, timeoutMs: vlmConfig.timeoutMs, keepAlive: vlmConfig.keepAlive
        });
        analysis = ollamaResult.analysis;
        analysisStatus = ollamaResult.status;
      } else {
        analysis = { type: 'unknown', severity: 'medium', description: vlmPreflight?.failureMessage ?? 'VLM unavailable. Inspect the crop manually.', likelyFix: 'Inspect the crop manually.' };
        analysisStatus = 'fallback';
      }
    }

    regions.push({
      id: regionId, box, area: box.width * box.height, actionable, classification,
      cropPaths: { expected: expCrop, actual: actCrop, diff: diffCrop },
      analysisStatus, analysis, fallbackLabel, fallbackDescription,
      intersectingRois: intersectingRois.map((roi) => roi.id)
    });

    const area = box.width * box.height;
    const diffDensity = countMaskPixels(pixelDiff.mismatchMask, box) / Math.max(1, area);
    const areaPercent = area / Math.max(1, pixelDiff.totalPixels);
    if (actionable && hotspotDetection.enabled && areaPercent >= hotspotDetection.minAreaPercent && diffDensity >= hotspotDetection.minDiffDensity) {
      localHotspotCandidates.push({ regionId, area, box, diffDensity, fallbackLabel, message: 'Large local mismatch remains despite global status.' });
    }
  }

  const localHotspots = localHotspotCandidates
    .sort((a, b) => { const d = b.area - a.area; return d !== 0 ? d : b.diffDensity - a.diffDensity; })
    .slice(0, hotspotDetection.maxHotspots);

  const artifactRegions = regions.filter((r) => r.actionable === false || r.classification === 'artifact');
  const actionableRegionCount = regions.filter((r) => r.actionable !== false).length;

  // ---- Quality evaluation (faithful port) ----
  const criticalRoiFailures: QualityFailure[] = roiCropArtifacts
    .map((roi, index) => ({ roi, index }))
    .filter(({ roi }) => roi.critical && roi.status === 'fail')
    .sort((a, b) => { const d = b.roi.weight - a.roi.weight; return d !== 0 ? d : a.index - b.index; })
    .map(({ roi }) => ({ type: 'critical_roi_failed' as const, roiId: roi.id, label: roi.label, diffPercent: roi.diffPercent, rawRoiDiffPercent: roi.rawRoiDiffPercent, structuralRoiDiffPercent: roi.structuralRoiDiffPercent, dynamicMaskedPercentOfRoi: roi.dynamicMaskedPercentOfRoi, maxDiffPercent: roi.maxDiffPercent }));

  const visualAssertions: VisualAssertionResult[] = visualAssertionsInput.map((assertion) => {
    if (assertion.type !== 'roiMaxDiffPercent') {
      return { id: assertion.id, status: 'pass' as const, severity: assertion.severity, message: assertion.message, maxDiffPercent: assertion.maxDiffPercent };
    }
    const roi = roiCropArtifacts.find((r) => r.id === assertion.roiId);
    if (!roi) {
      warnings.push(`Visual assertion '${assertion.id}' references unknown ROI '${assertion.roiId}'.`);
      return { id: assertion.id, status: 'fail' as const, severity: assertion.severity, message: assertion.message, maxDiffPercent: assertion.maxDiffPercent };
    }
    const actualDiffPercent = roi.diffPercent;
    const assertionStatus: 'pass' | 'fail' = actualDiffPercent <= assertion.maxDiffPercent ? 'pass' : 'fail';
    return { id: assertion.id, status: assertionStatus, severity: assertion.severity, message: assertion.message, actualDiffPercent, metricUsed: 'structuralRoiDiffPercent' as const, rawRoiDiffPercent: roi.rawRoiDiffPercent, structuralRoiDiffPercent: roi.structuralRoiDiffPercent, dynamicMaskedPercentOfRoi: roi.dynamicMaskedPercentOfRoi, maxDiffPercent: assertion.maxDiffPercent };
  });

  const criticalAssertionFailures: QualityFailure[] = visualAssertions
    .filter((a) => a.severity === 'critical' && a.status === 'fail')
    .map((a) => {
      const roiId = visualAssertionsInput.find((vi) => vi.id === a.id)?.roiId;
      const roi = roiCropArtifacts.find((r) => r.id === roiId);
      return { type: 'critical_visual_assertion_failed' as const, assertionId: a.id, label: roiId, diffPercent: a.actualDiffPercent, rawRoiDiffPercent: roi?.rawRoiDiffPercent, structuralRoiDiffPercent: roi?.structuralRoiDiffPercent, dynamicMaskedPercentOfRoi: roi?.dynamicMaskedPercentOfRoi, maxDiffPercent: a.maxDiffPercent };
    });

  const invalidCaptureQualityFailures: QualityFailure[] = isInvalidCapture
    ? [{ type: 'invalid_capture' as const, label: 'actual screenshot', diffPercent: pixelDiff.diffPercent }]
    : [];

  const qualityFailures: QualityFailure[] = [...invalidCaptureQualityFailures, ...criticalRoiFailures, ...criticalAssertionFailures, ...dynamicMaskQualityFailures];

  const hasQualityEvaluationConfig = regionsOfInterestInput.length > 0 || visualAssertionsInput.length > 0;
  const qualityWarnings = hasQualityEvaluationConfig
    ? []
    : ['No regionsOfInterest or visualAssertions configured. Global pixel status does not prove visual parity.'];
  qualityWarnings.push(...dynamicMaskQualityWarnings);
  if (isInvalidCapture) qualityWarnings.push('Actual screenshot appears invalid or asleep. Recapture before trusting ROI, VLM, or quality analysis.');
  if (actionRequired?.type === 'vlm_unavailable') qualityWarnings.push('VLM analysis was requested but unavailable. Ask the user whether to continue without semantic analysis.');

  let qualityStatus: 'pass' | 'fail' | 'not_evaluated' = isInvalidCapture
    ? 'fail'
    : !hasQualityEvaluationConfig
    ? 'not_evaluated'
    : qualityFailures.length > 0 ? 'fail' : 'pass';

  if (qualityStatus === 'pass') qualityWarnings.push(...nonCriticalRoiQualityWarnings);

  // ---- Stage 1.5: Evidence bundles ----
  const bundleBuilder = new EvidenceBundleBuilder();
  const bundles = bundleBuilder.build(ctx, graph);

  // ---- Stage 2: Model judges (policy-controlled) ----
  const modelJudgesInput = input.modelJudges as ModelJudgesConfig | undefined;
  const visualAuditMode = input.visualAuditMode ?? 'visual_parity';

  // visual_parity mode requires judges — hard fail when judges are disabled without explicitSkipReason,
  // when modelJudges is completely absent, or when enabled but missing API keys (handled in ModelJudgeAnalyzer).
  if (visualAuditMode === 'visual_parity' && !actionRequired) {
    const judgesEnabled = modelJudgesInput?.enabled ?? false;
    const hasExplicitSkip = modelJudgesInput?.enabled === false && !!modelJudgesInput?.explicitSkipReason;
    const judgesConfigured = modelJudgesInput !== undefined;
    if (judgesConfigured && !judgesEnabled && !hasExplicitSkip) {
      actionRequired = {
        type: 'model_judges_unavailable',
        severity: 'blocking',
        message: 'visualAuditMode is visual_parity but model judges are disabled without an explicitSkipReason.',
        recommendedUserPrompt: 'Configure modelJudges with enabled:true and provider API keys, or set visualAuditMode:metric_only to opt out of judge requirement.',
        suggestedFixes: [
          'Add modelJudges config with enabled:true and a provider',
          "Set visualAuditMode:'metric_only' to skip the judge requirement",
          "Set modelJudges.enabled:false with explicitSkipReason to explicitly declare a metric-only run"
        ]
      };
    } else if (!judgesConfigured) {
      actionRequired = {
        type: 'model_judges_unavailable',
        severity: 'blocking',
        message: 'visualAuditMode is visual_parity but no model judges are configured.',
        recommendedUserPrompt: 'Configure modelJudges with enabled:true and provider API keys, or set visualAuditMode:metric_only to opt out of judge requirement.',
        suggestedFixes: [
          'Add modelJudges config with enabled:true and a provider',
          "Set visualAuditMode:'metric_only' to skip the judge requirement",
          "Set modelJudges.enabled:false with explicitSkipReason to explicitly declare a metric-only run"
        ]
      };
    }
  }

  let judgeHadSuccessfulResults: boolean | undefined;
  let modelJudgesMs: number | undefined;
  let judgeProviderRunSummary: import('./types').JudgeProviderRunSummary | undefined;
  let judgeProviderErrors: import('./types').JudgeProviderError[] | undefined;
  // Default vlmPolicy to 'disabled' when model judges are the primary analysis path
  const effectiveVlmPolicy = vlmPolicy === 'ask_user' && modelJudgesInput?.enabled
    ? 'optional'
    : vlmPolicy;
  // Invalid capture must short-circuit before model judges — never spend time judging a black screenshot.
  if (modelJudgesInput?.enabled && !isInvalidCapture) {
    const judgesStart = Date.now();
    const judgeAnalyzer = new ModelJudgeAnalyzer(modelJudgesInput, visualAuditMode);
    const judgeResult = await judgeAnalyzer.run(ctx, graph, bundles);
    modelJudgesMs = Date.now() - judgesStart;
    warnings.push(...judgeResult.warnings);
    judgeHadSuccessfulResults = judgeResult.judgeHadSuccessfulResults;
    judgeProviderRunSummary = judgeResult.judgeProviderRunSummary;
    judgeProviderErrors = judgeResult.judgeProviderErrors;
    // Provider errors are separate from visual evidence — they must not be treated as visual claims.
    // If required judges had only errors and no successful results, judgeResult.actionRequired is already set.
    if (judgeResult.actionRequired && !actionRequired) {
      actionRequired = judgeResult.actionRequired;
    }
    if (judgeResult.visualCaveats) visualCaveats.push(...judgeResult.visualCaveats);
    // Log provider errors as warnings so they appear in the report
    for (const pe of judgeResult.judgeProviderErrors ?? []) {
      warnings.push(`Judge provider error [${pe.provider}/${pe.roiId}]: ${pe.message}`);
    }
  } else if (modelJudgesInput?.enabled === false && !modelJudgesInput?.explicitSkipReason) {
    warnings.push('Model judges disabled without explicitSkipReason. Set explicitSkipReason to confirm metric-only mode, or enable judges for visual parity.');
  }

  // ---- Stage 2.5: Criterion audit judges for overlap legibility regions ----
  // Runs after the main ModelJudgeAnalyzer. Both primary and reviewer validate that each
  // configured box covers the intended target element before trusting the deterministic measurement.
  if (criterionAuditBundles.length > 0 && modelJudgesInput?.enabled && !isInvalidCapture) {
    const primaryCfg = (modelJudgesInput as any).primary as { provider: 'openrouter' | 'nvidia'; model: string } | undefined;
    const reviewerCfg = (modelJudgesInput as any).reviewer as { provider: 'openrouter' | 'nvidia'; model: string } | undefined;
    const timeoutMs = (modelJudgesInput as any).timeoutMs ?? 45000;
    const maxRetries = (modelJudgesInput as any).maxRetries ?? 1;
    const retryOnParseError = (modelJudgesInput as any).retryOnParseError !== false;
    const isRequired = (modelJudgesInput as any).required !== false;

    const primaryCriterionProvider = primaryCfg ? buildCriterionProvider(primaryCfg, timeoutMs, maxRetries, retryOnParseError) : null;
    const reviewerCriterionProvider = reviewerCfg ? buildCriterionProvider(reviewerCfg, timeoutMs, maxRetries, retryOnParseError) : null;

    // visual_parity + required: hard-fail when criterion audit cannot run.
    // Override model_judges_failed if criterion audit availability is the root cause — both are
    // blocking but the criterion message is more specific about what needs fixing.
    const criterionAuditPreflightBlocked = actionRequired?.type === 'model_judges_failed' || !actionRequired;
    if (visualAuditMode === 'visual_parity' && isRequired && criterionAuditPreflightBlocked) {
      const primaryCanAudit = primaryCriterionProvider?.analyzeCriterion != null;
      const reviewerCanAudit = !reviewerCfg || reviewerCriterionProvider?.analyzeCriterion != null;
      if (!primaryCanAudit || !reviewerCanAudit) {
        const which = !primaryCanAudit ? 'primary' : 'reviewer';
        actionRequired = {
          type: 'invalid_overlap_target',
          severity: 'blocking',
          message: `visualAuditMode is visual_parity and modelJudges.required is true, but the ${which} provider does not support criterion audit (analyzeCriterion). Overlap legibility targets cannot be validated.`,
          recommendedUserPrompt: 'Configure a provider that supports criterion-specific judging (OpenRouter or NVIDIA with valid API key), or set visualAuditMode:metric_only to opt out of criterion audit.',
          suggestedFixes: [
            `Set ${which === 'primary' ? 'OPENROUTER_API_KEY or NVIDIA_API_KEY' : 'reviewer API key'} environment variable`,
            "Set visualAuditMode:'metric_only' to skip the criterion audit requirement"
          ]
        };
      }
    }

    if (primaryCriterionProvider && overlapLegibilitySummary) {
      const criterionAnalyzer = new CriterionJudgeAnalyzer();
      const criterionResults = await criterionAnalyzer.run(
        criterionAuditBundles,
        primaryCriterionProvider,
        reviewerCriterionProvider ?? undefined
      );

      const summaryEntries: CriterionJudgeSummaryEntry[] = [];

      overlapLegibilitySummary = {
        enabled: true,
        regions: overlapLegibilitySummary.regions.map((region) => {
          const dual = criterionResults.get(region.id);
          if (!dual) return region;
          const { primary, reviewer, final } = dual;
          const invalidTarget = final.targetStatus === 'not_matched' || final.targetStatus === 'ambiguous';

          const bundle = criterionAuditBundles.find((b) => b.criterionId === region.id);
          const artifactPathsSent = bundle ? Object.values(bundle.artifacts).filter(Boolean) as string[] : [];

          summaryEntries.push({
            criterionId: region.id,
            attempted: primary.judgeAuditStatus !== 'not_run',
            hadSuccess: primary.targetStatus !== 'ambiguous' && primary.judgeAuditStatus !== 'unavailable' && primary.judgeAuditStatus !== 'not_run',
            errorCount: (primary.judgeAuditStatus === 'unavailable' ? 1 : 0) + (reviewer?.judgeAuditStatus === 'unavailable' ? 1 : 0),
            primaryTargetStatus: primary.targetStatus,
            reviewerTargetStatus: reviewer?.targetStatus,
            finalTargetStatus: final.targetStatus,
            finalMeasurementStatus: invalidTarget ? 'not_evaluated' : region.measurementStatus,
            finalJudgeAuditStatus: final.judgeAuditStatus,
            artifactPathsSent
          });

          return {
            ...region,
            targetStatus: final.targetStatus,
            judgeAuditStatus: final.judgeAuditStatus,
            measurementStatus: invalidTarget ? ('not_evaluated' as const) : region.measurementStatus,
            status: invalidTarget ? ('invalid_target' as const) : region.status,
            primaryCriterionResult: primary,
            ...(reviewer ? { reviewerCriterionResult: reviewer } : {})
          };
        })
      };

      criterionJudgesSummaryData = {
        totalRegions: criterionAuditBundles.length,
        attempted: summaryEntries.filter((e) => e.attempted).length,
        hadSuccess: summaryEntries.some((e) => e.hadSuccess),
        errorCount: summaryEntries.reduce((sum, e) => sum + e.errorCount, 0),
        entries: summaryEntries
      };

      // visual_parity + required: not_checked after audit ran means criterion could not run
      if (visualAuditMode === 'visual_parity' && isRequired && !actionRequired) {
        const notChecked = overlapLegibilitySummary.regions.filter(
          (r) => r.targetStatus === 'not_checked' && r.checked
        );
        if (notChecked.length > 0) {
          const ids = notChecked.map((r) => `'${r.id}'`).join(', ');
          actionRequired = {
            type: 'invalid_overlap_target',
            severity: 'blocking',
            message: `visual_parity mode requires criterion audit for all regions, but ${ids} could not be audited (targetStatus: not_checked). Criterion audit was skipped or unavailable.`,
            recommendedUserPrompt: 'Ensure provider API keys are set and criterion audit is supported, or set visualAuditMode:metric_only to opt out.',
            suggestedFixes: [
              'Set OPENROUTER_API_KEY or NVIDIA_API_KEY environment variable',
              "Set visualAuditMode:'metric_only' to skip the criterion audit requirement"
            ]
          };
        }
      }
    }
  }

  // ---- Stage 3: Conflict resolution (runs before audit status so blocked caveats are filtered out) ----
  const conflictResolver = new ConflictResolver(referenceContextInput);
  const conflictResult = conflictResolver.resolve(graph);
  warnings.push(...conflictResult.warnings);

  // Remove caveats whose underlying evidence was blocked by ConflictResolver — blocked claims must not
  // drive visualAuditStatus or appear in the report's visualCaveats list.
  const effectiveVisualCaveats = visualCaveats.filter((c) => !conflictResult.blockedClaimIds.includes(c.id));

  // Build blockedModelFindings for the report — maps each blocked claim to the warning that explains why
  const blockedModelFindings: Array<{ claimId: string; reason: string; sourceFact?: string }> =
    conflictResult.blockedClaimIds.map((claimId) => {
      const warning = conflictResult.warnings.find((w) => w.includes(`'${claimId}'`)) ?? `Blocked by ConflictResolver`;
      const sourceMatch = warning.match(/source fact '([^']+)'/);
      return { claimId, reason: warning, ...(sourceMatch ? { sourceFact: sourceMatch[1] } : {}) };
    });

  // Compute visualAuditStatus — check actionRequired type first to avoid 'not_run' masking 'unavailable'
  let visualAuditStatus: VisualAuditStatus | undefined;
  let acceptanceStatus: AcceptanceStatus | undefined;

  if (isInvalidCapture) {
    // Invalid capture: judges never ran — visual audit is not_run, result is rejected
    visualAuditStatus = 'not_run';
    acceptanceStatus = 'rejected';
  } else if (actionRequired?.type === 'model_judges_unavailable') {
    visualAuditStatus = 'unavailable';
    acceptanceStatus = 'incomplete';
  } else if (actionRequired?.type === 'model_judges_failed') {
    visualAuditStatus = 'error';
    acceptanceStatus = 'rejected';
  } else if (modelJudgesInput?.enabled === false && modelJudgesInput?.explicitSkipReason) {
    visualAuditStatus = 'skipped_by_config';
    acceptanceStatus = 'metric_only';
  } else if (modelJudgesInput?.enabled) {
    // Required judges that ran but produced zero successful results must not pass.
    const isRequired = (modelJudgesInput as any).required !== false;
    if (isRequired && judgeHadSuccessfulResults === false) {
      visualAuditStatus = 'error';
      acceptanceStatus = 'rejected';
      if (!actionRequired) {
        // Build an accurate message based on what actually happened
        const prs = judgeProviderRunSummary;
        const reviewerOk = prs?.reviewerHadSuccess ?? false;
        const primaryAttempted = prs?.primaryAttempted ?? false;
        const primaryErrors = prs?.primaryErrorCount ?? 0;
        let fallbackMsg: string;
        if (!primaryAttempted) {
          fallbackMsg = reviewerOk
            ? 'Required primary judge was not attempted; reviewer succeeded. Visual audit is incomplete.'
            : 'Required primary judge was not attempted. Visual audit is incomplete.';
        } else if (primaryErrors > 0) {
          fallbackMsg = reviewerOk
            ? 'Required primary judge failed; reviewer succeeded. Visual audit is incomplete.'
            : 'All required model judges failed.';
        } else {
          fallbackMsg = reviewerOk
            ? 'Required primary judge produced no evidence; reviewer succeeded. Visual audit is incomplete.'
            : 'Required model judges ran but produced no usable results.';
        }
        actionRequired = {
          type: 'model_judges_failed',
          severity: 'blocking',
          message: fallbackMsg,
          recommendedUserPrompt: 'Check provider status, API key validity, and model compatibility.',
          suggestedFixes: [
            'Run model_judges_health with deep:true to test provider connectivity',
            'Verify API keys are valid and not rate-limited',
            "Set modelJudges.required: false to make failures non-blocking"
          ]
        };
      }
    } else {
      const hasBlockingCaveat = effectiveVisualCaveats.some((c) => c.blocking);
      const hasNonBlockingCaveat = effectiveVisualCaveats.some((c) => !c.blocking);
      if (hasBlockingCaveat) {
        visualAuditStatus = 'fail';
        acceptanceStatus = 'rejected';
      } else if (hasNonBlockingCaveat) {
        // Judges ran successfully, no blocking issues, but non-blocking caveats exist
        visualAuditStatus = 'pass_with_caveats';
        acceptanceStatus = qualityStatus === 'pass' ? 'accepted' : 'rejected';
      } else {
        visualAuditStatus = 'pass';
        // qualityStatus 'not_evaluated' means no ROIs configured — judges succeeding is sufficient for 'accepted'
        acceptanceStatus = qualityStatus === 'fail' ? 'rejected' : 'accepted';
      }
    }
  } else if (visualAuditMode === 'visual_parity') {
    // visual_parity + no judges and no prior actionRequired — should have been caught above, but guard here too
    visualAuditStatus = 'unavailable';
    acceptanceStatus = 'incomplete';
  } else {
    // metric_only with no judges configured — valid explicit skip path
    visualAuditStatus = 'not_run';
    acceptanceStatus = 'metric_only';
  }

  // Override acceptanceStatus when any overlap legibility region has invalid_target.
  // A wrong-box measurement cannot be trusted — the run must not be accepted.
  const invalidTargetRegions = overlapLegibilitySummary?.regions.filter((r) => r.status === 'invalid_target') ?? [];
  if (invalidTargetRegions.length > 0) {
    if (acceptanceStatus === 'accepted' || acceptanceStatus === 'metric_only') {
      acceptanceStatus = 'rejected';
    }
    if (!actionRequired) {
      const ids = invalidTargetRegions.map((r) => `'${r.id}'`).join(', ');
      actionRequired = {
        type: 'invalid_overlap_target',
        severity: 'blocking',
        message: `Overlap/legibility measurement target(s) could not be validated: ${ids}. The configured box may be pointing at the wrong UI element.`,
        recommendedUserPrompt: 'Review the overlap legibility configuration. The annotated artifact shows where the configured box is pointing. Adjust the box coordinates to cover the intended UI element, then re-run.',
        suggestedFixes: [
          'Inspect the annotated artifact (overlap-legibility-*-annotated.png) to see where the box is pointing',
          'Adjust the box coordinates in overlapLegibility.regions to cover the intended UI element',
          'Re-run to confirm targetStatus becomes "matched"'
        ]
      };
    }
  }

  // vlmAnalysisStatus — describes legacy Ollama VLM path separately from model judges
  let vlmAnalysisStatus: VlmAnalysisStatus;
  if (!shouldUseVlm) {
    vlmAnalysisStatus = 'disabled';
  } else if (isInvalidCapture) {
    vlmAnalysisStatus = 'skipped';
  } else if (!vlmAvailability.usable) {
    vlmAnalysisStatus = 'unavailable';
  } else {
    const hasVlmErrors = regions.some((r) => r.analysisStatus === 'error');
    vlmAnalysisStatus = hasVlmErrors ? 'error' : 'pass';
  }

  // ---- Priority findings ----
  const priorityFindings: PriorityFinding[] = [];
  for (const failure of criticalRoiFailures) {
    priorityFindings.push({ priority: priorityFindings.length + 1, kind: 'critical_roi_failed', label: failure.label ?? failure.roiId ?? 'critical ROI', message: `Critical ROI '${failure.label ?? failure.roiId}' failed local diff threshold. Do not treat global diff floor as acceptable.`, artifactPaths: failure.roiId ? [path.join(ctx.roiDir, `${failure.roiId}-expected.png`), path.join(ctx.roiDir, `${failure.roiId}-actual.png`), path.join(ctx.roiDir, `${failure.roiId}-diff.png`)] : [] });
  }
  if (criticalRoiFailures.length === 0) {
    for (const failure of criticalAssertionFailures) {
      const assertion = visualAssertions.find((a) => a.id === failure.assertionId);
      const roiId = failure.label;
      priorityFindings.push({ priority: priorityFindings.length + 1, kind: 'critical_visual_assertion_failed', label: failure.assertionId ?? 'critical visual assertion', message: assertion?.message ?? `Critical visual assertion '${failure.assertionId}' failed.`, artifactPaths: roiId ? [path.join(ctx.roiDir, `${roiId}-expected.png`), path.join(ctx.roiDir, `${roiId}-actual.png`), path.join(ctx.roiDir, `${roiId}-diff.png`)] : [] });
    }
  }
  for (const failure of dynamicMaskQualityFailures) {
    priorityFindings.push({ priority: priorityFindings.length + 1, kind: 'excessive_dynamic_masking', label: failure.label ?? failure.roiId ?? 'critical ROI', message: `Excessive dynamic mask coverage in '${failure.label ?? failure.roiId}' makes the ROI quality gate untrustworthy.`, artifactPaths: failure.roiId ? [path.join(ctx.roiDir, `${failure.roiId}-expected.png`), path.join(ctx.roiDir, `${failure.roiId}-actual.png`), path.join(ctx.roiDir, `${failure.roiId}-diff.png`)] : [] });
  }

  const rankedRegions = regions.filter((r) => r.actionable !== false)
    .map((r) => ({ region: r, intersectingRois: normalizedRois.filter((roi) => boxesIntersect(r.box, roi.box)) }))
    .sort((a, b) => {
      const aScore = a.region.area * (a.intersectingRois.reduce((s, roi) => s + (roi.weight ?? 1), 0) || 1);
      const bScore = b.region.area * (b.intersectingRois.reduce((s, roi) => s + (roi.weight ?? 1), 0) || 1);
      return bScore - aScore;
    });

  for (const item of rankedRegions.slice(0, 3)) {
    priorityFindings.push({ priority: priorityFindings.length + 1, kind: 'high_diff_region', label: item.region.fallbackLabel ?? item.region.id, message: item.region.fallbackDescription ?? `Changed region ${item.region.id} is visually important.`, artifactPaths: [item.region.cropPaths.expected, item.region.cropPaths.actual, item.region.cropPaths.diff] });
  }

  // ---- Floor state ----
  const floorState = evaluateFloorState({ floorDetection, runDelta, previousReport, currentDiffPercent: pixelDiff.diffPercent, qualityStatus, criticalFailures: criticalRoiFailures, criticalAssertionFailures });

  // ---- Threshold suggestion ----
  const hasCriticalFailure = qualityFailures.length > 0;
  const canSuggestMaxDiffPercent = pixelDiff.diffPercent > maxDiffPercent && qualityStatus === 'pass' && floorState.atFloor === true && !hasCriticalFailure;
  const suggestedMaxDiffPercent = canSuggestMaxDiffPercent ? Math.round(pixelDiff.diffPercent * 1.1 * 10000) / 10000 : null;
  const suggestionBlockers = !canSuggestMaxDiffPercent
    ? [
        ...(qualityStatus === 'not_evaluated' ? ['Critical UI quality was not evaluated. Configure ROIs or visualAssertions first.'] : []),
        ...qualityFailures.map((f) => {
          if (f.type === 'critical_roi_failed') return `Critical ROI '${f.label ?? f.roiId}' failed.`;
          if (f.type === 'excessive_dynamic_masking') return `Critical ROI '${f.label ?? f.roiId}' has excessive dynamic masking.`;
          if (f.type === 'invalid_capture') return 'Actual screenshot appears invalid or asleep; recapture before adjusting thresholds.';
          return `Critical visual assertion '${f.assertionId}' failed.`;
        })
      ]
    : [];

  // ---- Final warnings ----
  if (qualityWarnings.length > 0) warnings.push(...qualityWarnings);
  if (pixelDiff.diffPercent <= maxDiffPercent && localHotspots.length > 0) warnings.push('Global pass does not mean local visual parity; large local hotspots remain.');
  if (qualityStatus === 'not_evaluated' && pixelDiff.diffPercent <= maxDiffPercent && localHotspots.length > 0) {
    const largestHotspot = localHotspots[0];
    warnings.push(`Global pass may be misleading: largest changed region covers ${largestHotspot.area} pixels in ${largestHotspot.fallbackLabel}.`);
  }
  if (criticalRoiFailures.length > 0) {
    const failure = criticalRoiFailures[0];
    const structural = typeof failure.structuralRoiDiffPercent === 'number' ? ` Structural ROI diff: ${(failure.structuralRoiDiffPercent * 100).toFixed(2)}%.` : '';
    warnings.push(`Critical region '${failure.label}' failed structural local diff threshold.${structural} Do not treat global diff floor as acceptable.`);
  }
  if (suggestedMaxDiffPercent !== null) {
    configSuggestions.push({ kind: 'ignoreRegion', confidence: 0.55, reason: 'Global diff appears stable and local quality gates pass, so a threshold update may be appropriate.', risk: 'Medium. Raising thresholds can hide visual regressions; review artifacts first.', suggestedPatch: { maxDiffPercent: suggestedMaxDiffPercent } });
  }

  // ---- Stage 4: Verdict ----
  // Invalid measurement targets must fail the run — the measurement cannot be trusted.
  const reportStatus: DiffReport['status'] = isInvalidCapture ? 'fail' : invalidTargetRegions.length > 0 ? 'fail' : pixelDiff.diffPercent <= maxDiffPercent ? 'pass' : 'fail';
  const verdictEngine = new VerdictEngine();
  let agentActionContract = verdictEngine.buildAgentActionContract(
    graph,
    { requiresUserDecision: conflictResult.requiresUserDecision, blockedClaimIds: conflictResult.blockedClaimIds },
    qualityStatus,
    modelJudgesInput?.allowEditSuggestionsOnPass,
    visualAuditStatus,
    actionRequired
  );

  // Ensure canEditApp is false when a blocking action is required
  if (actionRequired?.severity === 'blocking' && agentActionContract.canEditApp) {
    agentActionContract = { ...agentActionContract, canEditApp: false };
  }

  let agentSummary = buildAgentSummary({
    status: reportStatus, qualityStatus, diffPercent: pixelDiff.diffPercent,
    criticalFailures: criticalRoiFailures, criticalAssertionFailures, qualityFailures,
    roiReports: roiCropArtifacts, priorityFindings, localHotspots, actionRequired
  });

  // incomplete (judges unavailable/failed) must not authorize stopping iteration
  // metric_only is an explicit opt-out — quality gate results determine canStopIterating
  if (acceptanceStatus === 'incomplete' && agentSummary.canStopIterating) {
    agentSummary = { ...agentSummary, canStopIterating: false };
  }

  const totalMs = Date.now() - pipelineStart;
  const timings: RunTimings = {
    totalMs,
    pixelDiffMs,
    modelJudgesMs,
    perAnalyzer: perAnalyzerMs
  };

  // Build modelJudgesSummary from judge config and per-provider run data
  let modelJudgesSummary: ModelJudgesSummary | undefined;
  if (modelJudgesInput?.enabled) {
    const cfg = modelJudgesInput;
    const isRequired = (cfg as any).required !== false;
    const policy = (cfg as any).policy ?? (visualAuditMode !== 'metric_only' ? 'always_audit' : 'disabled');
    const failedRois = (judgeProviderErrors ?? []).map((pe: any) => ({
      roiId: pe.roiId,
      provider: pe.provider,
      error: pe.message
    }));
    const primaryCfg = (cfg as any).primary;
    const reviewerCfg = (cfg as any).reviewer;
    const prs = judgeProviderRunSummary;

    const buildProviderSummary = (
      providerCfg: { provider: string; model: string } | undefined,
      evidenceCount: number,
      errorCount: number,
      hadSuccess: boolean,
      attempted: boolean,
      isProviderRequired: boolean
    ): ModelJudgesProviderSummary | undefined => {
      if (!providerCfg) return undefined;
      let status: ModelJudgesProviderSummary['status'];
      if (isInvalidCapture) {
        status = 'skipped';
      } else if (!attempted) {
        // Provider was never built (missing API key → unavailable)
        status = 'unavailable';
      } else if (!hadSuccess && errorCount > 0) {
        status = 'error';
      } else if (hadSuccess && errorCount > 0) {
        status = 'partial';
      } else if (hadSuccess) {
        status = 'success';
      } else {
        // attempted=true but no success and no errors: provider returned empty response
        // Guard: required judge must not show 'skipped' — convert to 'error'
        status = isProviderRequired && visualAuditMode === 'visual_parity' ? 'error' : 'skipped';
      }
      return { provider: providerCfg.provider, model: providerCfg.model, status, evidenceCount, errorCount, hadSuccess, attempted };
    };

    modelJudgesSummary = {
      enabled: true,
      required: isRequired,
      policy: String(policy),
      primary: buildProviderSummary(primaryCfg, prs?.primaryEvidenceCount ?? 0, prs?.primaryErrorCount ?? 0, prs?.primaryHadSuccess ?? false, prs?.primaryAttempted ?? false, isRequired),
      reviewer: buildProviderSummary(reviewerCfg, prs?.reviewerEvidenceCount ?? 0, prs?.reviewerErrorCount ?? 0, prs?.reviewerHadSuccess ?? false, prs?.reviewerAttempted ?? false, (cfg as any).requireConsensusForCodeHints === true),
      failedRois
    };
  }

  const diffFraction = pixelDiff.diffPercent;
  const diffPercentHuman = `${(diffFraction * 100).toFixed(2)}%`;
  const thresholdFraction = maxDiffPercent;
  const thresholdPercentHuman = `${(thresholdFraction * 100).toFixed(2)}%`;

  const report: DiffReport = {
    status: reportStatus,
    diffPixels: pixelDiff.diffPixels,
    totalPixels: pixelDiff.totalPixels,
    diffPercent: pixelDiff.diffPercent,
    diffFraction,
    diffPercentHuman,
    thresholdFraction,
    thresholdPercentHuman,
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
      expected: { width: targetWidth, height: targetHeight },
      actualSource: { width: actualSourceWidth, height: actualSourceHeight },
      comparison: { width: targetWidth, height: targetHeight }
    },
    atFloor: floorState.atFloor,
    floorBlockedBy: floorState.floorBlockedBy.length ? floorState.floorBlockedBy : undefined,
    floorReason: floorState.floorReason,
    maskedRegions: explicitMaskRegions,
    autoMaskedRegions: autoMaskedRegions.length ? autoMaskedRegions : undefined,
    appliedDeviceProfile: input.appliedDeviceProfile ?? undefined,
    configSuggestions: configSuggestions.length ? configSuggestions : undefined,
    agentSummary,
    agentActionContract,
    suggestedMaxDiffPercent,
    maxDiffPercentSuggestionBlockedBy: suggestionBlockers.length ? suggestionBlockers : undefined,
    vlmPolicy,
    vlmAvailability,
    vlmAnalysisStatus,
    actionRequired,
    ...(visualAuditStatus !== undefined ? { visualAuditStatus } : {}),
    ...(acceptanceStatus !== undefined ? { acceptanceStatus } : {}),
    ...(effectiveVisualCaveats.length > 0 ? { visualCaveats: effectiveVisualCaveats } : {}),
    ...(blockedModelFindings.length > 0 ? { blockedModelFindings } : {}),
    ...(modelJudgesSummary ? { modelJudgesSummary } : {}),
    ...(overlapLegibilitySummary ? { overlapLegibilitySummary } : {}),
    ...(criterionJudgesSummaryData ? { criterionJudgesSummary: criterionJudgesSummaryData } : {}),
    ...(targetResolutionSummary ? { targetResolutionSummary } : {}),
    ...(targetResolutionSummary
      ? { measurementBoxSource: targetResolutionSummary.resolvedViaFlutterAnchor > 0 ? ('flutter_anchor' as const) : ('none' as const) }
      : {}),
    timings,
    artifacts: {
      expected: pixelDiff.processedExpectedPath,
      actual: pixelDiff.processedActualPath,
      diff: pixelDiff.diffAbsPath,
      regionsDir: ctx.regionsDir
    },
    warnings: warnings.length ? warnings : undefined,
    vlm: vlmSummary,
    ...(referenceContextSummary ? { referenceContextSummary } : {})
  };

  const reportJsonPath = path.join(ctx.outputDir, 'report.json');
  report.reportJsonPath = reportJsonPath;
  await fs.writeFile(reportJsonPath, JSON.stringify(report, null, 2));
  return report;
}
