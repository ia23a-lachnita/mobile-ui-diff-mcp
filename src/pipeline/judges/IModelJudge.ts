import { Evidence, EvidenceBundle } from '../types';
import { CriterionAuditBundle, CriterionJudgeResult } from '../../types';

export interface IModelJudgeProvider {
  readonly providerName: string;
  analyze(bundle: EvidenceBundle, allEvidence: Evidence[]): Promise<Evidence[]>;
  /** Criterion-specific judge: validates that the configured box covers the intended target, then assesses legibility. */
  analyzeCriterion?(packet: CriterionAuditBundle): Promise<CriterionJudgeResult>;
  /**
   * Batch criterion judge: evaluate all criteria for a single target in one provider call.
   * Reduces token cost when a target has multiple criteria sharing the same image context.
   * Optional — if absent, the analyzer falls back to sequential analyzeCriterion calls.
   */
  analyzeCriteriaBatch?(packets: CriterionAuditBundle[]): Promise<CriterionJudgeResult[]>;
}
