import { CriterionAuditBundle, CriterionJudgeResult } from '../../types';
import { IModelJudgeProvider } from './IModelJudge';
import { OpenRouterProvider } from './providers/OpenRouterProvider';
import { NvidiaProvider } from './providers/NvidiaProvider';

export interface CriterionDualResult {
  primary: CriterionJudgeResult;
  reviewer?: CriterionJudgeResult;
  /** Merged final result after applying disagreement logic. */
  final: CriterionJudgeResult;
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
    reviewerProvider?: IModelJudgeProvider
  ): Promise<Map<string, CriterionDualResult>> {
    const results = new Map<string, CriterionDualResult>();

    for (const bundle of bundles) {
      const primary = await runSingleCriterion(bundle, primaryProvider);
      const reviewer = reviewerProvider ? await runSingleCriterion(bundle, reviewerProvider) : undefined;
      const final = mergeCriterionResults(primary, reviewer);
      results.set(bundle.criterionId, { primary, reviewer, final });
    }

    return results;
  }
}
