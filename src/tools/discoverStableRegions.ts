import path from 'path';
import { ConfigSuggestion, IgnoreRegion } from '../types';
import { ensureDir, resolveAbsolutePath } from '../utils/fs';
import { runScreenUiDiff } from './runScreenUiDiff';

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
  }>;
  suggestions: StableRegionSuggestion[];
  configSuggestions: ConfigSuggestion[];
}

function mayAffectTabsOrFab(region: IgnoreRegion): boolean {
  const bottomish = region.coordinateSpace === 'normalized'
    ? region.y + region.height > 0.78
    : region.y > 0 || region.height > 80;
  return bottomish && region.width > region.height;
}

function suggestionFromRegion(screenName: string, region: IgnoreRegion, reason: string, confidence: number): StableRegionSuggestion {
  return {
    screenName,
    confidence,
    risk: mayAffectTabsOrFab(region)
      ? 'Medium. This may cover selected tab indicators, bottom navigation, or a FAB; inspect before applying.'
      : 'Low to medium. Review before applying because stable chrome can still contain app-owned UI.',
    reason,
    suggestedRegion: region,
    mayAffectSelectedTabIndicatorsOrFabs: mayAffectTabsOrFab(region)
  };
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
      diffPercent: report.diffPercent
    });

    for (const region of report.autoMaskedRegions ?? []) {
      suggestions.push(suggestionFromRegion(
        screenName,
        region,
        'Runtime auto mask was generated for this device/screenshot environment.',
        0.85
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
        0.6
      ));
    }

    configSuggestions.push(...(report.configSuggestions ?? []));
  }

  for (const suggestion of suggestions) {
    configSuggestions.push({
      kind: 'ignoreRegion',
      confidence: suggestion.confidence,
      reason: suggestion.reason,
      risk: suggestion.risk,
      suggestedPatch: {
        screens: {
          [suggestion.screenName ?? '<screen>']: {
            ignoreRegions: [suggestion.suggestedRegion]
          }
        }
      }
    });
  }

  return {
    outputDir,
    runs,
    suggestions,
    configSuggestions
  };
}

