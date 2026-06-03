import path from 'path';
import { applyIgnoreRegions } from '../../image/mask';
import { createDiffErrorMask } from '../../image/diff';
import { detectRegions } from '../../image/regions';
import { cropAndSave } from '../../image/crops';
import { writePng } from '../../image/load';
import { IAnalyzer, AnalyzerContext } from './IAnalyzer';
import { AnalyzerResult, Evidence } from '../types';
import { EvidenceGraph } from '../EvidenceGraph';
import { PNG } from 'pngjs';

export interface PixelDiffResult {
  diffImage: PNG;
  diffPixels: number;
  totalPixels: number;
  diffPercent: number;
  mismatchMask: boolean[][];
  diffAbsPath: string;
  processedExpectedPath: string;
  processedActualPath: string;
}

// Stored on context after PixelDiffAnalyzer runs so other analyzers can use it
export const PIXEL_DIFF_KEY = '__pixelDiffResult';

export class PixelDiffAnalyzer implements IAnalyzer {
  readonly name = 'PixelDiffAnalyzer';
  readonly stage = 'stage1_deterministic' as const;

  async run(ctx: AnalyzerContext, graph: EvidenceGraph): Promise<AnalyzerResult> {
    const start = Date.now();
    const evidence: Evidence[] = [];
    const warnings: string[] = [];

    const pixelmatchThreshold = ctx.config.pixelmatchThreshold ?? ctx.config.threshold ?? 0.1;

    // Apply ignore regions to copies
    const expectedCopy = new PNG({ width: ctx.expectedPng.width, height: ctx.expectedPng.height });
    ctx.expectedPng.data.copy(expectedCopy.data);

    const actualCopy = new PNG({ width: ctx.actualPng.width, height: ctx.actualPng.height });
    ctx.actualPng.data.copy(actualCopy.data);

    applyIgnoreRegions(expectedCopy, ctx.ignoreRegions);
    applyIgnoreRegions(actualCopy, ctx.ignoreRegions);

    const { diffImage, diffPixels, mismatchMask } = createDiffErrorMask(expectedCopy, actualCopy, pixelmatchThreshold);

    const totalPixels = expectedCopy.width * expectedCopy.height;
    const diffPercent = diffPixels / totalPixels;

    const diffAbsPath = path.join(ctx.outputDir, 'diff.png');
    const processedExpectedPath = path.join(ctx.outputDir, 'expected.png');
    const processedActualPath = path.join(ctx.outputDir, 'actual.png');

    await writePng(diffImage, diffAbsPath);
    await writePng(expectedCopy, processedExpectedPath);
    await writePng(actualCopy, processedActualPath);

    // Store result on ctx for downstream analyzers
    (ctx as any)[PIXEL_DIFF_KEY] = {
      diffImage,
      diffPixels,
      totalPixels,
      diffPercent,
      mismatchMask,
      diffAbsPath,
      processedExpectedPath,
      processedActualPath
    } as PixelDiffResult;

    const e: Evidence = {
      source: 'pixelDiff',
      claimId: 'global-pixel-diff',
      subject: 'global',
      claim: `Global pixel diff is ${(diffPercent * 100).toFixed(4)}%`,
      confidence: 1.0,
      authority: 'deterministic',
      measurements: {
        diffPixels,
        totalPixels,
        diffPercent,
        pixelmatchThreshold
      }
    };
    evidence.push(e);
    graph.add(e);

    // Detect regions
    const maxRegions = ctx.config.maxRegions ?? 50;
    let rawRegions = detectRegions(mismatchMask);
    rawRegions.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    if (rawRegions.length > maxRegions) rawRegions = rawRegions.slice(0, maxRegions);

    for (let i = 0; i < rawRegions.length; i++) {
      const box = rawRegions[i];
      const regionId = `region-${(i + 1).toString().padStart(3, '0')}`;
      const expCrop = path.join(ctx.regionsDir, `${regionId}-expected.png`);
      const actCrop = path.join(ctx.regionsDir, `${regionId}-actual.png`);
      const diffCrop = path.join(ctx.regionsDir, `${regionId}-diff.png`);

      await cropAndSave(processedExpectedPath, box, expCrop);
      await cropAndSave(processedActualPath, box, actCrop);
      await cropAndSave(diffAbsPath, box, diffCrop);
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
