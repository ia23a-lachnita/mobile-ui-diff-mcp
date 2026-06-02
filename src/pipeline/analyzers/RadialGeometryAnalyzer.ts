import path from 'path';
import { runRadialChartDiagnostics } from '../../image/radialChartDiagnostics';
import { IAnalyzer, AnalyzerContext } from './IAnalyzer';
import { AnalyzerResult, Evidence } from '../types';
import { EvidenceGraph } from '../EvidenceGraph';

export class RadialGeometryAnalyzer implements IAnalyzer {
  readonly name = 'RadialGeometryAnalyzer';
  readonly stage = 'stage1_deterministic' as const;

  async run(ctx: AnalyzerContext, graph: EvidenceGraph): Promise<AnalyzerResult> {
    const start = Date.now();
    const evidence: Evidence[] = [];
    const warnings: string[] = [];

    for (const roi of ctx.regionsOfInterest) {
      if (roi.geometryDiagnostics?.type !== 'radialChart' || !roi.geometryDiagnostics.enabled) continue;

      const expCrop = path.join(ctx.roiDir, `${roi.id}-expected.png`);
      const actCrop = path.join(ctx.roiDir, `${roi.id}-actual.png`);

      // Resolve dynamic boxes relative to ROI
      const roiDynamicBoxes = (roi.allowedDynamicSubregions ?? [])
        .map((sub) => {
          const cs = sub.coordinateSpace ?? 'roiNormalized';
          if (cs === 'roiNormalized') {
            return {
              x: Math.floor(Math.max(0, Math.min(sub.box.x, 1)) * roi.box.width),
              y: Math.floor(Math.max(0, Math.min(sub.box.y, 1)) * roi.box.height),
              width: Math.max(1, Math.ceil(Math.max(0, Math.min(sub.box.width, 1)) * roi.box.width)),
              height: Math.max(1, Math.ceil(Math.max(0, Math.min(sub.box.height, 1)) * roi.box.height))
            };
          }
          return { x: sub.box.x - roi.box.x, y: sub.box.y - roi.box.y, width: sub.box.width, height: sub.box.height };
        });

      try {
        const geometryResult = await runRadialChartDiagnostics({
          roiId: roi.id,
          expectedCropPath: expCrop,
          actualCropPath: actCrop,
          outputDir: ctx.roiDir,
          config: roi.geometryDiagnostics,
          dynamicSubregions: roiDynamicBoxes
        });

        const e: Evidence = {
          source: 'radialGeometry',
          claimId: `radial-geometry-${roi.id}`,
          subject: `roi:${roi.id}`,
          claim: `Radial chart geometry: ${geometryResult.verdict}. ${geometryResult.agentHint}`,
          confidence: geometryResult.confidence,
          authority: 'deterministic',
          measurements: {
            verdict: geometryResult.verdict,
            status: geometryResult.status,
            findingCount: geometryResult.findings.length,
            confidence: geometryResult.confidence
          }
        };
        evidence.push(e);
        graph.add(e);

        for (const finding of geometryResult.findings) {
          const fe: Evidence = {
            source: 'radialGeometry',
            claimId: `radial-finding-${roi.id}-${finding.kind}`,
            subject: `roi:${roi.id}`,
            claim: finding.message ?? `${finding.kind} (${finding.severity})`,
            confidence: geometryResult.confidence,
            authority: 'deterministic',
            measurements: {
              kind: finding.kind,
              severity: finding.severity,
              ...(finding.expectedNorm !== undefined ? { expectedNorm: finding.expectedNorm } : {}),
              ...(finding.actualNorm !== undefined ? { actualNorm: finding.actualNorm } : {}),
              ...(finding.deltaNorm !== undefined ? { deltaNorm: finding.deltaNorm } : {})
            }
          };
          evidence.push(fe);
          graph.add(fe);
        }

        for (const w of geometryResult.warnings) {
          warnings.push(`ROI '${roi.label}' radial geometry warning: ${w}`);
        }
      } catch (err: any) {
        const w = `ROI '${roi.label}' radial geometry diagnostics failed: ${err?.message ?? String(err)}`;
        warnings.push(w);
      }
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
