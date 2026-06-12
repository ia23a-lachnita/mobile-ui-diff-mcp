import { ReasonCode } from '../types';

export interface ProviderDiagnosticsAttempt {
  httpStatus?: number;
  httpStatusText?: string;
  responseHeadersPreview?: Record<string, string>;
  responseBodyPreview?: string;
  envelopePreview?: string;
  contentPreview?: string;
  parseError?: string;
  schemaError?: string;
  validationDropReasons?: string[];
  errorName?: string;
  errorMessage?: string;
  timeoutMs?: number;
}

export interface ProviderDiagnostics {
  provider: string;
  model?: string;
  roiId: string;
  attemptCount: number;
  finalAttempt: ProviderDiagnosticsAttempt;
  retryFailures?: Array<{ attempt: number; failureReason: string; detail?: string }>;
}

export type AnalyzerStage =
  | 'stage1_deterministic'
  | 'stage1_5_bundle'
  | 'stage2_model'
  | 'stage3_conflict'
  | 'stage4_verdict';

export interface Evidence {
  source: string;
  claimId: string;
  subject: string;
  claim: string;
  confidence: number;
  authority: 'deterministic' | 'source' | 'model' | 'user';
  measurements?: Record<string, number | string | boolean>;
  providerDiagnostics?: ProviderDiagnostics;
  // Structured fields for contradiction detection (replaces keyword heuristics)
  claimType?: string;
  expectedValue?: number | string;
  actualValue?: number | string;
  unit?: string;
  proposedChangeVector?: string;
  blocked?: boolean;
  blockReason?: ReasonCode;
}

export interface EvidenceBundle {
  roiId: string;
  artifacts: {
    expectedCrop?: string;
    actualCrop?: string;
    structuralDiff?: string;
    geometryOverlay?: string;
  };
  deterministicFindings: string[];
  deterministicEvidence: Evidence[];
  ocrFindings: string[];
  ocrEvidence: Evidence[];
  referenceFacts: string[];
  referenceEvidence: Evidence[];
}

export interface JudgeProviderError {
  source: 'modelJudgeRuntime';
  kind: 'provider_error';
  provider: string;
  providerRole?: 'primary' | 'reviewer';
  model?: string;
  roiId: string;
  blocking: boolean;
  message: string;
  failureReason?: string;
  rawResponsePreview?: string;
  schemaErrorPreview?: string;
  lastFailureReason?: string;
  diagnosticIntegrity?: 'adapter_defect' | 'internal_missing_error_detail';
  providerDiagnostics?: ProviderDiagnostics;
}

export interface JudgeProviderRunSummary {
  primaryEvidenceCount: number;
  primaryErrorCount: number;
  primaryHadSuccess: boolean;
  primaryAttempted: boolean;
  primarySuccessfulRoiIds?: string[];
  reviewerEvidenceCount: number;
  reviewerErrorCount: number;
  reviewerHadSuccess: boolean;
  reviewerAttempted: boolean;
  reviewerSuccessfulRoiIds?: string[];
}

export interface AnalyzerResult {
  analyzerName: string;
  stage: AnalyzerStage;
  evidence: Evidence[];
  warnings: string[];
  durationMs: number;
  actionRequired?: import('../types').ActionRequired;
  visualCaveats?: import('../types').VisualCaveat[];
  judgeProviderErrors?: JudgeProviderError[];
  judgeHadSuccessfulResults?: boolean;
  judgeProviderRunSummary?: JudgeProviderRunSummary;
  overlapLegibilitySummary?: import('../types').OverlapLegibilitySummary;
  criterionAuditBundles?: import('../types').CriterionAuditBundle[];
}
