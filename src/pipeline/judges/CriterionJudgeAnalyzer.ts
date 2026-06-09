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
    provider: ctx.provider,
    model: ctx.model,
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
  async run(
    bundles: CriterionAuditBundle[],
    primaryProvider: IModelJudgeProvider,
    reviewerProvider?: IModelJudgeProvider,
    cache?: JudgeCache,
    cacheCtx?: CriterionCacheContext
  ): Promise<{ results: Map<string, CriterionDualResult>; cacheSummary: CacheSummary }> {
    const results = new Map<string, CriterionDualResult>();
    const cacheSummary: CacheSummary = { attempted: 0, cached: 0, skipped: 0, fresh: 0 };

    for (const bundle of bundles) {
      cacheSummary.attempted++;

      // Check cache before calling provider
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

      cacheSummary.fresh++;
      const primary = await runSingleCriterion(bundle, primaryProvider);
      const reviewer = reviewerProvider ? await runSingleCriterion(bundle, reviewerProvider) : undefined;
      const final = mergeCriterionResults(primary, reviewer);
      results.set(bundle.criterionId, { primary, reviewer, final });

      // Store in cache for subsequent runs
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

    return { results, cacheSummary };
  }
}
