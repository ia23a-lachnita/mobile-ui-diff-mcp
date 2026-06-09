import type { ParsedAnchorDump, SemanticTarget } from './types';
import type { SemanticTargetMapParsed } from './semanticTargetMap';

export interface DiscoveryInput {
  screen: string;
  anchorDump: ParsedAnchorDump;
  /** Existing target map (if any) — used to detect missing anchors. */
  existingTargetMap?: SemanticTargetMapParsed;
  /**
   * LLM criteria proposer — called for each anchor to propose criteria.
   * Must NOT author rectangle coordinates.
   * In tests, pass a mock that returns structured criteria.
   */
  criteriaProposer?: (anchorId: string, context: CriteriaProposalContext) => Promise<ProposedCriteria[]>;
}

export interface CriteriaProposalContext {
  anchorId: string;
  anchorLabel?: string;
  visible: boolean;
  visibleFraction: number;
}

export interface ProposedCriteria {
  id: string;
  domain: string;
  avoidColors?: string[];
  minClearancePx?: number;
  maxOverlapPercent?: number;
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'warning';
}

export interface DiscoveryResult {
  proposedTargetMap: SemanticTargetMapParsed;
  /** Anchor IDs present in dump but missing from existingTargetMap (if provided). */
  missingAnchorSuggestions: MissingAnchorSuggestion[];
  /** Target IDs in existingTargetMap with no matching anchor in dump. */
  unmatchedTargetIds: string[];
}

export interface MissingAnchorSuggestion {
  anchorId: string;
  label?: string;
  visible: boolean;
  suggestedTargetId: string;
  /** Pre-filled target entry the user can paste into their target map. */
  suggestedEntry: SemanticTarget;
}

/**
 * Generate or update a semantic target map from a Flutter anchor dump.
 *
 * LLM (via criteriaProposer) may propose criteria for each anchor.
 * LLM must NOT author rectangle coordinates — those come from the anchor dump only.
 *
 * In tests, pass a mock criteriaProposer that returns deterministic criteria.
 */
export async function runDiscovery(input: DiscoveryInput): Promise<DiscoveryResult> {
  const { screen, anchorDump, existingTargetMap, criteriaProposer } = input;

  const existingTargetIds = new Set(existingTargetMap?.targets.map((t) => t.id) ?? []);
  const dumpAnchorIds = new Set(anchorDump.dump.anchors.map((a) => a.id));

  const missingAnchorSuggestions: MissingAnchorSuggestion[] = [];
  const generatedTargets: SemanticTarget[] = [];

  for (const anchor of anchorDump.dump.anchors) {
    const proposedTargetId = anchor.id;
    const anchor_ = anchorDump.anchorIndex.get(anchor.id)!;

    let proposedCriteria: ProposedCriteria[] = [];
    if (criteriaProposer) {
      proposedCriteria = await criteriaProposer(anchor.id, {
        anchorId: anchor.id,
        anchorLabel: anchor.label,
        visible: anchor_.visible,
        visibleFraction: anchor_.visibility.visibleFraction
      });
    }

    const suggestedEntry: SemanticTarget = {
      id: proposedTargetId,
      locator: {
        type: 'flutter_anchor',
        anchorId: anchor.id,
        required: true
      },
      criteria: proposedCriteria.map((c) => ({
        id: c.id,
        domain: c.domain,
        avoidColors: c.avoidColors,
        minClearancePx: c.minClearancePx,
        maxOverlapPercent: c.maxOverlapPercent,
        severity: c.severity
      }))
    };

    generatedTargets.push(suggestedEntry);

    if (!existingTargetIds.has(proposedTargetId)) {
      missingAnchorSuggestions.push({
        anchorId: anchor.id,
        label: anchor.label,
        visible: anchor_.visible,
        suggestedTargetId: proposedTargetId,
        suggestedEntry
      });
    }
  }

  const unmatchedTargetIds = existingTargetMap
    ? existingTargetMap.targets.filter((t) => !dumpAnchorIds.has(t.locator.anchorId)).map((t) => t.id)
    : [];

  const proposedTargetMap: SemanticTargetMapParsed = {
    version: '1',
    screen,
    targets: generatedTargets
  };

  return { proposedTargetMap, missingAnchorSuggestions, unmatchedTargetIds };
}
