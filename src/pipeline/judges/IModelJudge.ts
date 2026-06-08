import { Evidence, EvidenceBundle } from '../types';
import { CriterionAuditBundle, CriterionJudgeResult } from '../../types';

export interface IModelJudgeProvider {
  readonly providerName: string;
  analyze(bundle: EvidenceBundle, allEvidence: Evidence[]): Promise<Evidence[]>;
  /** Criterion-specific judge: validates that the configured box covers the intended target, then assesses legibility. */
  analyzeCriterion?(packet: CriterionAuditBundle): Promise<CriterionJudgeResult>;
}
