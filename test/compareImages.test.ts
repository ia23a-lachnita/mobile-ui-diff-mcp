import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PNG } from 'pngjs';
import fs from 'fs/promises';
import path from 'path';
import { compareImages } from '../src/tools/compareImages';
import {
  compareImagesSchema,
  runMobileUiDiffSchema,
  captureAndroidSchema,
  captureIosSchema
} from '../src/mcp/server';

async function createTestImage(p: string, draw: (png: PNG) => void) {
  const png = new PNG({ width: 100, height: 100 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = 255;
      png.data[idx+1] = 255;
      png.data[idx+2] = 255;
      png.data[idx+3] = 255;
    }
  }
  draw(png);
  await fs.writeFile(p, PNG.sync.write(png));
}

async function createSizedTestImage(p: string, width: number, height: number, draw: (png: PNG) => void) {
  const png = new PNG({ width, height });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = 255;
      png.data[idx+1] = 255;
      png.data[idx+2] = 255;
      png.data[idx+3] = 255;
    }
  }
  draw(png);
  await fs.writeFile(p, PNG.sync.write(png));
}

function drawRect(png: PNG, rx: number, ry: number, rw: number, rh: number, color: [number, number, number]) {
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      if (x < 0 || x >= png.width || y < 0 || y >= png.height) continue;
      const idx = (png.width * y + x) << 2;
      png.data[idx] = color[0];
      png.data[idx+1] = color[1];
      png.data[idx+2] = color[2];
      png.data[idx+3] = 255;
    }
  }
}

function setPixel(png: PNG, x: number, y: number, color: [number, number, number]) {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx] = color[0];
  png.data[idx+1] = color[1];
  png.data[idx+2] = color[2];
  png.data[idx+3] = 255;
}

function drawRing(png: PNG, cx: number, cy: number, radius: number, strokeWidth: number, color: [number, number, number]) {
  const outer = radius + strokeWidth / 2;
  const inner = radius - strokeWidth / 2;
  for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
    for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
      const distance = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (distance >= inner && distance <= outer) {
        setPixel(png, x, y, color);
      }
    }
  }
}

function drawTodayMacroFixture(png: PNG, variant: 'expected' | 'actual') {
  drawRect(png, 0, 0, png.width, png.height, [248, 249, 246]);
  drawRect(png, 10, 52, 220, 170, [255, 255, 255]);
  if (variant === 'expected') {
    drawRing(png, 120, 130, 56, 4, [48, 140, 118]);
    drawRing(png, 120, 130, 44, 4, [230, 162, 78]);
    drawRing(png, 120, 130, 32, 4, [96, 126, 210]);
    drawRect(png, 98, 120, 44, 6, [20, 24, 31]);
    drawRect(png, 103, 133, 34, 5, [88, 96, 104]);
  } else {
    drawRing(png, 120, 130, 62, 11, [48, 140, 118]);
    drawRing(png, 120, 130, 46, 10, [230, 162, 78]);
    drawRing(png, 120, 130, 30, 9, [96, 126, 210]);
    drawRect(png, 88, 116, 64, 12, [20, 24, 31]);
    drawRect(png, 90, 128, 60, 12, [88, 96, 104]);
  }
  drawRect(png, 24, 250, 192, 18, [232, 236, 240]);
  drawRect(png, 24, 284, 172, 18, [232, 236, 240]);
}

describe('compareImages and Schemas', () => {
  const testDir = path.join(__dirname, 'fixtures');
  
  beforeAll(async () => {
    await fs.mkdir(testDir, { recursive: true });
    
    await createTestImage(path.join(testDir, 'base.png'), (png) => {
      drawRect(png, 10, 10, 20, 20, [0, 0, 0]);
    });
    await createTestImage(path.join(testDir, 'identical.png'), (png) => {
      drawRect(png, 10, 10, 20, 20, [0, 0, 0]);
    });
    
    await createTestImage(path.join(testDir, 'shifted.png'), (png) => {
      drawRect(png, 15, 10, 20, 20, [0, 0, 0]);
    });
    
    await createTestImage(path.join(testDir, 'multi.png'), (png) => {
      drawRect(png, 10, 10, 20, 20, [0, 0, 0]);
      drawRect(png, 50, 50, 10, 10, [255, 0, 0]);
      drawRect(png, 80, 80, 5, 5, [0, 255, 0]);
    });

    await createSizedTestImage(path.join(testDir, 'expected-big.png'), 100, 100, (png) => {
      drawRect(png, 10, 10, 20, 20, [0, 0, 0]);
    });
    await createSizedTestImage(path.join(testDir, 'actual-big.png'), 200, 200, (png) => {
      drawRect(png, 20, 20, 40, 40, [0, 0, 0]);
    });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('a. passes on identical images', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'identical.png'),
      outputDir: path.join(testDir, 'out-identical')
    });
    expect(result.status).toBe('pass');
    expect(result.diffPixels).toBe(0);
    expect(result.regions).toHaveLength(0);
  });

  it('b. fails on shifted image and returns one changed region', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-shifted')
    });
    expect(result.status).toBe('fail');
    expect(result.diffPixels).toBeGreaterThan(0);
    expect(result.regions.length).toBeGreaterThan(0);
  });

  it('c. passes when ignoreRegion covers the diff', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-ignore'),
      ignoreRegions: [{ x: 10, y: 10, width: 30, height: 20 }]
    });
    expect(result.status).toBe('pass');
    expect(result.diffPixels).toBe(0);
  });

  it('d. maxDiffPercent controls pass/fail independently from pixelmatchThreshold', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-diff-percent'),
      maxDiffPercent: 1.0
    });
    expect(result.status).toBe('pass');
    expect(result.diffPixels).toBeGreaterThan(0);
  });

  it('e. maxRegions keeps largest regions, not first screen-position regions', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'multi.png'),
      outputDir: path.join(testDir, 'out-multi'),
      maxRegions: 1
    });
    
    expect(result.regions).toHaveLength(1);
    const region = result.regions[0];
    expect(region.area).toBeGreaterThanOrEqual(100);
  });

  it('f. invalid Zod inputs are rejected', () => {
    const invalidInputs = {
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'identical.png'),
      outputDir: path.join(testDir, 'out-identical'),
      pixelmatchThreshold: 1.5,
      maxRegions: -5,
      ignoreRegions: [{ x: -1, y: 0, width: 10, height: 10 }]
    };
    const parsed = compareImagesSchema.safeParse(invalidInputs);
    expect(parsed.success).toBe(false);

    const preCaptureParsed = compareImagesSchema.safeParse({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'identical.png'),
      outputDir: path.join(testDir, 'out-identical'),
      preCapture: [{ type: 'adbShell', command: 'input tap 1 1', description: 'nope' }]
    } as any);
    expect(preCaptureParsed.success).toBe(false);
  });

  it('g. Ollama fallback returns structured fallback status', async () => {
    const originalUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = 'http://localhost:59999';
    try {
      const result = await compareImages({
        expectedImage: path.join(testDir, 'base.png'),
        actualImage: path.join(testDir, 'multi.png'),
        outputDir: path.join(testDir, 'out-ollama'),
        maxRegions: 1,
        maxVlmRegions: 1,
        includeVlmAnalysis: true
      });
      expect(result.regions[0].analysisStatus).toBe('fallback');
      expect(result.warnings).toContain('VLM analysis was requested but unavailable. Region analysis fell back to error/fallback statuses. Run vlm_health or start Ollama.');
    } finally {
      process.env.OLLAMA_BASE_URL = originalUrl;
    }
  });

  it('h. Android/iOS capture functions reject unsafe device/simulator IDs', () => {
    const invalidAndroid = captureAndroidSchema.safeParse({
      outputPath: 'out.png',
      deviceId: 'invalid id ; ls'
    });
    expect(invalidAndroid.success).toBe(false);

    const validAndroid = captureAndroidSchema.safeParse({
      outputPath: 'out.png',
      deviceId: '192.168.1.50:5555'
    });
    expect(validAndroid.success).toBe(true);

    const invalidIos = captureIosSchema.safeParse({
      outputPath: 'out.png',
      simulator: 'iPhone 14 | reboot'
    });
    expect(invalidIos.success).toBe(false);

    const validIos = captureIosSchema.safeParse({
      outputPath: 'out.png',
      simulator: '028DFBA8-692B-45EA-A9D8-A973C56DC2C9'
    });
    expect(validIos.success).toBe(true);
  });

  it('i. applies default region limits through Zod schemas', () => {
    const parsedCompare = compareImagesSchema.parse({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'identical.png'),
      outputDir: path.join(testDir, 'out-defaults')
    });
    expect(parsedCompare.maxRegions).toBe(50);
    expect(parsedCompare.maxVlmRegions).toBe(10);

    const parsedRun = runMobileUiDiffSchema.parse({
      platform: 'none',
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'identical.png'),
      outputDir: path.join(testDir, 'out-run-defaults')
    });
    expect(parsedRun.maxRegions).toBe(50);
    expect(parsedRun.maxVlmRegions).toBe(10);
  });

  it('j. warns when VLM analysis is disabled', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'identical.png'),
      outputDir: path.join(testDir, 'out-no-vlm')
    });
    expect(result.warnings).toContain('VLM analysis disabled. Enable includeVlmAnalysis for semantic region explanations.');
  });

  it('k. parses optional VLM label when returned by Ollama', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const urlString = String(url);
      if (urlString.endsWith('/api/tags')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: process.env.OLLAMA_MODEL || 'qwen2.5vl:7b' }] }),
          text: async () => ''
        } as Response;
      }
      if (urlString.endsWith('/api/ps')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [] }),
          text: async () => ''
        } as Response;
      }
      if (urlString.endsWith('/api/chat')) {
        const body = JSON.parse((options?.body as string) || '{}');
        const imageCount = body?.messages?.[0]?.images?.length ?? 0;
        if (imageCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ message: { content: '{}' } }),
            text: async () => ''
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            message: {
              content: JSON.stringify({
                label: 'bottom navigation',
                type: 'layout',
                severity: 'medium',
                description: 'Navigation bar is shifted',
                likelyFix: 'Align container constraints'
              })
            }
          }),
          text: async () => ''
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${urlString}`);
    }));

    try {
      const result = await compareImages({
        expectedImage: path.join(testDir, 'base.png'),
        actualImage: path.join(testDir, 'shifted.png'),
        outputDir: path.join(testDir, 'out-vlm-label'),
        includeVlmAnalysis: true,
        maxRegions: 1,
        maxVlmRegions: 1
      });
      expect(result.regions[0].analysisStatus).toBe('ok');
      expect(result.regions[0].analysis?.label).toBe('bottom navigation');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('l. fails quality when critical ROI diff exceeds local threshold even if global diff is stable', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-critical-roi'),
      maxDiffPercent: 1.0,
      regionsOfInterest: [
        {
          id: 'macro-ring',
          label: 'Macro ring chart',
          type: 'component',
          critical: true,
          weight: 10,
          coordinateSpace: 'normalized',
          box: { x: 0.08, y: 0.08, width: 0.42, height: 0.42 },
          maxDiffPercent: 0.01
        }
      ]
    } as any);

    expect(result.status).toBe('pass');
    expect(result.qualityStatus).toBe('fail');
    expect(result.qualityFailures?.[0]?.type).toBe('critical_roi_failed');
    expect(result.priorityFindings?.[0]?.kind).toBe('critical_roi_failed');
    expect(result.agentSummary?.canStopIterating).toBe(false);
    expect(result.regionsOfInterest?.[0].label).toBe('Macro ring chart');
  });

  it('l2. promotes critical visual assertion failures when no critical ROI failed', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-critical-visual-assertion'),
      maxDiffPercent: 1.0,
      regionsOfInterest: [
        {
          id: 'macro-ring',
          label: 'Macro ring chart',
          type: 'component',
          critical: false,
          weight: 10,
          coordinateSpace: 'normalized',
          box: { x: 0.08, y: 0.08, width: 0.42, height: 0.42 },
          maxDiffPercent: 1.0
        }
      ],
      visualAssertions: [
        {
          id: 'macro-ring-local-diff',
          type: 'roiMaxDiffPercent',
          roiId: 'macro-ring',
          maxDiffPercent: 0.01,
          severity: 'critical',
          message: 'Macro ring chart is visually too different from mockup.'
        }
      ]
    } as any);

    expect(result.status).toBe('pass');
    expect(result.qualityStatus).toBe('fail');
    expect(result.qualityFailures?.[0]?.type).toBe('critical_visual_assertion_failed');
    expect(result.priorityFindings?.[0]?.kind).toBe('critical_visual_assertion_failed');
    expect(result.priorityFindings?.[0]?.label).toBe('macro-ring-local-diff');
    expect(result.priorityFindings?.[0]?.message).toBe('Macro ring chart is visually too different from mockup.');
    expect(result.agentSummary?.canStopIterating).toBe(false);
  });

  it('m. maps actual-space roi boxes from original actual dimensions', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'expected-big.png'),
      actualImage: path.join(testDir, 'actual-big.png'),
      outputDir: path.join(testDir, 'out-actual-roi'),
      regionsOfInterest: [
        {
          id: 'macro-ring',
          label: 'Macro ring chart',
          type: 'component',
          critical: true,
          weight: 10,
          coordinateSpace: 'actual',
          box: { x: 20, y: 20, width: 40, height: 40 },
          maxDiffPercent: 0.01
        }
      ]
    } as any);

    expect(result.regionsOfInterest?.[0].box).toEqual({ x: 10, y: 10, width: 20, height: 20 });
    expect(result.regionsOfInterest?.[0].status).toBe('pass');
  });

  it('n. uses roi and normalized masks in comparison canvas space', async () => {
    const expectedMaskBig = path.join(testDir, 'expected-mask-big.png');
    const actualMaskBig = path.join(testDir, 'actual-mask-big.png');
    await createTestImage(expectedMaskBig, () => {});
    await createSizedTestImage(actualMaskBig, 200, 200, (png) => {
      drawRect(png, 0, 180, 200, 20, [0, 0, 0]);
    });

    const result = await compareImages({
      expectedImage: expectedMaskBig,
      actualImage: actualMaskBig,
      outputDir: path.join(testDir, 'out-mask-space'),
      ignoreRegions: [
        { x: 0, y: 180, width: 200, height: 20, type: 'system', coordinateSpace: 'actual', reason: 'nav bar' }
      ]
    } as any);

    expect(result.status).toBe('pass');
    expect(result.diffPixels).toBe(0);

    const normalizedMaskResult = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-normalized-mask'),
      ignoreRegions: [
        { x: 0.1, y: 0.1, width: 0.3, height: 0.2, type: 'system', coordinateSpace: 'normalized', reason: 'shift area' }
      ]
    } as any);

    expect(normalizedMaskResult.status).toBe('pass');
    expect(normalizedMaskResult.diffPixels).toBe(0);
  });

  it('o. blocks floor detection and maxDiffPercent suggestion when critical ROI or visual assertion fails', async () => {
    const previousReport = {
      status: 'fail',
      diffPixels: 123,
      totalPixels: 10000,
      diffPercent: 0.1366,
      pixelmatchThreshold: 0.1,
      maxDiffPercent: 0.001,
      regions: [],
      artifacts: {
        expected: 'expected.png',
        actual: 'actual.png',
        diff: 'diff.png',
        regionsDir: 'regions'
      },
      atFloor: true
    } as any;

    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-floor-blocked'),
      maxDiffPercent: 0.5,
      previousReport,
      floorDetection: {
        enabled: true,
        deltaThreshold: 0.0001,
        consecutiveRuns: 2
      },
      regionsOfInterest: [
        {
          id: 'macro-ring',
          label: 'Macro ring chart',
          type: 'component',
          critical: true,
          weight: 10,
          coordinateSpace: 'normalized',
          box: { x: 0.08, y: 0.08, width: 0.42, height: 0.42 },
          maxDiffPercent: 0.01
        }
      ],
      visualAssertions: [
        {
          id: 'macro-ring-local-diff',
          type: 'roiMaxDiffPercent',
          roiId: 'macro-ring',
          maxDiffPercent: 0.01,
          severity: 'critical',
          message: 'Macro ring chart is visually too different from mockup.'
        }
      ]
    } as any);

    expect(result.atFloor).toBe(false);
    expect(result.floorBlockedBy?.[0].type).toBe('critical_roi_failed');
    expect(result.visualAssertions?.[0].status).toBe('fail');
    expect(result.suggestedMaxDiffPercent).toBeNull();
    expect(result.maxDiffPercentSuggestionBlockedBy?.[0]).toContain("Critical ROI 'Macro ring chart' failed.");
    expect(result.agentSummary?.canStopIterating).toBe(false);
  });

  it('p. detects floor after two stable deltas and rounds suggestion', async () => {
    const baseline = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-floor-baseline'),
      maxDiffPercent: 1.0,
      regionsOfInterest: [
        {
          id: 'whole-screen',
          label: 'Whole screen',
          type: 'zone',
          critical: true,
          coordinateSpace: 'normalized',
          box: { x: 0, y: 0, width: 1, height: 1 },
          maxDiffPercent: 1.0
        }
      ],
      floorDetection: { enabled: true, deltaThreshold: 0.0001, consecutiveRuns: 2 }
    } as any);

    const waiting = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-floor-waiting'),
      maxDiffPercent: 0.0001,
      floorDetection: { enabled: true, deltaThreshold: 0.0001, consecutiveRuns: 2 },
      regionsOfInterest: [
        {
          id: 'whole-screen',
          label: 'Whole screen',
          type: 'zone',
          critical: true,
          coordinateSpace: 'normalized',
          box: { x: 0, y: 0, width: 1, height: 1 },
          maxDiffPercent: 1.0
        }
      ],
      previousReport: {
        ...baseline,
        delta: undefined
      } as any
    } as any);

    expect(waiting.atFloor).toBe(false);
    expect(waiting.floorReason).toBe('waiting for consecutive stable run');

    const stable = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-floor-stable'),
      maxDiffPercent: 0.0001,
      floorDetection: { enabled: true, deltaThreshold: 0.0001, consecutiveRuns: 2 },
      regionsOfInterest: [
        {
          id: 'whole-screen',
          label: 'Whole screen',
          type: 'zone',
          critical: true,
          coordinateSpace: 'normalized',
          box: { x: 0, y: 0, width: 1, height: 1 },
          maxDiffPercent: 1.0
        }
      ],
      previousReport: {
        ...baseline,
        delta: { diffPercentDelta: 0.00001 }
      } as any
    } as any);

    expect(stable.atFloor).toBe(true);
    expect(stable.suggestedMaxDiffPercent).toBe(Math.round(stable.diffPercent * 1.1 * 10000) / 10000);
  });

  it('q. warns when data mask overlaps critical ROI', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-data-mask-warning'),
      maxDiffPercent: 1.0,
      ignoreRegions: [
        { x: 0.0, y: 0.0, width: 0.4, height: 0.4, reason: 'fixture diff', type: 'data', coordinateSpace: 'normalized' }
      ],
      regionsOfInterest: [
        {
          id: 'macro-ring',
          label: 'Macro ring chart',
          type: 'component',
          critical: true,
          weight: 10,
          coordinateSpace: 'expected',
          box: { x: 5, y: 5, width: 30, height: 30 },
          maxDiffPercent: 0.01
        }
      ]
    } as any);

    expect(result.warnings).toContain("Data mask overlaps critical ROI 'Macro ring chart'. Verify this is intentional.");
  });

  it('r. marks global pass without ROIs as quality not_evaluated and keeps iterating', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-no-quality-gates'),
      maxDiffPercent: 1.0
    });

    expect(result.status).toBe('pass');
    expect(result.qualityStatus).toBe('not_evaluated');
    expect(result.qualityFailures).toEqual([]);
    expect(result.qualityWarnings).toContain('No regionsOfInterest or visualAssertions configured. Global pixel status does not prove visual parity.');
    expect(result.agentSummary?.canStopIterating).toBe(false);
    expect(result.agentSummary?.verdict).toContain('Global pixel gate passed, but critical UI quality was not evaluated.');
  });

  it('s. reports local hotspots and warning when global pass leaves large local mismatch', async () => {
    const expectedHotspot = path.join(testDir, 'hotspot-expected.png');
    const actualHotspot = path.join(testDir, 'hotspot-actual.png');
    await createTestImage(expectedHotspot, () => {});
    await createTestImage(actualHotspot, (png) => {
      drawRect(png, 20, 20, 60, 60, [0, 0, 0]);
    });

    const result = await compareImages({
      expectedImage: expectedHotspot,
      actualImage: actualHotspot,
      outputDir: path.join(testDir, 'out-hotspots'),
      maxDiffPercent: 1.0
    });

    expect(result.status).toBe('pass');
    expect(result.localHotspots?.length).toBeGreaterThan(0);
    expect(result.localHotspots?.[0].message).toBe('Large local mismatch remains despite global status.');
    expect(result.warnings).toContain('Global pass does not mean local visual parity; large local hotspots remain.');
    expect(result.agentSummary?.verdict).toContain('Global pass may be misleading: largest changed region covers');
  });

  it('t. blocks maxDiffPercent suggestion and floor detection when quality is not evaluated', async () => {
    const previousReport = {
      status: 'fail',
      diffPixels: 800,
      totalPixels: 10000,
      diffPercent: 0.08,
      pixelmatchThreshold: 0.1,
      maxDiffPercent: 0.0001,
      regions: [],
      artifacts: {
        expected: 'expected.png',
        actual: 'actual.png',
        diff: 'diff.png',
        regionsDir: 'regions'
      },
      delta: { diffPercentDelta: 0.00001 }
    } as any;

    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-floor-not-evaluated'),
      maxDiffPercent: 0.0001,
      previousReport,
      floorDetection: {
        enabled: true,
        deltaThreshold: 0.1,
        consecutiveRuns: 2
      }
    });

    expect(result.qualityStatus).toBe('not_evaluated');
    expect(result.atFloor).toBe(false);
    expect(result.floorBlockedBy?.[0]).toMatchObject({
      type: 'quality_not_evaluated',
      message: 'Critical UI quality was not evaluated.'
    });
    expect(result.suggestedMaxDiffPercent).toBeNull();
    expect(result.maxDiffPercentSuggestionBlockedBy).toContain('Critical UI quality was not evaluated. Configure ROIs or visualAssertions first.');
  });

  it('u. passes quality only when configured critical ROIs and assertions pass', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'identical.png'),
      outputDir: path.join(testDir, 'out-quality-pass'),
      regionsOfInterest: [
        {
          id: 'macro-ring',
          label: 'Macro ring chart',
          type: 'component',
          critical: true,
          coordinateSpace: 'normalized',
          box: { x: 0.08, y: 0.08, width: 0.42, height: 0.42 },
          maxDiffPercent: 0.01
        }
      ],
      visualAssertions: [
        {
          id: 'macro-ring-local-diff',
          type: 'roiMaxDiffPercent',
          roiId: 'macro-ring',
          maxDiffPercent: 0.01,
          severity: 'critical',
          message: 'Macro ring chart is visually too different from mockup.'
        }
      ]
    } as any);

    expect(result.status).toBe('pass');
    expect(result.qualityStatus).toBe('pass');
    expect(result.qualityFailures).toEqual([]);
    expect(result.agentSummary?.canStopIterating).toBe(true);
  });

  it('v. preserves global status behavior independently from qualityStatus', async () => {
    const failing = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-global-fail-compat'),
      maxDiffPercent: 0.0001
    });
    const passing = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-global-pass-compat'),
      maxDiffPercent: 1.0
    });

    expect(failing.status).toBe('fail');
    expect(passing.status).toBe('pass');
    expect(passing.qualityStatus).toBe('not_evaluated');
  });

  it('w. Today Run-010 false positive: global pass but macro-ring quality fail', async () => {
    const expectedToday = path.join(testDir, 'today-expected.png');
    const actualToday = path.join(testDir, 'today-actual-run-010.png');
    await createSizedTestImage(expectedToday, 240, 480, (png) => drawTodayMacroFixture(png, 'expected'));
    await createSizedTestImage(actualToday, 240, 480, (png) => drawTodayMacroFixture(png, 'actual'));

    const result = await compareImages({
      expectedImage: expectedToday,
      actualImage: actualToday,
      outputDir: path.join(testDir, 'out-today-run-010'),
      pixelmatchThreshold: 0.1,
      maxDiffPercent: 0.14,
      regionsOfInterest: [
        {
          id: 'hero-card',
          label: 'Hero macro summary card',
          type: 'component',
          critical: true,
          weight: 5,
          coordinateSpace: 'normalized',
          box: { x: 0.04, y: 0.12, width: 0.92, height: 0.42 },
          maxDiffPercent: 0.10
        },
        {
          id: 'macro-ring',
          label: 'Macro ring chart',
          type: 'component',
          critical: true,
          weight: 10,
          coordinateSpace: 'normalized',
          box: { x: 0.18, y: 0.16, width: 0.64, height: 0.28 },
          maxDiffPercent: 0.06
        },
        {
          id: 'macro-ring-center-text',
          label: 'Macro ring center text',
          type: 'component',
          critical: true,
          weight: 10,
          coordinateSpace: 'normalized',
          box: { x: 0.31, y: 0.23, width: 0.38, height: 0.13 },
          maxDiffPercent: 0.04
        }
      ],
      visualAssertions: [
        {
          id: 'macro-ring-local-diff',
          type: 'roiMaxDiffPercent',
          roiId: 'macro-ring',
          maxDiffPercent: 0.06,
          severity: 'critical',
          message: 'Macro ring chart differs too much from the mockup. Check stroke width, ring radius, spacing, and arc rendering.'
        },
        {
          id: 'center-text-local-diff',
          type: 'roiMaxDiffPercent',
          roiId: 'macro-ring-center-text',
          maxDiffPercent: 0.04,
          severity: 'critical',
          message: 'Center text differs too much. Check clipping, text scale, vertical position, and overlap with rings.'
        }
      ]
    } as any);

    expect(result.status).toBe('pass');
    expect(result.diffPercent).toBeLessThan(0.14);
    expect(result.qualityStatus).toBe('fail');
    expect(result.qualityFailures?.some((failure) => failure.roiId === 'macro-ring' || failure.roiId === 'macro-ring-center-text' || failure.label === 'macro-ring-center-text')).toBe(true);
    expect(result.priorityFindings?.[0].label).toBe('Macro ring chart');
    expect(result.agentSummary?.canStopIterating).toBe(false);
    expect(result.agentSummary?.verdict).toContain('Do not accept');
    expect(result.suggestedMaxDiffPercent).toBeNull();
    expect(result.maxDiffPercentSuggestionBlockedBy?.length).toBeGreaterThan(0);
  });

  it('x. critical center-text visual assertion failure produces quality fail', async () => {
    const expectedToday = path.join(testDir, 'today-center-expected.png');
    const actualToday = path.join(testDir, 'today-center-actual.png');
    await createSizedTestImage(expectedToday, 240, 480, (png) => drawTodayMacroFixture(png, 'expected'));
    await createSizedTestImage(actualToday, 240, 480, (png) => drawTodayMacroFixture(png, 'actual'));

    const result = await compareImages({
      expectedImage: expectedToday,
      actualImage: actualToday,
      outputDir: path.join(testDir, 'out-center-assertion'),
      maxDiffPercent: 0.14,
      regionsOfInterest: [
        {
          id: 'macro-ring-center-text',
          label: 'Macro ring center text',
          type: 'component',
          critical: false,
          coordinateSpace: 'normalized',
          box: { x: 0.31, y: 0.23, width: 0.38, height: 0.13 },
          maxDiffPercent: 1.0
        }
      ],
      visualAssertions: [
        {
          id: 'center-text-local-diff',
          type: 'roiMaxDiffPercent',
          roiId: 'macro-ring-center-text',
          maxDiffPercent: 0.04,
          severity: 'critical',
          message: 'Center text differs too much. Check clipping, text scale, vertical position, and overlap with rings.'
        }
      ]
    } as any);

    expect(result.status).toBe('pass');
    expect(result.qualityStatus).toBe('fail');
    expect(result.qualityFailures?.[0]?.type).toBe('critical_visual_assertion_failed');
    expect(result.qualityFailures?.[0]?.assertionId).toBe('center-text-local-diff');
  });
});
