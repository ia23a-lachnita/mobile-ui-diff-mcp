import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PNG } from 'pngjs';
import fs from 'fs/promises';
import path from 'path';

const mockState = vi.hoisted(() => ({
  reports: new Map<string, any>()
}));

vi.mock('../src/tools/runScreenUiDiff', () => ({
  runScreenUiDiff: vi.fn(async (input: { screen: string }) => {
    const report = mockState.reports.get(input.screen);
    if (!report) throw new Error(`missing mock report for ${input.screen}`);
    return report;
  })
}));

import { discoverStableRegions } from '../src/tools/discoverStableRegions';

function fill(png: PNG, x: number, y: number, width: number, height: number, color: [number, number, number]) {
  for (let yy = y; yy < y + height; yy++) {
    for (let xx = x; xx < x + width; xx++) {
      const idx = (png.width * yy + xx) << 2;
      png.data[idx] = color[0];
      png.data[idx + 1] = color[1];
      png.data[idx + 2] = color[2];
      png.data[idx + 3] = 255;
    }
  }
}

async function writeScreen(imagePath: string, mainColor: [number, number, number]) {
  const png = new PNG({ width: 120, height: 200 });
  fill(png, 0, 0, 120, 20, [24, 24, 24]);
  fill(png, 0, 20, 120, 150, mainColor);
  fill(png, 0, 170, 120, 30, [238, 238, 238]);
  await fs.writeFile(imagePath, PNG.sync.write(png));
}

describe('discoverStableRegions', () => {
  const testDir = path.join(__dirname, 'stable-region-fixtures');

  beforeEach(async () => {
    mockState.reports.clear();
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('compares screenshots across screens and suggests stable top/bottom chrome only', async () => {
    const screens = [
      { name: 'today', color: [220, 80, 80] as [number, number, number] },
      { name: 'scan', color: [80, 220, 80] as [number, number, number] },
      { name: 'settings', color: [80, 80, 220] as [number, number, number] }
    ];

    for (const screen of screens) {
      const actualPath = path.join(testDir, `${screen.name}.png`);
      await writeScreen(actualPath, screen.color);
      mockState.reports.set(screen.name, {
        status: 'pass',
        diffPercent: 0,
        run: {
          screen: screen.name,
          reportPath: path.join(testDir, `${screen.name}-report.json`)
        },
        artifacts: {
          actual: actualPath
        },
        imageSizes: {
          comparison: { width: 120, height: 200 }
        },
        configSuggestions: []
      });
    }

    const result = await discoverStableRegions({
      screenNames: screens.map((screen) => screen.name),
      outputDir: path.join(testDir, 'out')
    });

    const stableRegions = result.suggestions.map((suggestion) => suggestion.suggestedRegion);
    const topRegion = stableRegions.find((region) => region.coordinateSpace === 'normalized' && region.y < 0.02);
    const bottomRegion = stableRegions.find((region) => region.coordinateSpace === 'normalized' && region.y > 0.8);
    expect(topRegion).toBeTruthy();
    expect(topRegion?.x).toBe(0);
    expect(topRegion?.width).toBe(1);
    expect(topRegion?.coordinateSpace).toBe('normalized');
    expect(bottomRegion).toBeTruthy();
    expect((bottomRegion?.y ?? 0) + (bottomRegion?.height ?? 0)).toBeCloseTo(1, 5);
    expect(bottomRegion?.coordinateSpace).toBe('normalized');
    expect(stableRegions.some((region) => region.coordinateSpace === 'normalized' && region.y > 0.15 && region.y < 0.7)).toBe(false);

    const bottomSuggestion = result.suggestions.find((suggestion) => suggestion.suggestedRegion.coordinateSpace === 'normalized' && suggestion.suggestedRegion.y > 0.8);
    expect(bottomSuggestion?.mayAffectSelectedTabIndicatorsOrFabs).toBe(true);
    expect(bottomSuggestion?.risk).toContain('selected tab indicators');

    const suggestedScreenKeys = result.configSuggestions.flatMap((suggestion) => {
      const screensPatch = (suggestion.suggestedPatch as any).screens ?? {};
      return Object.keys(screensPatch);
    });
    expect(suggestedScreenKeys).not.toContain('');

    for (const screen of screens) {
      const screenRegions = result.configSuggestions.flatMap((suggestion) => {
        const screensPatch = (suggestion.suggestedPatch as any).screens ?? {};
        return screensPatch[screen.name]?.ignoreRegions ?? [];
      });
      expect(screenRegions.some((region: any) => region.coordinateSpace === 'normalized' && region.y < 0.02 && region.width === 1)).toBe(true);
      expect(screenRegions.some((region: any) => region.coordinateSpace === 'normalized' && region.y > 0.8 && Math.abs((region.y + region.height) - 1) < 0.00001)).toBe(true);
      expect(screenRegions.some((region: any) => region.coordinateSpace === 'normalized' && region.y > 0.15 && region.y < 0.7)).toBe(false);
    }

    const bottomConfigSuggestions = result.configSuggestions.filter((suggestion) => {
      const screensPatch = (suggestion.suggestedPatch as any).screens ?? {};
      return Object.values<any>(screensPatch).some((screenPatch) => {
        return (screenPatch.ignoreRegions ?? []).some((region: any) => region.coordinateSpace === 'normalized' && region.y > 0.8);
      });
    });
    expect(bottomConfigSuggestions.length).toBeGreaterThanOrEqual(3);
    expect(bottomConfigSuggestions.every((suggestion) => suggestion.risk.includes('selected tab indicators'))).toBe(true);
  });
});
