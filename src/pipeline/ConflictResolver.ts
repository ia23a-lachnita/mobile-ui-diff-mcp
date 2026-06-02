import { EvidenceGraph } from './EvidenceGraph';
import { Evidence } from './types';

export interface ReferenceContextConfig {
  enabled?: boolean;
  sources?: Array<{
    id: string;
    type: string;
    path: string;
    authority?: 'high' | 'medium' | 'low';
    description?: string;
  }>;
  facts?: Array<{
    id: string;
    subject: string;
    claim: string;
    authority?: 'high' | 'medium' | 'low';
  }>;
}

export interface ConflictResolverResult {
  blockedClaimIds: string[];
  downgradedClaimIds: string[];
  requiresUserDecision: boolean;
  warnings: string[];
}

export class ConflictResolver {
  constructor(private readonly referenceContext?: ReferenceContextConfig) {}

  resolve(graph: EvidenceGraph): ConflictResolverResult {
    const blockedClaimIds: string[] = [];
    const downgradedClaimIds: string[] = [];
    const warnings: string[] = [];
    let requiresUserDecision = false;

    const allEvidence = graph.getAll();

    // Load reference facts as high-authority source evidence
    const sourceFacts: Evidence[] = allEvidence.filter((e) => e.authority === 'source');

    // Rule 1: Model finding contradicted by source fact → block model finding
    const modelEvidence = allEvidence.filter((e) => e.authority === 'model' && !e.blocked);
    for (const modelItem of modelEvidence) {
      for (const sourceFact of sourceFacts) {
        if (sourceFact.subject === modelItem.subject || sourceFact.subject === 'global') {
          // Check for semantic contradiction (simple heuristic: opposing claims)
          if (this.claimsContradict(sourceFact.claim, modelItem.claim)) {
            graph.block(modelItem.claimId, 'SOURCE_CONTRADICTION');
            blockedClaimIds.push(modelItem.claimId);
            warnings.push(`Model claim '${modelItem.claimId}' blocked: contradicted by source fact '${sourceFact.claimId}'`);
          }
        }
      }
    }

    // Rule 2: Model finding contradicted by deterministic measurement → downgrade confidence
    const deterministicEvidence = allEvidence.filter((e) => e.authority === 'deterministic' && !e.blocked);
    for (const modelItem of allEvidence.filter((e) => e.authority === 'model' && !e.blocked)) {
      for (const detItem of deterministicEvidence) {
        if (detItem.subject === modelItem.subject) {
          if (this.claimsContradict(detItem.claim, modelItem.claim)) {
            // Downgrade confidence
            modelItem.confidence = Math.max(0, modelItem.confidence * 0.5);
            downgradedClaimIds.push(modelItem.claimId);
            warnings.push(`Model claim '${modelItem.claimId}' confidence downgraded: contradicted by deterministic measurement '${detItem.claimId}'`);
          }
        }
      }
    }

    // Rule 3: Scale-only mismatch → block all app code change vectors
    const scaleOnlyEvidence = allEvidence.filter(
      (e) => e.source === 'radialGeometry' && e.measurements?.verdict === 'scaleOnlyMismatch' && !e.blocked
    );
    if (scaleOnlyEvidence.length > 0) {
      // Block model evidence that suggests app code changes
      for (const modelItem of allEvidence.filter((e) => e.authority === 'model' && !e.blocked)) {
        graph.block(modelItem.claimId, 'SCALE_ONLY_MISMATCH');
        blockedClaimIds.push(modelItem.claimId);
      }
      warnings.push('Scale-only mismatch detected: blocking app code change vector suggestions from model judges');
    }

    // Rule 4: Reference conflict (reference and mockup disagree) → requiresUserDecision
    const referenceConflicts = allEvidence.filter((e) => e.source === 'referenceContext' && e.measurements?.conflict === true);
    if (referenceConflicts.length > 0) {
      requiresUserDecision = true;
      warnings.push('Reference conflict detected: reference context and mockup disagree. User decision required.');
    }

    // Rule 5: Source + deterministic agreement → allow specific change vector (annotate, do not block)
    // This is handled by VerdictEngine when building the contract

    return {
      blockedClaimIds,
      downgradedClaimIds,
      requiresUserDecision,
      warnings
    };
  }

  private claimsContradict(claimA: string, claimB: string): boolean {
    const a = claimA.toLowerCase();
    const b = claimB.toLowerCase();

    // Simple heuristic contradiction detection
    const passKeywords = ['pass', 'within tolerance', 'no mismatch', 'valid', 'acceptable'];
    const failKeywords = ['fail', 'mismatch', 'invalid', 'differs', 'wrong', 'error'];

    const aIsPass = passKeywords.some((k) => a.includes(k));
    const aIsFail = failKeywords.some((k) => a.includes(k));
    const bIsPass = passKeywords.some((k) => b.includes(k));
    const bIsFail = failKeywords.some((k) => b.includes(k));

    return (aIsPass && bIsFail) || (aIsFail && bIsPass);
  }
}
