import path from 'path';
import { AnalyzerContext } from './analyzers/IAnalyzer';
import { EvidenceGraph } from './EvidenceGraph';
import { EvidenceBundle } from './types';

export class EvidenceBundleBuilder {
  build(ctx: AnalyzerContext, graph: EvidenceGraph): EvidenceBundle[] {
    const bundles: EvidenceBundle[] = [];

    for (const roi of ctx.regionsOfInterest) {
      const roiEvidence = graph.getBySubject(`roi:${roi.id}`);
      const deterministicFindings = roiEvidence
        .filter((e) => e.authority === 'deterministic' && !e.blocked)
        .map((e) => e.claimId);

      const ocrFindings = roiEvidence
        .filter((e) => e.source === 'textOcr' && !e.blocked)
        .map((e) => e.claimId);

      const referenceFacts = roiEvidence
        .filter((e) => e.authority === 'source' && !e.blocked)
        .map((e) => e.claimId);

      const expCrop = path.join(ctx.roiDir, `${roi.id}-expected.png`);
      const actCrop = path.join(ctx.roiDir, `${roi.id}-actual.png`);
      const structuralDiff = path.join(ctx.roiDir, `${roi.id}-structural-diff.png`);
      const geometryOverlay = path.join(ctx.roiDir, `${roi.id}-geometry-overlay.png`);

      bundles.push({
        roiId: roi.id,
        artifacts: {
          expectedCrop: expCrop,
          actualCrop: actCrop,
          structuralDiff,
          geometryOverlay
        },
        deterministicFindings,
        ocrFindings,
        referenceFacts
      });
    }

    // Global bundle for evidence not tied to specific ROI
    const globalEvidence = graph.getBySubject('global');
    if (globalEvidence.length > 0) {
      bundles.push({
        roiId: 'global',
        artifacts: {
          expectedCrop: path.join(ctx.outputDir, 'expected.png'),
          actualCrop: path.join(ctx.outputDir, 'actual.png'),
          structuralDiff: path.join(ctx.outputDir, 'diff.png')
        },
        deterministicFindings: globalEvidence
          .filter((e) => e.authority === 'deterministic' && !e.blocked)
          .map((e) => e.claimId),
        ocrFindings: [],
        referenceFacts: globalEvidence
          .filter((e) => e.authority === 'source' && !e.blocked)
          .map((e) => e.claimId)
      });
    }

    return bundles;
  }
}
