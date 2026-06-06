/**
 * Integration test for the run-052 coordinate bug:
 *   parent ROI coordinateSpace:"normalized" + overlapLegibility coordinateSpace:"roiNormalized"
 *
 * Before the fix, resolveRoiToPixels fell through to the raw-pixel branch for a
 * 'normalized' ROI, producing huge coordinates like (527649, 1959893) for a 1080×2400 image.
 *
 * Asserts:
 *  - resolvedBox is inside the parent ROI pixel bounds (not out-of-image)
 *  - checked:true
 *  - artifactPath written to disk
 *  - no impossible coordinates (x/y < image dimensions)
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PNG } from 'pngjs';

vi.mock('../../src/pipeline/judges/providers/OpenRouterProvider');

import { OpenRouterProvider } from '../../src/pipeline/judges/providers/OpenRouterProvider';
import { runScreenUiDiff } from '../../src/tools/runScreenUiDiff';

const MockedProvider = vi.mocked(OpenRouterProvider);

// ── image dimensions matching the run-052 scenario (scaled down 2× to keep test fast) ──

const IMG_W = 540;  // half of 1080
const IMG_H = 1200; // half of 2400

// ROI macro-ring-hero in normalized coordinates (from Calorix today screen config)
// Resolves to pixel: x0≈22, y0≈154, width≈497, height≈275 on a 540×1200 image
const ROI_NORM = { x: 0.04, y: 0.128, width: 0.92, height: 0.229 };

// overlapLegibility box in roiNormalized coordinates (kcal-left-pill region)
// Resolves to approx: x0≈22+0.36*497=201, y0≈154+0.58*275=314, width≈139, height≈30
const OVERLAP_BOX = { x: 0.36, y: 0.58, width: 0.28, height: 0.11 };

function makeWhitePng(width = IMG_W, height = IMG_H): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 240; png.data[i + 1] = 240; png.data[i + 2] = 240; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** Green patch at absolute pixel coords — placed inside the expected resolved overlap box */
function makeImageWithGreenInResolvedBox(width = IMG_W, height = IMG_H): Buffer {
  // Compute expected resolved box pixel coords
  const roiX0 = Math.round(ROI_NORM.x * width);
  const roiY0 = Math.round(ROI_NORM.y * height);
  const roiW  = Math.round(ROI_NORM.width * width);
  const roiH  = Math.round(ROI_NORM.height * height);
  const bx0   = roiX0 + Math.round(OVERLAP_BOX.x * roiW);
  const by0   = roiY0 + Math.round(OVERLAP_BOX.y * roiH);
  const bx1   = roiX0 + Math.round((OVERLAP_BOX.x + OVERLAP_BOX.width) * roiW);
  const by1   = roiY0 + Math.round((OVERLAP_BOX.y + OVERLAP_BOX.height) * roiH);

  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      if (x >= bx0 && x < bx1 && y >= by0 && y < by1) {
        png.data[idx] = 0; png.data[idx + 1] = 220; png.data[idx + 2] = 0; png.data[idx + 3] = 255;
      } else {
        png.data[idx] = 240; png.data[idx + 1] = 240; png.data[idx + 2] = 240; png.data[idx + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

// ── test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;
let savedApiKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-run052-'));
  savedApiKey = process.env.OPENROUTER_API_KEY;
  MockedProvider.mockReset();
  MockedProvider.mockImplementation(function() { return { analyze: vi.fn().mockResolvedValue([]) }; } as any);
  process.env.OPENROUTER_API_KEY = 'test-key-run052';
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (savedApiKey !== undefined) {
    process.env.OPENROUTER_API_KEY = savedApiKey;
  } else {
    delete process.env.OPENROUTER_API_KEY;
  }
});

async function writeFile(name: string, buf: Buffer | string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, buf);
  return p;
}

async function writeConfig(cfg: Record<string, unknown>): Promise<string> {
  const configPath = path.join(tmpDir, 'ui-diff.config.json');
  await fs.writeFile(configPath, JSON.stringify({ screens: { today: cfg } }, null, 2));
  return configPath;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('run-052 coordinate bug: roiNormalized box with normalized parent ROI', () => {
  it('resolves inside parent ROI bounds — no impossible coordinates', async () => {
    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath   = await writeFile('actual.png',   makeWhitePng());
    const configPath = await writeConfig({
      platform: 'none',
      expectedImage: expectedPath,
      outputDir: path.join(tmpDir, 'runs'),
      visualAuditMode: 'visual_parity',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      regionsOfInterest: [{
        id: 'macro-ring-hero',
        label: 'Macro Ring Hero',
        type: 'component',
        coordinateSpace: 'normalized',
        box: ROI_NORM
      }],
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: 'kcal pill',
          roiId: 'macro-ring-hero',
          coordinateSpace: 'roiNormalized',
          box: OVERLAP_BOX,
          avoidColors: ['#00dc00'],
          maxOverlapPercent: 5
        }]
      }
    });

    const run = await runScreenUiDiff({ screen: 'today', configPath, actualImage: actualPath, runName: 'run-052-test' });

    const summary = (run as any).overlapLegibilitySummary;
    expect(summary, 'overlapLegibilitySummary missing from report').toBeDefined();
    const regions = summary?.regions ?? [];
    expect(regions).toHaveLength(1);

    const r = regions[0];
    expect(r.checked).toBe(true);
    expect(r.status).not.toBe('error');

    // resolvedBox must be within image bounds — the run-052 bug produced x≈527649
    expect(r.resolvedBox).toBeDefined();
    const rb = r.resolvedBox!;
    expect(rb.x).toBeGreaterThanOrEqual(0);
    expect(rb.y).toBeGreaterThanOrEqual(0);
    expect(rb.x + rb.width).toBeLessThanOrEqual(IMG_W);
    expect(rb.y + rb.height).toBeLessThanOrEqual(IMG_H);

    // resolvedBox must be inside the parent ROI pixel region
    const roiX0 = Math.round(ROI_NORM.x * IMG_W);
    const roiY0 = Math.round(ROI_NORM.y * IMG_H);
    const roiX1 = Math.round((ROI_NORM.x + ROI_NORM.width) * IMG_W);
    const roiY1 = Math.round((ROI_NORM.y + ROI_NORM.height) * IMG_H);
    expect(rb.x).toBeGreaterThanOrEqual(roiX0);
    expect(rb.y).toBeGreaterThanOrEqual(roiY0);
    expect(rb.x + rb.width).toBeLessThanOrEqual(roiX1);
    expect(rb.y + rb.height).toBeLessThanOrEqual(roiY1);

    // artifactPath must exist on disk
    expect(r.artifactPath).toBeTruthy();
    await expect(fs.access(r.artifactPath!)).resolves.toBeUndefined();
  });

  it('detects green-pill overlap and produces caveat + artifact when green present in resolved box', async () => {
    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath   = await writeFile('actual.png',   makeImageWithGreenInResolvedBox());
    const configPath = await writeConfig({
      platform: 'none',
      expectedImage: expectedPath,
      outputDir: path.join(tmpDir, 'runs'),
      visualAuditMode: 'visual_parity',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      regionsOfInterest: [{
        id: 'macro-ring-hero',
        label: 'Macro Ring Hero',
        type: 'component',
        coordinateSpace: 'normalized',
        box: ROI_NORM
      }],
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: 'kcal pill',
          roiId: 'macro-ring-hero',
          coordinateSpace: 'roiNormalized',
          box: OVERLAP_BOX,
          avoidColors: ['#00dc00'],
          maxOverlapPercent: 0,  // any green at all triggers caveat
          severity: 'high'
        }]
      }
    });

    const run = await runScreenUiDiff({ screen: 'today', configPath, actualImage: actualPath, runName: 'run-052-green' });

    const summary = (run as any).overlapLegibilitySummary;
    const r = summary?.regions?.[0];
    expect(r?.checked).toBe(true);
    expect(r?.overlapPercent).toBeGreaterThan(0);
    expect(r?.status).toBe('caveat');
    expect(r?.artifactPath).toBeTruthy();
    await expect(fs.access(r!.artifactPath!)).resolves.toBeUndefined();

    // Caveat must surface in visualCaveats
    const caveat = run.visualCaveats?.find((c) => c.id === 'overlap-legibility-kcal-left-pill');
    expect(caveat).toBeDefined();
    expect(caveat!.blocking).toBe(true);
  });
});
