import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PNG } from 'pngjs';
import fs from 'fs/promises';
import path from 'path';
import { compareImages } from '../src/tools/compareImages';

async function createTestImage(path: string, draw: (png: PNG) => void) {
  const png = new PNG({ width: 100, height: 100 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2;
      // White background
      png.data[idx] = 255;
      png.data[idx+1] = 255;
      png.data[idx+2] = 255;
      png.data[idx+3] = 255;
    }
  }
  draw(png);
  await fs.writeFile(path, PNG.sync.write(png));
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

describe('compareImages', () => {
  const testDir = path.join(__dirname, 'fixtures');
  
  beforeAll(async () => {
    await fs.mkdir(testDir, { recursive: true });
    
    // Base identical images
    await createTestImage(path.join(testDir, 'base.png'), (png) => {
      drawRect(png, 10, 10, 20, 20, [0, 0, 0]);
    });
    await createTestImage(path.join(testDir, 'identical.png'), (png) => {
      drawRect(png, 10, 10, 20, 20, [0, 0, 0]);
    });
    
    // Shifted
    await createTestImage(path.join(testDir, 'shifted.png'), (png) => {
      drawRect(png, 15, 10, 20, 20, [0, 0, 0]);
    });
    
    // Multiple regions
    await createTestImage(path.join(testDir, 'multi.png'), (png) => {
      drawRect(png, 10, 10, 20, 20, [0, 0, 0]);
      drawRect(png, 50, 50, 10, 10, [255, 0, 0]);
      drawRect(png, 80, 80, 5, 5, [0, 255, 0]);
    });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('passes on identical images', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'identical.png'),
      outputDir: path.join(testDir, 'out-identical')
    });
    expect(result.status).toBe('pass');
    expect(result.diffPixels).toBe(0);
    expect(result.regions).toHaveLength(0);
  });

  it('fails on shifted image with region detection', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-shifted')
    });
    expect(result.status).toBe('fail');
    expect(result.diffPixels).toBeGreaterThan(0);
    expect(result.regions.length).toBeGreaterThan(0);
  });

  it('passes when ignoreRegion covers the diff', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'shifted.png'),
      outputDir: path.join(testDir, 'out-ignore'),
      ignoreRegions: [{ x: 10, y: 10, width: 30, height: 20 }]
    });
    expect(result.status).toBe('pass');
    expect(result.diffPixels).toBe(0);
  });

  it('merges regions properly and uses vlm max regions', async () => {
    const result = await compareImages({
      expectedImage: path.join(testDir, 'base.png'),
      actualImage: path.join(testDir, 'multi.png'),
      outputDir: path.join(testDir, 'out-multi'),
      maxRegions: 2,
      maxVlmRegions: 1,
      includeVlmAnalysis: true
    });
    
    // Fallback/offline Ollama might result in "unknown" default VLM analysis, which is perfectly fine.
    expect(result.regions.length).toBeLessThanOrEqual(2);
    
    // Only one should have been analyzed
    const analyzedCount = result.regions.filter(r => r.analysisStatus === 'analyzed').length;
    expect(analyzedCount).toBe(1);
    const skippedCount = result.regions.filter(r => r.analysisStatus === 'skipped').length;
    expect(skippedCount).toBe(1);
  });
});
