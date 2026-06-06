import { describe, it, expect } from 'vitest';
import { EvidenceGraph } from '../src/pipeline/EvidenceGraph';
import { ConflictResolver } from '../src/pipeline/ConflictResolver';
import { Evidence } from '../src/pipeline/types';

function addEvidence(graph: EvidenceGraph, e: Evidence) {
  graph.add(e);
}

describe('ConflictResolver', () => {
  it('model finding contradicted by source fact is blocked', () => {
    const graph = new EvidenceGraph();

    // Source fact says UI passes
    addEvidence(graph, {
      source: 'referenceContext',
      claimId: 'ref-fact-ring-pass',
      subject: 'roi:ring',
      claim: 'ring is within tolerance',
      confidence: 1.0,
      authority: 'source'
    });

    // Model says it fails
    addEvidence(graph, {
      source: 'modelJudge',
      claimId: 'model-ring-fail',
      subject: 'roi:ring',
      claim: 'ring differs and fails',
      confidence: 0.8,
      authority: 'model'
    });

    const resolver = new ConflictResolver();
    const result = resolver.resolve(graph);

    expect(result.blockedClaimIds).toContain('model-ring-fail');
    const blocked = graph.getAll().find((e) => e.claimId === 'model-ring-fail');
    expect(blocked?.blocked).toBe(true);
    expect(blocked?.blockReason).toBe('SOURCE_CONTRADICTION');
  });

  it('deterministic ROI pass does NOT downgrade unstructured model visual caveat (keyword-only match is not a contradiction)', () => {
    const graph = new EvidenceGraph();

    // Deterministic says pass — no claimType, no proposedChangeVector
    addEvidence(graph, {
      source: 'roiQuality',
      claimId: 'det-ring-pass',
      subject: 'roi:ring',
      claim: 'ROI is within tolerance and passes',
      confidence: 1.0,
      authority: 'deterministic'
    });

    // Model observes a visual caveat — no claimType, no proposedChangeVector
    addEvidence(graph, {
      source: 'modelJudge',
      claimId: 'model-ring-caveat',
      subject: 'roi:ring',
      claim: 'pill visually crowded by arc, style mismatch within threshold',
      confidence: 0.8,
      authority: 'model'
    });

    const resolver = new ConflictResolver();
    const result = resolver.resolve(graph);

    // Visual caveat must survive — deterministic pass is not a contradiction of a style observation
    expect(result.downgradedClaimIds).not.toContain('model-ring-caveat');
    const item = graph.getAll().find((e) => e.claimId === 'model-ring-caveat');
    expect(item?.confidence).toBe(0.8);
  });

  it('structured claimType contradiction between deterministic pass and model fail downgrades model confidence', () => {
    const graph = new EvidenceGraph();

    addEvidence(graph, {
      source: 'roiQuality',
      claimId: 'det-ring-pass-structured',
      subject: 'roi:ring',
      claim: 'ROI passes',
      confidence: 1.0,
      authority: 'deterministic',
      claimType: 'roi_quality',
      expectedValue: 'pass',
      actualValue: 'pass'
    });

    addEvidence(graph, {
      source: 'modelJudge',
      claimId: 'model-ring-fail-structured',
      subject: 'roi:ring',
      claim: 'ROI fails quality gate',
      confidence: 0.8,
      authority: 'model',
      claimType: 'roi_quality',
      expectedValue: 'pass',
      actualValue: 'fail'
    });

    const resolver = new ConflictResolver();
    const result = resolver.resolve(graph);

    expect(result.downgradedClaimIds).toContain('model-ring-fail-structured');
    const downgraded = graph.getAll().find((e) => e.claimId === 'model-ring-fail-structured');
    expect(downgraded?.confidence).toBeLessThan(0.8);
  });

  it('ROI pass + model visual caveat → caveat survives in evidence graph', () => {
    const graph = new EvidenceGraph();

    addEvidence(graph, {
      source: 'roiQuality',
      claimId: 'det-macro-ring-pass',
      subject: 'roi:macro-ring-hero',
      claim: 'macro-ring-hero diff is 0.2% — within threshold',
      confidence: 1.0,
      authority: 'deterministic',
      measurements: { status: 'pass', diffPercent: 0.002 }
    });

    addEvidence(graph, {
      source: 'modelJudge',
      claimId: 'model-kcal-pill-crowded',
      subject: 'roi:macro-ring-hero',
      claim: '980 kcal left pill is visually crowded by green arc intersection',
      confidence: 0.85,
      authority: 'model'
    });

    const resolver = new ConflictResolver();
    const result = resolver.resolve(graph);

    expect(result.blockedClaimIds).not.toContain('model-kcal-pill-crowded');
    expect(result.downgradedClaimIds).not.toContain('model-kcal-pill-crowded');
    const item = graph.getAll().find((e) => e.claimId === 'model-kcal-pill-crowded');
    expect(item?.blocked).toBeFalsy();
    expect(item?.confidence).toBe(0.85);
  });

  it('ROI pass + model claims ROI failed (proposedChangeVector conflict) → model claim downgraded', () => {
    const graph = new EvidenceGraph();

    addEvidence(graph, {
      source: 'roiQuality',
      claimId: 'det-roi-no-change',
      subject: 'roi:ring',
      claim: 'ROI passes — no change needed',
      confidence: 1.0,
      authority: 'deterministic',
      proposedChangeVector: 'none'
    });

    addEvidence(graph, {
      source: 'modelJudge',
      claimId: 'model-roi-change-needed',
      subject: 'roi:ring',
      claim: 'Ring stroke needs to be updated',
      confidence: 0.8,
      authority: 'model',
      proposedChangeVector: 'ring_stroke_width'
    });

    const resolver = new ConflictResolver();
    const result = resolver.resolve(graph);

    expect(result.downgradedClaimIds).toContain('model-roi-change-needed');
  });

  it('scale-only mismatch blocks all model change vector suggestions', () => {
    const graph = new EvidenceGraph();

    // Scale-only geometry finding
    addEvidence(graph, {
      source: 'radialGeometry',
      claimId: 'radial-geometry-ring',
      subject: 'roi:ring',
      claim: 'scaleOnlyMismatch detected',
      confidence: 0.9,
      authority: 'deterministic',
      measurements: { verdict: 'scaleOnlyMismatch' }
    });

    // Model suggests app code change
    addEvidence(graph, {
      source: 'modelJudge',
      claimId: 'model-stroke-change',
      subject: 'roi:ring',
      claim: 'stroke width needs changing',
      confidence: 0.7,
      authority: 'model'
    });

    const resolver = new ConflictResolver();
    const result = resolver.resolve(graph);

    expect(result.blockedClaimIds).toContain('model-stroke-change');
    expect(result.warnings.some((w) => w.includes('Scale-only mismatch'))).toBe(true);
  });

  it('reference conflict sets requiresUserDecision', () => {
    const graph = new EvidenceGraph();

    addEvidence(graph, {
      source: 'referenceContext',
      claimId: 'ref-conflict-1',
      subject: 'roi:ring',
      claim: 'Reference and mockup disagree',
      confidence: 1.0,
      authority: 'source',
      measurements: { conflict: true }
    });

    const resolver = new ConflictResolver();
    const result = resolver.resolve(graph);

    expect(result.requiresUserDecision).toBe(true);
  });

  it('no conflicts → empty blocked list and no user decision required', () => {
    const graph = new EvidenceGraph();

    addEvidence(graph, {
      source: 'roiQuality',
      claimId: 'det-ring-ok',
      subject: 'roi:ring',
      claim: 'ROI passes structural diff',
      confidence: 1.0,
      authority: 'deterministic'
    });

    const resolver = new ConflictResolver();
    const result = resolver.resolve(graph);

    expect(result.blockedClaimIds).toHaveLength(0);
    expect(result.requiresUserDecision).toBe(false);
  });

  it('blocksClaimsMatching: source fact blocks model claim containing listed phrase', () => {
    const graph = new EvidenceGraph();
    // Source fact: recent scans count is a muted label, NOT a green filled pill
    graph.add({
      source: 'referenceContext',
      claimId: 'ref-fact-recent-scans-badge',
      subject: 'recent-scans-count',
      claim: 'Recent scans count is muted label text, not a green filled pill',
      confidence: 1.0,
      authority: 'source',
      measurements: {
        factId: 'recent-scans-badge',
        authorityLevel: 'high',
        blocksClaimsMatching: 'green pill|||filled pill|||badge should be green'
      }
    });
    // Model claim: contradicts source by saying green pill is expected
    graph.add({
      source: 'modelJudge',
      claimId: 'openrouter-ring-hero-LC01',
      subject: 'recent-scans-count',
      claim: 'Recent scans reference shows a green pill should be displayed',
      confidence: 0.85,
      authority: 'model'
    });

    const resolver = new ConflictResolver();
    const result = resolver.resolve(graph);
    expect(result.blockedClaimIds).toContain('openrouter-ring-hero-LC01');
    const blocked = graph.getAll().find((e) => e.claimId === 'openrouter-ring-hero-LC01');
    expect(blocked?.blocked).toBe(true);
    expect(blocked?.blockReason).toBe('SOURCE_CONTRADICTION');
  });

  it('blocksClaimsMatching: model claim NOT containing any phrase survives', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'referenceContext',
      claimId: 'ref-fact-badge',
      subject: 'recent-scans-count',
      claim: 'Recent scans count is muted label text, not a green filled pill',
      confidence: 1.0,
      authority: 'source',
      measurements: {
        factId: 'badge',
        authorityLevel: 'high',
        blocksClaimsMatching: 'green pill|||filled pill'
      }
    });
    graph.add({
      source: 'modelJudge',
      claimId: 'model-color-mismatch',
      subject: 'recent-scans-count',
      claim: 'Icon color appears lighter than expected in the mockup',
      confidence: 0.7,
      authority: 'model'
    });

    const resolver = new ConflictResolver();
    const result = resolver.resolve(graph);
    expect(result.blockedClaimIds).not.toContain('model-color-mismatch');
  });

  it('blocksClaimsMatching: subject prefix match — source fact on parent subject blocks child model claim', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'referenceContext',
      claimId: 'ref-fact-macro-ring',
      subject: 'roi:macro-ring-hero',
      claim: 'Macro ring values are correct',
      confidence: 1.0,
      authority: 'source',
      measurements: {
        factId: 'macro-ring-values',
        authorityLevel: 'high',
        blocksClaimsMatching: 'wrong arc sweep|||incorrect sweep'
      }
    });
    graph.add({
      source: 'modelJudge',
      claimId: 'nvidia-ring-hero-LC102',
      subject: 'roi:macro-ring-hero',
      claim: 'Cyan arc shows wrong arc sweep of -17.6 degrees',
      confidence: 0.9,
      authority: 'model'
    });

    const resolver = new ConflictResolver();
    const result = resolver.resolve(graph);
    expect(result.blockedClaimIds).toContain('nvidia-ring-hero-LC102');
  });

  it('source contradiction blocks model-proposed app change vector', () => {
    const graph = new EvidenceGraph();
    // Source fact: no change expected
    graph.add({
      source: 'referenceContext',
      claimId: 'ref-fact-no-change',
      subject: 'roi:ring',
      claim: 'Ring stroke matches reference: no change needed',
      confidence: 1.0,
      authority: 'source',
      proposedChangeVector: 'none',
      claimType: 'visual_match'
    });
    // Model claim: contradicts source by proposing an app change
    graph.add({
      source: 'modelJudge',
      claimId: 'model-claim-ring-stroke',
      subject: 'roi:ring',
      claim: 'Ring stroke differs from reference, needs update',
      confidence: 0.8,
      authority: 'model',
      proposedChangeVector: 'ring_stroke_width',
      claimType: 'visual_match'
    });

    const resolver = new ConflictResolver();
    const result = resolver.resolve(graph);
    expect(result.blockedClaimIds).toContain('model-claim-ring-stroke');
  });
});
