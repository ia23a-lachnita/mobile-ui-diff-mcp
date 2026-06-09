import type { ParsedAnchorDump, ResolvedTarget, TargetResolutionSummary, AnchorMappingMetadata } from './types';
import type { SemanticTargetMapParsed } from './semanticTargetMap';

export interface TargetResolverOptions {
  /** Allow manual fallback boxes when anchor is missing (default: false). */
  allowManualFallback?: boolean;
  /** Minimum visibleFraction to consider an anchor visible (default: 0.01). */
  visibilityThreshold?: number;
}

const DEFAULT_VISIBILITY_THRESHOLD = 0.01;

/**
 * Resolve each semantic target in the map to a physical pixel rect
 * using the current Flutter anchor dump.
 *
 * Resolution priority:
 *   1. Current Flutter anchor rect (preferred)
 *   2. Manual fallback (only if allowManualFallback = true, always noisy)
 *   3. Unresolved (anchor missing or invisible)
 */
export function resolveTargets(
  targetMap: SemanticTargetMapParsed,
  anchorDump: ParsedAnchorDump,
  opts: TargetResolverOptions = {}
): TargetResolutionSummary {
  const { allowManualFallback = false, visibilityThreshold = DEFAULT_VISIBILITY_THRESHOLD } = opts;
  const results: ResolvedTarget[] = [];

  for (const target of targetMap.targets) {
    const locator = target.locator;

    if (locator.type === 'flutter_anchor') {
      const anchor = anchorDump.anchorIndex.get(locator.anchorId);

      if (!anchor) {
        results.push({
          targetId: target.id,
          source: 'unresolved',
          visible: false,
          visibleFraction: 0,
          anchorMissing: true
        });
        continue;
      }

      const isVisible = anchor.visible && anchor.visibility.visibleFraction >= visibilityThreshold;

      if (!isVisible) {
        results.push({
          targetId: target.id,
          source: 'unresolved',
          visible: false,
          visibleFraction: anchor.visibility.visibleFraction,
          targetNotVisible: true
        });
        continue;
      }

      const rect = anchorDump.resolvedRects.get(locator.anchorId)!;
      const { devicePixelRatio, paddingLogical, viewPaddingLogical, viewInsetsLogical } = anchorDump.dump.device;

      const mappingMetadata: AnchorMappingMetadata = {
        measurementBoxSource: 'flutter_anchor',
        devicePixelRatio,
        coordinateOrigin: anchorDump.dump.coordinateOrigin,
        paddingPresent: !!paddingLogical,
        viewPaddingPresent: !!viewPaddingLogical,
        viewInsetsPresent: !!viewInsetsLogical,
        insetsApplied: false,
        rectLogical: anchor.rectLogical,
        rectActualPx: rect
      };

      results.push({
        targetId: target.id,
        source: 'flutter_anchor',
        rect,
        mappingMetadata,
        visible: true,
        visibleFraction: anchor.visibility.visibleFraction
      });
      continue;
    }

    // Unhandled locator type — treat as unresolved
    results.push({
      targetId: target.id,
      source: 'unresolved',
      visible: false,
      visibleFraction: 0
    });
  }

  return {
    totalTargets: results.length,
    resolvedViaFlutterAnchor: results.filter((r) => r.source === 'flutter_anchor').length,
    resolvedViaManualFallback: results.filter((r) => r.source === 'manual_fallback').length,
    unresolved: results.filter((r) => r.source === 'unresolved').length,
    notVisible: results.filter((r) => r.targetNotVisible).length,
    results
  };
}
