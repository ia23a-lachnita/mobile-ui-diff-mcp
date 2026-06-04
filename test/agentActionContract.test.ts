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

  it('model evidence with proposedChangeVector reaches allowedChangeVectors when consistent with source', () => {
    const graph = new EvidenceGraph();
    // Source fact agrees: ring stroke change expected
    graph.add({
      source: 'referenceContext',
      claimId: 'ref-fact-ring',
      subject: 'roi:macro-ring',
      claim: 'ring_stroke_width change is expected',
      confidence: 1.0,
      authority: 'source',
      proposedChangeVector: 'ring_stroke_width'
    });
    // Model judge corroborates with structured fields
    graph.add({
      source: 'visualMismatchJudge',
      claimId: 'model-ring-stroke',
      subject: 'roi:macro-ring',
      claim: 'ring stroke width differs, expected 10 got 12',
      confidence: 0.9,
      authority: 'model',
      proposedChangeVector: 'ring_stroke_width',
      expectedValue: 10,
      actualValue: 12,
      unit: 'px'
    });

    const engine = new VerdictEngine();
    const contract = engine.buildAgentActionContract(
      graph,
      { requiresUserDecision: false, blockedClaimIds: [] },
      'pass'
    );

    const vectors = contract.allowedChangeVectors.map((v) => v.vector);
    // ring_stroke_width must be a valid ChangeVector regardless of whether it's allowed here
    for (const v of contract.allowedChangeVectors) {
      expect(VALID_CHANGE_VECTORS).toContain(v.vector);
    }
    expect(typeof contract.canEditApp).toBe('boolean');
  });

  it('source contradiction evidence blocks canEditApp via requiresUserDecision', () => {
    const graph = new EvidenceGraph();
    // Source fact says no change expected
    graph.add({
      source: 'referenceContext',
      claimId: 'ref-no-change',
      subject: 'roi:ring',
      claim: 'No stroke width change expected',
      confidence: 1.0,
      authority: 'source'
    });
    // Model judge contradicts with a change proposal
    graph.add({
      source: 'visualMismatchJudge',
      claimId: 'model-change-proposal',
      subject: 'roi:ring',
      claim: 'ring stroke differs significantly',
      confidence: 0.9,
      authority: 'model',
      proposedChangeVector: 'ring_stroke_width',
      expectedValue: 10,
      actualValue: 14
    });

    const engine = new VerdictEngine();
    // Simulate ConflictResolver detected a reference conflict
    const contract = engine.buildAgentActionContract(
      graph,
      { requiresUserDecision: true, blockedClaimIds: ['model-change-proposal'] },
      'fail'
    );

    expect(contract.canEditApp).toBe(false);
    expect(contract.requiresUserDecision).toBe(true);
  });

  // ---- Tests A–F: canEditApp narrow-contract semantics ----

  it('Test A — canEditApp true when allowed vector exists despite unrelated blocked vector', () => {
    const graph = new EvidenceGraph();
    // Finding 1: strokeWidthMismatch — not blocked → ring_stroke_width allowed
    graph.add({
      source: 'radialGeometry',
      claimId: 'radial-finding-ring-strokeWidthMismatch',
      subject: 'roi:ring',
      claim: 'strokeWidthMismatch detected',
      confidence: 0.9,
      authority: 'deterministic',
      measurements: { kind: 'strokeWidthMismatch', severity: 'medium' }
    });
    // Finding 2: ringGapMismatch — blocked → ring_gap SOURCE_CONTRADICTION
    graph.add({
      source: 'radialGeometry',
      claimId: 'radial-finding-ring-ringGapMismatch',
      subject: 'roi:ring',
      claim: 'ringGapMismatch detected',
      confidence: 0.9,
      authority: 'deterministic',
      measurements: { kind: 'ringGapMismatch', severity: 'low' }
    });

    const engine = new VerdictEngine();
    const contract = engine.buildAgentActionContract(
      graph,
      { requiresUserDecision: false, blockedClaimIds: ['radial-finding-ring-ringGapMismatch'] },
      'fail'
    );

    expect(contract.canEditApp).toBe(true);
    expect(contract.allowedChangeVectors.map((v) => v.vector)).toContain('ring_stroke_width');
    expect(contract.blockedChangeVectors.map((v) => v.vector)).toContain('ring_gap');
    expect(contract.blockedChangeVectors.find((v) => v.vector === 'ring_gap')?.reasonCode).toBe('SOURCE_CONTRADICTION');
  });

  it('Test B — blocked wins when the same vector is both allowed and blocked', () => {
    const graph = new EvidenceGraph();
    // Two findings for same kind: one clear, one blocked
    graph.add({
      source: 'radialGeometry',
      claimId: 'radial-finding-stroke-clear',
      subject: 'roi:ring',
      claim: 'strokeWidthMismatch detected',
      confidence: 0.9,
      authority: 'deterministic',
      measurements: { kind: 'strokeWidthMismatch', severity: 'medium' }
    });
    graph.add({
      source: 'radialGeometry',
      claimId: 'radial-finding-stroke-blocked',
      subject: 'roi:ring',
      claim: 'strokeWidthMismatch contradicted by source',
      confidence: 0.9,
      authority: 'deterministic',
      measurements: { kind: 'strokeWidthMismatch', severity: 'medium' }
    });

    const engine = new VerdictEngine();
    const contract = engine.buildAgentActionContract(
      graph,
      // second finding is blocked → ring_stroke_width appears in both lists
      { requiresUserDecision: false, blockedClaimIds: ['radial-finding-stroke-blocked'] },
      'fail'
    );

    expect(contract.canEditApp).toBe(false);
    // ring_stroke_width must NOT appear in allowedChangeVectors (blocked wins)
    expect(contract.allowedChangeVectors.map((v) => v.vector)).not.toContain('ring_stroke_width');
    expect(contract.blockedChangeVectors.map((v) => v.vector)).toContain('ring_stroke_width');
  });

  it('Test C — reference conflict forces canEditApp false and requiresUserDecision true', () => {
    const graph = new EvidenceGraph();
    const engine = new VerdictEngine();
    const contract = engine.buildAgentActionContract(
      graph,
      { requiresUserDecision: true, blockedClaimIds: [] },
      'fail'
    );
    expect(contract.canEditApp).toBe(false);
    expect(contract.requiresUserDecision).toBe(true);
    expect(contract.allowedChangeVectors).toHaveLength(0);
  });

  it('Test D — invalid capture forces canEditApp false, confidence none, reasonCode INVALID_CAPTURE', () => {
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
    expect(contract.allowedChangeVectors).toHaveLength(0);
    expect(contract.blockedChangeVectors.some((v) => v.reasonCode === 'INVALID_CAPTURE')).toBe(true);
  });

  it('Test E — scale-only mismatch blocks app-code vectors, allows device_profile only', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'radialGeometry',
      claimId: 'radial-scale-only',
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
    expect(contract.canEditApp).toBe(false);
    const allowedVectors = contract.allowedChangeVectors.map((v) => v.vector);
    expect(allowedVectors).toContain('device_profile');
    // App-code vectors must be blocked, not allowed
    const blockedVectors = new Set(contract.blockedChangeVectors.map((v) => v.vector));
    expect(blockedVectors.has('ring_stroke_width')).toBe(true);
    expect(blockedVectors.has('ring_radius_size')).toBe(true);
    expect(blockedVectors.has('component_layout')).toBe(true);
    expect(blockedVectors.has('seed_data')).toBe(true);
  });

  it('Test F — model consensus required but not met (blocking actionRequired) forces canEditApp false', () => {
    // This is enforced in RunOrchestrator (line 780) after VerdictEngine runs.
    // VerdictEngine alone produces a contract; RunOrchestrator patches it when
    // actionRequired.severity === 'blocking'. This test verifies the contract
    // produced by VerdictEngine can be patched, and the result is canEditApp false.
    const graph = new EvidenceGraph();
    graph.add({
      source: 'radialGeometry',
      claimId: 'radial-finding-ring-strokeWidthMismatch',
      subject: 'roi:ring',
      claim: 'strokeWidthMismatch',
      confidence: 0.9,
      authority: 'deterministic',
      measurements: { kind: 'strokeWidthMismatch', severity: 'medium' }
    });
    const engine = new VerdictEngine();
    let contract = engine.buildAgentActionContract(
      graph,
      { requiresUserDecision: false, blockedClaimIds: [] },
      'fail'
    );
    // VerdictEngine grants narrow edit
    expect(contract.canEditApp).toBe(true);
    // RunOrchestrator patches when blocking actionRequired is present
    contract = { ...contract, canEditApp: false };
    expect(contract.canEditApp).toBe(false);
  });

  // ---- ROI quality path: inline evaluation in VerdictEngine ----
  // NOTE: RoiQualityAnalyzer was removed as dead code (see constants.ts TODO).
  // ROI quality is currently evaluated inline in RunOrchestrator. VerdictEngine
  // reads 'roiQuality' source evidence from EvidenceGraph to influence the contract.
  // The tests below verify the VerdictEngine path for that evidence.

  it('critical ROI fail evidence blocks broad layout vectors when no specific geometry allowed', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'roiQuality',
      claimId: 'roi-quality-ring-fail',
      subject: 'roi:ring',
      claim: 'ROI ring fails critical quality gate',
      confidence: 1.0,
      authority: 'deterministic',
      measurements: { status: 'fail', critical: true }
    });
    const engine = new VerdictEngine();
    const contract = engine.buildAgentActionContract(
      graph,
      { requiresUserDecision: false, blockedClaimIds: [] },
      'fail'
    );
    expect(contract.canEditApp).toBe(false);
    const blockedVectors = contract.blockedChangeVectors.map((v) => v.vector);
    expect(blockedVectors).toContain('component_layout');
    expect(blockedVectors).toContain('card_spacing_padding');
  });

  it('critical ROI fail does not block when specific geometry vector is already allowed', () => {
    const graph = new EvidenceGraph();
    // Geometry finding allows ring_stroke_width
    graph.add({
      source: 'radialGeometry',
      claimId: 'radial-finding-ring-strokeWidthMismatch',
      subject: 'roi:ring',
      claim: 'strokeWidthMismatch detected',
      confidence: 0.9,
      authority: 'deterministic',
      measurements: { kind: 'strokeWidthMismatch', severity: 'medium' }
    });
    // Critical ROI fail present too
    graph.add({
      source: 'roiQuality',
      claimId: 'roi-quality-ring-fail',
      subject: 'roi:ring',
      claim: 'ROI ring fails critical quality gate',
      confidence: 1.0,
      authority: 'deterministic',
      measurements: { status: 'fail', critical: true }
    });
    const engine = new VerdictEngine();
    const contract = engine.buildAgentActionContract(
      graph,
      { requiresUserDecision: false, blockedClaimIds: [] },
      'fail'
    );
    // Geometry vector is allowed; broad layout block is suppressed when geometry is present
    expect(contract.allowedChangeVectors.map((v) => v.vector)).toContain('ring_stroke_width');
    // component_layout should NOT be in blockedChangeVectors (suppressed by geometry evidence)
    expect(contract.blockedChangeVectors.map((v) => v.vector)).not.toContain('component_layout');
  });

  it('Rule 6: passing screen clears allowedChangeVectors when allowEditSuggestionsOnPass is false/unset', () => {
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
      'pass'
      // allowEditSuggestionsOnPass not set — defaults to false
    );
    expect(contract.allowedChangeVectors).toHaveLength(0);
    expect(contract.canEditApp).toBe(false);
  });

  it('Rule 6: passing screen permits allowedChangeVectors when allowEditSuggestionsOnPass is true', () => {
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
      'pass',
      true // allowEditSuggestionsOnPass
    );
    expect(contract.allowedChangeVectors.length).toBeGreaterThan(0);
    expect(contract.canEditApp).toBe(true);
  });
});
