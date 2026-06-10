import { describe, it, expect, vi } from 'vitest';
import { CriterionJudgeAnalyzer } from '../src/pipeline/judges/CriterionJudgeAnalyzer';
import { JudgeCache } from '../src/flutter/judgeCache';
import type { IModelJudgeProvider } from '../src/pipeline/judges/IModelJudge';
import type { CriterionAuditBundle, CriterionJudgeResult } from '../src/types';
import type { Evidence, EvidenceBundle } from '../src/pipeline/types';

function makeBundle(criterionId: string, targetId = 'shared-target'): CriterionAuditBundle {
  return {
    criterionId,
    targetId,
    criterionLabel: `Label for ${criterionId}`,
    criterionDescription: `Contract for ${criterionId}`,
    artifacts: {}
  };
}

function makeResult(criterionId: string, status: CriterionJudgeResult['judgeAuditStatus'] = 'pass'): CriterionJudgeResult {
  return {
    criterionId,
    targetStatus: 'matched',
    judgeAuditStatus: status,
    reasoning: `Result for ${criterionId}`,
    confidence: 0.9
  };
}

function makeMockProvider(overrides: Partial<IModelJudgeProvider> = {}): IModelJudgeProvider {
  return {
    providerName: 'mock',
    analyze: vi.fn().mockResolvedValue([]),
    analyzeCriterion: vi.fn().mockImplementation(async (p: CriterionAuditBundle) => makeResult(p.criterionId)),
    ...overrides
  };
}

describe('CriterionJudgeAnalyzer — batch path', () => {
  it('multiple criteria for same target produce ONE primary provider call when batch is supported', async () => {
    const batchFn = vi.fn().mockImplementation(async (packets: CriterionAuditBundle[]) =>
      packets.map((p) => makeResult(p.criterionId))
    );
    const primary = makeMockProvider({ analyzeCriteriaBatch: batchFn });

    const analyzer = new CriterionJudgeAnalyzer();
    const bundles = [
      makeBundle('crit.text', 'target-a'),
      makeBundle('crit.legibility', 'target-a'),
      makeBundle('crit.layout', 'target-a')
    ];

    await analyzer.run(bundles, primary);

    expect(batchFn).toHaveBeenCalledTimes(1);
    expect(batchFn).toHaveBeenCalledWith(bundles);
    expect((primary.analyzeCriterion as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('batch produces ONE reviewer provider call when reviewer supports batch', async () => {
    const primaryBatchFn = vi.fn().mockImplementation(async (packets: CriterionAuditBundle[]) =>
      packets.map((p) => makeResult(p.criterionId))
    );
    const reviewerBatchFn = vi.fn().mockImplementation(async (packets: CriterionAuditBundle[]) =>
      packets.map((p) => makeResult(p.criterionId, 'pass'))
    );
    const primary = makeMockProvider({ analyzeCriteriaBatch: primaryBatchFn });
    const reviewer = makeMockProvider({ analyzeCriteriaBatch: reviewerBatchFn });

    const analyzer = new CriterionJudgeAnalyzer();
    const bundles = [
      makeBundle('crit.a', 'target-x'),
      makeBundle('crit.b', 'target-x')
    ];

    await analyzer.run(bundles, primary, reviewer);

    expect(primaryBatchFn).toHaveBeenCalledTimes(1);
    expect(reviewerBatchFn).toHaveBeenCalledTimes(1);
  });

  it('results map back to each criterion ID correctly', async () => {
    const batchFn = vi.fn().mockImplementation(async (packets: CriterionAuditBundle[]) =>
      packets.map((p) => makeResult(p.criterionId, p.criterionId.includes('text') ? 'fail' : 'pass'))
    );
    const primary = makeMockProvider({ analyzeCriteriaBatch: batchFn });

    const analyzer = new CriterionJudgeAnalyzer();
    const bundles = [makeBundle('crit.text', 'tgt'), makeBundle('crit.icon', 'tgt')];

    const { results } = await analyzer.run(bundles, primary);

    expect(results.get('crit.text')?.final.judgeAuditStatus).toBe('fail');
    expect(results.get('crit.icon')?.final.judgeAuditStatus).toBe('pass');
  });

  it('missing criterion result in batch becomes unavailable/ambiguous', async () => {
    // Batch returns only one result when two were sent
    const batchFn = vi.fn().mockResolvedValue([makeResult('crit.a')]);
    const primary = makeMockProvider({ analyzeCriteriaBatch: batchFn });

    const analyzer = new CriterionJudgeAnalyzer();
    const bundles = [makeBundle('crit.a', 'tgt'), makeBundle('crit.b', 'tgt')];

    const { results } = await analyzer.run(bundles, primary);

    expect(results.get('crit.a')?.final.judgeAuditStatus).toBe('pass');
    const missing = results.get('crit.b');
    expect(missing).toBeDefined();
    expect(['unavailable', 'not_run'].includes(missing!.final.judgeAuditStatus)).toBe(true);
    expect(['ambiguous', 'not_checked'].includes(missing!.final.targetStatus)).toBe(true);
  });

  it('falls back to sequential when provider has no analyzeCriteriaBatch', async () => {
    const singleFn = vi.fn().mockImplementation(async (p: CriterionAuditBundle) => makeResult(p.criterionId));
    const primary = makeMockProvider({ analyzeCriterion: singleFn });
    // No analyzeCriteriaBatch on this provider

    const analyzer = new CriterionJudgeAnalyzer();
    const bundles = [makeBundle('crit.a', 'tgt'), makeBundle('crit.b', 'tgt')];

    const { results } = await analyzer.run(bundles, primary);

    expect(singleFn).toHaveBeenCalledTimes(2);
    expect(results.size).toBe(2);
  });

  it('cacheSummary.fresh reflects batch results correctly', async () => {
    const batchFn = vi.fn().mockImplementation(async (packets: CriterionAuditBundle[]) =>
      packets.map((p) => makeResult(p.criterionId))
    );
    const primary = makeMockProvider({ analyzeCriteriaBatch: batchFn });
    const cache = new JudgeCache();

    const analyzer = new CriterionJudgeAnalyzer();
    const bundles = [makeBundle('crit.x', 'tgt'), makeBundle('crit.y', 'tgt')];

    const { cacheSummary } = await analyzer.run(bundles, primary, undefined, cache);

    expect(cacheSummary.attempted).toBe(2);
    expect(cacheSummary.fresh).toBe(2);
    expect(cacheSummary.cached).toBe(0);
  });
});

describe('CriterionJudgeAnalyzer — cache provenance on hit', () => {
  it('cache hit preserves primary and reviewer provenance in CriterionDualResult', async () => {
    const cache = new JudgeCache();
    const primary = makeMockProvider();
    const analyzer = new CriterionJudgeAnalyzer();
    const bundle = makeBundle('crit.prov', 'tgt');

    const cacheCtx = {
      provider: 'openrouter',
      model: 'gpt-4o',
      reviewerProvider: 'nvidia',
      reviewerModel: 'llama-vision',
      promptVersion: 'v1',
      targetMapVersion: '1'
    };

    // Run once to populate cache with provenance
    const reviewer = makeMockProvider({
      analyzeCriterion: vi.fn().mockResolvedValue({
        criterionId: 'crit.prov',
        targetStatus: 'matched' as const,
        judgeAuditStatus: 'caveat' as const,
        reasoning: 'reviewer caveat',
        confidence: 0.7
      })
    });

    (primary.analyzeCriterion as ReturnType<typeof vi.fn>).mockResolvedValue({
      criterionId: 'crit.prov',
      targetStatus: 'matched' as const,
      judgeAuditStatus: 'pass' as const,
      reasoning: 'primary pass',
      confidence: 0.95
    });

    await analyzer.run([bundle], primary, reviewer, cache, cacheCtx);

    // Run again — should come from cache
    const { results: cached, cacheSummary } = await analyzer.run([bundle], primary, reviewer, cache, cacheCtx);
    expect(cacheSummary.cached).toBe(1);

    const dual = cached.get('crit.prov');
    expect(dual).toBeDefined();
    expect(dual!.primary.fromCache).toBe(true);
    expect(dual!.primary.judgeAuditStatus).toBe('pass');
    expect(dual!.reviewer?.judgeAuditStatus).toBe('caveat');
    expect(dual!.final).toBeDefined();
  });
});
