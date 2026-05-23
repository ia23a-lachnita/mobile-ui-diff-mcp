import path from 'path';
import fs from 'fs/promises';
import { PNG } from 'pngjs';
import { ConfigSuggestion, IgnoreRegion } from '../types';
import { ensureDir, resolveAbsolutePath } from '../utils/fs';
import { runScreenUiDiff } from './runScreenUiDiff';
import { loadImageAsPng, resizeImageToMatch } from '../image/load';

export interface DiscoverStableRegionsInput {
  screenNames: string[];
  configPath?: string;
  outputDir: string;
}

export interface StableRegionSuggestion {
  screenName?: string;
  confidence: number;
  risk: string;
  reason: string;
  suggestedRegion: IgnoreRegion;
  mayAffectSelectedTabIndicatorsOrFabs: boolean;
}

export interface DiscoverStableRegionsResult {
  outputDir: string;
  runs: Array<{
    screenName: string;
    reportPath: string;
    status: 'pass' | 'fail';
    diffPercent: number;
    actualPath: string;
  }>;
  suggestions: StableRegionSuggestion[];
  configSuggestions: ConfigSuggestion[];
}

function mayAffectTabsOrFab(region: IgnoreRegion, canvasHeight?: number): boolean {
  const bottomish = region.coordinateSpace === 'normalized'
    ? region.y + region.height >= 0.78
    : (typeof canvasHeight === 'number' && region.y + region.height >= 0.78 * canvasHeight);
  return bottomish && region.width > region.height;
}

function suggestionFromRegion(screenName: string | undefined, region: IgnoreRegion, reason: string, confidence: number, canvasHeight?: number): StableRegionSuggestion {
  const hasNavRisk = mayAffectTabsOrFab(region, canvasHeight);
  return {
    screenName,
    confidence,
    risk: hasNavRisk
      ? 'Medium. This may cover selected tab indicators, bottom navigation, or a FAB; inspect before applying.'
      : 'Low to medium. Review before applying because stable chrome can still contain app-owned UI.',
    reason,
    suggestedRegion: region,
    mayAffectSelectedTabIndicatorsOrFabs: hasNavRisk
  };
}

async function normalizeActualScreens(paths: string[]): Promise<PNG[]> {
  if (paths.length === 0) return [];
  const first = await loadImageAsPng(paths[0]);
  const normalized = [first];
  for (const imagePath of paths.slice(1)) {
    const png = await loadImageAsPng(imagePath);
    if (png.width === first.width && png.height === first.height) {
      normalized.push(png);
      continue;
    }
    const raw = await fs.readFile(imagePath);
    const resized = await resizeImageToMatch(raw, first.width, first.height);
    normalized.push(PNG.sync.read(resized));
  }
  return normalized;
}

function pixelStable(images: PNG[], x: number, y: number, tolerance: number): boolean {
  const base = images[0];
  const baseIdx = (base.width * y + x) << 2;
  for (const image of images.slice(1)) {
    const idx = (image.width * y + x) << 2;
    if (Math.abs(base.data[baseIdx] - image.data[idx]) > tolerance) return false;
    if (Math.abs(base.data[baseIdx + 1] - image.data[idx + 1]) > tolerance) return false;
    if (Math.abs(base.data[baseIdx + 2] - image.data[idx + 2]) > tolerance) return false;
    if (Math.abs(base.data[baseIdx + 3] - image.data[idx + 3]) > tolerance) return false;
  }
  return true;
}

function stableRowRatios(images: PNG[], tolerance = 2): number[] {
  const width = images[0].width;
  const height = images[0].height;
  const ratios: number[] = [];
  for (let y = 0; y < height; y++) {
    let stable = 0;
    for (let x = 0; x < width; x++) {
      if (pixelStable(images, x, y, tolerance)) stable++;
    }
    ratios.push(stable / width);
  }
  return ratios;
}

function findStableChromeBands(images: PNG[]): StableRegionSuggestion[] {
  if (images.length < 2) return [];
  const width = images[0].width;
  const height = images[0].height;
  const ratios = stableRowRatios(images);
  const candidates: StableRegionSuggestion[] = [];
  const minHeight = Math.max(4, Math.round(height * 0.025));
  const minStableRatio = 0.92;
  const bands = [
    { name: 'top system/status chrome', start: 0, end: Math.max(1, Math.floor(height * 0.18)) },
    { name: 'bottom navigation/stable chrome', start: Math.floor(height * 0.70), end: height }
  ];

  for (const band of bands) {
    let y = band.start;
    while (y < band.end) {
      while (y < band.end && ratios[y] < minStableRatio) y++;
      const start = y;
      let ratioSum = 0;
      while (y < band.end && ratios[y] >= minStableRatio) {
        ratioSum += ratios[y];
        y++;
      }
      const regionHeight = y - start;
      if (regionHeight < minHeight) continue;
      const confidence = Math.min(0.95, Math.max(0.5, ratioSum / regionHeight));
      const region: IgnoreRegion = {
        x: 0,
        y: start,
        width,
        height: regionHeight,
        reason: `Stable across captured screens: ${band.name}`,
        type: 'system',
        coordinateSpace: 'expected'
      };
      candidates.push(suggestionFromRegion(
        undefined,
        region,
        `This ${band.name} band is visually stable across ${images.length} captured screens.`,
        Math.round(confidence * 100) / 100,
        height
      ));
    }
  }

  return candidates;
}

export async function discoverStableRegions(input: DiscoverStableRegionsInput): Promise<DiscoverStableRegionsResult> {
  if (input.screenNames.length === 0) {
    throw new Error('screenNames must contain at least one screen.');
  }

  const outputDir = resolveAbsolutePath(input.outputDir);
  await ensureDir(outputDir);
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runs: DiscoverStableRegionsResult['runs'] = [];
  const suggestions: StableRegionSuggestion[] = [];
  const configSuggestions: ConfigSuggestion[] = [];

  for (const screenName of input.screenNames) {
    const report = await runScreenUiDiff({
      screen: screenName,
      configPath: input.configPath,
      runName: `stable-${runStamp}`,
      outputDir: path.join(outputDir, screenName)
    });

    runs.push({
      screenName,
      reportPath: report.run.reportPath,
      status: report.status,
      diffPercent: report.diffPercent,
      actualPath: report.artifacts.actual
    });

    for (const region of report.autoMaskedRegions ?? []) {
      suggestions.push(suggestionFromRegion(
        screenName,
        region,
        'Runtime auto mask was generated for this device/screenshot environment.',
        0.85,
        report.imageSizes?.comparison.height
      ));
    }

    for (const hotspot of report.localHotspots ?? []) {
      const nearChrome = hotspot.fallbackLabel.includes('status')
        || hotspot.fallbackLabel.includes('navigation')
        || hotspot.fallbackLabel.includes('chrome')
        || hotspot.fallbackLabel.includes('edge');
      if (!nearChrome) continue;
      suggestions.push(suggestionFromRegion(
        screenName,
        {
          ...hotspot.box,
          reason: `Stable-looking ${hotspot.fallbackLabel} hotspot on ${screenName}`,
          type: 'system',
          coordinateSpace: 'expected'
        },
        `Large repeated-looking hotspot appears in ${hotspot.fallbackLabel}.`,
        0.6,
        report.imageSizes?.comparison.height
      ));
    }

    configSuggestions.push(...(report.configSuggestions ?? []));
  }

  const screenshots = await normalizeActualScreens(runs.map((run) => run.actualPath));
  suggestions.push(...findStableChromeBands(screenshots));

  for (const suggestion of suggestions) {
    const targetScreenNames = suggestion.screenName ? [suggestion.screenName] : input.screenNames;
    for (const screenName of targetScreenNames) {
      configSuggestions.push({
        kind: 'ignoreRegion',
        confidence: suggestion.confidence,
        reason: suggestion.screenName
          ? suggestion.reason
          : `${suggestion.reason} Suggested for '${screenName}' because the band was stable across all discovered screens.`,
        risk: suggestion.risk,
        suggestedPatch: {
          screens: {
            [screenName]: {
              ignoreRegions: [suggestion.suggestedRegion]
            }
          }
        }
      });
    }
  }

  return {
    outputDir,
    runs,
    suggestions,
    configSuggestions
  };
}
