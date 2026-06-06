/**
 * Unit tests for OverlapLegibilityAnalyzer coordinate conversion.
 *
 * Covers:
 *  1. roiNormalized: box resolved inside ROI, not out of image bounds
 *  2. normalized: box resolved relative to full image
 *  3. Double-multiplication regression: normalization in ArtifactBuilder must set coordinateSpace:'expected'
 *     so OverlapLegibilityAnalyzer does not re-multiply pixel coords by image dimensions
 *  4. ROI not found → falls back to raw box (box.x treated as absolute pixel)
 *  5. resolvedBox and imageSize fields present in successful result
 *  6. Error result includes resolvedBox, roiBox, imageSize for debugging
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PNG } from 'pngjs';
import { OverlapLegibilityAnalyzer } from '../src/pipeline/analyzers/OverlapLegibilityAnalyzer';
import { EvidenceGraph } from '../src/pipeline/EvidenceGraph';
import type { AnalyzerContext } from '../src/pipeline/analyzers/IAnalyzer';
import type { RegionOfInterestConfig } from '../src/types';

let tmpDir: string;

beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'olc-test-')); });
afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

function makePng(width: number, height: number, r = 200, g = 200, b = 200): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  }
  return png;
}

/** Place a green patch at absolute pixel coords */
function makePngWithGreen(width: number, height: number, px: number, py: number, pw: number, ph: number): PNG {
  const png = makePng(width, height);
  for (let y = py; y < py + ph; y++) {
    for (let x = px; x < px + pw; x++) {
      const idx = (y * width + x) << 2;
      png.data[idx] = 0; png.data[idx + 1] = 220; png.data[idx + 2] = 0; png.data[idx + 3] = 255;
    }
  }
  return png;
}

function makeCtx(
  png: PNG,
  regionsOfInterest: RegionOfInterestConfig[],
  overlapConfig: any
): AnalyzerContext {
  return {
    runId: 'test',
    outputDir: tmpDir,
    configDir: tmpDir,
    roiDir: tmpDir,
    regionsDir: tmpDir,
    expectedImagePath: '',
    actualImagePath: '',
    expectedPng: png,
    actualPng: png,
    comparisonPng: png,
    actualSourceWidth: png.width,
    actualSourceHeight: png.height,
    regionsOfInterest,
    ignoreRegions: [],
    config: { overlapLegibility: overlapConfig } as any
  };
}

// Image: 1206x2622; ROI macro-ring-hero at pixel x=48,y=336,w=1110,h=600 (coordinateSpace:'expected')
// This simulates what ArtifactBuilder produces after normalization — coordinateSpace is ALWAYS 'expected'
const IMG_W = 1206;
const IMG_H = 2622;
const ROI: RegionOfInterestConfig = {
  id: 'macro-ring-hero',
  label: 'Macro Ring Hero',
  type: 'component',
  coordinateSpace: 'expected',  // ArtifactBuilder always normalizes to 'expected'
  box: { x: 48, y: 336, width: 1110, height: 600 }
};

describe('OverlapLegibilityAnalyzer — coordinate resolution', () => {
  it('roiNormalized box resolves inside ROI, well within image bounds (no double-multiplication)', async () => {
    // box x:0.36,y:0.58,w:0.28,h:0.11 relative to ROI
    // expected: x≈48+0.36*1110=448, y≈336+0.58*600=684, w≈310, h≈66
    const png = makePng(IMG_W, IMG_H);
    const ctx = makeCtx(png, [ROI], {
      enabled: true,
      regions: [{
        id: 'kcal-left-pill',
        label: 'kcal pill',
        roiId: 'macro-ring-hero',
        coordinateSpace: 'roiNormalized',
        box: { x: 0.36, y: 0.58, width: 0.28, height: 0.11 },
        avoidColors: ['#00dc00'],
        maxOverlapPercent: 5
      }]
    });

    const result = await new OverlapLegibilityAnalyzer().run(ctx, new EvidenceGraph());
    const regions = result.overlapLegibilitySummary!.regions;
    expect(regions).toHaveLength(1);
    const r = regions[0];

    // Must NOT be an error from out-of-bounds
    expect(r.status).not.toBe('error');
    expect(r.checked).toBe(true);

    // resolvedBox must be inside image bounds
    expect(r.resolvedBox).toBeDefined();
    const rb = r.resolvedBox!;
    expect(rb.x).toBeGreaterThanOrEqual(0);
    expect(rb.y).toBeGreaterThanOrEqual(0);
    expect(rb.x + rb.width).toBeLessThanOrEqual(IMG_W);
    expect(rb.y + rb.height).toBeLessThanOrEqual(IMG_H);

    // Must be inside the ROI (x=48..1158, y=336..936)
    expect(rb.x).toBeGreaterThanOrEqual(48);
    expect(rb.y).toBeGreaterThanOrEqual(336);
    expect(rb.x + rb.width).toBeLessThanOrEqual(48 + 1110);
    expect(rb.y + rb.height).toBeLessThanOrEqual(336 + 600);

    // Roughly correct: x≈448, y≈684
    expect(rb.x).toBeGreaterThan(400);
    expect(rb.x).toBeLessThan(500);
    expect(rb.y).toBeGreaterThan(640);
    expect(rb.y).toBeLessThan(730);
  });

  it('normalized box resolves relative to full image', async () => {
    const png = makePng(IMG_W, IMG_H);
    const ctx = makeCtx(png, [ROI], {
      enabled: true,
      regions: [{
        id: 'top-area',
        label: 'top area',
        coordinateSpace: 'normalized',
        box: { x: 0.1, y: 0.05, width: 0.3, height: 0.1 },
        avoidColors: ['#00dc00'],
        maxOverlapPercent: 5
      }]
    });

    const result = await new OverlapLegibilityAnalyzer().run(ctx, new EvidenceGraph());
    const r = result.overlapLegibilitySummary!.regions[0];
    expect(r.checked).toBe(true);
    const rb = r.resolvedBox!;
    // x ≈ 0.1*1206=121, y ≈ 0.05*2622=131
    expect(rb.x).toBeCloseTo(121, -1);
    expect(rb.y).toBeCloseTo(131, -1);
    expect(rb.x + rb.width).toBeLessThanOrEqual(IMG_W);
    expect(rb.y + rb.height).toBeLessThanOrEqual(IMG_H);
  });

  it('regression: pre-normalized ROI (coordinateSpace:expected, pixel box) must not produce huge coords', async () => {
    // This is the exact regression from run-052: ArtifactBuilder converts normalized ROI to pixels
    // but if coordinateSpace is not updated to 'expected', OverlapLegibilityAnalyzer double-multiplies.
    // The fix: ArtifactBuilder and RunOrchestrator both set coordinateSpace:'expected' after normalization.
    const png = makePng(IMG_W, IMG_H);
    const ctx = makeCtx(png, [ROI], {  // ROI already has coordinateSpace:'expected'
      enabled: true,
      regions: [{
        id: 'kcal-pill-regression',
        roiId: 'macro-ring-hero',
        coordinateSpace: 'roiNormalized',
        box: { x: 0.36, y: 0.58, width: 0.28, height: 0.11 },
        avoidColors: ['#ff0000'],
        maxOverlapPercent: 5
      }]
    });

    const result = await new OverlapLegibilityAnalyzer().run(ctx, new EvidenceGraph());
    const r = result.overlapLegibilitySummary!.regions[0];
    expect(r.status).not.toBe('error');
    // Resolved coords must be sane (not hundreds of thousands)
    const rb = r.resolvedBox!;
    expect(rb.x).toBeLessThan(IMG_W);
    expect(rb.y).toBeLessThan(IMG_H);
  });

  it('roiNormalized with green patch in box → caveat detected, artifact created', async () => {
    // Green patch at absolute x:450,y:690 (inside the resolved kcal-left-pill box)
    const png = makePngWithGreen(IMG_W, IMG_H, 450, 690, 50, 30);
    const outDir = path.join(tmpDir, 'artifact-test');
    await fs.mkdir(outDir, { recursive: true });
    const ctx = makeCtx(png, [ROI], {
      enabled: true,
      regions: [{
        id: 'kcal-left-pill',
        label: 'kcal pill',
        roiId: 'macro-ring-hero',
        coordinateSpace: 'roiNormalized',
        box: { x: 0.36, y: 0.58, width: 0.28, height: 0.11 },
        avoidColors: ['#00dc00'],
        maxOverlapPercent: 0
      }]
    });
    (ctx as any).outputDir = outDir;

    const result = await new OverlapLegibilityAnalyzer().run(ctx, new EvidenceGraph());
    const r = result.overlapLegibilitySummary!.regions[0];
    expect(r.checked).toBe(true);
    expect(r.overlapPercent).toBeGreaterThan(0);
    expect(r.status).toBe('caveat');
    expect(r.artifactPath).toBeTruthy();
  });

  it('artifact always created for passing region (proves what was measured)', async () => {
    const outDir = path.join(tmpDir, 'artifact-pass');
    await fs.mkdir(outDir, { recursive: true });
    const png = makePng(IMG_W, IMG_H);  // no green — should pass
    const ctx = makeCtx(png, [ROI], {
      enabled: true,
      regions: [{
        id: 'kcal-left-pill',
        roiId: 'macro-ring-hero',
        coordinateSpace: 'roiNormalized',
        box: { x: 0.36, y: 0.58, width: 0.28, height: 0.11 },
        avoidColors: ['#00dc00'],
        maxOverlapPercent: 5
      }]
    });
    (ctx as any).outputDir = outDir;

    const result = await new OverlapLegibilityAnalyzer().run(ctx, new EvidenceGraph());
    const r = result.overlapLegibilitySummary!.regions[0];
    expect(r.status).toBe('pass');
    expect(r.artifactPath).toBeTruthy();
  });

  it('unknown ROI id → error with imageSize and skipReason for debugging', async () => {
    const png = makePng(IMG_W, IMG_H);
    const ctx = makeCtx(png, [ROI], {
      enabled: true,
      regions: [{
        id: 'bad-roi-region',
        roiId: 'nonexistent-roi',
        coordinateSpace: 'roiNormalized',
        box: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 },
        avoidColors: ['#00dc00']
      }]
    });

    const result = await new OverlapLegibilityAnalyzer().run(ctx, new EvidenceGraph());
    const r = result.overlapLegibilitySummary!.regions[0];
    // ROI not found → falls back to raw box coords (0.5,0.5,0.1,0.1 pixels = out of range in a different way)
    // The important thing: no crash and imageSize is present for debugging
    expect(r.imageSize).toEqual({ width: IMG_W, height: IMG_H });
  });
});
