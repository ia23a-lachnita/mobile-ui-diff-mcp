import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterProvider } from '../src/pipeline/judges/providers/OpenRouterProvider';
import { NvidiaProvider } from '../src/pipeline/judges/providers/NvidiaProvider';
import { EvidenceBundle } from '../src/pipeline/types';
import type { CriterionAuditBundle } from '../src/types';

function makeBundle(roiId = 'macro-ring-hero'): EvidenceBundle {
  return {
    roiId,
    artifacts: {},
    deterministicFindings: [],
    deterministicEvidence: [],
    ocrFindings: [],
    ocrEvidence: [],
    referenceFacts: [],
    referenceEvidence: []
  };
}

function makeOkResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => content
  };
}

function makeErrorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    text: async () => body,
    json: async () => ({})
  };
}

describe('OpenRouterProvider — real provider with mocked fetch', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves all structured fields from model response', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'stroke-width-too-large',
        subject: 'roi:macro-ring-hero',
        polarity: 'mismatch',
        claim: 'Actual stroke is wider than source spec.',
        confidence: 0.9,
        source: 'geometryInterpretationJudge',
        claimType: 'strokeWidth',
        expectedValue: 10,
        actualValue: 18,
        unit: 'px',
        proposedChangeVector: 'ring_stroke_width',
        measurements: { expectedStroke: 10, actualStroke: 18 }
      }]
    });

    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);

    expect(result).toHaveLength(1);
    const e = result[0];
    expect(e.source).toBe('geometryInterpretationJudge');
    expect(e.claimType).toBe('strokeWidth');
    expect(e.expectedValue).toBe(10);
    expect(e.actualValue).toBe(18);
    expect(e.unit).toBe('px');
    expect(e.proposedChangeVector).toBe('ring_stroke_width');
    expect((e.measurements as any)?.expectedStroke).toBe(10);
    expect((e.measurements as any)?.actualStroke).toBe(18);
    expect(e.authority).toBe('model');
  });

  it('preserves source role: visualMismatchJudge', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'visual-mismatch',
        claim: 'Visual mismatch detected',
        polarity: 'mismatch',
        confidence: 0.8,
        source: 'visualMismatchJudge'
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].source).toBe('visualMismatchJudge');
  });

  it('preserves source role: geometryInterpretationJudge', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'geometry-finding',
        claim: 'Ring geometry differs',
        polarity: 'mismatch',
        confidence: 0.85,
        source: 'geometryInterpretationJudge'
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].source).toBe('geometryInterpretationJudge');
  });

  it('preserves source role: adversarialReviewer', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'counter-claim',
        claim: 'No meaningful mismatch',
        polarity: 'match',
        confidence: 0.7,
        source: 'adversarialReviewer'
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].source).toBe('adversarialReviewer');
  });

  it('preserves source role: sourceAwareReviewer', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'source-corroboration',
        claim: 'Corroborates reference facts',
        polarity: 'match',
        confidence: 0.85,
        source: 'sourceAwareReviewer'
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].source).toBe('sourceAwareReviewer');
  });

  it('falls back to modelJudge when source field is absent', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'no-source-claim',
        claim: 'Something happened',
        polarity: 'mismatch',
        confidence: 0.6
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].source).toBe('modelJudge');
  });

  it('returns safe error evidence on malformed JSON — no crash', async () => {
    // Two calls: first attempt + one retry (maxRetries=1)
    mockFetch.mockResolvedValue(makeOkResponse('this is not { valid json'));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle('test-roi'), []);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].confidence).toBe(0);
    expect(result[0].authority).toBe('model');
    expect(result[0].proposedChangeVector).toBeUndefined();
  });

  it('returns error evidence on HTTP error — no crash', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(503, 'Service Unavailable'));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle('roi-x'), []);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].confidence).toBe(0);
    expect(result[0].claim).toMatch(/failed/i);
    expect(result[0].proposedChangeVector).toBeUndefined();
  });

  it('drops unknown proposedChangeVector — does not allow arbitrary strings', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'bad-vector',
        claim: 'Some finding',
        polarity: 'mismatch',
        confidence: 0.8,
        source: 'visualMismatchJudge',
        proposedChangeVector: 'hack_the_system_xyz'
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].proposedChangeVector).toBeUndefined();
  });

  it('preserves valid proposedChangeVector from model response', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'valid-vector',
        claim: 'Ring stroke differs',
        polarity: 'mismatch',
        confidence: 0.8,
        source: 'geometryInterpretationJudge',
        proposedChangeVector: 'ring_stroke_width'
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].proposedChangeVector).toBe('ring_stroke_width');
  });

  it('skips items missing claimId or claim', async () => {
    const responseBody = JSON.stringify({
      evidence: [
        { claim: 'missing claimId', confidence: 0.5, source: 'visualMismatchJudge' },
        { claimId: 'missing-claim', confidence: 0.5, source: 'visualMismatchJudge' },
        { claimId: 'complete', claim: 'Valid item', polarity: 'mismatch', confidence: 0.9, source: 'visualMismatchJudge' }
      ]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result).toHaveLength(1);
    expect(result[0].claim).toBe('Valid item');
  });

  it('clamps confidence to [0, 1]', async () => {
    const responseBody = JSON.stringify({
      evidence: [
        { claimId: 'over', claim: 'Over', polarity: 'mismatch', confidence: 5.0, source: 'visualMismatchJudge' },
        { claimId: 'under', claim: 'Under', polarity: 'mismatch', confidence: -2.0, source: 'visualMismatchJudge' }
      ]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].confidence).toBe(1);
    expect(result[1].confidence).toBe(0);
  });

  it('missing polarity triggers parse error and retry', async () => {
    const badResponse = JSON.stringify({
      evidence: [{ claimId: 'no-polarity', claim: 'Something', confidence: 0.9 }]
    });
    // Need two calls: initial + one retry
    mockFetch.mockResolvedValue(makeOkResponse(badResponse));
    const provider = new OpenRouterProvider('test-key', 'test-model', 45000, 1, true);
    const result = await provider.analyze(makeBundle('roi-a'), []);
    expect(mockFetch).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(result[0].measurements).toMatchObject({
      error: 'retry_exhausted',
      failureReason: 'retry_exhausted',
      rawResponsePreview: badResponse.slice(0, 200)
    });
    expect(String(result[0].measurements?.schemaErrorPreview)).toContain('polarity');
  });

  it('schema mismatch without retry preserves schema_parse_error diagnostic', async () => {
    const badResponse = JSON.stringify({
      evidence: [{ claimId: 'no-polarity', claim: 'Something', confidence: 0.9 }]
    });
    mockFetch.mockResolvedValue(makeOkResponse(badResponse));
    const provider = new OpenRouterProvider('test-key', 'test-model', 45000, 1, false);
    const result = await provider.analyze(makeBundle('roi-schema'), []);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result[0].measurements).toMatchObject({
      error: 'schema_parse_error',
      failureReason: 'schema_parse_error',
      rawResponsePreview: badResponse.slice(0, 200)
    });
    expect(String(result[0].measurements?.schemaErrorPreview)).toContain('polarity');
  });

  it('invalid polarity triggers parse error', async () => {
    const badResponse = JSON.stringify({
      evidence: [{ claimId: 'bad-polarity', claim: 'Something', polarity: 'bad_value', confidence: 0.9 }]
    });
    mockFetch.mockResolvedValue(makeOkResponse(badResponse));
    const provider = new OpenRouterProvider('test-key', 'test-model', 45000, 1, true);
    const result = await provider.analyze(makeBundle('roi-b'), []);
    expect(result[0].measurements).toMatchObject({
      error: 'retry_exhausted',
      failureReason: 'retry_exhausted',
      rawResponsePreview: badResponse.slice(0, 200)
    });
  });

  it('maxRetries=0 returns parse error without retrying', async () => {
    const badResponse = JSON.stringify({
      evidence: [{ claimId: 'no-polarity', claim: 'Something', confidence: 0.9 }]
    });
    mockFetch.mockResolvedValue(makeOkResponse(badResponse));
    const provider = new OpenRouterProvider('test-key', 'test-model', 45000, 0, true);
    const result = await provider.analyze(makeBundle('roi-c'), []);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result[0].measurements).toMatchObject({
      error: 'schema_parse_error',
      failureReason: 'schema_parse_error',
      rawResponsePreview: badResponse.slice(0, 200)
    });
  });

  it('retryOnParseError=false skips retry on parse error', async () => {
    const badResponse = JSON.stringify({
      evidence: [{ claimId: 'no-polarity', claim: 'Something', confidence: 0.9 }]
    });
    mockFetch.mockResolvedValue(makeOkResponse(badResponse));
    const provider = new OpenRouterProvider('test-key', 'test-model', 45000, 1, false);
    const result = await provider.analyze(makeBundle('roi-d'), []);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result[0].measurements).toMatchObject({
      error: 'schema_parse_error',
      failureReason: 'schema_parse_error',
      rawResponsePreview: badResponse.slice(0, 200)
    });
  });

  it('high-confidence mismatch without explicit blocking:true is non-blocking', async () => {
    // evidenceToVisualCaveat is in ModelJudgeAnalyzer, but here we verify
    // the provider preserves blocking:false from the model response
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'high-conf-no-block',
        claim: 'High confidence finding but not blocking',
        polarity: 'mismatch',
        confidence: 0.95,
        blocking: false,
        source: 'visualMismatchJudge'
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect((result[0] as any).blocking).toBe(false);
    expect(result[0].confidence).toBe(0.95);
  });

  it('explicit blocking:true mismatch is preserved', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'explicit-block',
        claim: 'Confirmed mismatch',
        polarity: 'mismatch',
        confidence: 0.9,
        blocking: true,
        source: 'visualMismatchJudge'
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect((result[0] as any).blocking).toBe(true);
  });
});

describe('NvidiaProvider — real provider with mocked fetch', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves all structured fields from model response', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'radius-too-small',
        subject: 'roi:macro-ring',
        polarity: 'mismatch',
        claim: 'Ring radius is smaller than expected.',
        confidence: 0.88,
        source: 'geometryInterpretationJudge',
        claimType: 'radiusMismatch',
        expectedValue: 100,
        actualValue: 92,
        unit: 'px',
        proposedChangeVector: 'ring_radius_size',
        measurements: { expectedRadius: 100, actualRadius: 92 }
      }]
    });

    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new NvidiaProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle('macro-ring'), []);

    expect(result).toHaveLength(1);
    const e = result[0];
    expect(e.source).toBe('geometryInterpretationJudge');
    expect(e.claimType).toBe('radiusMismatch');
    expect(e.expectedValue).toBe(100);
    expect(e.actualValue).toBe(92);
    expect(e.unit).toBe('px');
    expect(e.proposedChangeVector).toBe('ring_radius_size');
    expect((e.measurements as any)?.expectedRadius).toBe(100);
    expect(e.authority).toBe('model');
  });

  it('preserves adversarialReviewer source role', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'challenge-1',
        claim: 'Counter-evidence: difference is within tolerance',
        polarity: 'match',
        confidence: 0.7,
        source: 'adversarialReviewer'
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new NvidiaProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].source).toBe('adversarialReviewer');
  });

  it('falls back to modelJudge when source is absent', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'no-src',
        claim: 'No source role set',
        polarity: 'mismatch',
        confidence: 0.5
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new NvidiaProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].source).toBe('modelJudge');
  });

  it('returns safe error evidence on malformed JSON — no crash', async () => {
    mockFetch.mockResolvedValue(makeOkResponse('{ bad json >>>'));
    const provider = new NvidiaProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle('test-roi'), []);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].confidence).toBe(0);
    expect(result[0].authority).toBe('model');
    expect(result[0].proposedChangeVector).toBeUndefined();
  });

  it('returns error evidence on HTTP error — no crash', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(429, 'Rate limited'));
    const provider = new NvidiaProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle('roi-y'), []);
    expect(result[0].confidence).toBe(0);
    expect(result[0].claim).toMatch(/failed/i);
  });

  it('drops unknown proposedChangeVector — does not allow arbitrary strings', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'bad-cv',
        claim: 'Some finding',
        polarity: 'mismatch',
        confidence: 0.75,
        source: 'adversarialReviewer',
        proposedChangeVector: '__invalid__vector__'
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new NvidiaProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].proposedChangeVector).toBeUndefined();
  });

  it('preserves valid proposedChangeVector from model response', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'valid-cv',
        claim: 'Ring gap differs',
        polarity: 'mismatch',
        confidence: 0.8,
        source: 'geometryInterpretationJudge',
        proposedChangeVector: 'ring_gap'
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new NvidiaProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].proposedChangeVector).toBe('ring_gap');
  });

  it('prefixes claimId with nvidia-<roiId>-', async () => {
    const responseBody = JSON.stringify({
      evidence: [{
        claimId: 'my-claim',
        claim: 'Test claim',
        polarity: 'mismatch',
        confidence: 0.8,
        source: 'adversarialReviewer'
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new NvidiaProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle('my-roi'), []);
    expect(result[0].claimId).toBe('nvidia-my-roi-my-claim');
  });

  it('missing polarity triggers parse error and retry', async () => {
    const badResponse = JSON.stringify({
      evidence: [{ claimId: 'no-polarity', claim: 'Something', confidence: 0.9 }]
    });
    mockFetch.mockResolvedValue(makeOkResponse(badResponse));
    const provider = new NvidiaProvider('test-key', 'test-model', 45000, 1, true);
    const result = await provider.analyze(makeBundle('roi-n'), []);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result[0].measurements).toMatchObject({ error: 'parse_error_after_retry' });
  });

  it('maxRetries honored — retries up to configured limit', async () => {
    const badResponse = JSON.stringify({
      evidence: [{ claimId: 'no-polarity', claim: 'No polarity', confidence: 0.9 }]
    });
    mockFetch.mockResolvedValue(makeOkResponse(badResponse));
    const provider = new NvidiaProvider('test-key', 'test-model', 45000, 3, true);
    await provider.analyze(makeBundle('roi-retry'), []);
    expect(mockFetch).toHaveBeenCalledTimes(4); // initial + 3 retries
  });
});

// ─── analyzeCriteriaBatch visual evidence ────────────────────────────────────

function makeCriterionBundle(
  criterionId: string,
  artifactOverrides: Partial<CriterionAuditBundle['artifacts']> = {}
): CriterionAuditBundle {
  return {
    criterionId,
    targetId: 'target-a',
    criterionLabel: `Label ${criterionId}`,
    artifacts: { ...artifactOverrides }
  };
}

function makeBatchOkResponse(criterionIds: string[]): ReturnType<typeof makeOkResponse> {
  return makeOkResponse(JSON.stringify({
    results: criterionIds.map(id => ({
      criterionId: id,
      targetStatus: 'matched',
      judgeAuditStatus: 'pass',
      reasoning: 'ok',
      confidence: 0.9
    }))
  }));
}

// Helper: extract prompt text whether content is a string or multipart array
function extractPromptText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as any[]).find((c) => c.type === 'text')?.text ?? '';
  }
  return '';
}

describe('OpenRouterProvider — analyzeCriteriaBatch image evidence', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('batch prompt IMAGE ORDER includes images 4 and 5 (crops)', async () => {
    mockFetch.mockResolvedValueOnce(makeBatchOkResponse(['crit.a', 'crit.b']));
    const provider = new OpenRouterProvider('key', 'model');
    const packets = [
      makeCriterionBundle('crit.a', { fullExpectedScreen: '/e.png', fullActualScreen: '/a.png', annotatedActualScreen: '/ann.png', expectedCrop: '/ec.png', actualCrop: '/ac.png' }),
      makeCriterionBundle('crit.b', { fullExpectedScreen: '/e.png', fullActualScreen: '/a.png', annotatedActualScreen: '/ann.png', expectedCrop: '/ec.png', actualCrop: '/ac.png' })
    ];

    await provider.analyzeCriteriaBatch(packets);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const textContent = extractPromptText(body.messages[0].content);
    expect(textContent).toMatch(/4\. EXPECTED CROP/);
    expect(textContent).toMatch(/5\. ACTUAL CROP/);
  });

  it('batch with shared diagnostic artifact includes image 6 in prompt', async () => {
    mockFetch.mockResolvedValueOnce(makeBatchOkResponse(['crit.a', 'crit.b']));
    const provider = new OpenRouterProvider('key', 'model');
    const packets = [
      makeCriterionBundle('crit.a', { fullExpectedScreen: '/e.png', fullActualScreen: '/a.png', annotatedActualScreen: '/ann.png', expectedCrop: '/ec.png', actualCrop: '/ac.png', diagnosticArtifact: '/diag.png' }),
      makeCriterionBundle('crit.b', { fullExpectedScreen: '/e.png', fullActualScreen: '/a.png', annotatedActualScreen: '/ann.png', expectedCrop: '/ec.png', actualCrop: '/ac.png', diagnosticArtifact: '/diag.png' })
    ];

    await provider.analyzeCriteriaBatch(packets);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const textContent = extractPromptText(body.messages[0].content);
    expect(textContent).toMatch(/6\. DIAGNOSTIC ARTIFACT.*shared/i);
    expect(textContent).toMatch(/DIAGNOSTIC ARTIFACT: image 6 \(shared\)/);
  });

  it('batch with different per-criterion diagnostics maps each to its own image index', async () => {
    mockFetch.mockResolvedValueOnce(makeBatchOkResponse(['crit.a', 'crit.b']));
    const provider = new OpenRouterProvider('key', 'model');
    const packets = [
      makeCriterionBundle('crit.a', { fullExpectedScreen: '/e.png', fullActualScreen: '/a.png', annotatedActualScreen: '/ann.png', expectedCrop: '/ec.png', actualCrop: '/ac.png', diagnosticArtifact: '/diagA.png' }),
      makeCriterionBundle('crit.b', { fullExpectedScreen: '/e.png', fullActualScreen: '/a.png', annotatedActualScreen: '/ann.png', expectedCrop: '/ec.png', actualCrop: '/ac.png', diagnosticArtifact: '/diagB.png' })
    ];

    await provider.analyzeCriteriaBatch(packets);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const textContent = extractPromptText(body.messages[0].content);
    // Each criterion should reference its own image index (6 and 7)
    expect(textContent).toMatch(/DIAGNOSTIC ARTIFACT: image 6/);
    expect(textContent).toMatch(/DIAGNOSTIC ARTIFACT: image 7/);
    // IMAGE ORDER should list both
    expect(textContent).toMatch(/6\. DIAGNOSTIC ARTIFACT 1/);
    expect(textContent).toMatch(/7\. DIAGNOSTIC ARTIFACT 2/);
  });
});

describe('NvidiaProvider — analyzeCriteriaBatch image evidence', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('batch prompt IMAGE ORDER includes images 4 and 5 (crops)', async () => {
    mockFetch.mockResolvedValueOnce(makeBatchOkResponse(['crit.a', 'crit.b']));
    const provider = new NvidiaProvider('key', 'model');
    const packets = [
      makeCriterionBundle('crit.a', { fullExpectedScreen: '/e.png', fullActualScreen: '/a.png', annotatedActualScreen: '/ann.png', expectedCrop: '/ec.png', actualCrop: '/ac.png' }),
      makeCriterionBundle('crit.b', { fullExpectedScreen: '/e.png', fullActualScreen: '/a.png', annotatedActualScreen: '/ann.png', expectedCrop: '/ec.png', actualCrop: '/ac.png' })
    ];

    await provider.analyzeCriteriaBatch(packets);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const textContent = extractPromptText(body.messages[0].content);
    expect(textContent).toMatch(/4\. EXPECTED CROP/);
    expect(textContent).toMatch(/5\. ACTUAL CROP/);
  });

  it('batch with shared diagnostic includes image 6 in prompt and criterion mapping', async () => {
    mockFetch.mockResolvedValueOnce(makeBatchOkResponse(['crit.x', 'crit.y']));
    const provider = new NvidiaProvider('key', 'model');
    const packets = [
      makeCriterionBundle('crit.x', { fullExpectedScreen: '/e.png', fullActualScreen: '/a.png', annotatedActualScreen: '/ann.png', expectedCrop: '/ec.png', actualCrop: '/ac.png', diagnosticArtifact: '/diag.png' }),
      makeCriterionBundle('crit.y', { fullExpectedScreen: '/e.png', fullActualScreen: '/a.png', annotatedActualScreen: '/ann.png', expectedCrop: '/ec.png', actualCrop: '/ac.png', diagnosticArtifact: '/diag.png' })
    ];

    await provider.analyzeCriteriaBatch(packets);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const textContent = extractPromptText(body.messages[0].content);
    expect(textContent).toMatch(/6\. DIAGNOSTIC ARTIFACT.*shared/i);
  });
});

// ─── judgeCachePath contract ──────────────────────────────────────────────────

describe('judgeCachePath — persistence is opt-in', () => {
  it('CompareImagesInput.judgeCachePath is optional (undefined by default)', () => {
    // Type-level: judgeCachePath is optional — an object without it must be assignable
    const input: import('../src/tools/compareImages').CompareImagesInput = {
      expectedImagePath: '/e.png',
      actualImagePath: '/a.png'
    };
    expect(input.judgeCachePath).toBeUndefined();
  });

  it('JudgeCache with no path loaded stays empty — no disk read attempted on construction', async () => {
    const { JudgeCache } = await import('../src/flutter/judgeCache');
    const cache = new JudgeCache();
    // Without calling loadFromFile, cache must be empty (in-memory only, no side effects)
    const result = cache.get({
      provider: 'openrouter', model: 'test', promptVersion: 'v1',
      targetId: 'tgt', criterionIds: ['c1'], targetMapVersion: '1'
    });
    expect(result).toBeUndefined();
    expect(cache.size()).toBe(0);
  });
});
