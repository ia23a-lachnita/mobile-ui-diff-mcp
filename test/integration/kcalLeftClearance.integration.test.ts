import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PNG } from 'pngjs';

vi.mock('../../src/pipeline/judges/providers/OpenRouterProvider');

import { OpenRouterProvider } from '../../src/pipeline/judges/providers/OpenRouterProvider';
import { runScreenUiDiff } from '../../src/tools/runScreenUiDiff';

const MockedOpenRouter = vi.mocked(OpenRouterProvider);

const IMG_W = 240;
const IMG_H = 240;
const DPR = 1;
const PILL = { x: 82, y: 54, width: 76, height: 26 };
const RING = { x: 54, y: 82, width: 132, height: 132 };
const GREEN = { r: 31, g: 204, b: 116 };
const DARK = { r: 12, g: 14, b: 18 };
const PILL_GREEN = { r: 28, g: 186, b: 100 };

let tmpDir: string;
let savedOpenRouterKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-kcal-clearance-'));
  savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  MockedOpenRouter.mockReset();
  MockedOpenRouter.mockImplementation(function () {
    return {
      analyze: vi.fn().mockResolvedValue([{
        source: 'modelJudge',
        claimId: 'openrouter-full-screen-match',
        subject: 'roi:screen',
        claim: 'The screen matches the expected layout.',
        confidence: 0.9,
        authority: 'model',
        polarity: 'match',
        blocking: false
      }]),
      analyzeCriterion: vi.fn().mockImplementation(async (packet: any) => ({
        criterionId: packet.criterionId,
        targetStatus: 'matched',
        judgeAuditStatus: 'pass',
        reasoning: 'The highlighted target covers the kcal-left pill.',
        confidence: 0.95
      }))
    };
  } as any);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
});

function setPixel(png: PNG, x: number, y: number, c: { r: number; g: number; b: number }): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (y * png.width + x) << 2;
  png.data[idx] = c.r;
  png.data[idx + 1] = c.g;
  png.data[idx + 2] = c.b;
  png.data[idx + 3] = 255;
}

function fillRect(png: PNG, box: { x: number; y: number; width: number; height: number }, c: { r: number; g: number; b: number }): void {
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) setPixel(png, x, y, c);
  }
}

function drawTextLikePixels(png: PNG): void {
  for (let y = PILL.y + 8; y < PILL.y + 18; y++) {
    for (const x of [PILL.x + 16, PILL.x + 17, PILL.x + 31, PILL.x + 32, PILL.x + 48, PILL.x + 49]) {
      setPixel(png, x, y, { r: 64, g: 230, b: 138 });
    }
  }
}

function drawRingArc(png: PNG, opts: { intrudes: boolean }): void {
  const cx = RING.x + RING.width / 2;
  const cy = RING.y + RING.height / 2;
  const radius = opts.intrudes ? 64 : 58;
  const stroke = 6;
  const startDeg = opts.intrudes ? 248 : 20;
  const endDeg = opts.intrudes ? 292 : 160;
  for (let deg = startDeg; deg <= endDeg; deg += 0.25) {
    const rad = deg * Math.PI / 180;
    for (let s = -stroke; s <= stroke; s++) {
      const x = Math.round(cx + (radius + s) * Math.cos(rad));
      const y = Math.round(cy + (radius + s) * Math.sin(rad));
      setPixel(png, x, y, GREEN);
    }
  }
}

function makeFixture(opts: { intrudes: boolean }): Buffer {
  const png = new PNG({ width: IMG_W, height: IMG_H });
  fillRect(png, { x: 0, y: 0, width: IMG_W, height: IMG_H }, DARK);
  drawRingArc(png, opts);
  fillRect(png, PILL, PILL_GREEN);
  drawTextLikePixels(png);
  return PNG.sync.write(png);
}

function makeAnchorDumpJson(): string {
  return JSON.stringify({
    framework: 'flutter',
    screen: 'TodayScreen',
    coordinateSpace: 'flutterLogical',
    coordinateOrigin: 'topLeft',
    device: {
      screenshotWidthPx: IMG_W,
      screenshotHeightPx: IMG_H,
      devicePixelRatio: DPR,
      mediaQuerySizeLogical: { width: IMG_W, height: IMG_H },
      paddingLogical: { top: 0, left: 0, right: 0, bottom: 0 },
      viewPaddingLogical: { top: 0, left: 0, right: 0, bottom: 0 },
      viewInsetsLogical: { top: 0, left: 0, right: 0, bottom: 0 }
    },
    anchors: [
      {
        id: 'today.kcalLeftPill',
        rectLogical: PILL,
        visible: true,
        visibility: { visibleFraction: 1, offscreen: false }
      },
      {
        id: 'today.macroRingHero',
        rectLogical: RING,
        visible: true,
        visibility: { visibleFraction: 1, offscreen: false }
      }
    ]
  });
}

function makeTargetMapJson(): string {
  return JSON.stringify({
    version: '1',
    screen: 'TodayScreen',
    targets: [
      {
        id: 'today.kcalLeftPill',
        locator: { type: 'flutter_anchor', anchorId: 'today.kcalLeftPill', required: true },
        expectedText: '980 kcal left',
        criteria: [
          {
            id: 'today.kcalLeftPill.legibility',
            domain: 'legibility.overlap',
            avoidColors: ['#1FCC74'],
            minClearancePx: 20,
            maxOverlapPercent: 1,
            severity: 'high',
            anchorDescription: 'kcal-left pill below the macro ring hero',
            mustContainText: ['kcal', 'left']
          }
        ]
      },
      {
        id: 'today.macroRingHero',
        locator: { type: 'flutter_anchor', anchorId: 'today.macroRingHero', required: true },
        criteria: []
      }
    ]
  });
}

async function writeFile(name: string, content: Buffer | string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, content);
  return p;
}

async function writeConfig(expectedPath: string, outputDir: string): Promise<string> {
  return writeFile('ui-diff.config.json', JSON.stringify({
    screens: {
      TodayScreen: {
        platform: 'none',
        expectedImage: expectedPath,
        outputDir,
        maxDiffPercent: 1,
        visualAuditMode: 'visual_parity',
        regionsOfInterest: [
          {
            id: 'screen',
            label: 'Full screen',
            type: 'component',
            critical: false,
            coordinateSpace: 'expected',
            box: { x: 0, y: 0, width: IMG_W, height: IMG_H },
            maxDiffPercent: 1
          }
        ],
        modelJudges: {
          enabled: true,
          primary: { provider: 'openrouter', model: 'test-model' }
        }
      }
    }
  }, null, 2));
}

async function runFixture(kind: 'clear' | 'intruding') {
  const expectedPath = await writeFile(`expected-${kind}.png`, makeFixture({ intrudes: kind === 'intruding' }));
  const actualPath = await writeFile(`actual-${kind}.png`, makeFixture({ intrudes: kind === 'intruding' }));
  const outputDir = path.join(tmpDir, `runs-${kind}`);
  const configPath = await writeConfig(expectedPath, outputDir);
  const anchorDir = path.join(tmpDir, `anchors-${kind}`);
  await fs.mkdir(anchorDir, { recursive: true });
  await fs.writeFile(path.join(anchorDir, 'flutter-anchors.json'), makeAnchorDumpJson());
  await fs.writeFile(path.join(anchorDir, 'flutter-anchors.done'), '');
  const targetMapPath = await writeFile(`target-map-${kind}.json`, makeTargetMapJson());

  const report = await runScreenUiDiff({
    screen: 'TodayScreen',
    configPath,
    actualImage: actualPath,
    runName: `run-kcal-${kind}`,
    targetMapPath,
    flutterAnchorsPath: anchorDir
  });
  const region = report.overlapLegibilitySummary?.regions.find((r) => r.id === 'today.kcalLeftPill.legibility');
  expect(region, 'missing kcal-left overlap region').toBeDefined();
  return { report, region: region as any };
}

describe('kcalLeftClearance', () => {
  it('ignoresPillOwnGreenPixelsWhenRingIsClear', async () => {
    const { report, region } = await runFixture('clear');

    expect(report.measurementBoxSource).toBe('flutter_anchor');
    expect(report.targetResolutionSummary?.resolvedViaFlutterAnchor).toBe(2);
    expect(report.targetResolutionSummary?.resolvedViaManualFallback).toBe(0);
    expect(region.targetStatus).toBe('matched');
    // measurementStatus is always 'caveat' for macroRingBox: color-heuristic cannot confirm absence of arc intrusion.
    expect(region.measurementStatus).toBe('caveat');
    expect(region.measurementReason).toBe('exact_arc_geometry_unavailable');
    const final = report.criterionJudgesSummary?.entries.find((e) => e.criterionId === region.id);
    expect(final?.finalMeasurementStatus).toBe('caveat');
    expect(region.coloredPixelCountInBox).toBe(0);
    expect(region.pillMaskPixelCount).toBeGreaterThan(0);
    expect(region.macroRingArcPixelCount).toBeGreaterThan(0);
    expect(region.clearancePx).toBeGreaterThanOrEqual(region.minClearancePx);
    expect(report.visualCaveats ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'overlap-legibility-today.kcalLeftPill.legibility' })])
    );
  });

  it('failsWhenMacroRingArcIntrudesIntoPillClearance', async () => {
    const { region } = await runFixture('intruding');

    expect(region.targetStatus).toBe('matched');
    expect(['fail', 'caveat']).toContain(region.measurementStatus);
    expect(region.measurementReason).toBe('exact_arc_geometry_unavailable');
    expect(region.clearancePx).toBeLessThan(region.minClearancePx);
    expect(region.artifactPath).toBeTruthy();
    await expect(fs.access(region.artifactPath)).resolves.toBeUndefined();
    expect(region.diagnosticLayers).toEqual(
      expect.arrayContaining(['pill_mask (bounding box)', 'macro_ring_arc_mask (color heuristic)', 'clearance_band', 'closest_distance_vector'])
    );
  });

  it('doesNotUseLegacyManualRoiFallback', async () => {
    const { report, region } = await runFixture('clear');

    expect(report.targetResolutionSummary?.resolvedViaManualFallback).toBe(0);
    expect(report.measurementBoxSource).toBe('flutter_anchor');
    expect(region.resolvedBox?.coordinateSpace).toBe('expected');
    expect(region.roiId).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('roiNormalized');
    expect(JSON.stringify(report)).not.toContain('manual_fallback');
  });
});
