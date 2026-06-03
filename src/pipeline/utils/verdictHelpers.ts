// src/pipeline/utils/verdictHelpers.ts
import {
  DiffReport,
  QualityFailure,
  FloorBlocker,
  RunDelta,
  FloorDetectionConfig,
  ActionRequired,
  VlmPolicy,
  BoxLike,
  VlmAvailability
} from '../../types';
import { VLM_ASK_USER_UNAVAILABLE_MESSAGE, VLM_UNUSABLE_MESSAGE } from '../constants';

export function geometryFallbackLabel(region: BoxLike, canvasWidth: number, canvasHeight: number): string {
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

export function geometryFallbackDescription(label: string): string {
  return `This changed region looks like ${label}. Review local component geometry even without VLM.`;
}

export function resolveVlmPolicy(input: { includeVlmAnalysis: boolean; requireVlmAnalysis?: boolean; vlmPolicy?: VlmPolicy }): VlmPolicy {
  if (input.vlmPolicy) return input.vlmPolicy;
  if (!input.includeVlmAnalysis) return 'disabled';
  if (input.requireVlmAnalysis === true) return 'required';
  return 'ask_user';
}

export function evaluateFloorState(input: {
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

export function buildInvalidCaptureActionRequired(): ActionRequired {
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

export function buildVlmUnavailableActionRequired(): ActionRequired {
  return {
    type: 'vlm_unavailable', severity: 'blocking',
    message: VLM_UNUSABLE_MESSAGE,
    recommendedUserPrompt: VLM_ASK_USER_UNAVAILABLE_MESSAGE,
    suggestedFixes: [
      'Start Ollama with `ollama serve`', 'Run the `vlm_health` MCP tool', 'Pull or configure a smaller vision model',
      "Set includeVlmAnalysis:false or vlmPolicy:'disabled' to proceed without VLM",
      "Set vlmPolicy:'optional' to allow non-semantic fallback"
    ]
  };
}