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
});
