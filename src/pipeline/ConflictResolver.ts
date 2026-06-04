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
    claimType?: string;
    expectedValue?: number | string;
    actualValue?: number | string;
    unit?: string;
    proposedChangeVector?: string;
    blocksChangeVectors?: string[];
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
          if (this.claimsContradict(sourceFact, modelItem)) {
            graph.block(modelItem.claimId, 'SOURCE_CONTRADICTION');
            blockedClaimIds.push(modelItem.claimId);
            warnings.push(`Model claim '${modelItem.claimId}' blocked: contradicted by source fact '${sourceFact.claimId}'`);
          }
        }
      }
    }

    // Rule 2: Model finding contradicted by deterministic measurement → downgrade confidence.
    // Only applies when there is a structured contradiction (same claimType or proposedChangeVector
    // conflict). Keyword fallback is NOT used here — a deterministic ROI pass does not contradict
    // a model visual-caveat claim that merely observes style issues or crowding.
    const deterministicEvidence = allEvidence.filter((e) => e.authority === 'deterministic' && !e.blocked);
    for (const modelItem of allEvidence.filter((e) => e.authority === 'model' && !e.blocked)) {
      for (const detItem of deterministicEvidence) {
        if (detItem.subject === modelItem.subject) {
          if (this.claimsContradictStructured(detItem, modelItem)) {
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

  // Structured-only contradiction: same claimType + mismatched values, or proposedChangeVector conflict.
  // Does NOT fall back to keyword matching — used for Rule 2 to avoid false downgrades of visual caveats.
  private claimsContradictStructured(evidenceA: Evidence, evidenceB: Evidence): boolean {
    if (
      evidenceA.claimType &&
      evidenceB.claimType &&
      evidenceA.claimType === evidenceB.claimType
    ) {
      if (evidenceA.expectedValue !== undefined && evidenceB.actualValue !== undefined) {
        return String(evidenceA.expectedValue) !== String(evidenceB.actualValue);
      }
      if (evidenceA.actualValue !== undefined && evidenceB.expectedValue !== undefined) {
        return String(evidenceA.actualValue) !== String(evidenceB.expectedValue);
      }
    }
    if (evidenceA.proposedChangeVector && evidenceB.proposedChangeVector) {
      const noChangeVectors = ['none', 'no_change'];
      const aIsNoChange = noChangeVectors.includes(evidenceA.proposedChangeVector);
      const bIsNoChange = noChangeVectors.includes(evidenceB.proposedChangeVector);
      if (aIsNoChange !== bIsNoChange) return true;
    }
    return false;
  }

  private claimsContradict(evidenceA: Evidence, evidenceB: Evidence): boolean {
    // Structured comparison: same claimType and subject — compare expected vs actual values
    if (
      evidenceA.claimType &&
      evidenceB.claimType &&
      evidenceA.claimType === evidenceB.claimType
    ) {
      if (evidenceA.expectedValue !== undefined && evidenceB.actualValue !== undefined) {
        return String(evidenceA.expectedValue) !== String(evidenceB.actualValue);
      }
      if (evidenceA.actualValue !== undefined && evidenceB.expectedValue !== undefined) {
        return String(evidenceA.actualValue) !== String(evidenceB.expectedValue);
      }
    }

    // Structured comparison: proposedChangeVector — 'none' vs any app change vector contradicts
    if (evidenceA.proposedChangeVector && evidenceB.proposedChangeVector) {
      const noChangeVectors = ['none', 'no_change'];
      const aIsNoChange = noChangeVectors.includes(evidenceA.proposedChangeVector);
      const bIsNoChange = noChangeVectors.includes(evidenceB.proposedChangeVector);
      if (aIsNoChange !== bIsNoChange) return true;
    }

    // Keyword fallback for unstructured claim text
    const a = evidenceA.claim.toLowerCase();
    const b = evidenceB.claim.toLowerCase();
    const passKeywords = ['pass', 'within tolerance', 'no mismatch', 'valid', 'acceptable'];
    const failKeywords = ['fail', 'mismatch', 'invalid', 'differs', 'wrong', 'error'];
    const aIsPass = passKeywords.some((k) => a.includes(k));
    const aIsFail = failKeywords.some((k) => a.includes(k));
    const bIsPass = passKeywords.some((k) => b.includes(k));
    const bIsFail = failKeywords.some((k) => b.includes(k));
    return (aIsPass && bIsFail) || (aIsFail && bIsPass);
  }
}
