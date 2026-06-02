import { describe, it, expect } from 'vitest';
import { EvidenceGraph } from '../src/pipeline/EvidenceGraph';
import { VerdictEngine } from '../src/pipeline/VerdictEngine';
import { ChangeVector, ReasonCode } from '../src/types';

const VALID_CHANGE_VECTORS: ChangeVector[] = [
  'seed_data', 'fixture_plan',
  'ring_stroke_width', 'ring_radius_size', 'ring_gap',
  'ring_start_angle', 'ring_sweep_mapping', 'ring_center_alignment',
  'ring_glow_track',
  'component_layout', 'card_spacing_padding',
  'text_style', 'color_token',
  'thumbnail_gradient', 'badge_style', 'bottom_nav_padding',
  'expected_baseline', 'roi_threshold', 'device_profile',
  'dynamic_mask', 'none'
];

const VALID_REASON_CODES: ReasonCode[] = [
  'SOURCE_AND_GEOMETRY_AGREE',
  'SOURCE_CONTRADICTION',
  'SCALE_ONLY_MISMATCH',
  'REFERENCE_CONFLICT',
  'INSUFFICIENT_CONFIDENCE',
  'MODEL_DISAGREEMENT',
  'NON_DETERMINISTIC_CAPTURE',
  'INVALID_CAPTURE',
  'QUALITY_GATE_PASS',
  'MASK_TOO_BROAD',
  'NO_SUPPORTING_EVIDENCE',
  'OUT_OF_SCOPE'
];

describe('AgentActionContract', () => {
  it('uses ChangeVector enum values in allowedChangeVectors', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'radialGeometry',
      claimId: 'radial-finding-ring-strokeWidthMismatch',
      subject: 'roi:ring',
      claim: 'strokeWidthMismatch detected',
      confidence: 0.9,
      authority: 'deterministic',
      measurements: { kind: 'strokeWidthMismatch', severity: 'medium' }
    });

    const engine = new VerdictEngine();
    const contract = engine.buildAgentActionContract(
      graph,
      { requiresUserDecision: false, blockedClaimIds: [] },
      'fail'
    );

    for (const v of contract.allowedChangeVectors) {
      expect(VALID_CHANGE_VECTORS).toContain(v.vector);
      expect(VALID_REASON_CODES).toContain(v.reasonCode);
    }
    for (const v of contract.blockedChangeVectors) {
      expect(VALID_CHANGE_VECTORS).toContain(v.vector);
      expect(VALID_REASON_CODES).toContain(v.reasonCode);
    }
  });

  it('blocked vectors never appear in allowedChangeVectors', () => {
    const graph = new EvidenceGraph();
    // Scale-only mismatch blocks app vectors
    graph.add({
      source: 'radialGeometry',
      claimId: 'radial-geometry-ring',
      subject: 'roi:ring',
      claim: 'scaleOnlyMismatch',
      confidence: 0.95,
      authority: 'deterministic',
      measurements: { verdict: 'scaleOnlyMismatch' }
    });

    const engine = new VerdictEngine();
    const contract = engine.buildAgentActionContract(
      graph,
      { requiresUserDecision: false, blockedClaimIds: [] },
      'fail'
    );

    const allowedVectors = new Set(contract.allowedChangeVectors.map((v) => v.vector));
    for (const blocked of contract.blockedChangeVectors) {
      expect(allowedVectors.has(blocked.vector)).toBe(false);
    }
  });

  it('invalid capture produces canEditApp=false and confidence=none', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'invalidCapture',
      claimId: 'invalid-capture-detected',
      subject: 'global',
      claim: 'Actual screenshot appears invalid',
      confidence: 0.95,
      authority: 'deterministic'
    });

    const engine = new VerdictEngine();
    const contract = engine.buildAgentActionContract(
      graph,
      { requiresUserDecision: false, blockedClaimIds: [] },
      'fail'
    );

    expect(contract.canEditApp).toBe(false);
    expect(contract.confidence).toBe('none');
  });

  it('requiresUserDecision set true for reference conflict', () => {
    const graph = new EvidenceGraph();
    const engine = new VerdictEngine();
    const contract = engine.buildAgentActionContract(
      graph,
      { requiresUserDecision: true, blockedClaimIds: [] },
      'fail'
    );
    expect(contract.requiresUserDecision).toBe(true);
    expect(contract.canEditApp).toBe(false);
  });

  it('confidence field uses only valid values', () => {
    const validConfidenceValues = ['high', 'medium', 'low', 'none'];
    const graph = new EvidenceGraph();
    const engine = new VerdictEngine();
    const contract = engine.buildAgentActionContract(
      graph,
      { requiresUserDecision: false, blockedClaimIds: [] },
      'not_evaluated'
    );
    expect(validConfidenceValues).toContain(contract.confidence);
  });
});
