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

/**
 * Invariant: every JudgeProviderError must carry diagnostic fields.
 * Fills in normalized failure sentinels when the upstream did not provide them,
 * preventing the report from containing status:error with no explanation.
 */
export function ensureJudgeErrorHasDiagnostics(err: JudgeProviderError): JudgeProviderError {
  return {
    ...err,
    failureReason: err.failureReason ?? 'unknown_empty_failure',
    rawResponsePreview: err.rawResponsePreview ?? '<missing_error_detail>'
  };
}

/** polarity:'match' evidence is never a visual caveat — it is confirmation only. Config metadata is not a visual finding. Data-value observations are not visual defects. */
function isCaveatEligible(e: Evidence): boolean {
  const polarity = (e as any).polarity as string | undefined;
  if (polarity === 'match') return false;
  if (polarity === 'error') return false;
  if (isConfigMetadataObservation(e.claim)) return false;
  if (isDataObservation(e.claim)) return false;
  return true;
}

/**
 * Pure data-value observations (e.g. "1,420 kcal is displayed as consumed") describe what is
 * shown, not a visual defect. They must never become blocking visual caveats regardless of the
 * model's confidence or severity. A claim is a data observation if it only reports a numeric or
 * text value being displayed without asserting it is visually wrong.
 */
function isDataObservation(claim: string): boolean {
  const lower = claim.toLowerCase();
  // Patterns: "X is displayed", "X is shown", "X appears" where X is a data value
  if (/\b\d[\d,]*\.?\d*\s*(kcal|cal|g|mg|ml|lb|oz|km|mi|%|px)?\b.*\bis (displayed|shown|listed|visible|present)\b/.test(lower)) return true;
  if (/\bis displayed as\b/.test(lower) && !/\bwrong\b|\bincorrect\b|\bdoes not match\b|\bshould be\b|\bexpected\b/.test(lower)) return true;
  if (/\bis shown as\b/.test(lower) && !/\bwrong\b|\bincorrect\b|\bdoes not match\b|\bshould be\b|\bexpected\b/.test(lower)) return true;
  // "X kcal is displayed" pattern — pure observation without asserting wrong
  if (/^\d[\d,]*\.?\d*\s*(kcal|cal|g|mg|ml)?\s+\w+\s+is\s+(displayed|shown)\b/.test(lower)) return true;
  return false;
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
  // Config/metadata and pure data observations must never block
  const blocking = explicitBlocking === true && polarity === 'mismatch' &&
    !isConfigMetadataObservation(e.claim) && !isDataObservation(e.claim);
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
      // Required judges in visual_parity mode cannot be silently skipped by policy —
      // if the policy conditions aren't met, this is a configuration error.
      if (isRequired && isVisualParity) {
        return {
          analyzerName: this.name,
          stage: this.stage,
          evidence: [],
          warnings: [],
          durationMs: Date.now() - start,
          judgeHadSuccessfulResults: false,
          judgeProviderRunSummary: {
            primaryEvidenceCount: 0, primaryErrorCount: 0, primaryHadSuccess: false, primaryAttempted: false,
            reviewerEvidenceCount: 0, reviewerErrorCount: 0, reviewerHadSuccess: false, reviewerAttempted: false
          },
          actionRequired: {
            type: 'model_judges_failed',
            severity: 'blocking',
            message: `Required primary judge was not attempted: policy '${policy}' conditions were not met. In visual_parity mode with required:true, judges must always execute.`,
            recommendedUserPrompt: `Set modelJudges.policy to 'always_audit' or 'always' when required:true in visual_parity mode.`,
            suggestedFixes: [
              "Set modelJudges.policy: 'always_audit' to ensure judges always execute",
              "Set visualAuditMode: 'metric_only' to opt out of the judge requirement"
            ]
          }
        };
      }
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
    let primaryAttempted = false;
    let reviewerHadSuccess = false;
    let reviewerAttempted = false;

    if (cfg.primary) {
      const provider = buildProvider(cfg.primary, timeoutMs, maxRetries, retryOnParseError);
      if (!provider) {
        const keyName = cfg.primary.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'NVIDIA_API_KEY';
        warnings.push(`ModelJudgeAnalyzer: primary provider '${cfg.primary.provider}' requires ${keyName} env var`);
        if (isRequired || policy === 'always' || policy === 'always_audit') {
          actionRequired = {
            type: 'model_judges_unavailable',
            severity: 'blocking',
            message: `Required primary judge '${cfg.primary.provider}' is unavailable: ${keyName} is not set.`,
            recommendedUserPrompt: `Set the ${keyName} environment variable and rerun, or change modelJudges.policy to a non-required value.`,
            suggestedFixes: [
              `Set ${keyName} in your environment`,
              "Change modelJudges.policy to 'on_failed_quality' to make judges optional",
              "Set modelJudges.enabled: false with explicitSkipReason to skip judges for this run"
            ]
          };
        }
      } else {
        primaryAttempted = true;
        for (const bundle of bundles) {
          try {
            const bundleEvidence = await provider.analyze(bundle, allEvidence);
            // Separate execution errors from real visual evidence
            let bundleHadEvidence = false;
            let bundleHadError = false;
            for (const item of bundleEvidence) {
              if (isProviderErrorEvidence(item)) {
                bundleHadError = true;
                judgeProviderErrors.push(ensureJudgeErrorHasDiagnostics({
                  source: 'modelJudgeRuntime',
                  kind: 'provider_error',
                  provider: cfg.primary.provider,
                  model: cfg.primary.model,
                  roiId: bundle.roiId,
                  blocking: isRequired,
                  message: String(item.measurements?.error ?? item.claim),
                  ...(typeof item.measurements?.failureReason === 'string' ? { failureReason: item.measurements.failureReason } : {}),
                  ...(typeof item.measurements?.rawResponsePreview === 'string' ? { rawResponsePreview: item.measurements.rawResponsePreview } : {})
                }));
                warnings.push(`ModelJudgeAnalyzer: primary provider returned error for ROI '${bundle.roiId}': ${item.measurements?.error ?? item.claim}`);
              } else {
                bundleHadEvidence = true;
                primaryEvidence.push(item);
                primaryHadSuccess = true;
              }
            }
            // Guard: provider returned neither evidence nor an explicit error — synthesize a diagnostic
            // entry so the report cannot contain status:error with empty failedRois.
            if (!bundleHadEvidence && !bundleHadError) {
              judgeProviderErrors.push({
                source: 'modelJudgeRuntime',
                kind: 'provider_error',
                provider: cfg.primary.provider,
                model: cfg.primary.model,
                roiId: bundle.roiId,
                blocking: isRequired,
                message: `Primary judge '${cfg.primary.provider}' returned empty evidence for ROI '${bundle.roiId}'`,
                failureReason: 'unknown_empty_failure',
                rawResponsePreview: '<missing_error_detail>'
              });
              warnings.push(`ModelJudgeAnalyzer: primary provider returned empty evidence for ROI '${bundle.roiId}' (no items, no explicit error)`);
            }
          } catch (err: any) {
            judgeProviderErrors.push(ensureJudgeErrorHasDiagnostics({
              source: 'modelJudgeRuntime',
              kind: 'provider_error',
              provider: cfg.primary.provider,
              model: cfg.primary.model,
              roiId: bundle.roiId,
              blocking: isRequired,
              message: err?.message ?? String(err)
            }));
            warnings.push(`ModelJudgeAnalyzer: primary provider failed for ROI '${bundle.roiId}': ${err?.message ?? String(err)}`);
          }
        }
        // NOTE: do NOT set actionRequired here — wait until after reviewer runs so we have full context
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
        reviewerAttempted = true;
        for (const bundle of bundles) {
          try {
            const bundleEvidence = await provider.analyze(bundle, allEvidence);
            let bundleHadEvidence = false;
            let bundleHadError = false;
            for (const item of bundleEvidence) {
              if (isProviderErrorEvidence(item)) {
                bundleHadError = true;
                judgeProviderErrors.push(ensureJudgeErrorHasDiagnostics({
                  source: 'modelJudgeRuntime',
                  kind: 'provider_error',
                  provider: cfg.reviewer.provider,
                  model: cfg.reviewer.model,
                  roiId: bundle.roiId,
                  blocking: cfg.requireConsensusForCodeHints ?? false,
                  message: String(item.measurements?.error ?? item.claim),
                  ...(typeof item.measurements?.failureReason === 'string' ? { failureReason: item.measurements.failureReason } : {}),
                  ...(typeof item.measurements?.rawResponsePreview === 'string' ? { rawResponsePreview: item.measurements.rawResponsePreview } : {})
                }));
                warnings.push(`ModelJudgeAnalyzer: reviewer provider returned error for ROI '${bundle.roiId}': ${item.measurements?.error ?? item.claim}`);
                reviewerUnavailable = true;
              } else {
                bundleHadEvidence = true;
                reviewerEvidence.push(item);
                reviewerHadSuccess = true;
              }
            }
            // Guard: reviewer returned neither evidence nor an explicit error — add diagnostics
            // but do NOT set reviewerUnavailable, so the "no usable evidence" actionRequired
            // branch fires (not the "unavailable" branch) and MODEL_DISAGREEMENT blocking is preserved.
            if (!bundleHadEvidence && !bundleHadError) {
              judgeProviderErrors.push({
                source: 'modelJudgeRuntime',
                kind: 'provider_error',
                provider: cfg.reviewer.provider,
                model: cfg.reviewer.model,
                roiId: bundle.roiId,
                blocking: cfg.requireConsensusForCodeHints ?? false,
                message: `Reviewer judge '${cfg.reviewer.provider}' returned empty evidence for ROI '${bundle.roiId}'`,
                failureReason: 'unknown_empty_failure',
                rawResponsePreview: '<missing_error_detail>'
              });
              warnings.push(`ModelJudgeAnalyzer: reviewer provider returned empty evidence for ROI '${bundle.roiId}' (no items, no explicit error)`);
            }
          } catch (err: any) {
            judgeProviderErrors.push(ensureJudgeErrorHasDiagnostics({
              source: 'modelJudgeRuntime',
              kind: 'provider_error',
              provider: cfg.reviewer.provider,
              model: cfg.reviewer.model,
              roiId: bundle.roiId,
              blocking: cfg.requireConsensusForCodeHints ?? false,
              message: err?.message ?? String(err)
            }));
            warnings.push(`ModelJudgeAnalyzer: reviewer provider failed for ROI '${bundle.roiId}': ${err?.message ?? String(err)}`);
            reviewerUnavailable = true;
          }
        }
      }
    }

    // ---- Build actionRequired with full context from both providers ----
    // This runs after both primary and reviewer so messages accurately reflect both outcomes.
    if (!actionRequired) {
      if (isRequired && cfg.primary && !primaryHadSuccess) {
        // Primary failed. Determine exact reason and incorporate reviewer outcome.
        const primaryErrors = judgeProviderErrors.filter((e) => e.provider === cfg.primary!.provider);
        const reviewerSucceeded = reviewerHadSuccess;
        const reviewerNote = reviewerSucceeded ? `; reviewer '${cfg.reviewer?.provider ?? 'reviewer'}' succeeded` : '';

        if (!primaryAttempted) {
          // Provider was not built (missing API key — already handled above as model_judges_unavailable)
          // Fall through to consensus checks
        } else if (primaryErrors.length > 0) {
          actionRequired = reviewerSucceeded
            ? {
                type: 'model_judges_failed',
                severity: 'blocking',
                message: `Required primary judge '${cfg.primary.provider}' failed${reviewerNote}. Visual audit is incomplete.`,
                recommendedUserPrompt: 'Check primary provider status, API key validity, and model compatibility, then rerun.',
                suggestedFixes: [
                  'Verify primary API key is valid and not rate-limited',
                  'Run model_judges_health with deep:true to test provider connectivity',
                  ...(!isVisualParity ? ["Set modelJudges.required: false to make failures non-blocking"] : [])
                ]
              }
            : {
                type: 'model_judges_failed',
                severity: 'blocking',
                message: 'All required model judges failed.',
                recommendedUserPrompt: 'Check provider status, API key validity, and model compatibility, then rerun.',
                suggestedFixes: [
                  'Run model_judges_health with deep:true to test provider connectivity',
                  'Verify API keys are valid and not rate-limited',
                  ...(!isVisualParity ? ["Set modelJudges.required: false to make failures non-blocking"] : [])
                ]
              };
        } else {
          // Primary was attempted, no errors, but produced zero evidence
          actionRequired = {
            type: 'model_judges_failed',
            severity: 'blocking',
            message: `Required primary judge '${cfg.primary.provider}' produced no evidence${reviewerNote}. Visual audit is incomplete.`,
            recommendedUserPrompt: 'Primary judge returned an empty response. Check model configuration and retry.',
            suggestedFixes: [
              'Verify model is configured correctly and the prompt/schema is accepted',
              'Run model_judges_health with deep:true to test provider schema validation',
              ...(!isVisualParity ? ["Set modelJudges.required: false to make failures non-blocking"] : [])
            ]
          };
        }
      }

      // Reviewer required for consensus and failed/unavailable
      if (!actionRequired && cfg.requireConsensusForCodeHints && cfg.reviewer && reviewerUnavailable) {
        if (reviewerMissingKey) {
          const keyName = cfg.reviewer.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'NVIDIA_API_KEY';
          const primaryNote = primaryHadSuccess ? `; primary '${cfg.primary?.provider ?? 'primary'}' succeeded` : '';
          actionRequired = {
            type: 'model_judges_unavailable',
            severity: 'blocking',
            message: `Required reviewer judge '${cfg.reviewer.provider}' is unavailable (requireConsensusForCodeHints:true): ${keyName} is not set${primaryNote}. Visual audit is incomplete.`,
            recommendedUserPrompt: `Set ${keyName} to enable the reviewer judge, or set requireConsensusForCodeHints:false to make reviewer optional.`,
            suggestedFixes: [
              `Set ${keyName} in your environment`,
              "Set requireConsensusForCodeHints:false to make reviewer optional"
            ]
          };
        } else {
          const primaryNote = primaryHadSuccess ? `; primary '${cfg.primary?.provider ?? 'primary'}' succeeded` : '';
          actionRequired = {
            type: 'model_judges_failed',
            severity: 'blocking',
            message: `Required reviewer judge '${cfg.reviewer.provider}' failed (requireConsensusForCodeHints:true)${primaryNote}. Visual audit is incomplete.`,
            recommendedUserPrompt: `Check reviewer API key and provider status, then rerun. Or set requireConsensusForCodeHints:false to make reviewer optional.`,
            suggestedFixes: [
              'Verify reviewer API key is valid and not rate-limited',
              "Set requireConsensusForCodeHints:false to make reviewer optional"
            ]
          };
        }
      }

      // Reviewer ran but produced no evidence — failure in consensus mode
      if (!actionRequired && cfg.requireConsensusForCodeHints && cfg.reviewer && !reviewerUnavailable && !reviewerHadSuccess) {
        const primaryNote = primaryHadSuccess ? `; primary '${cfg.primary?.provider ?? 'primary'}' succeeded` : '';
        actionRequired = {
          type: 'model_judges_failed',
          severity: 'blocking',
          message: `Required reviewer judge '${cfg.reviewer.provider}' produced no usable evidence (requireConsensusForCodeHints:true)${primaryNote}. Visual audit is incomplete.`,
          recommendedUserPrompt: `Check reviewer model configuration and provider status, then rerun. Or set requireConsensusForCodeHints:false to make reviewer optional.`,
          suggestedFixes: [
            'Verify reviewer model is configured correctly and returns valid evidence',
            "Set requireConsensusForCodeHints:false to make reviewer optional"
          ]
        };
      }
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
      primaryAttempted,
      reviewerEvidenceCount: reviewerEvidence.length,
      reviewerErrorCount,
      reviewerHadSuccess,
      reviewerAttempted
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
