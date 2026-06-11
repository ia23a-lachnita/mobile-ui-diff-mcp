import path from 'path';
import fs from 'fs/promises';
import { PNG } from 'pngjs';
import { IAnalyzer, AnalyzerContext } from './IAnalyzer';
import { AnalyzerResult } from '../types';
import { EvidenceGraph } from '../EvidenceGraph';
import { VisualCaveat, RegionOfInterestConfig, OverlapLegibilityRegionResult, CriterionAuditBundle } from '../../types';

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

type PixelPoint = { x: number; y: number };
type PixelBox = { x: number; y: number; width: number; height: number };

function clampPixelBox(box: PixelBox, imgWidth: number, imgHeight: number): PixelBox | null {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const right = Math.min(imgWidth, Math.round(box.x + box.width));
  const bottom = Math.min(imgHeight, Math.round(box.y + box.height));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function pointInBox(point: PixelPoint, box: PixelBox): boolean {
  return point.x >= box.x && point.x < box.x + box.width && point.y >= box.y && point.y < box.y + box.height;
}

function distanceBetweenPoints(a: PixelPoint, b: PixelPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function collectPillMask(png: PNG, pillBox: PixelBox): PixelPoint[] {
  const points: PixelPoint[] = [];
  for (let y = pillBox.y; y < pillBox.y + pillBox.height; y++) {
    for (let x = pillBox.x; x < pillBox.x + pillBox.width; x++) {
      const idx = (y * png.width + x) << 2;
      if (png.data[idx + 3] > 0) points.push({ x, y });
    }
  }
  return points;
}

function collectMacroRingArcMask(
  png: PNG,
  macroRingBox: PixelBox,
  avoidColors: { r: number; g: number; b: number }[],
  colorThreshold: number,
  pillBox?: PixelBox
): PixelPoint[] {
  const points: PixelPoint[] = [];
  for (let y = macroRingBox.y; y < macroRingBox.y + macroRingBox.height; y++) {
    for (let x = macroRingBox.x; x < macroRingBox.x + macroRingBox.width; x++) {
      // Prevents pill-color pixels from being counted as arc pixels (pill-color contamination).
      // Does NOT exclude arc pixels that visually intrude inside the pill bounding box from other directions.
      if (pillBox && x >= pillBox.x && x < pillBox.x + pillBox.width && y >= pillBox.y && y < pillBox.y + pillBox.height) continue;
      const idx = (y * png.width + x) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      if (avoidColors.some((c) => colorDistance(r, g, b, c.r, c.g, c.b) < colorThreshold)) {
        points.push({ x, y });
      }
    }
  }
  return points;
}

function measureMaskClearance(
  pillMask: PixelPoint[],
  arcMask: PixelPoint[],
  minClearancePx: number,
  pillBox: PixelBox
): {
  clearancePx: number | null;
  closestPillPoint?: PixelPoint;
  closestArcPoint?: PixelPoint;
  arcOverlapCount: number;
  arcPixelsInClearanceBand: number;
} {
  if (pillMask.length === 0 || arcMask.length === 0) {
    return { clearancePx: null, arcOverlapCount: 0, arcPixelsInClearanceBand: 0 };
  }

  let clearancePx = Infinity;
  let closestPillPoint: PixelPoint | undefined;
  let closestArcPoint: PixelPoint | undefined;
  let arcOverlapCount = 0;
  let arcPixelsInClearanceBand = 0;
  const seenArcInBand = new Set<string>();

  for (const arcPoint of arcMask) {
    if (pointInBox(arcPoint, pillBox)) arcOverlapCount++;
    for (const pillPoint of pillMask) {
      const dist = distanceBetweenPoints(pillPoint, arcPoint);
      if (dist < clearancePx) {
        clearancePx = dist;
        closestPillPoint = pillPoint;
        closestArcPoint = arcPoint;
      }
      if (dist < minClearancePx) {
        seenArcInBand.add(`${arcPoint.x},${arcPoint.y}`);
      }
    }
  }

  arcPixelsInClearanceBand = seenArcInBand.size;
  return {
    clearancePx: Number.isFinite(clearancePx) ? clearancePx : null,
    closestPillPoint,
    closestArcPoint,
    arcOverlapCount,
    arcPixelsInClearanceBand
  };
}

async function writeMaskClearanceArtifact(
  ctx: AnalyzerContext,
  regionId: string,
  png: PNG,
  pillBox: PixelBox,
  macroRingBox: PixelBox,
  pillMask: PixelPoint[],
  arcMask: PixelPoint[],
  minClearancePx: number,
  closestPillPoint?: PixelPoint,
  closestArcPoint?: PixelPoint
): Promise<string | null> {
  try {
    const margin = Math.max(24, minClearancePx + 12);
    const cx0 = Math.max(0, Math.min(pillBox.x, macroRingBox.x) - margin);
    const cy0 = Math.max(0, Math.min(pillBox.y, macroRingBox.y) - margin);
    const cx1 = Math.min(png.width, Math.max(pillBox.x + pillBox.width, macroRingBox.x + macroRingBox.width) + margin);
    const cy1 = Math.min(png.height, Math.max(pillBox.y + pillBox.height, macroRingBox.y + macroRingBox.height) + margin);
    const cropW = cx1 - cx0;
    const cropH = cy1 - cy0;
    if (cropW <= 0 || cropH <= 0) return null;

    const crop = new PNG({ width: cropW, height: cropH });
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        const srcIdx = ((cy0 + y) * png.width + (cx0 + x)) << 2;
        const dstIdx = (y * cropW + x) << 2;
        crop.data[dstIdx] = Math.round(png.data[srcIdx] * 0.45);
        crop.data[dstIdx + 1] = Math.round(png.data[srcIdx + 1] * 0.45);
        crop.data[dstIdx + 2] = Math.round(png.data[srcIdx + 2] * 0.45);
        crop.data[dstIdx + 3] = 255;
      }
    }

    for (const point of pillMask) {
      const x = point.x - cx0;
      const y = point.y - cy0;
      setPixel(crop.data, cropW, x, y, 0, 180, 255, 230);
    }

    for (const point of arcMask) {
      const x = point.x - cx0;
      const y = point.y - cy0;
      setPixel(crop.data, cropW, x, y, 0, 255, 80, 255);
    }

    const rx0 = pillBox.x - cx0;
    const ry0 = pillBox.y - cy0;
    const rx1 = rx0 + pillBox.width;
    const ry1 = ry0 + pillBox.height;
    const cbx0 = Math.max(0, rx0 - minClearancePx);
    const cby0 = Math.max(0, ry0 - minClearancePx);
    const cbx1 = Math.min(cropW - 1, rx1 + minClearancePx);
    const cby1 = Math.min(cropH - 1, ry1 + minClearancePx);

    for (let x = cbx0; x <= cbx1; x++) {
      if (x % 4 < 2) {
        setPixel(crop.data, cropW, x, cby0, 255, 150, 0, 240);
        setPixel(crop.data, cropW, x, cby1, 255, 150, 0, 240);
      }
    }
    for (let y = cby0; y <= cby1; y++) {
      if (y % 4 < 2) {
        setPixel(crop.data, cropW, cbx0, y, 255, 150, 0, 240);
        setPixel(crop.data, cropW, cbx1, y, 255, 150, 0, 240);
      }
    }

    if (closestPillPoint && closestArcPoint) {
      const x0 = closestPillPoint.x - cx0;
      const y0 = closestPillPoint.y - cy0;
      const x1 = closestArcPoint.x - cx0;
      const y1 = closestArcPoint.y - cy0;
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = Math.round(x0 + (x1 - x0) * t);
        const y = Math.round(y0 + (y1 - y0) * t);
        setPixel(crop.data, cropW, x, y, 255, 255, 0, 255);
        setPixel(crop.data, cropW, x + 1, y, 255, 255, 0, 255);
      }
    }

    const artifactPath = path.join(ctx.outputDir, `overlap-legibility-${regionId}-mask-clearance.png`);
    await fs.writeFile(artifactPath, PNG.sync.write(crop));
    return artifactPath;
  } catch {
    return null;
  }
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

/** Write the full actual image with the configured box highlighted by a thick magenta border.
 *  Judges use this to determine what element the box is targeting. */
async function writeAnnotatedFullScreen(
  ctx: AnalyzerContext,
  regionId: string,
  bx0: number, by0: number, bx1: number, by1: number
): Promise<string | null> {
  try {
    const png = ctx.actualPng;
    const annotated = new PNG({ width: png.width, height: png.height });
    png.data.copy(annotated.data);

    const BORDER = 4;
    // Draw thick magenta border around the box (outside the box, not inside)
    for (let t = 0; t < BORDER; t++) {
      // top and bottom bands
      const top = bx0 - t;
      const bottom = by1 + t;
      for (let x = Math.max(0, bx0 - BORDER); x <= Math.min(png.width - 1, bx1 + BORDER); x++) {
        if (by0 - t >= 0) setPixel(annotated.data, png.width, x, by0 - t, 255, 0, 255, 255);
        if (by1 + t < png.height) setPixel(annotated.data, png.width, x, by1 + t, 255, 0, 255, 255);
      }
      // left and right bands
      for (let y = Math.max(0, by0 - BORDER); y <= Math.min(png.height - 1, by1 + BORDER); y++) {
        if (bx0 - t >= 0) setPixel(annotated.data, png.width, bx0 - t, y, 255, 0, 255, 255);
        if (bx1 + t < png.width) setPixel(annotated.data, png.width, bx1 + t, y, 255, 0, 255, 255);
      }
      void top; void bottom; // suppress unused warnings
    }

    const artifactPath = path.join(ctx.outputDir, `overlap-legibility-${regionId}-annotated.png`);
    await fs.writeFile(artifactPath, PNG.sync.write(annotated));
    return artifactPath;
  } catch {
    return null;
  }
}

/** Write a generous-margin crop from the given PNG without any overlays (original pixels). */
async function writeGenerousCrop(
  png: PNG,
  outputPath: string,
  bx0: number, by0: number, bx1: number, by1: number,
  marginPx: number
): Promise<string | null> {
  try {
    const cx0 = Math.max(0, bx0 - marginPx);
    const cy0 = Math.max(0, by0 - marginPx);
    const cx1 = Math.min(png.width, bx1 + marginPx);
    const cy1 = Math.min(png.height, by1 + marginPx);
    const cropW = cx1 - cx0;
    const cropH = cy1 - cy0;
    if (cropW <= 0 || cropH <= 0) return null;

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
    await fs.writeFile(outputPath, PNG.sync.write(crop));
    return outputPath;
  } catch {
    return null;
  }
}

function buildCriterionDescription(region: { label?: string; target?: { expectedText?: string; anchorDescription?: string; mustContainText?: string[]; mustNotMatch?: string[] } }): string | undefined {
  const t = region.target;
  if (!t) return undefined;
  const parts: string[] = [];
  if (t.expectedText) parts.push(`Expected text: "${t.expectedText}"`);
  if (t.anchorDescription) parts.push(`Anchor: ${t.anchorDescription}`);
  if (t.mustContainText?.length) parts.push(`Must contain: ${t.mustContainText.map((s) => `"${s}"`).join(', ')}`);
  if (t.mustNotMatch?.length) parts.push(`Must NOT match (wrong element if visible): ${t.mustNotMatch.map((s) => `"${s}"`).join(', ')}`);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

export class OverlapLegibilityAnalyzer implements IAnalyzer {
  readonly name = 'OverlapLegibilityAnalyzer';
  readonly stage = 'stage1_deterministic' as const;

  async run(ctx: AnalyzerContext, graph: EvidenceGraph): Promise<AnalyzerResult> {
    const start = Date.now();
    const visualCaveats: VisualCaveat[] = [];
    const regionResults: OverlapLegibilityRegionResult[] = [];
    const criterionAuditBundles: CriterionAuditBundle[] = [];

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
          targetStatus: 'not_checked',
          measurementStatus: 'not_evaluated',
          judgeAuditStatus: 'not_run',
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
          targetStatus: 'not_checked',
          measurementStatus: 'not_evaluated',
          judgeAuditStatus: 'not_run',
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
          targetStatus: 'not_checked',
          measurementStatus: 'not_evaluated',
          judgeAuditStatus: 'not_run',
          skipReason: `Resolved box is empty or out of image bounds (${bx0},${by0})-(${bx1},${by1}); clamped to (${x0},${y0})-(${x1},${y1}); image=${imgWidth}x${imgHeight}`,
          resolvedBox: { x: bx0, y: by0, width: bx1 - bx0, height: by1 - by0, coordinateSpace: region.coordinateSpace ?? 'expected' },
          imageSize: { width: imgWidth, height: imgHeight },
          ...(roiForDebug ? { roiBox: roiForDebug.box } : {})
        });
        continue;
      }

      const totalPixels = Math.max(1, (x1 - x0) * (y1 - y0));
      const macroRingBoxRaw = (region as any).macroRingBox as PixelBox | undefined;

      if (macroRingBoxRaw) {
        const pillBox = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        const macroRingBox = clampPixelBox(macroRingBoxRaw, imgWidth, imgHeight);
        if (!macroRingBox) {
          regionResults.push({
            id: region.id,
            roiId: region.roiId,
            checked: false,
            status: 'error',
            targetStatus: 'not_checked',
            measurementStatus: 'not_evaluated',
            judgeAuditStatus: 'not_run',
            skipReason: 'Macro-ring anchor box is empty or out of image bounds',
            resolvedBox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, coordinateSpace: 'expected' },
            imageSize: { width: imgWidth, height: imgHeight }
          });
          continue;
        }

        const clearance = region.minClearancePx ?? 0;
        const pillMask = collectPillMask(png, pillBox);
        const arcMask = collectMacroRingArcMask(png, macroRingBox, avoidColors, colorThreshold, pillBox);
        const clearanceMeasurement = measureMaskClearance(pillMask, arcMask, clearance, pillBox);
        const clearancePx = clearanceMeasurement.clearancePx;
        const hasViolation = clearancePx !== null && clearancePx < clearance;
        const overlapPercent = pillMask.length > 0 ? clearanceMeasurement.arcOverlapCount / pillMask.length : 0;
        const sev = region.severity ?? 'high';
        const isBlocking = sev === 'critical' || sev === 'high';
        const measurementStatus: OverlapLegibilityRegionResult['measurementStatus'] =
          hasViolation ? (isBlocking ? 'fail' : 'caveat') : 'pass';
        const regionStatus: OverlapLegibilityRegionResult['status'] = hasViolation ? 'caveat' : 'pass';

        graph.add({
          source: 'overlapLegibility',
          claimId: `overlap-legibility-${region.id}`,
          subject: `region:${region.id}`,
          claim: `Region '${region.label ?? region.id}' macro-ring arc clearance: ${clearancePx === null ? 'not measurable' : `${clearancePx.toFixed(2)}px`}`,
          confidence: 0.85,
          authority: 'deterministic',
          measurements: {
            overlapPercent,
            maxOverlapPercent: (region.maxOverlapPercent ?? 5) / 100,
            regionId: region.id,
            proximityViolation: hasViolation,
            ...(clearancePx !== null ? { clearancePx } : {}),
            minClearancePx: clearance,
            pillMaskPixelCount: pillMask.length,
            macroRingArcPixelCount: arcMask.length,
            coloredPixelCountInBox: clearanceMeasurement.arcOverlapCount,
            coloredPixelCountInClearanceBand: clearanceMeasurement.arcPixelsInClearanceBand
          }
        });

        const artifactPath = await writeMaskClearanceArtifact(
          ctx,
          region.id,
          png,
          pillBox,
          macroRingBox,
          pillMask,
          arcMask,
          clearance,
          clearanceMeasurement.closestPillPoint,
          clearanceMeasurement.closestArcPoint
        );

        const GENEROUS_MARGIN = Math.max(100, clearance + 60);
        const annotatedActualPath = await writeAnnotatedFullScreen(ctx, region.id, x0, y0, x1, y1);
        const expectedCropPath = await writeGenerousCrop(
          ctx.expectedPng,
          path.join(ctx.outputDir, `overlap-legibility-${region.id}-expected-crop.png`),
          x0, y0, x1, y1, GENEROUS_MARGIN
        );
        const actualCropPath = await writeGenerousCrop(
          png,
          path.join(ctx.outputDir, `overlap-legibility-${region.id}-actual-crop.png`),
          x0, y0, x1, y1, GENEROUS_MARGIN
        );

        const criterionArtifacts: OverlapLegibilityRegionResult['criterionArtifacts'] = {};
        if (annotatedActualPath) criterionArtifacts.annotatedActualScreen = annotatedActualPath;
        if (expectedCropPath) criterionArtifacts.expectedCrop = expectedCropPath;
        if (actualCropPath) criterionArtifacts.actualCrop = actualCropPath;

        regionResults.push({
          id: region.id,
          roiId: region.roiId,
          checked: true,
          status: regionStatus,
          targetStatus: 'not_checked',
          measurementStatus,
          judgeAuditStatus: 'not_run',
          overlapPercent,
          clearancePx,
          nearestAvoidColorDistancePx: clearancePx,
          coloredPixelCountInBox: clearanceMeasurement.arcOverlapCount,
          coloredPixelCountInClearanceBand: clearanceMeasurement.arcPixelsInClearanceBand,
          pillMaskPixelCount: pillMask.length,
          macroRingArcPixelCount: arcMask.length,
          diagnosticLayers: ['pill_mask', 'macro_ring_arc_mask', 'clearance_band', 'closest_distance_vector'],
          minClearancePx: clearance,
          artifactPath: artifactPath ?? null,
          resolvedBox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, coordinateSpace: 'expected' },
          imageSize: { width: imgWidth, height: imgHeight },
          ...(Object.keys(criterionArtifacts).length > 0 ? { criterionArtifacts } : {})
        });

        const deterministicSummary = hasViolation
          ? `Clearance violation: macro-ring arc mask is ${clearancePx?.toFixed(1) ?? 'N/A'}px from the pill mask (min ${clearance}px). Pill mask pixels: ${pillMask.length}. Macro-ring arc mask pixels: ${arcMask.length}.`
          : `No clearance violation: macro-ring arc mask is ${clearancePx?.toFixed(1) ?? 'N/A'}px from the pill mask (min ${clearance}px). Pill mask pixels: ${pillMask.length}. Macro-ring arc mask pixels: ${arcMask.length}.`;

        criterionAuditBundles.push({
          criterionId: region.id,
          criterionLabel: region.label ?? region.id,
          criterionDescription: buildCriterionDescription(region as any),
          resolvedBox: { x0, y0, x1, y1 },
          deterministicSummary,
          artifacts: {
            fullExpectedScreen: ctx.expectedImagePath,
            fullActualScreen: ctx.actualImagePath,
            ...(annotatedActualPath ? { annotatedActualScreen: annotatedActualPath } : {}),
            ...(expectedCropPath ? { expectedCrop: expectedCropPath } : {}),
            ...(actualCropPath ? { actualCrop: actualCropPath } : {}),
            ...(artifactPath ? { diagnosticArtifact: artifactPath } : {})
          }
        });

        if (hasViolation) {
          visualCaveats.push({
            id: `overlap-legibility-${region.id}`,
            source: 'overlapLegibility',
            subject: `region:${region.id}`,
            severity: sev,
            blocking: isBlocking,
            message: `Region '${region.label ?? region.id}' has ${clearancePx?.toFixed(1) ?? 'N/A'}px macro-ring arc to pill clearance (min ${clearance}px).`,
            confidence: 0.85,
            measurements: {
              overlapPercent,
              maxOverlapPercent: (region.maxOverlapPercent ?? 5) / 100,
              proximityViolation: true,
              ...(clearancePx !== null ? { clearancePx } : {}),
              minClearancePx: clearance,
              coloredPixelCountInBox: clearanceMeasurement.arcOverlapCount,
              coloredPixelCountInClearanceBand: clearanceMeasurement.arcPixelsInClearanceBand,
              pillMaskPixelCount: pillMask.length,
              macroRingArcPixelCount: arcMask.length
            },
            artifacts: artifactPath ? [artifactPath] : []
          });
        }

        continue;
      }

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

      const maxAllowed = (region.maxOverlapPercent ?? 5) / 100;
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

      // Always write overlay diagnostic artifact
      const artifactPath = await writeOverlayArtifact(ctx, region.id, png, x0, y0, x1, y1, avoidColors, colorThreshold, clearance, nearestAvoidColorDistancePx);

      // Criterion audit artifacts: annotated full-screen + generous crops (original pixels)
      const GENEROUS_MARGIN = Math.max(100, clearance + 60);
      const annotatedActualPath = await writeAnnotatedFullScreen(ctx, region.id, x0, y0, x1, y1);
      const expectedCropPath = await writeGenerousCrop(
        ctx.expectedPng,
        path.join(ctx.outputDir, `overlap-legibility-${region.id}-expected-crop.png`),
        x0, y0, x1, y1, GENEROUS_MARGIN
      );
      const actualCropPath = await writeGenerousCrop(
        png,
        path.join(ctx.outputDir, `overlap-legibility-${region.id}-actual-crop.png`),
        x0, y0, x1, y1, GENEROUS_MARGIN
      );

      const regionStatus: OverlapLegibilityRegionResult['status'] = hasViolation ? 'caveat' : 'pass';
      const measurementStatus: OverlapLegibilityRegionResult['measurementStatus'] = hasViolation ? 'caveat' : 'pass';

      const criterionArtifacts: OverlapLegibilityRegionResult['criterionArtifacts'] = {};
      if (annotatedActualPath) criterionArtifacts.annotatedActualScreen = annotatedActualPath;
      if (expectedCropPath) criterionArtifacts.expectedCrop = expectedCropPath;
      if (actualCropPath) criterionArtifacts.actualCrop = actualCropPath;

      regionResults.push({
        id: region.id,
        roiId: region.roiId,
        checked: true,
        status: regionStatus,
        targetStatus: 'not_checked',
        measurementStatus,
        judgeAuditStatus: 'not_run',
        overlapPercent,
        nearestAvoidColorDistancePx,
        coloredPixelCountInBox: matchCount,
        coloredPixelCountInClearanceBand,
        minClearancePx: clearance,
        artifactPath: artifactPath ?? null,
        resolvedBox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, coordinateSpace: 'expected' },
        imageSize: { width: imgWidth, height: imgHeight },
        ...(Object.keys(criterionArtifacts).length > 0 ? { criterionArtifacts } : {})
      });

      // Build criterion audit bundle for this region
      const deterministicSummary = hasViolation
        ? (proximityViolation && overlapPercent <= maxAllowed
            ? `Clearance violation: avoid-color pixels within ${clearance}px of the box (nearest: ${nearestAvoidColorDistancePx?.toFixed(1) ?? 'N/A'}px). Overlap: ${(overlapPercent * 100).toFixed(2)}%.`
            : `Overlap violation: ${(overlapPercent * 100).toFixed(2)}% overlap with avoid-colors (max ${(maxAllowed * 100).toFixed(1)}%). Nearest avoid-color: ${nearestAvoidColorDistancePx?.toFixed(1) ?? 'N/A'}px.`)
        : `No violation. Overlap: ${(overlapPercent * 100).toFixed(2)}% (max ${(maxAllowed * 100).toFixed(1)}%). Nearest avoid-color: ${nearestAvoidColorDistancePx?.toFixed(1) ?? 'N/A'}px.`;

      const bundle: CriterionAuditBundle = {
        criterionId: region.id,
        criterionLabel: region.label ?? region.id,
        criterionDescription: buildCriterionDescription(region as any),
        resolvedBox: { x0, y0, x1, y1 },
        deterministicSummary,
        artifacts: {
          fullExpectedScreen: ctx.expectedImagePath,
          fullActualScreen: ctx.actualImagePath,
          ...(annotatedActualPath ? { annotatedActualScreen: annotatedActualPath } : {}),
          ...(expectedCropPath ? { expectedCrop: expectedCropPath } : {}),
          ...(actualCropPath ? { actualCrop: actualCropPath } : {}),
          ...(artifactPath ? { diagnosticArtifact: artifactPath } : {})
        }
      };
      criterionAuditBundles.push(bundle);

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
      },
      criterionAuditBundles: criterionAuditBundles.length > 0 ? criterionAuditBundles : undefined
    };
  }
}
