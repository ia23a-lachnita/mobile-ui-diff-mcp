import { IAnalyzer, AnalyzerContext } from './IAnalyzer';
import { AnalyzerResult } from '../types';
import { EvidenceGraph } from '../EvidenceGraph';
import { VisualCaveat } from '../../types';

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

export class OverlapLegibilityAnalyzer implements IAnalyzer {
  readonly name = 'OverlapLegibilityAnalyzer';
  readonly stage = 'stage1_deterministic' as const;

  async run(ctx: AnalyzerContext, graph: EvidenceGraph): Promise<AnalyzerResult> {
    const start = Date.now();
    const visualCaveats: VisualCaveat[] = [];

    const config = ctx.config.overlapLegibility;
    if (!config?.enabled || !config.regions?.length) {
      return {
        analyzerName: this.name,
        stage: this.stage,
        evidence: [],
        warnings: [],
        visualCaveats: [],
        durationMs: Date.now() - start
      };
    }

    const png = ctx.actualPng;
    const imgWidth = png.width;
    const imgHeight = png.height;

    for (const region of config.regions) {
      const avoidColors = (region.avoidColors ?? []).map(parseHex).filter((c): c is NonNullable<typeof c> => c !== null);
      if (!avoidColors.length) continue;

      const box = region.box;
      const x0 = Math.max(0, Math.round(box.x));
      const y0 = Math.max(0, Math.round(box.y));
      const x1 = Math.min(imgWidth, Math.round(box.x + box.width));
      const y1 = Math.min(imgHeight, Math.round(box.y + box.height));
      const totalPixels = Math.max(1, (x1 - x0) * (y1 - y0));

      let matchCount = 0;
      const colorThreshold = 40;

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * imgWidth + x) << 2;
          const r = png.data[idx];
          const g = png.data[idx + 1];
          const b = png.data[idx + 2];
          const matches = avoidColors.some((c) => colorDistance(r, g, b, c.r, c.g, c.b) < colorThreshold);
          if (matches) matchCount++;
        }
      }

      const overlapPercent = matchCount / totalPixels;
      const maxAllowed = region.maxOverlapPercent ?? 0.05;
      const sev = region.severity ?? 'high';
      const isBlocking = sev === 'critical' || sev === 'high';

      graph.add({
        source: 'overlapLegibility',
        claimId: `overlap-legibility-${region.id}`,
        subject: `region:${region.id}`,
        claim: `Region '${region.label ?? region.id}' overlap with avoid-colors: ${(overlapPercent * 100).toFixed(2)}%`,
        confidence: 0.75,
        authority: 'deterministic',
        measurements: { overlapPercent, maxOverlapPercent: maxAllowed, regionId: region.id }
      });

      if (overlapPercent > maxAllowed) {
        visualCaveats.push({
          id: `overlap-legibility-${region.id}`,
          source: 'overlapLegibility',
          subject: `region:${region.id}`,
          severity: sev,
          blocking: isBlocking,
          message: `Region '${region.label ?? region.id}' has ${(overlapPercent * 100).toFixed(1)}% overlap with avoid-colors (max ${(maxAllowed * 100).toFixed(1)}%).`,
          confidence: 0.75,
          measurements: { overlapPercent, maxOverlapPercent: maxAllowed }
        });
      }
    }

    return {
      analyzerName: this.name,
      stage: this.stage,
      evidence: [],
      warnings: [],
      visualCaveats,
      durationMs: Date.now() - start
    };
  }
}
