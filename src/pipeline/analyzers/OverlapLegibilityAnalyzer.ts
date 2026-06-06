import path from 'path';
import fs from 'fs/promises';
import { PNG } from 'pngjs';
import { IAnalyzer, AnalyzerContext } from './IAnalyzer';
import { AnalyzerResult } from '../types';
import { EvidenceGraph } from '../EvidenceGraph';
import { VisualCaveat, RegionOfInterestConfig, OverlapLegibilityRegionResult } from '../../types';

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

function setPixel(data: Buffer, w: number, cx: number, cy: number, r: number, g: number, b: number, a: number) {
  const idx = (cy * w + cx) << 2;
  if (idx < 0 || idx + 3 >= data.length) return;
  data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = a;
}

async function writeOverlayArtifact(
  ctx: AnalyzerContext,
  regionId: string,
  png: PNG,
  bx0: number, by0: number, bx1: number, by1: number,
  avoidColors: { r: number; g: number; b: number }[],
  colorThreshold: number,
  clearancePx: number,
  nearestAvoidColorDistancePx: number | null
): Promise<string | null> {
  try {
    // Expand crop by context + clearance so annotations are visible
    const CONTEXT_PX = Math.max(50, clearancePx + 10);
    const cx0 = Math.max(0, bx0 - CONTEXT_PX);
    const cy0 = Math.max(0, by0 - CONTEXT_PX);
    const cx1 = Math.min(png.width, bx1 + CONTEXT_PX);
    const cy1 = Math.min(png.height, by1 + CONTEXT_PX);
    const cropW = cx1 - cx0;
    const cropH = cy1 - cy0;
    if (cropW <= 0 || cropH <= 0) return null;

    // Copy source pixels into context crop
    const crop = new PNG({ width: cropW, height: cropH });
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        const srcIdx = ((cy0 + y) * png.width + (cx0 + x)) << 2;
        const dstIdx = (y * cropW + x) << 2;
        crop.data[dstIdx] = png.data[srcIdx];
        crop.data[dstIdx + 1] = png.data[srcIdx + 1];
        crop.data[dstIdx + 2] = png.data[srcIdx + 2];
        crop.data[dstIdx + 3] = png.data[srcIdx + 3];
      }
    }

    // Box coords relative to crop origin
    const rx0 = bx0 - cx0; const ry0 = by0 - cy0;
    const rx1 = bx1 - cx0; const ry1 = by1 - cy0;

    // Highlight avoid-color pixels inside the configured box (red overlay)
    for (let y = ry0; y < ry1; y++) {
      for (let x = rx0; x < rx1; x++) {
        const idx = (y * cropW + x) << 2;
        const r = crop.data[idx]; const g = crop.data[idx + 1]; const b = crop.data[idx + 2];
        if (avoidColors.some((c) => colorDistance(r, g, b, c.r, c.g, c.b) < colorThreshold)) {
          crop.data[idx] = 255; crop.data[idx + 1] = 0; crop.data[idx + 2] = 0; crop.data[idx + 3] = 220;
        }
      }
    }

    // Highlight avoid-color pixels in the clearance band (orange overlay) if clearance > 0
    if (clearancePx > 0) {
      const ex0 = Math.max(0, rx0 - clearancePx); const ey0 = Math.max(0, ry0 - clearancePx);
      const ex1 = Math.min(cropW, rx1 + clearancePx); const ey1 = Math.min(cropH, ry1 + clearancePx);
      for (let y = ey0; y < ey1; y++) {
        for (let x = ex0; x < ex1; x++) {
          if (x >= rx0 && x < rx1 && y >= ry0 && y < ry1) continue; // skip inner box
          const idx = (y * cropW + x) << 2;
          const r = crop.data[idx]; const g = crop.data[idx + 1]; const b = crop.data[idx + 2];
          if (avoidColors.some((c) => colorDistance(r, g, b, c.r, c.g, c.b) < colorThreshold)) {
            crop.data[idx] = 255; crop.data[idx + 1] = 140; crop.data[idx + 2] = 0; crop.data[idx + 3] = 200;
          }
        }
      }
    }

    // Draw clearance band border (dashed orange rectangle)
    if (clearancePx > 0) {
      const cbx0 = Math.max(0, rx0 - clearancePx); const cby0 = Math.max(0, ry0 - clearancePx);
      const cbx1 = Math.min(cropW - 1, rx1 + clearancePx); const cby1 = Math.min(cropH - 1, ry1 + clearancePx);
      for (let x = cbx0; x <= cbx1; x++) {
        if (x % 4 < 2) {
          setPixel(crop.data, cropW, x, cby0, 255, 140, 0, 220);
          setPixel(crop.data, cropW, x, cby1, 255, 140, 0, 220);
        }
      }
      for (let y = cby0; y <= cby1; y++) {
        if (y % 4 < 2) {
          setPixel(crop.data, cropW, cbx0, y, 255, 140, 0, 220);
          setPixel(crop.data, cropW, cbx1, y, 255, 140, 0, 220);
        }
      }
    }

    // Draw box boundary (solid blue border = configured legibility region)
    for (let x = rx0; x < rx1; x++) {
      setPixel(crop.data, cropW, x, ry0, 0, 100, 255, 255);
      setPixel(crop.data, cropW, x, ry1 - 1, 0, 100, 255, 255);
    }
    for (let y = ry0; y < ry1; y++) {
      setPixel(crop.data, cropW, rx0, y, 0, 100, 255, 255);
      setPixel(crop.data, cropW, rx1 - 1, y, 0, 100, 255, 255);
    }

    // Draw nearest-distance marker: a short horizontal line from box edge toward the nearest avoid-color pixel
    if (nearestAvoidColorDistancePx !== null && nearestAvoidColorDistancePx > 0 && nearestAvoidColorDistancePx < CONTEXT_PX) {
      const midY = Math.floor((ry0 + ry1) / 2);
      const markerLen = Math.min(Math.round(nearestAvoidColorDistancePx), rx0);
      for (let x = rx0 - markerLen; x < rx0; x++) {
        setPixel(crop.data, cropW, x, midY, 255, 255, 0, 255);
        if (midY + 1 < cropH) setPixel(crop.data, cropW, x, midY + 1, 255, 255, 0, 255);
      }
    }

    const artifactPath = path.join(ctx.outputDir, `overlap-legibility-${regionId}.png`);
    await fs.writeFile(artifactPath, PNG.sync.write(crop));
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
    const regionResults: OverlapLegibilityRegionResult[] = [];

    const config = ctx.config.overlapLegibility;
    // Treat omitted `enabled` as true when regions are present; only skip when explicitly disabled.
    if (config?.enabled === false || !config?.regions?.length) {
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
      if (!avoidColors.length) {
        regionResults.push({
          id: region.id,
          roiId: region.roiId,
          checked: false,
          status: 'skipped',
          skipReason: 'No valid avoidColors configured'
        });
        continue;
      }

      let resolvedBox: { x0: number; y0: number; x1: number; y1: number };
      const roiForDebug = region.roiId ? ctx.regionsOfInterest.find((r) => r.id === region.roiId) : undefined;
      try {
        resolvedBox = resolveBox(
          region.box,
          region.coordinateSpace,
          region.roiId,
          imgWidth,
          imgHeight,
          ctx.regionsOfInterest
        );
      } catch (err: any) {
        regionResults.push({
          id: region.id,
          roiId: region.roiId,
          checked: false,
          status: 'error',
          skipReason: `Coordinate resolution failed: ${err?.message ?? String(err)}`,
          imageSize: { width: imgWidth, height: imgHeight },
          ...(roiForDebug ? { roiBox: roiForDebug.box } : {})
        });
        continue;
      }

      const { x0: bx0, y0: by0, x1: bx1, y1: by1 } = resolvedBox;

      const x0 = Math.max(0, bx0);
      const y0 = Math.max(0, by0);
      const x1 = Math.min(imgWidth, bx1);
      const y1 = Math.min(imgHeight, by1);

      if (x1 <= x0 || y1 <= y0) {
        regionResults.push({
          id: region.id,
          roiId: region.roiId,
          checked: false,
          status: 'error',
          skipReason: `Resolved box is empty or out of image bounds (${bx0},${by0})-(${bx1},${by1}); clamped to (${x0},${y0})-(${x1},${y1}); image=${imgWidth}x${imgHeight}`,
          resolvedBox: { x: bx0, y: by0, width: bx1 - bx0, height: by1 - by0, coordinateSpace: region.coordinateSpace ?? 'expected' },
          imageSize: { width: imgWidth, height: imgHeight },
          ...(roiForDebug ? { roiBox: roiForDebug.box } : {})
        });
        continue;
      }

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

      // Proximity check + nearest avoid-color distance measurement
      let proximityViolation = false;
      let nearestAvoidColorDistancePx: number | null = null;
      let coloredPixelCountInClearanceBand = 0;
      const clearance = region.minClearancePx ?? 0;
      if (clearance > 0) {
        const ex0 = Math.max(0, x0 - clearance);
        const ey0 = Math.max(0, y0 - clearance);
        const ex1 = Math.min(imgWidth, x1 + clearance);
        const ey1 = Math.min(imgHeight, y1 + clearance);
        let minDist = Infinity;
        for (let y = ey0; y < ey1; y++) {
          for (let x = ex0; x < ex1; x++) {
            if (x >= x0 && x < x1 && y >= y0 && y < y1) continue; // skip inner box
            const idx = (y * imgWidth + x) << 2;
            const r = png.data[idx];
            const g = png.data[idx + 1];
            const b = png.data[idx + 2];
            if (avoidColors.some((c) => colorDistance(r, g, b, c.r, c.g, c.b) < colorThreshold)) {
              coloredPixelCountInClearanceBand++;
              // Distance from pixel to nearest box edge
              const dx = x < x0 ? x0 - x : x >= x1 ? x - x1 + 1 : 0;
              const dy = y < y0 ? y0 - y : y >= y1 ? y - y1 + 1 : 0;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < minDist) minDist = dist;
              if (!proximityViolation) proximityViolation = true;
            }
          }
        }
        if (minDist !== Infinity) nearestAvoidColorDistancePx = minDist;
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
        measurements: {
          overlapPercent,
          maxOverlapPercent: maxAllowed,
          regionId: region.id,
          proximityViolation,
          coloredPixelCountInBox: matchCount,
          coloredPixelCountInClearanceBand,
          ...(nearestAvoidColorDistancePx !== null ? { nearestAvoidColorDistancePx } : {})
        }
      });

      // Always write artifact — even for passing regions (proves what was measured)
      const artifactPath = await writeOverlayArtifact(ctx, region.id, png, x0, y0, x1, y1, avoidColors, colorThreshold, clearance, nearestAvoidColorDistancePx);

      const regionStatus: OverlapLegibilityRegionResult['status'] = hasViolation ? 'caveat' : 'pass';

      regionResults.push({
        id: region.id,
        roiId: region.roiId,
        checked: true,
        status: regionStatus,
        overlapPercent,
        nearestAvoidColorDistancePx,
        coloredPixelCountInBox: matchCount,
        coloredPixelCountInClearanceBand,
        minClearancePx: clearance,
        artifactPath: artifactPath ?? null,
        resolvedBox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, coordinateSpace: 'expected' },
        imageSize: { width: imgWidth, height: imgHeight }
      });

      if (hasViolation) {
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
          measurements: {
            overlapPercent,
            maxOverlapPercent: maxAllowed,
            proximityViolation,
            coloredPixelCountInBox: matchCount,
            coloredPixelCountInClearanceBand,
            ...(nearestAvoidColorDistancePx !== null ? { nearestAvoidColorDistancePx } : {}),
            minClearancePx: clearance
          },
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
      durationMs: Date.now() - start,
      overlapLegibilitySummary: {
        enabled: true,
        regions: regionResults
      }
    };
  }
}
