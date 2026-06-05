import { AnalyzerContext } from '../analyzers/IAnalyzer';
import { EvidenceGraph } from '../EvidenceGraph';
import { AnalyzerResult, Evidence, EvidenceBundle, JudgeProviderError } from '../types';
import { ActionRequired, VisualCaveat } from '../../types';
import { IModelJudgeProvider } from './IModelJudge';
import { OpenRouterProvider } from './providers/OpenRouterProvider';
import { NvidiaProvider } from './providers/NvidiaProvider';

function isProviderErrorEvidence(e: Evidence): boolean {
  return !!(e.measurements?.error) || /-(error|parse-error)-/.test(e.claimId);
}

/** polarity:'match' evidence is never a visual caveat — it is confirmation only. */
function isCaveatEligible(e: Evidence): boolean {
  const polarity = (e as any).polarity as string | undefined;
  if (polarity === 'match') return false;
  if (polarity === 'error') return false;
  return true;
}

/**
 * Configuration/metadata observations from the model (e.g. "ROI has 1 dynamic subregion configured")
 * must never become blocking caveats — they describe pipeline state, not visual differences.
 */
function isConfigMetadataObservation(claim: string): boolean {
  const lower = claim.toLowerCase();
  return (
    /\broi has \d+/.test(lower) ||
    /\d+ dynamic subregion/.test(lower) ||
    lower.includes(' is configured') ||
    lower.includes(' are configured') ||
    lower.includes('subregion configured') ||
    lower.includes('dynamic region configured')
  );
}

function evidenceToVisualCaveat(e: Evidence): VisualCaveat {
  const polarity = (e as any).polarity as string | undefined;
  const explicitBlocking = (e as any).blocking as boolean | undefined;
  let severity: VisualCaveat['severity'];
  if (e.confidence >= 0.8) severity = 'high';
  else if (e.confidence >= 0.5) severity = 'medium';
  else severity = 'low';
  // blocking requires explicit blocking:true AND polarity:'mismatch' — confidence alone must not block
  // Config/metadata observations (e.g. "ROI has 1 dynamic subregion configured") must never block
  const blocking = explicitBlocking === true && polarity === 'mismatch' && !isConfigMetadataObservation(e.claim);
  return {
    id: e.claimId,
    source: e.source,
    subject: e.subject,
    severity,
    blocking,
    message: e.claim,
    confidence: e.confidence,
    ...(e.measurements ? { measurements: e.measurements } : {}),
    ...(e.proposedChangeVector ? { proposedChangeVector: e.proposedChangeVector } : {})
  };
}

export interface ModelJudgesConfig {
  enabled?: boolean;
  required?: boolean;
  explicitSkipReason?: string;
  allowEditSuggestionsOnPass?: boolean;
  policy?: 'disabled' | 'on_failed_quality' | 'on_failed_quality_or_uncertain_root_cause' | 'always' | 'always_audit';
  primary?: { provider: 'openrouter' | 'nvidia'; model: string };
  reviewer?: { provider: 'openrouter' | 'nvidia'; model: string };
  requireConsensusForCodeHints?: boolean;
  /** Timeout in ms per provider call. Default: 45000. */
  timeoutMs?: number;
  /** Max retries on parse/format error. Default: 1. */
  maxRetries?: number;
  /** Retry on parse error. Default: true. */
  retryOnParseError?: boolean;
}

function buildProvider(
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

export class ModelJudgeAnalyzer {
  readonly name = 'ModelJudgeAnalyzer';
  readonly stage = 'stage2_model' as const;

  constructor(
    private readonly judgesConfig?: ModelJudgesConfig,
    private readonly visualAuditMode: 'visual_parity' | 'metric_only' = 'visual_parity'
  ) {}

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

    if (!cfg?.enabled) {
      if (cfg?.enabled === false) {
        if (cfg.explicitSkipReason) {
          warnings.push(`Model judges disabled (explicitSkipReason: "${cfg.explicitSkipReason}"). This run is metric-only and does not prove visual parity.`);
        } else {
          warnings.push('Model judges disabled without explicitSkipReason. Set explicitSkipReason to confirm metric-only mode, or enable judges for visual parity.');
        }
      }
      return {
        analyzerName: this.name,
        stage: this.stage,
        evidence: [],
        warnings,
        durationMs: Date.now() - start,
        judgeHadSuccessfulResults: false
      };
    }

    const isVisualParity = this.visualAuditMode !== 'metric_only';

    // In visual_parity mode, enabled:true with no primary provider is a hard failure.
    if (isVisualParity && !cfg.primary) {
      return {
        analyzerName: this.name,
        stage: this.stage,
        evidence: [],
        warnings: [],
        durationMs: Date.now() - start,
        judgeHadSuccessfulResults: false,
        actionRequired: {
          type: 'model_judges_unavailable' as const,
          severity: 'blocking' as const,
          message: 'modelJudges.enabled is true but no primary provider is configured.',
          recommendedUserPrompt: 'Add a modelJudges.primary provider with a valid API key, or set visualAuditMode:metric_only to opt out of the judge requirement.',
          suggestedFixes: [
            "Add modelJudges.primary with provider and model fields",
            "Set visualAuditMode:'metric_only' to skip the judge requirement"
          ]
        }
      };
    }

    const policy = cfg.policy ?? (isVisualParity ? 'always_audit' : 'disabled');
    if (policy === 'disabled') {
      return {
        analyzerName: this.name,
        stage: this.stage,
        evidence: [],
        warnings: [],
        durationMs: Date.now() - start,
        judgeHadSuccessfulResults: false
      };
    }

    const isRequired = cfg.required ?? true;
    const timeoutMs = cfg.timeoutMs ?? 45000;
    const maxRetries = cfg.maxRetries ?? 1;
    const retryOnParseError = cfg.retryOnParseError !== false;

    const shouldRun = this.shouldRunForPolicy(policy, graph);
    if (!shouldRun) {
      return {
        analyzerName: this.name,
        stage: this.stage,
        evidence: [],
        warnings: [`ModelJudgeAnalyzer: policy '${policy}' did not trigger execution`],
        durationMs: Date.now() - start,
        judgeHadSuccessfulResults: false
      };
    }

    const allEvidence = graph.getAll();

    let actionRequired: ActionRequired | undefined;
    const primaryEvidence: Evidence[] = [];
    const reviewerEvidence: Evidence[] = [];
    const judgeProviderErrors: JudgeProviderError[] = [];
    let primaryHadSuccess = false;
    let reviewerHadSuccess = false;

    if (cfg.primary) {
      const provider = buildProvider(cfg.primary, timeoutMs, maxRetries, retryOnParseError);
      if (!provider) {
        const keyName = cfg.primary.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'NVIDIA_API_KEY';
        warnings.push(`ModelJudgeAnalyzer: primary provider '${cfg.primary.provider}' requires ${keyName} env var`);
        if (isRequired || policy === 'always' || policy === 'always_audit') {
          actionRequired = {
            type: 'model_judges_unavailable',
            severity: 'blocking',
            message: `Model judge analysis is required but ${keyName} is not set.`,
            recommendedUserPrompt: `Set the ${keyName} environment variable and rerun, or change modelJudges.policy to a non-required value.`,
            suggestedFixes: [
              `Set ${keyName} in your environment`,
              "Change modelJudges.policy to 'on_failed_quality' to make judges optional",
              "Set modelJudges.enabled: false with explicitSkipReason to skip judges for this run"
            ]
          };
        }
      } else {
        for (const bundle of bundles) {
          try {
            const bundleEvidence = await provider.analyze(bundle, allEvidence);
            // Separate execution errors from real visual evidence
            for (const item of bundleEvidence) {
              if (isProviderErrorEvidence(item)) {
                judgeProviderErrors.push({
                  source: 'modelJudgeRuntime',
                  kind: 'provider_error',
                  provider: cfg.primary.provider,
                  model: cfg.primary.model,
                  roiId: bundle.roiId,
                  blocking: isRequired,
                  message: String(item.measurements?.error ?? item.claim)
                });
                warnings.push(`ModelJudgeAnalyzer: primary provider returned error for ROI '${bundle.roiId}': ${item.measurements?.error ?? item.claim}`);
              } else {
                primaryEvidence.push(item);
                primaryHadSuccess = true;
              }
            }
          } catch (err: any) {
            judgeProviderErrors.push({
              source: 'modelJudgeRuntime',
              kind: 'provider_error',
              provider: cfg.primary.provider,
              model: cfg.primary.model,
              roiId: bundle.roiId,
              blocking: isRequired,
              message: err?.message ?? String(err)
            });
            warnings.push(`ModelJudgeAnalyzer: primary provider failed for ROI '${bundle.roiId}': ${err?.message ?? String(err)}`);
          }
        }
        // If required and we got no successful results (all errors), mark as failed
        if (isRequired && !primaryHadSuccess && judgeProviderErrors.some((e) => e.provider === cfg.primary!.provider)) {
          actionRequired = {
            type: 'model_judges_failed',
            severity: 'blocking',
            message: `Required model judge '${cfg.primary.provider}' returned only errors. Check API key validity, provider status, and model compatibility.`,
            recommendedUserPrompt: 'Model judge calls failed. Check API key validity and provider status, then rerun.',
            suggestedFixes: [
              'Verify API key is valid and not rate-limited',
              'Check provider status and model compatibility (run model_judges_health with deep:true)',
              "Set modelJudges.required: false to make failures non-blocking"
            ]
          };
        }
      }
    }

    let reviewerUnavailable = false;
    let reviewerMissingKey = false;
    if (cfg.reviewer) {
      const provider = buildProvider(cfg.reviewer, timeoutMs, maxRetries, retryOnParseError);
      if (!provider) {
        const keyName = cfg.reviewer.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'NVIDIA_API_KEY';
        warnings.push(`ModelJudgeAnalyzer: reviewer provider '${cfg.reviewer.provider}' requires ${keyName} env var`);
        reviewerUnavailable = true;
        reviewerMissingKey = true;
      } else {
        for (const bundle of bundles) {
          try {
            const bundleEvidence = await provider.analyze(bundle, allEvidence);
            for (const item of bundleEvidence) {
              if (isProviderErrorEvidence(item)) {
                judgeProviderErrors.push({
                  source: 'modelJudgeRuntime',
                  kind: 'provider_error',
                  provider: cfg.reviewer.provider,
                  model: cfg.reviewer.model,
                  roiId: bundle.roiId,
                  blocking: cfg.requireConsensusForCodeHints ?? false,
                  message: String(item.measurements?.error ?? item.claim)
                });
                warnings.push(`ModelJudgeAnalyzer: reviewer provider returned error for ROI '${bundle.roiId}': ${item.measurements?.error ?? item.claim}`);
                reviewerUnavailable = true;
              } else {
                reviewerEvidence.push(item);
                reviewerHadSuccess = true;
              }
            }
          } catch (err: any) {
            judgeProviderErrors.push({
              source: 'modelJudgeRuntime',
              kind: 'provider_error',
              provider: cfg.reviewer.provider,
              model: cfg.reviewer.model,
              roiId: bundle.roiId,
              blocking: cfg.requireConsensusForCodeHints ?? false,
              message: err?.message ?? String(err)
            });
            warnings.push(`ModelJudgeAnalyzer: reviewer provider failed for ROI '${bundle.roiId}': ${err?.message ?? String(err)}`);
            reviewerUnavailable = true;
          }
        }
      }
    }

    // When reviewer is required for consensus and failed, the audit cannot pass.
    if (cfg.requireConsensusForCodeHints && cfg.reviewer && reviewerUnavailable && !actionRequired) {
      if (reviewerMissingKey) {
        const keyName = cfg.reviewer.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'NVIDIA_API_KEY';
        actionRequired = {
          type: 'model_judges_unavailable',
          severity: 'blocking',
          message: `Reviewer judge '${cfg.reviewer.provider}' is required for consensus (requireConsensusForCodeHints:true) but ${keyName} is not set.`,
          recommendedUserPrompt: `Set ${keyName} to enable the reviewer judge, or set requireConsensusForCodeHints:false to make reviewer optional.`,
          suggestedFixes: [
            `Set ${keyName} in your environment`,
            "Set requireConsensusForCodeHints:false to make reviewer optional"
          ]
        };
      } else {
        actionRequired = {
          type: 'model_judges_failed',
          severity: 'blocking',
          message: `Reviewer judge '${cfg.reviewer.provider}' is required for consensus (requireConsensusForCodeHints:true) but returned only errors.`,
          recommendedUserPrompt: `Check reviewer API key and provider status, then rerun. Or set requireConsensusForCodeHints:false to make reviewer optional.`,
          suggestedFixes: [
            'Verify reviewer API key is valid and not rate-limited',
            "Set requireConsensusForCodeHints:false to make reviewer optional"
          ]
        };
      }
    }

    // Reviewer ran without errors but produced no usable evidence — treat as failure in consensus mode.
    if (cfg.requireConsensusForCodeHints && cfg.reviewer && !reviewerUnavailable && !reviewerHadSuccess && !actionRequired) {
      actionRequired = {
        type: 'model_judges_failed',
        severity: 'blocking',
        message: `Reviewer judge '${cfg.reviewer.provider}' is required for consensus (requireConsensusForCodeHints:true) but produced no usable evidence.`,
        recommendedUserPrompt: `Check reviewer model configuration and provider status, then rerun. Or set requireConsensusForCodeHints:false to make reviewer optional.`,
        suggestedFixes: [
          'Verify reviewer model is configured correctly and returns valid evidence',
          "Set requireConsensusForCodeHints:false to make reviewer optional"
        ]
      };
    }

    if (cfg.requireConsensusForCodeHints) {
      const allGraphEvidence = graph.getAll();
      for (const primaryItem of primaryEvidence) {
        if (!primaryItem.proposedChangeVector) continue;

        if (reviewerUnavailable) {
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
        } else if (cfg.reviewer) {
          // Reviewer ran but returned empty evidence — cannot confirm any code hints.
          primaryItem.blocked = true;
          primaryItem.blockReason = 'MODEL_DISAGREEMENT';
          warnings.push(`ModelJudgeAnalyzer: code hint '${primaryItem.claimId}' blocked: reviewer returned no evidence for vector '${primaryItem.proposedChangeVector}'`);
        }
      }
    }

    for (const e of [...primaryEvidence, ...reviewerEvidence]) {
      evidence.push(e);
      graph.add(e);
    }

    // Surface non-blocked mismatch/uncertainty findings as visualCaveats.
    // match/error polarity evidence is excluded — confirmations are not caveats.
    // Provider errors are already separated into judgeProviderErrors and must not become caveats.
    const modelCaveats: VisualCaveat[] = [...primaryEvidence, ...reviewerEvidence]
      .filter((e) => !e.blocked && isCaveatEligible(e))
      .map(evidenceToVisualCaveat);

    const judgeHadSuccessfulResults = primaryHadSuccess;

    const primaryErrorCount = judgeProviderErrors.filter((e) => e.provider === cfg.primary?.provider).length;
    const reviewerErrorCount = cfg.reviewer
      ? judgeProviderErrors.filter((e) => e.provider === cfg.reviewer!.provider).length
      : 0;

    const judgeProviderRunSummary = {
      primaryEvidenceCount: primaryEvidence.length,
      primaryErrorCount,
      primaryHadSuccess,
      reviewerEvidenceCount: reviewerEvidence.length,
      reviewerErrorCount,
      reviewerHadSuccess
    };

    return {
      analyzerName: this.name,
      stage: this.stage,
      evidence,
      warnings,
      durationMs: Date.now() - start,
      ...(actionRequired ? { actionRequired } : {}),
      ...(judgeProviderErrors.length > 0 ? { judgeProviderErrors } : {}),
      ...(modelCaveats.length > 0 ? { visualCaveats: modelCaveats } : {}),
      judgeHadSuccessfulResults,
      judgeProviderRunSummary
    };
  }

  private shouldRunForPolicy(
    policy: NonNullable<ModelJudgesConfig['policy']>,
    graph: EvidenceGraph
  ): boolean {
    if (policy === 'always' || policy === 'always_audit') return true;
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
