import { CriterionAuditBundle, CriterionJudgeResult } from '../../types';
import { IModelJudgeProvider } from './IModelJudge';
import { OpenRouterProvider } from './providers/OpenRouterProvider';
import { NvidiaProvider } from './providers/NvidiaProvider';

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

export class CriterionJudgeAnalyzer {
  async run(
    bundles: CriterionAuditBundle[],
    provider: IModelJudgeProvider
  ): Promise<Map<string, CriterionJudgeResult>> {
    const results = new Map<string, CriterionJudgeResult>();

    for (const bundle of bundles) {
      if (!provider.analyzeCriterion) {
        results.set(bundle.criterionId, {
          criterionId: bundle.criterionId,
          targetStatus: 'not_checked',
          judgeAuditStatus: 'not_run',
          reasoning: 'Provider does not support criterion analysis',
          confidence: 0
        });
        continue;
      }

      try {
        const result = await provider.analyzeCriterion(bundle);
        results.set(bundle.criterionId, result);
      } catch (err: any) {
        results.set(bundle.criterionId, {
          criterionId: bundle.criterionId,
          targetStatus: 'ambiguous',
          judgeAuditStatus: 'unavailable',
          reasoning: `Criterion judge failed: ${err?.message ?? String(err)}`,
          confidence: 0
        });
      }
    }

    return results;
  }
}
