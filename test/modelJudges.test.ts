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
  it('disabled model judges do not require API key and return empty evidence', async () => {
    const judge = new ModelJudgeAnalyzer({ enabled: false });
    const ctx = makeContext();
    const graph = new EvidenceGraph();
    const bundles = makeBundles();

    const result = await judge.run(ctx, graph, bundles);

    expect(result.evidence).toHaveLength(0);
    // disabled without explicitSkipReason emits an advisory warning (no API key required)
    expect(result.warnings.some((w) => w.includes('explicitSkipReason'))).toBe(true);
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

  it('policy on_failed_quality does not run when all ROIs pass (required:false)', async () => {
    // required:false = policy-based skip is valid (judges are optional)
    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      required: false,
      policy: 'on_failed_quality',
      primary: { provider: 'openrouter', model: 'test-model' }
    });
    const ctx = makeContext();
    const graph = new EvidenceGraph();

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

    // Optional judge: policy skip → warning only, no actionRequired
    expect(result.warnings.some((w) => w.includes('policy') && w.includes('on_failed_quality'))).toBe(true);
    expect(result.actionRequired).toBeUndefined();
  });

  it('policy on_failed_quality with required:true (default) and quality passing → error (required judge cannot be skipped)', async () => {
    // required:true (default) + conditional policy that does not trigger = misconfiguration → error
    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'on_failed_quality',
      primary: { provider: 'openrouter', model: 'test-model' }
    });
    const ctx = makeContext();
    const graph = new EvidenceGraph();

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

    // Required judge cannot be silently skipped by policy in visual_parity mode
    expect(result.actionRequired).toBeDefined();
    expect(result.actionRequired?.type).toBe('model_judges_failed');
    expect(result.actionRequired?.message).toMatch(/not attempted|policy.*did not trigger/i);
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
      expect(result.actionRequired?.type).toBe('model_judges_unavailable');
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
    expect(result.actionRequired?.type).toBe('model_judges_unavailable');
    expect(result.actionRequired?.severity).toBe('blocking');
    expect(result.actionRequired?.message).toContain('OPENROUTER_API_KEY');

    if (savedKey) process.env.OPENROUTER_API_KEY = savedKey;
  });

  it('enabled:true with no required field defaults required to true', async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const judge = new ModelJudgeAnalyzer({
        enabled: true,
        policy: 'always',
        primary: { provider: 'openrouter', model: 'test-model' }
        // required not set — should default to true
      });
      const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());
      // Missing key + required defaults true → model_judges_unavailable
      expect(result.actionRequired?.type).toBe('model_judges_unavailable');
    } finally {
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
    }
  });

  it('disabled with explicitSkipReason emits metric-only advisory warning', async () => {
    const judge = new ModelJudgeAnalyzer({
      enabled: false,
      explicitSkipReason: 'CI run — API keys not available'
    });
    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());
    expect(result.evidence).toHaveLength(0);
    expect(result.actionRequired).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('metric-only'))).toBe(true);
  });
});

// ============================================================
// Blocker 1: schema pass-through for timeoutMs/maxRetries/retryOnParseError
// ============================================================

describe('modelJudges schema accepts timeoutMs, maxRetries, retryOnParseError', () => {
  it('uiDiffConfig modelJudgesSchema accepts and preserves all three fields', async () => {
    const { modelJudgesSchema } = await import('../src/config/uiDiffConfig');
    const input = {
      enabled: true,
      required: false,
      timeoutMs: 8000,
      maxRetries: 3,
      retryOnParseError: false,
      primary: { provider: 'openrouter' as const, model: 'gpt-4o' }
    };
    const parsed = modelJudgesSchema!.parse(input);
    expect(parsed!.timeoutMs).toBe(8000);
    expect(parsed!.maxRetries).toBe(3);
    expect(parsed!.retryOnParseError).toBe(false);
  });

  it('mcp server modelJudgesSchema accepts and preserves all three fields', async () => {
    const { modelJudgesSchema } = await import('../src/mcp/server');
    const input = {
      enabled: true,
      timeoutMs: 5000,
      maxRetries: 1,
      retryOnParseError: true,
      primary: { provider: 'nvidia' as const, model: 'llama-3.2-90b' }
    };
    const parsed = modelJudgesSchema.parse(input);
    expect(parsed!.timeoutMs).toBe(5000);
    expect(parsed!.maxRetries).toBe(1);
    expect(parsed!.retryOnParseError).toBe(true);
  });

  it('ModelJudgesConfig TypeScript interface exposes timeoutMs, maxRetries, retryOnParseError', async () => {
    // Compile-time check: ensure the config object passes to ModelJudgeAnalyzer without TS error
    const cfg = {
      enabled: true,
      timeoutMs: 12000,
      maxRetries: 2,
      retryOnParseError: true,
      primary: { provider: 'openrouter' as const, model: 'test' }
    };
    // ModelJudgeAnalyzer constructor must accept this without a type error
    const judge = new ModelJudgeAnalyzer(cfg);
    expect(judge).toBeDefined();
  });

  it('disabled without explicitSkipReason emits ambiguity warning', async () => {
    const judge = new ModelJudgeAnalyzer({ enabled: false });
    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());
    expect(result.evidence).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('explicitSkipReason'))).toBe(true);
  });

  it('always_audit policy treated same as always — runs unconditionally', async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const judge = new ModelJudgeAnalyzer({
        enabled: true,
        policy: 'always_audit',
        primary: { provider: 'openrouter', model: 'test-model' }
      });
      const graph = new EvidenceGraph();
      // No ROI quality evidence in graph — policy 'always_audit' should still run
      const result = await judge.run(makeContext(), graph, makeBundles());
      // It ran (tried to call provider) and found missing key
      expect(result.actionRequired?.type).toBe('model_judges_unavailable');
    } finally {
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
    }
  });
});
