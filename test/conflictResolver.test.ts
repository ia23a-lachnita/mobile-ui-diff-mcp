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

  it('deterministic measurement contradicting model downgrades model confidence', () => {
    const graph = new EvidenceGraph();

    // Deterministic says pass
    addEvidence(graph, {
      source: 'roiQuality',
      claimId: 'det-ring-pass',
      subject: 'roi:ring',
      claim: 'ROI is within tolerance and passes',
      confidence: 1.0,
      authority: 'deterministic'
    });

    // Model says fails
    addEvidence(graph, {
      source: 'modelJudge',
      claimId: 'model-ring-fail-2',
      subject: 'roi:ring',
      claim: 'ring mismatch detected',
      confidence: 0.8,
      authority: 'model'
    });

    const resolver = new ConflictResolver();
    const result = resolver.resolve(graph);

    expect(result.downgradedClaimIds).toContain('model-ring-fail-2');
    const downgraded = graph.getAll().find((e) => e.claimId === 'model-ring-fail-2');
    expect(downgraded?.confidence).toBeLessThan(0.8);
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
});
