import path from 'path';
import { AnalyzerContext } from './analyzers/IAnalyzer';
import { EvidenceGraph } from './EvidenceGraph';
import { EvidenceBundle } from './types';

export class EvidenceBundleBuilder {
  build(ctx: AnalyzerContext, graph: EvidenceGraph): EvidenceBundle[] {
    const bundles: EvidenceBundle[] = [];

    const globalSourceEvidence = graph.getBySubject('global').filter((e) => e.authority === 'source' && !e.blocked);

    for (const roi of ctx.regionsOfInterest) {
      const roiEvidence = graph.getBySubject(`roi:${roi.id}`);
      const deterministicEvidenceObjects = roiEvidence.filter((e) => e.authority === 'deterministic' && !e.blocked);
      const ocrEvidenceObjects = roiEvidence.filter((e) => e.source === 'textOcr' && !e.blocked);
      const roiReferenceEvidence = roiEvidence.filter((e) => e.authority === 'source' && !e.blocked);
      const referenceEvidenceObjects = [...roiReferenceEvidence, ...globalSourceEvidence];

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
        deterministicFindings: deterministicEvidenceObjects.map((e) => e.claimId),
        deterministicEvidence: deterministicEvidenceObjects,
        ocrFindings: ocrEvidenceObjects.map((e) => e.claimId),
        ocrEvidence: ocrEvidenceObjects,
        referenceFacts: referenceEvidenceObjects.map((e) => e.claimId),
        referenceEvidence: referenceEvidenceObjects
      });
    }

    // Global bundle for evidence not tied to specific ROI
    const globalEvidence = graph.getBySubject('global');
    if (globalEvidence.length > 0) {
      const globalDeterministic = globalEvidence.filter((e) => e.authority === 'deterministic' && !e.blocked);
      const globalReference = globalEvidence.filter((e) => e.authority === 'source' && !e.blocked);
      bundles.push({
        roiId: 'global',
        artifacts: {
          expectedCrop: path.join(ctx.outputDir, 'expected.png'),
          actualCrop: path.join(ctx.outputDir, 'actual.png'),
          structuralDiff: path.join(ctx.outputDir, 'diff.png')
        },
        deterministicFindings: globalDeterministic.map((e) => e.claimId),
        deterministicEvidence: globalDeterministic,
        ocrFindings: [],
        ocrEvidence: [],
        referenceFacts: globalReference.map((e) => e.claimId),
        referenceEvidence: globalReference
      });
    }

    return bundles;
  }
}
