import path from 'path';
import fs from 'fs/promises';
import { PNG } from 'pngjs';
import { IAnalyzer, AnalyzerContext } from './IAnalyzer';
import { AnalyzerResult } from '../types';
import { EvidenceGraph } from '../EvidenceGraph';
import { VisualCaveat, RegionOfInterestConfig } from '../../types';

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function resolveRoiToPixels(
  roi: RegionOfInterestConfig,
  imgWidth: number,
  imgHeight: number
): { x0: number; y0: number; x1: number; y1: number } {
  const b = roi.box;
  const cs = roi.coordinateSpace;
  if (cs === 'normalized') {
    return {
      x0: Math.round(b.x * imgWidth),
      y0: Math.round(b.y * imgHeight),
      x1: Math.round((b.x + b.width) * imgWidth),
      y1: Math.round((b.y + b.height) * imgHeight)
    };
  }
  return { x0: Math.round(b.x), y0: Math.round(b.y), x1: Math.round(b.x + b.width), y1: Math.round(b.y + b.height) };
}

function resolveBox(
  box: { x: number; y: number; width: number; height: number },
  coordinateSpace: 'roiNormalized' | 'normalized' | 'expected' | 'actual' | undefined,
  roiId: string | undefined,
  imgWidth: number,
  imgHeight: number,
  regionsOfInterest: RegionOfInterestConfig[]
): { x0: number; y0: number; x1: number; y1: number } {
  if (coordinateSpace === 'normalized') {
    return {
      x0: Math.round(box.x * imgWidth),
      y0: Math.round(box.y * imgHeight),
      x1: Math.round((box.x + box.width) * imgWidth),
      y1: Math.round((box.y + box.height) * imgHeight)
    };
  }

  if (coordinateSpace === 'roiNormalized') {
    const roi = regionsOfInterest.find((r) => r.id === roiId);
    if (roi) {
      const parent = resolveRoiToPixels(roi, imgWidth, imgHeight);
      const roiW = parent.x1 - parent.x0;
      const roiH = parent.y1 - parent.y0;
      return {
        x0: parent.x0 + Math.round(box.x * roiW),
        y0: parent.y0 + Math.round(box.y * roiH),
        x1: parent.x0 + Math.round((box.x + box.width) * roiW),
        y1: parent.y0 + Math.round((box.y + box.height) * roiH)
      };
    }
  }

  return {
    x0: Math.round(box.x),
    y0: Math.round(box.y),
    x1: Math.round(box.x + box.width),
    y1: Math.round(box.y + box.height)
  };
}

async function writeOverlayArtifact(
  ctx: AnalyzerContext,
  regionId: string,
  png: PNG,
  x0: number, y0: number, x1: number, y1: number,
  avoidColors: { r: number; g: number; b: number }[],
  colorThreshold: number
): Promise<string | null> {
  try {
    const overlay = new PNG({ width: png.width, height: png.height });
    png.data.copy(overlay.data);

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * png.width + x) << 2;
        const r = png.data[idx];
        const g = png.data[idx + 1];
        const b = png.data[idx + 2];
        const matches = avoidColors.some((c) => colorDistance(r, g, b, c.r, c.g, c.b) < colorThreshold);
        if (matches) {
          overlay.data[idx] = 255;
          overlay.data[idx + 1] = 0;
          overlay.data[idx + 2] = 0;
          overlay.data[idx + 3] = 200;
        }
      }
    }

    const artifactPath = path.join(ctx.outputDir, `overlap-legibility-${regionId}.png`);
    await fs.writeFile(artifactPath, PNG.sync.write(overlay));
    return artifactPath;
  } catch {
    return null;
  }
}

export class OverlapLegibilityAnalyzer implements IAnalyzer {
  readonly name = 'OverlapLegibilityAnalyzer';
  readonly stage = 'stage1_deterministic' as const;

  async run(ctx: AnalyzerContext, graph: EvidenceGraph): Promise<AnalyzerResult> {
    const start = Date.now();
    const visualCaveats: VisualCaveat[] = [];
    const artifacts: string[] = [];

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
    const colorThreshold = 40;

    for (const region of config.regions) {
      const avoidColors = (region.avoidColors ?? []).map(parseHex).filter((c): c is NonNullable<typeof c> => c !== null);
      if (!avoidColors.length) continue;

      const { x0: bx0, y0: by0, x1: bx1, y1: by1 } = resolveBox(
        region.box,
        region.coordinateSpace,
        region.roiId,
        imgWidth,
        imgHeight,
        ctx.regionsOfInterest
      );

      const x0 = Math.max(0, bx0);
      const y0 = Math.max(0, by0);
      const x1 = Math.min(imgWidth, bx1);
      const y1 = Math.min(imgHeight, by1);
      const totalPixels = Math.max(1, (x1 - x0) * (y1 - y0));

      let matchCount = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * imgWidth + x) << 2;
          const r = png.data[idx];
          const g = png.data[idx + 1];
          const b = png.data[idx + 2];
          if (avoidColors.some((c) => colorDistance(r, g, b, c.r, c.g, c.b) < colorThreshold)) matchCount++;
        }
      }

      const overlapPercent = matchCount / totalPixels;

      // Proximity check: count avoid-color pixels in expanded border (minClearancePx) around the box
      let proximityViolation = false;
      const clearance = region.minClearancePx ?? 0;
      if (clearance > 0) {
        const ex0 = Math.max(0, x0 - clearance);
        const ey0 = Math.max(0, y0 - clearance);
        const ex1 = Math.min(imgWidth, x1 + clearance);
        const ey1 = Math.min(imgHeight, y1 + clearance);
        for (let y = ey0; y < ey1 && !proximityViolation; y++) {
          for (let x = ex0; x < ex1 && !proximityViolation; x++) {
            if (x >= x0 && x < x1 && y >= y0 && y < y1) continue; // skip inner box
            const idx = (y * imgWidth + x) << 2;
            const r = png.data[idx];
            const g = png.data[idx + 1];
            const b = png.data[idx + 2];
            if (avoidColors.some((c) => colorDistance(r, g, b, c.r, c.g, c.b) < colorThreshold)) {
              proximityViolation = true;
            }
          }
        }
      }

      const maxAllowed = region.maxOverlapPercent ?? 0.05;
      const sev = region.severity ?? 'high';
      const isBlocking = sev === 'critical' || sev === 'high';
      const hasViolation = overlapPercent > maxAllowed || proximityViolation;

      graph.add({
        source: 'overlapLegibility',
        claimId: `overlap-legibility-${region.id}`,
        subject: `region:${region.id}`,
        claim: `Region '${region.label ?? region.id}' overlap with avoid-colors: ${(overlapPercent * 100).toFixed(2)}%`,
        confidence: 0.75,
        authority: 'deterministic',
        measurements: { overlapPercent, maxOverlapPercent: maxAllowed, regionId: region.id, proximityViolation }
      });

      if (hasViolation) {
        const artifactPath = await writeOverlayArtifact(ctx, region.id, png, x0, y0, x1, y1, avoidColors, colorThreshold);
        if (artifactPath) artifacts.push(artifactPath);

        const reason = proximityViolation && overlapPercent <= maxAllowed
          ? `Region '${region.label ?? region.id}' has avoid-color pixels within ${clearance}px clearance zone.`
          : `Region '${region.label ?? region.id}' has ${(overlapPercent * 100).toFixed(1)}% overlap with avoid-colors (max ${(maxAllowed * 100).toFixed(1)}%).`;

        visualCaveats.push({
          id: `overlap-legibility-${region.id}`,
          source: 'overlapLegibility',
          subject: `region:${region.id}`,
          severity: sev,
          blocking: isBlocking,
          message: reason,
          confidence: 0.75,
          measurements: { overlapPercent, maxOverlapPercent: maxAllowed, proximityViolation },
          artifacts: artifactPath ? [artifactPath] : []
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
