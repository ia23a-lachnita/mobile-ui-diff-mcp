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
    blocksClaimsMatching?: string[];
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

    // Rule 1: Model finding contradicted by source fact → block model finding.
    // Subject matching: exact match, or global, or the model subject starts with the source subject prefix.
    const modelEvidence = allEvidence.filter((e) => e.authority === 'model' && !e.blocked);
    for (const modelItem of modelEvidence) {
      for (const sourceFact of sourceFacts) {
        const subjectMatches =
          sourceFact.subject === modelItem.subject ||
          sourceFact.subject === 'global' ||
          modelItem.subject.startsWith(sourceFact.subject);
        if (subjectMatches) {
          if (this.claimsContradict(sourceFact, modelItem)) {
            graph.block(modelItem.claimId, 'SOURCE_CONTRADICTION');
            blockedClaimIds.push(modelItem.claimId);
            warnings.push(`Model claim '${modelItem.claimId}' blocked: contradicted by source fact '${sourceFact.claimId}'`);
          }
        }
      }
    }

    // Rule 1b: Source fact has explicit blocksClaimsMatching phrases — block any model claim whose
    // text contains one of the listed phrases (case-insensitive substring match).
    for (const modelItem of allEvidence.filter((e) => e.authority === 'model' && !e.blocked)) {
      for (const sourceFact of sourceFacts) {
        if (blockedClaimIds.includes(modelItem.claimId)) break;
        const patternsRaw = typeof sourceFact.measurements?.blocksClaimsMatching === 'string'
          ? (sourceFact.measurements.blocksClaimsMatching as string).split('|||').map((s: string) => s.trim()).filter(Boolean)
          : [];
        if (patternsRaw.length === 0) continue;
        const claimLower = modelItem.claim.toLowerCase();
        if (patternsRaw.some((p: string) => claimLower.includes(p.toLowerCase()))) {
          graph.block(modelItem.claimId, 'SOURCE_CONTRADICTION');
          blockedClaimIds.push(modelItem.claimId);
          warnings.push(`Model claim '${modelItem.claimId}' blocked: matches blocksClaimsMatching phrase from source fact '${sourceFact.claimId}'`);
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

    // Rule 6: Block seed_data/fixture_plan vectors when reference facts confirm current values match expected.
    // If geometry/model infers seed mismatch but reference facts confirm the same current/target values,
    // the causal claim is a SOURCE_CONTRADICTION — do not recommend seed or plan changes.
    const referenceConfirmsCurrentValues = allEvidence.some(
      (e) => e.authority === 'source' && !e.blocked &&
        e.measurements?.confirmsCurrentValues === true
    );
    if (referenceConfirmsCurrentValues) {
      for (const modelItem of allEvidence.filter((e) => e.authority === 'model' && !e.blocked)) {
        if (modelItem.proposedChangeVector === 'seed_data' || modelItem.proposedChangeVector === 'fixture_plan') {
          graph.block(modelItem.claimId, 'SOURCE_CONTRADICTION');
          blockedClaimIds.push(modelItem.claimId);
          warnings.push(`Model claim '${modelItem.claimId}' blocked: seed_data/fixture_plan vector contradicted by reference facts confirming current values`);
        }
      }
    }

    // Also block seed_data/fixture_plan vectors for any model evidence where the subject's
    // reference facts show matching current/target values (e.g. referenceContext macro values).
    const seedDataModelClaims = allEvidence.filter(
      (e) =>
        e.authority === 'model' &&
        !e.blocked &&
        (e.proposedChangeVector === 'seed_data' || e.proposedChangeVector === 'fixture_plan')
    );
    if (seedDataModelClaims.length > 0) {
      const hasMatchingRefFacts = allEvidence.some(
        (e) =>
          e.authority === 'source' &&
          !e.blocked &&
          e.measurements?.macroValuesMatch === true
      );
      if (hasMatchingRefFacts) {
        for (const modelItem of seedDataModelClaims) {
          if (blockedClaimIds.includes(modelItem.claimId)) continue;
          graph.block(modelItem.claimId, 'SOURCE_CONTRADICTION');
          blockedClaimIds.push(modelItem.claimId);
          warnings.push(`Model claim '${modelItem.claimId}' blocked (INSUFFICIENT_CONFIDENCE): reference macro values match expected — seed/fixture mismatch claim is unsupported`);
        }
      }

      // Also block when a reference fact explicitly declares it blocks this change vector via blocksChangeVectors field.
      // This handles the real config path where ReferenceContextAnalyzer stores blocksChangeVectors as a comma-separated string.
      for (const modelItem of seedDataModelClaims) {
        if (blockedClaimIds.includes(modelItem.claimId)) continue;
        const hasExplicitBlock = allEvidence.some(
          (e) =>
            e.authority === 'source' &&
            !e.blocked &&
            typeof e.measurements?.blocksChangeVectors === 'string' &&
            (e.measurements.blocksChangeVectors as string)
              .split(',')
              .map((v: string) => v.trim())
              .includes(modelItem.proposedChangeVector as string)
        );
        if (hasExplicitBlock) {
          graph.block(modelItem.claimId, 'SOURCE_CONTRADICTION');
          blockedClaimIds.push(modelItem.claimId);
          warnings.push(`Model claim '${modelItem.claimId}' blocked: reference fact explicitly blocks '${modelItem.proposedChangeVector}' change vector`);
        }
      }
    }

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
