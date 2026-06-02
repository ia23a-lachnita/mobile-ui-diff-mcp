import path from 'path';
import { PNG } from 'pngjs';
import { cropAndSave } from '../../image/crops';
import { writePng } from '../../image/load';
import { IAnalyzer, AnalyzerContext } from './IAnalyzer';
import { AnalyzerResult, Evidence } from '../types';
import { EvidenceGraph } from '../EvidenceGraph';
import { PIXEL_DIFF_KEY, PixelDiffResult } from './PixelDiffAnalyzer';

function isPointInBox(x: number, y: number, box: { x: number; y: number; width: number; height: number }): boolean {
  return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
}

function countRoiPixelsWithDynamicMask(
  mask: boolean[][],
  roiBox: { x: number; y: number; width: number; height: number },
  dynamicBoxes: Array<{ x: number; y: number; width: number; height: number }>
): { rawDiffPixels: number; structuralDiffPixels: number; dynamicMaskedPixels: number; structuralTotalPixels: number } {
  let rawDiffPixels = 0;
  let structuralDiffPixels = 0;
  let dynamicMaskedPixels = 0;
  const maxY = Math.min(mask.length, roiBox.y + roiBox.height);

  for (let y = Math.max(0, roiBox.y); y < maxY; y++) {
    const row = mask[y];
    const maxX = Math.min(row.length, roiBox.x + roiBox.width);
    for (let x = Math.max(0, roiBox.x); x < maxX; x++) {
      const isDynamic = dynamicBoxes.some((box) => isPointInBox(x, y, box));
      if (row[x]) {
        rawDiffPixels++;
        if (!isDynamic) structuralDiffPixels++;
      }
      if (isDynamic) dynamicMaskedPixels++;
    }
  }

  const roiArea = Math.max(1, roiBox.width * roiBox.height);
  return {
    rawDiffPixels,
    structuralDiffPixels,
    dynamicMaskedPixels,
    structuralTotalPixels: Math.max(1, roiArea - dynamicMaskedPixels)
  };
}

async function writeStructuralRoiDiffCrop(
  diffImage: PNG,
  roiBox: { x: number; y: number; width: number; height: number },
  dynamicBoxes: Array<{ x: number; y: number; width: number; height: number }>,
  outputPath: string
): Promise<void> {
  const crop = new PNG({ width: roiBox.width, height: roiBox.height });
  for (let y = 0; y < roiBox.height; y++) {
    for (let x = 0; x < roiBox.width; x++) {
      const sourceX = roiBox.x + x;
      const sourceY = roiBox.y + y;
      const targetIdx = (crop.width * y + x) << 2;
      if (dynamicBoxes.some((box) => isPointInBox(sourceX, sourceY, box))) {
        crop.data[targetIdx] = 0;
        crop.data[targetIdx + 1] = 0;
        crop.data[targetIdx + 2] = 0;
        crop.data[targetIdx + 3] = 0;
        continue;
      }
      const sourceIdx = (diffImage.width * sourceY + sourceX) << 2;
      crop.data[targetIdx] = diffImage.data[sourceIdx];
      crop.data[targetIdx + 1] = diffImage.data[sourceIdx + 1];
      crop.data[targetIdx + 2] = diffImage.data[sourceIdx + 2];
      crop.data[targetIdx + 3] = diffImage.data[sourceIdx + 3];
    }
  }
  await writePng(crop, outputPath);
}

export class RoiQualityAnalyzer implements IAnalyzer {
  readonly name = 'RoiQualityAnalyzer';
  readonly stage = 'stage1_deterministic' as const;

  async run(ctx: AnalyzerContext, graph: EvidenceGraph): Promise<AnalyzerResult> {
    const start = Date.now();
    const evidence: Evidence[] = [];
    const warnings: string[] = [];

    const pixelDiff: PixelDiffResult | undefined = (ctx as any)[PIXEL_DIFF_KEY];
    if (!pixelDiff) {
      warnings.push('RoiQualityAnalyzer: PixelDiffResult not available on context');
      return { analyzerName: this.name, stage: this.stage, evidence, warnings, durationMs: Date.now() - start };
    }

    const maxDiffPercent = ctx.config.maxDiffPercent ?? 0.001;

    for (const roi of ctx.regionsOfInterest) {
      const expCrop = path.join(ctx.roiDir, `${roi.id}-expected.png`);
      const actCrop = path.join(ctx.roiDir, `${roi.id}-actual.png`);
      const diffCrop = path.join(ctx.roiDir, `${roi.id}-diff.png`);
      const structuralDiffCrop = path.join(ctx.roiDir, `${roi.id}-structural-diff.png`);

      await cropAndSave(pixelDiff.processedExpectedPath, roi.box, expCrop);
      await cropAndSave(pixelDiff.processedActualPath, roi.box, actCrop);
      await cropAndSave(pixelDiff.diffAbsPath, roi.box, diffCrop);

      // Resolve dynamic subregion boxes (already normalized)
      const resolvedDynamicBoxes = (roi.allowedDynamicSubregions ?? [])
        .map((sub) => {
          const cs = sub.coordinateSpace ?? 'roiNormalized';
          if (cs === 'roiNormalized') {
            return {
              x: roi.box.x + Math.floor(Math.max(0, Math.min(sub.box.x, 1)) * roi.box.width),
              y: roi.box.y + Math.floor(Math.max(0, Math.min(sub.box.y, 1)) * roi.box.height),
              width: Math.max(1, Math.ceil(Math.max(0, Math.min(sub.box.width, 1)) * roi.box.width)),
              height: Math.max(1, Math.ceil(Math.max(0, Math.min(sub.box.height, 1)) * roi.box.height))
            };
          }
          return sub.box;
        });

      await writeStructuralRoiDiffCrop(pixelDiff.diffImage, roi.box, resolvedDynamicBoxes, structuralDiffCrop);

      const counts = countRoiPixelsWithDynamicMask(pixelDiff.mismatchMask, roi.box, resolvedDynamicBoxes);
      const totalPixelsInRoiRaw = Math.max(1, roi.box.width * roi.box.height);
      const structuralRoiDiffPercent = counts.structuralDiffPixels / counts.structuralTotalPixels;
      const rawRoiDiffPercent = counts.rawDiffPixels / totalPixelsInRoiRaw;
      const dynamicMaskedPercentOfRoi = counts.dynamicMaskedPixels / totalPixelsInRoiRaw;
      const maxDiffPercentForRoi = roi.maxDiffPercent ?? maxDiffPercent;
      const status: 'pass' | 'fail' = structuralRoiDiffPercent <= maxDiffPercentForRoi ? 'pass' : 'fail';

      const e: Evidence = {
        source: 'roiQuality',
        claimId: `roi-quality-${roi.id}`,
        subject: `roi:${roi.id}`,
        claim: `ROI '${roi.label}' structural diff is ${(structuralRoiDiffPercent * 100).toFixed(4)}% (${status})`,
        confidence: 1.0,
        authority: 'deterministic',
        measurements: {
          roiId: roi.id,
          structuralRoiDiffPercent,
          rawRoiDiffPercent,
          dynamicMaskedPercentOfRoi,
          maxDiffPercent: maxDiffPercentForRoi,
          status,
          critical: roi.critical ?? false
        }
      };
      evidence.push(e);
      graph.add(e);

      if (dynamicMaskedPercentOfRoi > 0.40 && (roi.critical ?? false) && roi.allowBroadDynamicSubregions !== true) {
        const w = `Excessive dynamic masking covers ${(dynamicMaskedPercentOfRoi * 100).toFixed(1)}% of critical ROI '${roi.label}'.`;
        warnings.push(w);
        const ew: Evidence = {
          source: 'roiQuality',
          claimId: `roi-excessive-mask-${roi.id}`,
          subject: `roi:${roi.id}`,
          claim: w,
          confidence: 1.0,
          authority: 'deterministic',
          measurements: { dynamicMaskedPercentOfRoi }
        };
        evidence.push(ew);
        graph.add(ew);
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
