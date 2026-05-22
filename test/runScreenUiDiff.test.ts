import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PNG } from 'pngjs';
import fs from 'fs/promises';
import path from 'path';
import { runScreenUiDiff } from '../src/tools/runScreenUiDiff';
import { getToolList } from '../src/mcp/server';

async function createTestImage(p: string, draw: (png: PNG) => void) {
  const png = new PNG({ width: 100, height: 100 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = 255;
      png.data[idx + 1] = 255;
      png.data[idx + 2] = 255;
      png.data[idx + 3] = 255;
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
      png.data[idx + 1] = color[1];
      png.data[idx + 2] = color[2];
      png.data[idx + 3] = 255;
    }
  }
}

describe('runScreenUiDiff', () => {
  const testDir = path.join(__dirname, 'screen-fixtures');
  const expectedPath = path.join(testDir, 'expected.png');
  const actualIdentical = path.join(testDir, 'actual-identical.png');
  const actualShifted = path.join(testDir, 'actual-shifted.png');
  const configPath = path.join(testDir, 'ui-diff.config.json');
  const outputDir = path.join(testDir, 'runs');

  beforeAll(async () => {
    await fs.mkdir(testDir, { recursive: true });
    await createTestImage(expectedPath, (png) => {
      drawRect(png, 10, 10, 20, 20, [0, 0, 0]);
    });
    await createTestImage(actualIdentical, (png) => {
      drawRect(png, 10, 10, 20, 20, [0, 0, 0]);
    });
    await createTestImage(actualShifted, (png) => {
      drawRect(png, 15, 10, 20, 20, [0, 0, 0]);
    });

    const config = {
      screens: {
        home: {
          platform: 'none',
          expectedImage: expectedPath,
          outputDir
        },
        settings: {
          platform: 'none',
          expectedImage: expectedPath,
          outputDir
        }
      }
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('rejects unknown screens with available list', async () => {
    await expect(runScreenUiDiff({
      screen: 'missing',
      configPath,
      actualImage: actualIdentical
    })).rejects.toThrow(/Available screens: home, settings/);
  });

  it('auto-assigns run folders, persists final report, and computes numbered deltas + trend', async () => {
    await fs.rm(outputDir, { recursive: true, force: true });

    const run1 = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualIdentical
    });
    expect(run1.run.name).toBe('run-001');
    expect(run1.run.outputDir).toBe(path.resolve(outputDir, 'run-001'));
    expect(run1.run.configPath).toBe(path.resolve(configPath));
    expect(run1.delta).toBeUndefined();

    const run2 = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualShifted
    });
    expect(run2.run.name).toBe('run-002');
    expect(run2.delta?.previousRun.name).toBe('run-001');
    expect(run2.delta?.trend).toBe('worsened');

    const reportPath = path.join(outputDir, 'run-002', 'report.json');
    const persisted = JSON.parse(await fs.readFile(reportPath, 'utf-8'));
    expect(persisted).toEqual(run2);

    const run1ReportPath = path.join(outputDir, 'run-001', 'report.json');
    const future = new Date(Date.now() + 5000);
    await fs.utimes(run1ReportPath, future, future);

    const run3 = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualIdentical
    });
    expect(run3.run.name).toBe('run-003');
    expect(run3.delta?.previousRun.name).toBe('run-002');
    expect(run3.delta?.trend).toBe('improved');

    const run4 = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualIdentical
    });
    expect(run4.run.name).toBe('run-004');
    expect(run4.delta?.previousRun.name).toBe('run-003');
    expect(run4.delta?.trend).toBe('unchanged');
  });

  it('lists tool descriptions that prefer compare_images when actualImage is provided', () => {
    const tools = getToolList();
    expect(JSON.stringify(tools)).toContain('prefer compare_images');
  });
});
