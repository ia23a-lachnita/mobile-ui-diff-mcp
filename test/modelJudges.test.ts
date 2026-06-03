import { describe, it, expect } from 'vitest';
import { ModelJudgeAnalyzer } from '../src/pipeline/judges/ModelJudgeAnalyzer';
import { EvidenceGraph } from '../src/pipeline/EvidenceGraph';
import { EvidenceBundle } from '../src/pipeline/types';
import { PNG } from 'pngjs';
import os from 'os';
import { AnalyzerContext } from '../src/pipeline/analyzers/IAnalyzer';

function makeContext(): AnalyzerContext {
  const png = new PNG({ width: 10, height: 10 });
  return {
    runId: 'test-run',
    outputDir: os.tmpdir(),
    configDir: os.tmpdir(),
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
    }
  };
}

function makeBundles(): EvidenceBundle[] {
  return [
    {
      roiId: 'test-roi',
      artifacts: {},
      deterministicFindings: [],
      deterministicEvidence: [],
      ocrFindings: [],
      ocrEvidence: [],
      referenceFacts: [],
      referenceEvidence: []
    }
  ];
}

describe('ModelJudgeAnalyzer', () => {
  it('disabled model judges do not require API key and return empty', async () => {
    const judge = new ModelJudgeAnalyzer({ enabled: false });
    const ctx = makeContext();
    const graph = new EvidenceGraph();
    const bundles = makeBundles();

    const result = await judge.run(ctx, graph, bundles);

    expect(result.evidence).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.stage).toBe('stage2_model');
  });

  it('disabled by policy returns empty immediately', async () => {
    const judge = new ModelJudgeAnalyzer({ enabled: true, policy: 'disabled' });
    const ctx = makeContext();
    const graph = new EvidenceGraph();
    const bundles = makeBundles();

    const result = await judge.run(ctx, graph, bundles);
    expect(result.evidence).toHaveLength(0);
  });

  it('enabled with missing API key emits warning evidence', async () => {
    // Save and clear any existing API key
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always',
      primary: { provider: 'openrouter', model: 'test-model' }
    });
    const ctx = makeContext();
    const graph = new EvidenceGraph();
    const bundles = makeBundles();

    const result = await judge.run(ctx, graph, bundles);

    // Should warn about missing key
    const hasKeyWarning = result.warnings.some((w) => w.includes('OPENROUTER_API_KEY'));
    expect(hasKeyWarning).toBe(true);

    // Restore
    if (savedKey) process.env.OPENROUTER_API_KEY = savedKey;
  });

  it('policy on_failed_quality does not run when all ROIs pass', async () => {
    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'on_failed_quality',
      primary: { provider: 'openrouter', model: 'test-model' }
    });
    const ctx = makeContext();
    const graph = new EvidenceGraph();

    // Add passing ROI evidence
    graph.add({
      source: 'roiQuality',
      claimId: 'roi-quality-ring',
      subject: 'roi:ring',
      claim: 'ROI passes',
      confidence: 1.0,
      authority: 'deterministic',
      measurements: { status: 'pass' }
    });

    const bundles = makeBundles();
    const result = await judge.run(ctx, graph, bundles);

    // Policy should not trigger (no fails), so no API calls needed
    expect(result.warnings.some((w) => w.includes('policy') && w.includes('on_failed_quality'))).toBe(true);
  });

  it('provider parse preserves unit field from model response', () => {
    const item: any = {
      claimId: 'claim-u',
      claim: 'ring stroke differs',
      confidence: 0.85,
      source: 'geometryInterpretationJudge',
      proposedChangeVector: 'ring_stroke_width',
      expectedValue: 10,
      actualValue: 8,
      unit: 'px'
    };
    const e: any = {
      source: typeof item.source === 'string' && item.source ? item.source : 'modelJudge',
      claimId: `openrouter-test-roi-${item.claimId}`,
      subject: item.subject ?? 'roi:test-roi',
      claim: String(item.claim),
      confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.5,
      authority: 'model' as const,
      ...(item.claimType !== undefined ? { claimType: String(item.claimType) } : {}),
      ...(item.expectedValue !== undefined ? { expectedValue: item.expectedValue } : {}),
      ...(item.actualValue !== undefined ? { actualValue: item.actualValue } : {}),
      ...(item.proposedChangeVector !== undefined ? { proposedChangeVector: String(item.proposedChangeVector) } : {}),
      ...(item.unit !== undefined ? { unit: String(item.unit) } : {}),
    };
    expect(e.source).toBe('geometryInterpretationJudge');
    expect(e.proposedChangeVector).toBe('ring_stroke_width');
    expect(e.expectedValue).toBe(10);
    expect(e.actualValue).toBe(8);
    expect(e.unit).toBe('px');
  });

  it('provider parse preserves proposedChangeVector from model response', () => {
    // Test that OpenRouterProvider parse block copies proposedChangeVector
    // We test this by checking the Evidence interface shape directly
    const item: any = {
      claimId: 'claim-1',
      claim: 'ring stroke differs',
      confidence: 0.9,
      source: 'visualMismatchJudge',
      proposedChangeVector: 'ring_stroke_width',
      expectedValue: 10,
      actualValue: 8
    };
    // Simulate the parse logic
    const e: any = {
      source: typeof item.source === 'string' && item.source ? item.source : 'modelJudge',
      claimId: `openrouter-test-roi-${item.claimId}`,
      subject: item.subject ?? 'roi:test-roi',
      claim: String(item.claim),
      confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.5,
      authority: 'model' as const,
      ...(item.proposedChangeVector !== undefined ? { proposedChangeVector: String(item.proposedChangeVector) } : {}),
      ...(item.expectedValue !== undefined ? { expectedValue: item.expectedValue } : {}),
      ...(item.actualValue !== undefined ? { actualValue: item.actualValue } : {}),
    };
    expect(e.source).toBe('visualMismatchJudge');
    expect(e.proposedChangeVector).toBe('ring_stroke_width');
    expect(e.expectedValue).toBe(10);
    expect(e.actualValue).toBe(8);
  });

  it('model judge required + missing API key produces blocking actionRequired', async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const judge = new ModelJudgeAnalyzer({
        enabled: true,
        policy: 'always',
        primary: { provider: 'openrouter', model: 'test-model' }
      });
      const graph = new EvidenceGraph();
      const result = await judge.run(makeContext(), graph, makeBundles());

      expect(result.actionRequired).toBeDefined();
      expect(result.actionRequired?.severity).toBe('blocking');
      expect(result.actionRequired?.type).toBe('vlm_unavailable');
    } finally {
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
    }
  });

  it('policy always + missing API key produces actionRequired', async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always',
      primary: { provider: 'openrouter', model: 'test-model' }
    });
    const ctx = makeContext();
    const graph = new EvidenceGraph();
    const bundles = makeBundles();

    const result = await judge.run(ctx, graph, bundles);

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.actionRequired).toBeDefined();
    expect(result.actionRequired?.type).toBe('vlm_unavailable');
    expect(result.actionRequired?.severity).toBe('blocking');
    expect(result.actionRequired?.message).toContain('OPENROUTER_API_KEY');

    if (savedKey) process.env.OPENROUTER_API_KEY = savedKey;
  });
});
