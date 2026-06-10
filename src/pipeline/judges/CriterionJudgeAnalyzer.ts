import fs from 'fs/promises';
import { CriterionAuditBundle, CriterionJudgeResult } from '../../types';
import { IModelJudgeProvider } from './IModelJudge';
import { OpenRouterProvider } from './providers/OpenRouterProvider';
import { NvidiaProvider } from './providers/NvidiaProvider';
import { JudgeCache, JudgeCacheKey, CacheSummary, hashContent } from '../../flutter/judgeCache';

export interface CriterionDualResult {
  primary: CriterionJudgeResult;
  reviewer?: CriterionJudgeResult;
  /** Merged final result after applying disagreement logic. */
  final: CriterionJudgeResult;
}

export interface CriterionCacheContext {
  provider: string;
  model: string;
  /** Reviewer identity — included in key so a reviewer change invalidates cached final results. */
  reviewerProvider?: string;
  reviewerModel?: string;
  promptVersion: string;
  targetMapVersion: string;
}

export function buildCriterionProvider(
  cfg: { provider: 'openrouter' | 'nvidia'; model: string },
  timeoutMs: number,
  maxRetries: number,
  retryOnParseError: boolean
): IModelJudgeProvider | null {
  if (cfg.provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY ?? '';
    if (!apiKey) return null;
    return new OpenRouterProvider(apiKey, cfg.model, timeoutMs, maxRetries, retryOnParseError);
  }
  if (cfg.provider === 'nvidia') {
    const apiKey = process.env.NVIDIA_API_KEY ?? '';
    if (!apiKey) return null;
    return new NvidiaProvider(apiKey, cfg.model, timeoutMs, maxRetries, retryOnParseError);
  }
  return null;
}

async function hashFile(p: string | undefined): Promise<string> {
  if (!p) return 'none';
  try {
    return hashContent(await fs.readFile(p));
  } catch {
    return 'unreadable';
  }
}

async function buildCacheKey(bundle: CriterionAuditBundle, ctx: CriterionCacheContext): Promise<JudgeCacheKey> {
  return {
    // Include reviewer identity so that changing reviewer invalidates the cached merged result.
    provider: ctx.reviewerProvider ? `${ctx.provider}+${ctx.reviewerProvider}` : ctx.provider,
    model: ctx.reviewerModel ? `${ctx.model}+${ctx.reviewerModel}` : ctx.model,
    promptVersion: ctx.promptVersion,
    targetId: bundle.criterionId,
    criterionIds: [bundle.criterionId],
    actualImageHash: await hashFile(bundle.artifacts.fullActualScreen),
    actualCropHash: await hashFile(bundle.artifacts.actualCrop),
    anchorRectHash: bundle.resolvedBox
      ? hashContent(`${bundle.resolvedBox.x0},${bundle.resolvedBox.y0},${bundle.resolvedBox.x1},${bundle.resolvedBox.y1}`)
      : 'no-rect',
    expectedImageHash: await hashFile(bundle.artifacts.expectedCrop),
    sourceFactsHash: bundle.deterministicSummary ? hashContent(bundle.deterministicSummary) : 'no-facts',
    deterministicMeasurementHash: bundle.deterministicSummary ?? 'none',
    targetMapVersion: ctx.targetMapVersion
  };
}

async function runSingleCriterion(
  bundle: CriterionAuditBundle,
  provider: IModelJudgeProvider
): Promise<CriterionJudgeResult> {
  if (!provider.analyzeCriterion) {
    return {
      criterionId: bundle.criterionId,
      targetStatus: 'not_checked',
      judgeAuditStatus: 'not_run',
      reasoning: 'Provider does not support criterion analysis',
      confidence: 0
    };
  }
  try {
    return await provider.analyzeCriterion(bundle);
  } catch (err: any) {
    return {
      criterionId: bundle.criterionId,
      targetStatus: 'ambiguous',
      judgeAuditStatus: 'unavailable',
      reasoning: `Criterion judge failed: ${err?.message ?? String(err)}`,
      confidence: 0
    };
  }
}

function mergeCriterionResults(primary: CriterionJudgeResult, reviewer?: CriterionJudgeResult): CriterionJudgeResult {
  if (!reviewer) return primary;

  // Primary not_matched: always not_matched regardless of reviewer
  if (primary.targetStatus === 'not_matched') return primary;

  // Reviewer not_matched: downgrade to ambiguous (providers disagree)
  if (reviewer.targetStatus === 'not_matched') {
    return {
      ...primary,
      targetStatus: 'ambiguous',
      judgeAuditStatus: 'unavailable',
      reasoning: `Primary and reviewer disagree on target. Primary: ${primary.targetStatus} — ${primary.reasoning}. Reviewer: ${reviewer.targetStatus} — ${reviewer.reasoning}.`,
      confidence: Math.min(primary.confidence, reviewer.confidence)
    };
  }

  // Primary matched + reviewer ambiguous: downgrade to ambiguous
  if (primary.targetStatus === 'matched' && reviewer.targetStatus === 'ambiguous') {
    return {
      ...primary,
      targetStatus: 'ambiguous',
      judgeAuditStatus: 'unavailable',
      reasoning: `Primary says matched but reviewer is ambiguous. Primary: ${primary.reasoning}. Reviewer: ${reviewer.reasoning}.`,
      confidence: Math.min(primary.confidence, reviewer.confidence)
    };
  }

  // Primary ambiguous: remains ambiguous regardless of reviewer
  if (primary.targetStatus === 'ambiguous') return primary;

  // Both matched: use primary (it ran first, typically higher detail)
  return primary;
}

export class CriterionJudgeAnalyzer {
  /**
   * Run criterion audit for each bundle.
   *
   * Cache scope: the JudgeCache passed in is a per-run in-memory deduplication cache.
   * For cross-run persistence, callers should call JudgeCache.loadFromFile() before
   * the run and JudgeCache.saveToFile() after to skip LLM calls when pixels are unchanged.
   *
   * Batching: bundles are grouped by targetId. If the primary provider implements
   * analyzeCriteriaBatch, all cache-miss bundles for the same target are sent in one
   * provider call. Providers that do not implement analyzeCriteriaBatch fall back to
   * sequential analyzeCriterion calls.
   */
  async run(
    bundles: CriterionAuditBundle[],
    primaryProvider: IModelJudgeProvider,
    reviewerProvider?: IModelJudgeProvider,
    cache?: JudgeCache,
    cacheCtx?: CriterionCacheContext
  ): Promise<{ results: Map<string, CriterionDualResult>; cacheSummary: CacheSummary }> {
    const results = new Map<string, CriterionDualResult>();
    const cacheSummary: CacheSummary = { attempted: 0, cached: 0, skipped: 0, fresh: 0 };

    // Phase 1: serve cache hits, collect misses.
    const freshBundles: CriterionAuditBundle[] = [];
    for (const bundle of bundles) {
      cacheSummary.attempted++;
      if (cache && cacheCtx) {
        const key = await buildCacheKey(bundle, cacheCtx);
        const hit = cache.get(key);
        if (hit) {
          cacheSummary.cached++;
          const cachedResult: CriterionJudgeResult = {
            criterionId: bundle.criterionId,
            targetStatus: hit.targetStatus ?? 'matched',
            judgeAuditStatus: hit.judgeAuditStatus,
            reasoning: `[cache hit] cached at ${new Date(hit.cachedAt).toISOString()}`,
            confidence: hit.confidence ?? 1,
            fromCache: true
          };
          results.set(bundle.criterionId, { primary: cachedResult, final: cachedResult });
          continue;
        }
      }
      freshBundles.push(bundle);
    }

    // Phase 2: group cache misses by target and run (batched if provider supports it).
    const byTarget = new Map<string, CriterionAuditBundle[]>();
    for (const bundle of freshBundles) {
      const groupKey = bundle.targetId ?? bundle.criterionId;
      const group = byTarget.get(groupKey) ?? [];
      group.push(bundle);
      byTarget.set(groupKey, group);
    }

    for (const group of byTarget.values()) {
      const useBatch =
        group.length > 1 &&
        typeof primaryProvider.analyzeCriteriaBatch === 'function';

      if (useBatch) {
        // Batch path: one provider call for all criteria in this target group.
        cacheSummary.fresh += group.length;
        const primaryResults = await primaryProvider.analyzeCriteriaBatch!(group);
        const reviewerResults = reviewerProvider?.analyzeCriteriaBatch
          ? await reviewerProvider.analyzeCriteriaBatch(group)
          : undefined;

        for (let i = 0; i < group.length; i++) {
          const bundle = group[i];
          const primary = primaryResults[i] ?? {
            criterionId: bundle.criterionId,
            targetStatus: 'ambiguous' as const,
            judgeAuditStatus: 'unavailable' as const,
            reasoning: 'Batch result missing for this criterion',
            confidence: 0
          };
          const reviewer = reviewerResults?.[i];
          const final = mergeCriterionResults(primary, reviewer);
          results.set(bundle.criterionId, { primary, reviewer, final });

          if (cache && cacheCtx) {
            const key = await buildCacheKey(bundle, cacheCtx);
            cache.set(key, {
              judgeAuditStatus: final.judgeAuditStatus,
              targetStatus: final.targetStatus,
              confidence: final.confidence,
              cachedAt: Date.now()
            });
          }
        }
      } else {
        // Sequential fallback: one provider call per criterion.
        for (const bundle of group) {
          cacheSummary.fresh++;
          const primary = await runSingleCriterion(bundle, primaryProvider);
          const reviewer = reviewerProvider ? await runSingleCriterion(bundle, reviewerProvider) : undefined;
          const final = mergeCriterionResults(primary, reviewer);
          results.set(bundle.criterionId, { primary, reviewer, final });

          if (cache && cacheCtx) {
            const key = await buildCacheKey(bundle, cacheCtx);
            cache.set(key, {
              judgeAuditStatus: final.judgeAuditStatus,
              targetStatus: final.targetStatus,
              confidence: final.confidence,
              cachedAt: Date.now()
            });
          }
        }
      }
    }

    return { results, cacheSummary };
  }
}
