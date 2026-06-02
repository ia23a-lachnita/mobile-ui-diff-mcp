import { describe, it, expect } from 'vitest';
import { EvidenceGraph } from '../src/pipeline/EvidenceGraph';
import { ConflictResolver } from '../src/pipeline/ConflictResolver';
import { referenceContextSchema } from '../src/config/uiDiffConfig';

describe('referenceContext config schema', () => {
  it('parses valid referenceContext config', () => {
    const raw = {
      enabled: true,
      facts: [
        { id: 'ring-stroke', subject: 'macro-ring', claim: 'BigMacroRing stroke is 10', authority: 'high' }
      ]
    };
    const result = referenceContextSchema!.parse(raw);
    expect(result?.enabled).toBe(true);
    expect(result?.facts).toHaveLength(1);
    expect(result?.facts![0].claim).toBe('BigMacroRing stroke is 10');
  });

  it('defaults enabled to false when not specified', () => {
    const result = referenceContextSchema!.parse({});
    expect(result?.enabled).toBe(false);
  });

  it('sources are optional', () => {
    const result = referenceContextSchema!.parse({ enabled: true });
    expect(result?.sources).toBeUndefined();
  });

  it('entire referenceContext is optional (undefined parses ok)', () => {
    const result = referenceContextSchema!.parse(undefined);
    expect(result).toBeUndefined();
  });

  it('fact authority defaults to high', () => {
    const raw = {
      enabled: true,
      facts: [{ id: 'f1', subject: 'ring', claim: 'ring ok' }]
    };
    const result = referenceContextSchema!.parse(raw);
    expect(result?.facts![0].authority).toBe('high');
  });
});

describe('referenceContext loading behavior', () => {
  it('facts loaded as source authority evidence do not throw on missing source file', () => {
    // ConflictResolver accepts referenceContext but missing source files emit warnings
    const graph = new EvidenceGraph();

    // Simulate what would happen when loading facts from a referenceContext
    // Facts themselves are always loadable; only file sources could be missing
    const refContext = {
      enabled: true,
      sources: [{ id: 's1', type: 'source' as const, path: '/nonexistent/file.jsx', authority: 'high' as const }],
      facts: [{ id: 'f1', subject: 'ring', claim: 'stroke is 10', authority: 'high' as const }]
    };

    // Facts are directly injectable as evidence (no file I/O needed)
    for (const fact of refContext.facts) {
      graph.add({
        source: 'referenceContext',
        claimId: `ref-fact-${fact.id}`,
        subject: fact.subject,
        claim: fact.claim,
        confidence: 1.0,
        authority: 'source'
      });
    }

    // Should not throw — missing source file path is handled by warnings only
    const resolver = new ConflictResolver(refContext);
    let error: Error | null = null;
    try {
      resolver.resolve(graph);
    } catch (e: any) {
      error = e;
    }
    expect(error).toBeNull();
  });

  it('reference facts appear as high-authority source evidence in the graph', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'referenceContext',
      claimId: 'ref-fact-ring-stroke',
      subject: 'roi:macro-ring',
      claim: 'BigMacroRing stroke is 10',
      confidence: 1.0,
      authority: 'source'
    });

    const sourceEvidence = graph.getBySource('referenceContext');
    expect(sourceEvidence).toHaveLength(1);
    expect(sourceEvidence[0].authority).toBe('source');
    expect(sourceEvidence[0].confidence).toBe(1.0);
  });

  it('missing referenceContext does not throw in ConflictResolver', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'roiQuality',
      claimId: 'roi-q-1',
      subject: 'roi:ring',
      claim: 'ROI passes',
      confidence: 1.0,
      authority: 'deterministic'
    });

    // No referenceContext provided
    const resolver = new ConflictResolver(undefined);
    let error: Error | null = null;
    try {
      resolver.resolve(graph);
    } catch (e: any) {
      error = e;
    }
    expect(error).toBeNull();
  });
});
