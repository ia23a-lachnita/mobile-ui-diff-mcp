import { PNG } from 'pngjs';
import { IAnalyzer, AnalyzerContext } from './IAnalyzer';
import { AnalyzerResult, Evidence } from '../types';
import { EvidenceGraph } from '../EvidenceGraph';

function detectInvalidCapture(png: PNG): { invalid: boolean; reason?: string } {
  const totalPixels = Math.max(1, png.width * png.height);
  let luminanceSum = 0;
  let luminanceSqSum = 0;
  let visiblePixels = 0;
  let brightPixels = 0;

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2;
      const alpha = png.data[idx + 3] / 255;
      const luminance = (
        0.2126 * png.data[idx]
        + 0.7152 * png.data[idx + 1]
        + 0.0722 * png.data[idx + 2]
      ) * alpha;
      luminanceSum += luminance;
      luminanceSqSum += luminance * luminance;
      if (luminance > 16) visiblePixels++;
      if (luminance > 32) brightPixels++;
    }
  }

  const mean = luminanceSum / totalPixels;
  const variance = Math.max(0, (luminanceSqSum / totalPixels) - mean * mean);
  const standardDeviation = Math.sqrt(variance);
  const visibleRatio = visiblePixels / totalPixels;
  const brightRatio = brightPixels / totalPixels;

  if (mean <= 8 && standardDeviation <= 6 && brightRatio < 0.002) {
    return { invalid: true, reason: 'near-black screenshot with almost no visible detail' };
  }
  if (visibleRatio < 0.005 && standardDeviation <= 8) {
    return { invalid: true, reason: 'screenshot has too few visible pixels to trust' };
  }

  return { invalid: false };
}

export class InvalidCaptureAnalyzer implements IAnalyzer {
  readonly name = 'InvalidCaptureAnalyzer';
  readonly stage = 'stage1_deterministic' as const;

  async run(ctx: AnalyzerContext, graph: EvidenceGraph): Promise<AnalyzerResult> {
    const start = Date.now();
    const evidence: Evidence[] = [];
    const warnings: string[] = [];

    const result = detectInvalidCapture(ctx.actualPng);

    if (result.invalid) {
      const e: Evidence = {
        source: 'invalidCapture',
        claimId: 'invalid-capture-detected',
        subject: 'global',
        claim: `Actual screenshot appears invalid: ${result.reason}`,
        confidence: 0.95,
        authority: 'deterministic',
        measurements: { reason: result.reason ?? 'unknown' }
      };
      evidence.push(e);
      graph.add(e);
      warnings.push(`Invalid capture detected: ${result.reason}`);
    } else {
      const e: Evidence = {
        source: 'invalidCapture',
        claimId: 'capture-valid',
        subject: 'global',
        claim: 'Actual screenshot appears valid',
        confidence: 0.9,
        authority: 'deterministic'
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
