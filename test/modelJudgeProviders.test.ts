import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterProvider } from '../src/pipeline/judges/providers/OpenRouterProvider';
import { NvidiaProvider } from '../src/pipeline/judges/providers/NvidiaProvider';
import { EvidenceBundle } from '../src/pipeline/types';

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
        confidence: 0.6
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].source).toBe('modelJudge');
  });

  it('returns safe error evidence on malformed JSON — no crash', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse('this is not { valid json'));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle('test-roi'), []);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].confidence).toBe(0);
    expect(result[0].authority).toBe('model');
    // No proposedChangeVector on error evidence
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
        { claimId: 'complete', claim: 'Valid item', confidence: 0.9, source: 'visualMismatchJudge' }
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
        { claimId: 'over', claim: 'Over', confidence: 5.0, source: 'visualMismatchJudge' },
        { claimId: 'under', claim: 'Under', confidence: -2.0, source: 'visualMismatchJudge' }
      ]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new OpenRouterProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].confidence).toBe(1);
    expect(result[1].confidence).toBe(0);
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
        confidence: 0.5
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new NvidiaProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle(), []);
    expect(result[0].source).toBe('modelJudge');
  });

  it('returns safe error evidence on malformed JSON — no crash', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse('{ bad json >>>'));
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
        confidence: 0.8,
        source: 'adversarialReviewer'
      }]
    });
    mockFetch.mockResolvedValueOnce(makeOkResponse(responseBody));
    const provider = new NvidiaProvider('test-key', 'test-model');
    const result = await provider.analyze(makeBundle('my-roi'), []);
    expect(result[0].claimId).toBe('nvidia-my-roi-my-claim');
  });
});
