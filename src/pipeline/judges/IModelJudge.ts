import { Evidence, EvidenceBundle } from '../types';

export interface IModelJudgeProvider {
  readonly providerName: string;
  analyze(bundle: EvidenceBundle, allEvidence: Evidence[]): Promise<Evidence[]>;
}
