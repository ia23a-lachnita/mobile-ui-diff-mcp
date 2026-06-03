import { describe, it, expect } from 'vitest';
import { EvidenceBundleBuilder } from '../src/pipeline/EvidenceBundleBuilder';
import { EvidenceGraph } from '../src/pipeline/EvidenceGraph';
import type { AnalyzerContext } from '../src/pipeline/analyzers/IAnalyzer';

function makeCtx(): AnalyzerContext {
  return {
    runId: 'test-run',
    outputDir: '/tmp/test-output',
    configDir: '/tmp/test-project',
    roiDir: '/tmp/test-output/regions-of-interest',
    regionsDir: '/tmp/test-output/regions',
    expectedImagePath: '/tmp/expected.png',
    actualImagePath: '/tmp/actual.png',
    expectedPng: {} as any,
    actualPng: {} as any,
    comparisonPng: {} as any,
    actualSourceWidth: 390,
    actualSourceHeight: 844,
    config: { maxDiffPercent: 0.001 } as any,
    regionsOfInterest: [
      { id: 'ring', label: 'Ring', box: { x: 0, y: 0, width: 100, height: 100 }, critical: true, weight: 1 }
    ],
    ignoreRegions: []
  } as any;
}

describe('EvidenceBundleBuilder', () => {
  it('global source evidence appears in every ROI bundle referenceEvidence', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'referenceContext',
      claimId: 'ref-source-today-jsx',
      subject: 'global',
      claim: 'Source file: Today.jsx loaded',
      confidence: 1.0,
      authority: 'source'
    });

    const builder = new EvidenceBundleBuilder();
    const bundles = builder.build(makeCtx(), graph);

    const roiBundle = bundles.find((b) => b.roiId === 'ring');
    expect(roiBundle).toBeDefined();
    expect(roiBundle!.referenceEvidence.some((e) => e.claimId === 'ref-source-today-jsx')).toBe(true);
    expect(roiBundle!.referenceFacts).toContain('ref-source-today-jsx');
  });

  it('ROI-scoped source evidence appears in that ROI bundle', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'referenceContext',
      claimId: 'ref-fact-ring',
      subject: 'roi:ring',
      claim: 'Ring stroke should be 10',
      confidence: 1.0,
      authority: 'source'
    });

    const builder = new EvidenceBundleBuilder();
    const bundles = builder.build(makeCtx(), graph);

    const roiBundle = bundles.find((b) => b.roiId === 'ring');
    expect(roiBundle).toBeDefined();
    expect(roiBundle!.referenceEvidence.some((e) => e.claimId === 'ref-fact-ring')).toBe(true);
  });

  it('global source evidence does not appear in the global bundle twice', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'referenceContext',
      claimId: 'ref-source-global-1',
      subject: 'global',
      claim: 'Source file loaded',
      confidence: 1.0,
      authority: 'source'
    });

    const builder = new EvidenceBundleBuilder();
    const bundles = builder.build(makeCtx(), graph);

    const globalBundle = bundles.find((b) => b.roiId === 'global');
    expect(globalBundle).toBeDefined();
    const count = globalBundle!.referenceEvidence.filter((e) => e.claimId === 'ref-source-global-1').length;
    expect(count).toBe(1);
  });
});
