import { IAnalyzer, AnalyzerContext } from './IAnalyzer';
import { AnalyzerResult, Evidence } from '../types';
import { EvidenceGraph } from '../EvidenceGraph';

export class DynamicMaskAnalyzer implements IAnalyzer {
  readonly name = 'DynamicMaskAnalyzer';
  readonly stage = 'stage1_deterministic' as const;

  async run(ctx: AnalyzerContext, graph: EvidenceGraph): Promise<AnalyzerResult> {
    const start = Date.now();
    const evidence: Evidence[] = [];
    const warnings: string[] = [];

    for (const roi of ctx.regionsOfInterest) {
      const dynamicSubregions = roi.allowedDynamicSubregions ?? [];
      if (dynamicSubregions.length === 0) continue;

      const e: Evidence = {
        source: 'dynamicMask',
        claimId: `dynamic-mask-${roi.id}`,
        subject: `roi:${roi.id}`,
        claim: `ROI '${roi.label}' has ${dynamicSubregions.length} dynamic subregion(s) configured`,
        confidence: 1.0,
        authority: 'deterministic',
        measurements: {
          dynamicSubregionCount: dynamicSubregions.length,
          allowBroadDynamicSubregions: roi.allowBroadDynamicSubregions ?? false
        }
      };
      evidence.push(e);
      graph.add(e);
    }

    // Emit evidence for global ignore regions
    const ignoreRegionCount = ctx.ignoreRegions.length;
    if (ignoreRegionCount > 0) {
      const e: Evidence = {
        source: 'dynamicMask',
        claimId: 'global-ignore-regions',
        subject: 'global',
        claim: `${ignoreRegionCount} ignore/mask region(s) applied globally`,
        confidence: 1.0,
        authority: 'deterministic',
        measurements: { ignoreRegionCount }
      };
      evidence.push(e);
      graph.add(e);
    }

    return {
      analyzerName: this.name,
      stage: this.stage,
      evidence,
      warnings,
      durationMs: Date.now() - start
    };
  }
}
