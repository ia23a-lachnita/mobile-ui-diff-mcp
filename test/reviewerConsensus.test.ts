import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelJudgeAnalyzer } from '../src/pipeline/judges/ModelJudgeAnalyzer';
import { EvidenceGraph } from '../src/pipeline/EvidenceGraph';
import { EvidenceBundle } from '../src/pipeline/types';
import { PNG } from 'pngjs';
import os from 'os';
import { AnalyzerContext } from '../src/pipeline/analyzers/IAnalyzer';

// Mock providers to control success/failure without real API calls
const mockPrimaryAnalyze = vi.fn();
const mockReviewerAnalyze = vi.fn();

vi.mock('../src/pipeline/judges/providers/OpenRouterProvider', () => ({
  OpenRouterProvider: vi.fn().mockImplementation(function (this: any) {
    this.analyze = mockPrimaryAnalyze;
  })
}));

vi.mock('../src/pipeline/judges/providers/NvidiaProvider', () => ({
  NvidiaProvider: vi.fn().mockImplementation(function (this: any) {
    this.analyze = mockReviewerAnalyze;
  })
}));

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
  return [{
    roiId: 'test-roi',
    artifacts: {},
    deterministicFindings: [],
    deterministicEvidence: [],
    ocrFindings: [],
    ocrEvidence: [],
    referenceFacts: [],
    referenceEvidence: []
  }];
}

const primarySuccessEvidence = [{
  source: 'visualMismatchJudge',
  claimId: 'openrouter-test-roi-visual-diff-1',
  subject: 'roi:test-roi',
  claim: 'Ring stroke width mismatch detected',
  confidence: 0.9,
  authority: 'model' as const
}];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  savedEnv.NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-test-primary-key';
  process.env.NVIDIA_API_KEY = 'sk-test-reviewer-key';
  mockPrimaryAnalyze.mockReset();
  mockReviewerAnalyze.mockReset();
});

afterEach(() => {
  if (savedEnv.OPENROUTER_API_KEY !== undefined) process.env.OPENROUTER_API_KEY = savedEnv.OPENROUTER_API_KEY;
  else delete process.env.OPENROUTER_API_KEY;
  if (savedEnv.NVIDIA_API_KEY !== undefined) process.env.NVIDIA_API_KEY = savedEnv.NVIDIA_API_KEY;
  else delete process.env.NVIDIA_API_KEY;
});

// ---------------------------------------------------------------------------
// Blocker 1: Reviewer errors must fail required visual audit
// ---------------------------------------------------------------------------
describe('Reviewer consensus enforcement (Blocker 1)', () => {
  it('primary success + reviewer runtime error + requireConsensusForCodeHints true → model_judges_failed', async () => {
    mockPrimaryAnalyze.mockResolvedValue(primarySuccessEvidence);
    mockReviewerAnalyze.mockRejectedValue(new Error('HTTP 503: Service Unavailable'));

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' },
      reviewer: { provider: 'nvidia', model: 'reviewer-model' },
      requireConsensusForCodeHints: true
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    expect(result.actionRequired).toBeDefined();
    expect(result.actionRequired?.type).toBe('model_judges_failed');
    expect(result.actionRequired?.severity).toBe('blocking');
    expect(result.judgeHadSuccessfulResults).toBe(true);
  });

  it('primary success + reviewer missing key + requireConsensusForCodeHints true → model_judges_unavailable', async () => {
    delete process.env.NVIDIA_API_KEY; // reviewer provider returns null → missing key
    mockPrimaryAnalyze.mockResolvedValue(primarySuccessEvidence);

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' },
      reviewer: { provider: 'nvidia', model: 'reviewer-model' },
      requireConsensusForCodeHints: true
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    expect(result.actionRequired).toBeDefined();
    expect(result.actionRequired?.type).toBe('model_judges_unavailable');
    expect(result.actionRequired?.severity).toBe('blocking');
  });

  it('primary success + reviewer error + requireConsensusForCodeHints false → warning only, no actionRequired', async () => {
    mockPrimaryAnalyze.mockResolvedValue(primarySuccessEvidence);
    mockReviewerAnalyze.mockRejectedValue(new Error('HTTP 503: Service Unavailable'));

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' },
      reviewer: { provider: 'nvidia', model: 'reviewer-model' },
      requireConsensusForCodeHints: false
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    expect(result.actionRequired).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('reviewer'))).toBe(true);
  });

  it('reviewer error provider errors are marked blocking when requireConsensusForCodeHints true', async () => {
    mockPrimaryAnalyze.mockResolvedValue(primarySuccessEvidence);
    mockReviewerAnalyze.mockRejectedValue(new Error('timeout'));

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' },
      reviewer: { provider: 'nvidia', model: 'reviewer-model' },
      requireConsensusForCodeHints: true
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    const reviewerErrors = (result.judgeProviderErrors ?? []).filter((e) => e.provider === 'nvidia');
    expect(reviewerErrors.length).toBeGreaterThan(0);
    expect(reviewerErrors.every((e) => e.blocking === true)).toBe(true);
  });

  it('reviewer error provider errors are non-blocking when requireConsensusForCodeHints false', async () => {
    mockPrimaryAnalyze.mockResolvedValue(primarySuccessEvidence);
    mockReviewerAnalyze.mockRejectedValue(new Error('timeout'));

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' },
      reviewer: { provider: 'nvidia', model: 'reviewer-model' },
      requireConsensusForCodeHints: false
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    const reviewerErrors = (result.judgeProviderErrors ?? []).filter((e) => e.provider === 'nvidia');
    expect(reviewerErrors.every((e) => e.blocking === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Blocker 2: Model judge findings surfaced as visualCaveats
// ---------------------------------------------------------------------------
describe('Model judge findings surfaced as visualCaveats (Blocker 2)', () => {
  it('high confidence finding (≥0.8) → blocking visualCaveat with severity high', async () => {
    mockPrimaryAnalyze.mockResolvedValue([{
      source: 'visualMismatchJudge',
      claimId: 'openrouter-test-roi-high-conf',
      subject: 'roi:test-roi',
      claim: 'Ring stroke width mismatch detected',
      confidence: 0.9,
      authority: 'model' as const
    }]);

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' }
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    expect(result.visualCaveats).toBeDefined();
    expect(result.visualCaveats!.length).toBeGreaterThan(0);
    const caveat = result.visualCaveats![0];
    expect(caveat.blocking).toBe(true);
    expect(caveat.severity).toBe('high');
    expect(caveat.source).toBe('modelJudge');
    expect(caveat.message).toBe('Ring stroke width mismatch detected');
    expect(caveat.confidence).toBe(0.9);
  });

  it('medium confidence finding (0.5–0.8) → non-blocking visualCaveat with severity medium', async () => {
    mockPrimaryAnalyze.mockResolvedValue([{
      source: 'visualMismatchJudge',
      claimId: 'openrouter-test-roi-medium-conf',
      subject: 'roi:test-roi',
      claim: 'Possible color shift in ring area',
      confidence: 0.6,
      authority: 'model' as const
    }]);

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' }
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    expect(result.visualCaveats).toBeDefined();
    const caveat = result.visualCaveats![0];
    expect(caveat.blocking).toBe(false);
    expect(caveat.severity).toBe('medium');
  });

  it('low confidence finding (<0.5) → non-blocking visualCaveat with severity low', async () => {
    mockPrimaryAnalyze.mockResolvedValue([{
      source: 'visualMismatchJudge',
      claimId: 'openrouter-test-roi-low-conf',
      subject: 'roi:test-roi',
      claim: 'Possible minor variation',
      confidence: 0.3,
      authority: 'model' as const
    }]);

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' }
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    expect(result.visualCaveats).toBeDefined();
    const caveat = result.visualCaveats![0];
    expect(caveat.blocking).toBe(false);
    expect(caveat.severity).toBe('low');
  });

  it('provider error evidence → no visualCaveat emitted', async () => {
    // Provider throws → goes to judgeProviderErrors, not primaryEvidence
    mockPrimaryAnalyze.mockRejectedValue(new Error('Network error'));

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' }
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    expect(result.visualCaveats ?? []).toHaveLength(0);
    expect(result.judgeProviderErrors ?? []).toHaveLength(1);
  });

  it('error-tagged evidence item → no visualCaveat', async () => {
    // Provider returns an item with measurements.error — isProviderErrorEvidence detects it
    mockPrimaryAnalyze.mockResolvedValue([{
      source: 'modelJudge',
      claimId: 'openrouter-error-test-roi',
      subject: 'roi:test-roi',
      claim: 'OpenRouter analysis failed: rate limited',
      confidence: 0,
      authority: 'model' as const,
      measurements: { error: 'rate limited' }
    }]);

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' }
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    expect(result.visualCaveats ?? []).toHaveLength(0);
    expect(result.judgeProviderErrors ?? []).toHaveLength(1);
  });

  it('evidence blocked by consensus (reviewerUnavailable + no ground truth) → no visualCaveat', async () => {
    mockPrimaryAnalyze.mockResolvedValue([{
      source: 'visualMismatchJudge',
      claimId: 'openrouter-test-roi-code-hint',
      subject: 'roi:test-roi',
      claim: 'Ring stroke width needs fix',
      confidence: 0.9,
      authority: 'model' as const,
      proposedChangeVector: 'ring_stroke_width'
    }]);
    mockReviewerAnalyze.mockRejectedValue(new Error('HTTP 503'));

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' },
      reviewer: { provider: 'nvidia', model: 'reviewer-model' },
      requireConsensusForCodeHints: true
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    // Evidence was blocked (no ground truth, reviewer unavailable)
    const caveatsForBlockedItem = (result.visualCaveats ?? []).filter(
      (c) => c.proposedChangeVector === 'ring_stroke_width'
    );
    expect(caveatsForBlockedItem).toHaveLength(0);
  });

  it('proposedChangeVector is preserved on visualCaveat', async () => {
    mockPrimaryAnalyze.mockResolvedValue([{
      source: 'geometryInterpretationJudge',
      claimId: 'openrouter-test-roi-geom-1',
      subject: 'roi:test-roi',
      claim: 'Ring radius off by 2px',
      confidence: 0.85,
      authority: 'model' as const,
      proposedChangeVector: 'ring_outer_radius'
    }]);

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' }
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    expect(result.visualCaveats).toBeDefined();
    expect(result.visualCaveats![0].proposedChangeVector).toBe('ring_outer_radius');
  });

  it('reviewer evidence also surfaces as visualCaveats', async () => {
    mockPrimaryAnalyze.mockResolvedValue([{
      source: 'visualMismatchJudge',
      claimId: 'openrouter-test-roi-primary',
      subject: 'roi:test-roi',
      claim: 'Primary finding',
      confidence: 0.85,
      authority: 'model' as const
    }]);
    mockReviewerAnalyze.mockResolvedValue([{
      source: 'visualMismatchJudge',
      claimId: 'nvidia-test-roi-reviewer',
      subject: 'roi:test-roi',
      claim: 'Reviewer confirms visual issue',
      confidence: 0.9,
      authority: 'model' as const
    }]);

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' },
      reviewer: { provider: 'nvidia', model: 'reviewer-model' }
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    expect(result.visualCaveats).toBeDefined();
    expect(result.visualCaveats!.length).toBe(2);
  });

  it('empty provider response → no visualCaveats', async () => {
    mockPrimaryAnalyze.mockResolvedValue([]);

    const judge = new ModelJudgeAnalyzer({
      enabled: true,
      policy: 'always_audit',
      primary: { provider: 'openrouter', model: 'primary-model' }
    }, 'visual_parity');

    const result = await judge.run(makeContext(), new EvidenceGraph(), makeBundles());

    expect(result.visualCaveats ?? []).toHaveLength(0);
  });
});
