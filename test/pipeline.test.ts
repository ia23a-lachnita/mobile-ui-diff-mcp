import { describe, it, expect } from 'vitest';
import { EvidenceGraph } from '../src/pipeline/EvidenceGraph';
import { EvidenceBundleBuilder } from '../src/pipeline/EvidenceBundleBuilder';
import { Evidence } from '../src/pipeline/types';
import { ModelJudgeAnalyzer } from '../src/pipeline/judges/ModelJudgeAnalyzer';
import { ReferenceContextAnalyzer } from '../src/pipeline/analyzers/ReferenceContextAnalyzer';
import { PNG } from 'pngjs';
import path from 'path';
import os from 'os';
import { AnalyzerContext } from '../src/pipeline/analyzers/IAnalyzer';

function makeContext(overrides: Partial<AnalyzerContext> = {}): AnalyzerContext {
  const png = new PNG({ width: 10, height: 10 });
  return {
    runId: 'test-run',
    outputDir: os.tmpdir(),
    roiDir: os.tmpdir(),
    regionsDir: os.tmpdir(),
    expectedImagePath: '/fake/expected.png',
    actualImagePath: '/fake/actual.png',
    expectedPng: png,
    actualPng: png,
    comparisonPng: png,
    actualSourceWidth: 10,
    actualSourceHeight: 10,
    regionsOfInterest: [],
    ignoreRegions: [],
    config: {
      expectedImage: '/fake/expected.png',
      actualImage: '/fake/actual.png',
      outputDir: os.tmpdir()
    },
    ...overrides
  };
}

describe('EvidenceGraph', () => {
  it('stores and retrieves evidence by source', () => {
    const graph = new EvidenceGraph();
    const e: Evidence = {
      source: 'pixelDiff',
      claimId: 'claim-1',
      subject: 'global',
      claim: 'Global diff is 0.5%',
      confidence: 1.0,
      authority: 'deterministic'
    };
    graph.add(e);
    const results = graph.getBySource('pixelDiff');
    expect(results).toHaveLength(1);
    expect(results[0].claimId).toBe('claim-1');
  });

  it('retrieves evidence by subject', () => {
    const graph = new EvidenceGraph();
    const e: Evidence = {
      source: 'roiQuality',
      claimId: 'roi-q-1',
      subject: 'roi:macro-ring',
      claim: 'ROI passes',
      confidence: 1.0,
      authority: 'deterministic'
    };
    graph.add(e);
    expect(graph.getBySubject('roi:macro-ring')).toHaveLength(1);
    expect(graph.getBySubject('global')).toHaveLength(0);
  });

  it('blocks evidence by claimId with reason', () => {
    const graph = new EvidenceGraph();
    const e: Evidence = {
      source: 'modelJudge',
      claimId: 'model-claim-1',
      subject: 'roi:ring',
      claim: 'Model says pass',
      confidence: 0.8,
      authority: 'model'
    };
    graph.add(e);
    graph.block('model-claim-1', 'SOURCE_CONTRADICTION');
    const blocked = graph.getAll().find((ev) => ev.claimId === 'model-claim-1');
    expect(blocked?.blocked).toBe(true);
    expect(blocked?.blockReason).toBe('SOURCE_CONTRADICTION');
  });

  it('getAll returns all items', () => {
    const graph = new EvidenceGraph();
    graph.add({ source: 'a', claimId: 'c1', subject: 'global', claim: 'x', confidence: 1, authority: 'deterministic' });
    graph.add({ source: 'b', claimId: 'c2', subject: 'global', claim: 'y', confidence: 1, authority: 'deterministic' });
    expect(graph.getAll()).toHaveLength(2);
  });
});

describe('EvidenceBundleBuilder', () => {
  it('builds a bundle per ROI', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'roiQuality',
      claimId: 'roi-quality-ring1',
      subject: 'roi:ring1',
      claim: 'ROI passes',
      confidence: 1.0,
      authority: 'deterministic'
    });

    const ctx = makeContext({
      regionsOfInterest: [{
        id: 'ring1',
        label: 'Ring 1',
        type: 'component',
        box: { x: 0, y: 0, width: 10, height: 10 }
      }]
    });

    const builder = new EvidenceBundleBuilder();
    const bundles = builder.build(ctx, graph);
    expect(bundles.some((b) => b.roiId === 'ring1')).toBe(true);
    const ringBundle = bundles.find((b) => b.roiId === 'ring1')!;
    expect(ringBundle.deterministicFindings).toContain('roi-quality-ring1');
  });

  it('creates a global bundle for global evidence', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'pixelDiff',
      claimId: 'global-pixel-diff',
      subject: 'global',
      claim: 'diff 0.1%',
      confidence: 1.0,
      authority: 'deterministic'
    });

    const ctx = makeContext({ regionsOfInterest: [] });
    const builder = new EvidenceBundleBuilder();
    const bundles = builder.build(ctx, graph);
    const globalBundle = bundles.find((b) => b.roiId === 'global');
    expect(globalBundle).toBeDefined();
    expect(globalBundle!.deterministicFindings).toContain('global-pixel-diff');
  });

  it('does not include blocked evidence in deterministicFindings', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'roiQuality',
      claimId: 'roi-quality-ring2',
      subject: 'roi:ring2',
      claim: 'blocked claim',
      confidence: 1.0,
      authority: 'deterministic'
    });
    graph.block('roi-quality-ring2', 'SOURCE_CONTRADICTION');

    const ctx = makeContext({
      regionsOfInterest: [{
        id: 'ring2',
        label: 'Ring 2',
        type: 'component',
        box: { x: 0, y: 0, width: 10, height: 10 }
      }]
    });

    const builder = new EvidenceBundleBuilder();
    const bundles = builder.build(ctx, graph);
    const bundle = bundles.find((b) => b.roiId === 'ring2')!;
    expect(bundle.deterministicFindings).not.toContain('roi-quality-ring2');
  });
});

describe('Stage ordering enforcement', () => {
  it('ModelJudgeAnalyzer.run requires EvidenceBundle[] parameter (type-level enforcement)', async () => {
    const judge = new ModelJudgeAnalyzer({ enabled: false });
    const ctx = makeContext();
    const graph = new EvidenceGraph();
    // Must pass bundles (even empty) — disabled config returns immediately
    const result = await judge.run(ctx, graph, []);
    expect(result.evidence).toHaveLength(0);
    expect(result.analyzerName).toBe('ModelJudgeAnalyzer');
  });

  it('disabled model judges return empty result immediately', async () => {
    const judge = new ModelJudgeAnalyzer({ enabled: false });
    const ctx = makeContext();
    const graph = new EvidenceGraph();
    const bundles: any[] = [];
    const result = await judge.run(ctx, graph, bundles);
    expect(result.evidence).toHaveLength(0);
    // disabled without explicitSkipReason emits advisory warning — no blocking ActionRequired
    expect(result.actionRequired).toBeUndefined();
  });

  it('radialGeometry evidence is present in graph before ModelJudgeAnalyzer runs (stage ordering)', async () => {
    // Simulate the pipeline stage order:
    // Stage 1c (RadialGeometryAnalyzer) → Stage 1.5 (EvidenceBundleBuilder) → Stage 2 (ModelJudgeAnalyzer)
    // This test proves that if radial evidence is added before bundle-building,
    // it will appear in bundles passed to ModelJudgeAnalyzer.
    const graph = new EvidenceGraph();

    // Simulate RadialGeometryAnalyzer output (Stage 1c)
    graph.add({
      source: 'radialGeometry',
      claimId: 'radial-geometry-ring',
      subject: 'roi:ring',
      claim: 'Radial chart: strokeWidthMismatch',
      confidence: 0.9,
      authority: 'deterministic',
      measurements: { verdict: 'strokeWidthMismatch', status: 'fail', confidence: 0.9 }
    });

    const ctx = makeContext({
      regionsOfInterest: [{
        id: 'ring',
        label: 'Ring',
        type: 'component',
        box: { x: 0, y: 0, width: 10, height: 10 }
      }]
    });

    // Stage 1.5: build bundles — radialGeometry is deterministic, ends up in deterministicEvidence
    const builder = new EvidenceBundleBuilder();
    const bundles = builder.build(ctx, graph);
    const ringBundle = bundles.find((b) => b.roiId === 'ring')!;

    expect(ringBundle).toBeDefined();
    expect(ringBundle.deterministicEvidence.some((e) => e.source === 'radialGeometry')).toBe(true);

    // Stage 2: ModelJudgeAnalyzer receives bundles WITH radial evidence already populated
    const judge = new ModelJudgeAnalyzer({ enabled: true, policy: 'always' });
    // policy=always but no API key → returns actionRequired, not an error
    const result = await judge.run(ctx, graph, bundles);
    // The key assertion: radialGeometry was available in the bundle before the judge ran
    expect(ringBundle.deterministicFindings).toContain('radial-geometry-ring');
  });
});
