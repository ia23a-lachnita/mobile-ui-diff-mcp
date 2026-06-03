import path from 'path';
import { AnalyzerContext } from './analyzers/IAnalyzer';
import { EvidenceGraph } from './EvidenceGraph';
import {
  AgentActionContract,
  AllowedChangeVector,
  BlockedChangeVector,
  ChangeVector,
  ReasonCode,
  AgentSummary,
  DiffReport,
  QualityFailure,
  PriorityFinding,
  LocalHotspot,
  RegionOfInterestReport,
  VisualAssertionResult,
  FloorBlocker
} from '../types';
import { CompareImagesInput } from '../tools/compareImages';
import { PIXEL_DIFF_KEY, PixelDiffResult } from './analyzers/PixelDiffAnalyzer';

export interface VerdictInput {
  conflictResult: {
    requiresUserDecision: boolean;
    blockedClaimIds: string[];
    warnings: string[];
  };
  roiReports: RegionOfInterestReport[];
  qualityFailures: QualityFailure[];
  qualityStatus: 'pass' | 'fail' | 'not_evaluated';
  priorityFindings: PriorityFinding[];
  localHotspots: LocalHotspot[];
  warnings: string[];
  visualAssertions: VisualAssertionResult[];
  floorState: { atFloor: boolean | null; floorBlockedBy: FloorBlocker[]; floorReason?: string };
}

export class VerdictEngine {
  buildAgentActionContract(
    graph: EvidenceGraph,
    conflictResult: { requiresUserDecision: boolean; blockedClaimIds: string[] },
    qualityStatus: 'pass' | 'fail' | 'not_evaluated'
  ): AgentActionContract {
    const allEvidence = graph.getAll();
    const allowedChangeVectors: AllowedChangeVector[] = [];
    const blockedChangeVectors: BlockedChangeVector[] = [];

    // Determine if invalid capture
    const invalidCaptureEvidence = allEvidence.find(
      (e) => e.source === 'invalidCapture' && e.claimId === 'invalid-capture-detected' && !e.blocked
    );
    if (invalidCaptureEvidence) {
      return {
        canEditApp: false,
        confidence: 'none',
        allowedChangeVectors: [],
        blockedChangeVectors: [{ vector: 'none' as ChangeVector, reasonCode: 'INVALID_CAPTURE' }],
        requiresUserDecision: false,
        reasonSummary: 'Invalid capture: screenshot is unusable. Recapture before any analysis.'
      };
    }

    // Check for scale-only mismatch — block ALL app code change vectors per spec Rule B
    const scaleOnly = allEvidence.find(
      (e) => e.source === 'radialGeometry' && e.measurements?.verdict === 'scaleOnlyMismatch' && !e.blocked
    );
    if (scaleOnly) {
      const appCodeVectors: ChangeVector[] = [
        'ring_stroke_width', 'ring_radius_size', 'ring_gap',
        'ring_start_angle', 'ring_sweep_mapping', 'ring_center_alignment', 'ring_glow_track',
        'component_layout', 'card_spacing_padding',
        'text_style', 'color_token',
        'thumbnail_gradient', 'badge_style', 'bottom_nav_padding',
        'seed_data', 'fixture_plan'
      ];
      for (const vector of appCodeVectors) {
        blockedChangeVectors.push({ vector, reasonCode: 'SCALE_ONLY_MISMATCH' });
      }
      return {
        canEditApp: false,
        confidence: 'high',
        allowedChangeVectors: [{ vector: 'device_profile', reasonCode: 'SCALE_ONLY_MISMATCH', scope: 'Update device profile to match capture resolution' }],
        blockedChangeVectors,
        requiresUserDecision: conflictResult.requiresUserDecision,
        reasonSummary: 'Scale-only mismatch: difference is a capture scale issue, not an app code issue.'
      };
    }

    // Check for reference conflict — block all app code change vectors per spec Rule C
    if (conflictResult.requiresUserDecision) {
      const appCodeVectors: ChangeVector[] = [
        'ring_stroke_width', 'ring_radius_size', 'ring_gap',
        'ring_start_angle', 'ring_sweep_mapping', 'ring_center_alignment', 'ring_glow_track',
        'component_layout', 'card_spacing_padding',
        'text_style', 'color_token',
        'thumbnail_gradient', 'badge_style', 'bottom_nav_padding',
        'seed_data', 'fixture_plan'
      ];
      const refConflictBlocked: BlockedChangeVector[] = appCodeVectors.map((vector) => ({
        vector,
        reasonCode: 'REFERENCE_CONFLICT' as ReasonCode
      }));
      return {
        canEditApp: false,
        confidence: 'low',
        allowedChangeVectors: [],
        blockedChangeVectors: refConflictBlocked,
        requiresUserDecision: true,
        reasonSummary: 'Reference context and mockup disagree. User must resolve before agent can act.'
      };
    }

    // Check for geometry findings that suggest specific change vectors
    const geometryFindings = allEvidence.filter(
      (e) => e.source === 'radialGeometry' && !e.blocked && e.claimId.startsWith('radial-finding-')
    );

    for (const finding of geometryFindings) {
      const kind = finding.measurements?.kind as string | undefined;
      if (!kind) continue;

      const vector = this.geometryKindToChangeVector(kind);
      if (vector) {
        // Check if it's blocked
        if (conflictResult.blockedClaimIds.includes(finding.claimId)) {
          blockedChangeVectors.push({ vector, reasonCode: 'SOURCE_CONTRADICTION' });
        } else {
          // Source + deterministic agree or deterministic alone
          const hasSourceAgreement = allEvidence.some(
            (e) => e.authority === 'source' && e.subject === finding.subject && !e.blocked
          );
          const reasonCode: ReasonCode = hasSourceAgreement ? 'SOURCE_AND_GEOMETRY_AGREE' : 'QUALITY_GATE_PASS';
          if (!allowedChangeVectors.find((a) => a.vector === vector)) {
            allowedChangeVectors.push({ vector, reasonCode });
          }
        }
      }
    }

    // Critical ROI failures with no specific geometry evidence → block broad layout vectors
    const criticalRoiFails = allEvidence.filter(
      (e) => e.source === 'roiQuality' && e.measurements?.status === 'fail' && e.measurements?.critical === true && !e.blocked
    );
    if (criticalRoiFails.length > 0 && allowedChangeVectors.length === 0) {
      // No specific geometry evidence to support a change vector — block broad edits
      const broadLayoutVectors: ChangeVector[] = ['component_layout', 'card_spacing_padding'];
      for (const vector of broadLayoutVectors) {
        if (!blockedChangeVectors.find((b) => b.vector === vector)) {
          blockedChangeVectors.push({ vector, reasonCode: 'NO_SUPPORTING_EVIDENCE' });
        }
      }
    }

    // Determine overall confidence
    let confidence: AgentActionContract['confidence'] = 'low';
    if (qualityStatus === 'pass' && geometryFindings.length === 0 && criticalRoiFails.length === 0) {
      confidence = 'high';
    } else if (qualityStatus === 'fail' && allowedChangeVectors.length > 0 && criticalRoiFails.length === 0) {
      confidence = 'medium';
    } else if (qualityStatus === 'not_evaluated') {
      confidence = 'low';
    }

    const canEditApp =
      allowedChangeVectors.length > 0 &&
      blockedChangeVectors.length === 0 &&
      !conflictResult.requiresUserDecision;

    // Deduplicate blocked vectors (remove any that are also allowed)
    const allowedVectorSet = new Set(allowedChangeVectors.map((a) => a.vector));
    const finalBlockedVectors = blockedChangeVectors.filter((b) => !allowedVectorSet.has(b.vector));

    return {
      canEditApp,
      confidence,
      allowedChangeVectors,
      blockedChangeVectors: finalBlockedVectors,
      requiresUserDecision: conflictResult.requiresUserDecision,
      reasonSummary: this.buildReasonSummary(qualityStatus, allowedChangeVectors, finalBlockedVectors, conflictResult)
    };
  }

  private geometryKindToChangeVector(kind: string): ChangeVector | null {
    const map: Record<string, ChangeVector> = {
      strokeWidthMismatch: 'ring_stroke_width',
      relativeRadiusMismatch: 'ring_radius_size',
      ringGapMismatch: 'ring_gap',
      angleMismatch: 'ring_start_angle',
      sweepMismatch: 'ring_sweep_mapping',
      centerShift: 'ring_center_alignment',
      haloOrTrackMismatch: 'ring_glow_track',
      capMismatch: 'ring_stroke_width',
      missingArc: 'ring_sweep_mapping',
      scaleOnlyMismatch: 'device_profile'
    };
    return map[kind] ?? null;
  }

  private buildReasonSummary(
    qualityStatus: 'pass' | 'fail' | 'not_evaluated',
    allowed: AllowedChangeVector[],
    blocked: BlockedChangeVector[],
    conflictResult: { requiresUserDecision: boolean }
  ): string {
    if (conflictResult.requiresUserDecision) return 'Reference conflict requires user resolution.';
    if (qualityStatus === 'pass' && allowed.length === 0) return 'All quality gates pass. No changes needed.';
    if (allowed.length > 0) return `Suggested change vectors: ${allowed.map((a) => a.vector).join(', ')}.`;
    if (blocked.length > 0) return `All change vectors blocked: ${blocked.map((b) => b.reasonCode).join(', ')}.`;
    return 'Insufficient evidence to determine change vector.';
  }

  buildAgentSummary(
    status: DiffReport['status'],
    qualityStatus: 'pass' | 'fail' | 'not_evaluated',
    diffPercent: number,
    qualityFailures: QualityFailure[],
    roiReports: RegionOfInterestReport[],
    priorityFindings: PriorityFinding[],
    localHotspots: LocalHotspot[]
  ): AgentSummary {
    const criticalFailures = qualityFailures.filter((f) => f.type === 'critical_roi_failed');
    const criticalAssertionFailures = qualityFailures.filter((f) => f.type === 'critical_visual_assertion_failed');

    if (criticalFailures.length > 0) {
      const label = criticalFailures[0].label ?? 'critical region';
      const structural = criticalFailures[0].structuralRoiDiffPercent ?? criticalFailures[0].diffPercent;
      const structuralText = typeof structural === 'number' ? ` Structural ROI diff is ${(structural * 100).toFixed(2)}%.` : '';
      return {
        verdict: `Do not accept. Critical ${label} region still differs significantly from mockup.${structuralText}`,
        globalDiffPercent: diffPercent,
        qualityStatus,
        topAction: `Fix ${label} before considering full-screen floor.`,
        canStopIterating: false
      };
    }

    if (criticalAssertionFailures.length > 0) {
      const label = criticalAssertionFailures[0].label ?? 'critical visual assertion';
      return {
        verdict: `Do not accept. Critical visual assertion failed for ${label}.`,
        globalDiffPercent: diffPercent,
        qualityStatus,
        topAction: `Fix ${label} before considering full-screen floor.`,
        canStopIterating: false
      };
    }

    if (qualityStatus === 'fail') {
      return {
        verdict: 'Do not accept. Local visual quality gates failed.',
        globalDiffPercent: diffPercent,
        qualityStatus,
        topAction: priorityFindings[0]?.message ?? 'Review failed ROI and visual assertion details.',
        canStopIterating: false
      };
    }

    if (status === 'fail') {
      return {
        verdict: 'Global diff still above threshold.',
        globalDiffPercent: diffPercent,
        qualityStatus,
        topAction: priorityFindings[0]?.message ?? 'Reduce global diff until report passes.',
        canStopIterating: false
      };
    }

    if (qualityStatus === 'not_evaluated') {
      return {
        verdict: 'Global pixel gate passed, but critical UI quality was not evaluated.',
        globalDiffPercent: diffPercent,
        qualityStatus,
        topAction: 'Configure regionsOfInterest / visualAssertions for important components before accepting the screen.',
        canStopIterating: false
      };
    }

    return {
      verdict: 'Screen acceptable by global and local gates.',
      globalDiffPercent: diffPercent,
      qualityStatus,
      topAction: 'No blocking visual issues detected.',
      canStopIterating: true
    };
  }
}
