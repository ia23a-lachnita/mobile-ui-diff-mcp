import { ReasonCode } from '../types';

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
  ocrFindings: string[];
  referenceFacts: string[];
}

export interface AnalyzerResult {
  analyzerName: string;
  stage: AnalyzerStage;
  evidence: Evidence[];
  warnings: string[];
  durationMs: number;
  actionRequired?: import('../types').ActionRequired;
}
