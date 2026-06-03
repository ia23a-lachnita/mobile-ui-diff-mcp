import { AnalyzerContext } from '../analyzers/IAnalyzer';
import { EvidenceGraph } from '../EvidenceGraph';
import { AnalyzerResult, Evidence, EvidenceBundle } from '../types';
import { ActionRequired } from '../../types';
import { IModelJudgeProvider } from './IModelJudge';
import { OpenRouterProvider } from './providers/OpenRouterProvider';
import { NvidiaProvider } from './providers/NvidiaProvider';

export interface ModelJudgesConfig {
  enabled?: boolean;
  policy?: 'disabled' | 'on_failed_quality' | 'on_failed_quality_or_uncertain_root_cause' | 'always';
  primary?: { provider: 'openrouter' | 'nvidia'; model: string };
  reviewer?: { provider: 'openrouter' | 'nvidia'; model: string };
  requireConsensusForCodeHints?: boolean;
}

function buildProvider(cfg: { provider: 'openrouter' | 'nvidia'; model: string }): IModelJudgeProvider | null {
  if (cfg.provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY ?? '';
    if (!apiKey) return null;
    return new OpenRouterProvider(apiKey, cfg.model);
  }
  if (cfg.provider === 'nvidia') {
    const apiKey = process.env.NVIDIA_API_KEY ?? '';
    if (!apiKey) return null;
    return new NvidiaProvider(apiKey, cfg.model);
  }
  return null;
}

export class ModelJudgeAnalyzer {
  readonly name = 'ModelJudgeAnalyzer';
  readonly stage = 'stage2_model' as const;

  constructor(private readonly judgesConfig?: ModelJudgesConfig) {}

  /**
   * CRITICAL: bundles parameter is required — proves Stage 1.5 (EvidenceBundleBuilder) has run.
   * This enforces stage ordering at the type level.
   */
  async run(
    ctx: AnalyzerContext,
    graph: EvidenceGraph,
    bundles: EvidenceBundle[]
  ): Promise<AnalyzerResult> {
    const start = Date.now();
    const evidence: Evidence[] = [];
    const warnings: string[] = [];

    const cfg = this.judgesConfig;

    // If disabled or not configured, return immediately
    if (!cfg?.enabled) {
      return {
        analyzerName: this.name,
        stage: this.stage,
        evidence: [],
        warnings: [],
        durationMs: Date.now() - start
      };
    }

    // Check policy
    const policy = cfg.policy ?? 'disabled';
    if (policy === 'disabled') {
      return {
        analyzerName: this.name,
        stage: this.stage,
        evidence: [],
        warnings: [],
        durationMs: Date.now() - start
      };
    }

    // Determine whether to actually run based on policy
    const shouldRun = this.shouldRunForPolicy(policy, graph);
    if (!shouldRun) {
      return {
        analyzerName: this.name,
        stage: this.stage,
        evidence: [],
        warnings: [`ModelJudgeAnalyzer: policy '${policy}' did not trigger execution`],
        durationMs: Date.now() - start
      };
    }

    const allEvidence = graph.getAll();

    // Build primary provider
    let actionRequired: ActionRequired | undefined;
    const primaryEvidence: Evidence[] = [];
    const reviewerEvidence: Evidence[] = [];

    if (cfg.primary) {
      const provider = buildProvider(cfg.primary);
      if (!provider) {
        const keyName = cfg.primary.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'NVIDIA_API_KEY';
        warnings.push(`ModelJudgeAnalyzer: primary provider '${cfg.primary.provider}' requires ${keyName} env var`);
        evidence.push({
          source: 'modelJudge',
          claimId: 'model-judge-missing-api-key',
          subject: 'global',
          claim: `Model judge '${cfg.primary.provider}' skipped: missing API key (${keyName})`,
          confidence: 0,
          authority: 'model',
          measurements: { provider: cfg.primary.provider, missingKey: keyName }
        });
        if (policy === 'always') {
          actionRequired = {
            type: 'vlm_unavailable',
            severity: 'blocking',
            message: `Model judge analysis is required (policy: always) but ${keyName} is not set.`,
            recommendedUserPrompt: `Set the ${keyName} environment variable and rerun, or change modelJudges.policy to a non-required value.`,
            suggestedFixes: [
              `Set ${keyName} in your environment`,
              "Change modelJudges.policy to 'on_failed_quality' to make judges optional",
              "Set modelJudges.enabled: false to disable judges entirely"
            ]
          };
        }
      } else {
        for (const bundle of bundles) {
          try {
            const bundleEvidence = await provider.analyze(bundle, allEvidence);
            primaryEvidence.push(...bundleEvidence);
          } catch (err: any) {
            warnings.push(`ModelJudgeAnalyzer: primary provider failed for ROI '${bundle.roiId}': ${err?.message ?? String(err)}`);
          }
        }
      }
    }

    // Build reviewer provider
    let reviewerUnavailable = false;
    if (cfg.reviewer) {
      const provider = buildProvider(cfg.reviewer);
      if (!provider) {
        const keyName = cfg.reviewer.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'NVIDIA_API_KEY';
        warnings.push(`ModelJudgeAnalyzer: reviewer provider '${cfg.reviewer.provider}' requires ${keyName} env var`);
        reviewerUnavailable = true;
      } else {
        for (const bundle of bundles) {
          try {
            const bundleEvidence = await provider.analyze(bundle, allEvidence);
            reviewerEvidence.push(...bundleEvidence);
          } catch (err: any) {
            warnings.push(`ModelJudgeAnalyzer: reviewer provider failed for ROI '${bundle.roiId}': ${err?.message ?? String(err)}`);
          }
        }
      }
    }

    // Enforce requireConsensusForCodeHints: block code hints from primary that reviewer doesn't corroborate
    if (cfg.requireConsensusForCodeHints) {
      const allGraphEvidence = graph.getAll();
      for (const primaryItem of primaryEvidence) {
        if (!primaryItem.proposedChangeVector) continue;

        if (reviewerUnavailable) {
          // Reviewer configured but unreachable — allow only if deterministic or source evidence supports the same vector
          const supportedByGroundTruth = allGraphEvidence.some(
            (e) =>
              (e.authority === 'deterministic' || e.authority === 'source') &&
              !e.blocked &&
              (e.proposedChangeVector === primaryItem.proposedChangeVector ||
                e.subject === primaryItem.subject)
          );
          if (!supportedByGroundTruth) {
            primaryItem.blocked = true;
            primaryItem.blockReason = 'INSUFFICIENT_CONFIDENCE';
            warnings.push(`ModelJudgeAnalyzer: code hint '${primaryItem.claimId}' blocked: reviewer unavailable and no deterministic/source evidence supports vector '${primaryItem.proposedChangeVector}'`);
          }
        } else if (reviewerEvidence.length > 0) {
          const hasConsensus = reviewerEvidence.some(
            (r) => r.subject === primaryItem.subject && r.proposedChangeVector === primaryItem.proposedChangeVector
          );
          if (!hasConsensus) {
            primaryItem.blocked = true;
            primaryItem.blockReason = 'SOURCE_CONTRADICTION';
            warnings.push(`ModelJudgeAnalyzer: code hint '${primaryItem.claimId}' blocked: no reviewer consensus on proposedChangeVector '${primaryItem.proposedChangeVector}'`);
          }
        }
      }
    }

    // Commit all evidence to graph
    for (const e of [...primaryEvidence, ...reviewerEvidence]) {
      evidence.push(e);
      graph.add(e);
    }

    return {
      analyzerName: this.name,
      stage: this.stage,
      evidence,
      warnings,
      durationMs: Date.now() - start,
      ...(actionRequired ? { actionRequired } : {})
    };
  }

  private shouldRunForPolicy(
    policy: NonNullable<ModelJudgesConfig['policy']>,
    graph: EvidenceGraph
  ): boolean {
    if (policy === 'always') return true;
    if (policy === 'disabled') return false;

    const allEvidence = graph.getAll();

    if (policy === 'on_failed_quality') {
      return allEvidence.some(
        (e) => e.source === 'roiQuality' && e.measurements?.status === 'fail'
      );
    }

    if (policy === 'on_failed_quality_or_uncertain_root_cause') {
      const hasFail = allEvidence.some(
        (e) => e.source === 'roiQuality' && e.measurements?.status === 'fail'
      );
      const hasGeometryUncertainty = allEvidence.some(
        (e) => e.source === 'radialGeometry' && e.measurements?.confidence !== undefined && (e.measurements.confidence as number) < 0.6
      );
      return hasFail || hasGeometryUncertainty;
    }

    return false;
  }
}
