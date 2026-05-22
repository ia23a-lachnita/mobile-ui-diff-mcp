import fs from 'fs/promises';
import path from 'path';
import { loadUiDiffConfig } from '../config/uiDiffConfig';
import { DiffReport, IgnoreRegion } from '../types';
import { resolveAbsolutePath } from '../utils/fs';
import { runMobileUiDiff } from './runMobileUiDiff';

export interface RunScreenUiDiffInput {
  screen: string;
  configPath?: string;
  runName?: string;
  actualImage?: string;
  platform?: 'android' | 'ios' | 'none';
  expectedImage?: string;
  outputDir?: string;
  pixelmatchThreshold?: number;
  maxDiffPercent?: number;
  maxRegions?: number;
  maxVlmRegions?: number;
  includeVlmAnalysis?: boolean;
  ignoreRegions?: IgnoreRegion[];
}

export interface RunScreenUiDiffDelta {
  previousRun: {
    name: string;
    reportPath: string;
    status: DiffReport['status'];
    diffPercent: number;
    diffPixels: number;
    regionCount: number;
  };
  currentRun: {
    name: string;
    reportPath: string;
    status: DiffReport['status'];
    diffPercent: number;
    diffPixels: number;
    regionCount: number;
  };
  diffPercentDelta: number;
  diffPixelsDelta: number;
  regionCountDelta: number;
  statusChanged: boolean;
  trend: 'improved' | 'worsened' | 'unchanged';
}

export interface RunScreenUiDiffReport extends DiffReport {
  run: {
    screen: string;
    name: string;
    outputDir: string;
    reportPath: string;
    configPath: string;
  };
  delta?: RunScreenUiDiffDelta;
}

interface ReportMetrics {
  status: DiffReport['status'];
  diffPercent: number;
  diffPixels: number;
  regionCount: number;
}

function toReportMetrics(report: unknown): ReportMetrics | null {
  if (!report || typeof report !== 'object') return null;
  const typed = report as {
    status?: unknown;
    diffPercent?: unknown;
    diffPixels?: unknown;
    regions?: unknown;
  };
  if (typed.status !== 'pass' && typed.status !== 'fail') return null;
  if (typeof typed.diffPercent !== 'number' || typeof typed.diffPixels !== 'number') return null;
  const regionCount = Array.isArray(typed.regions) ? typed.regions.length : 0;
  return {
    status: typed.status,
    diffPercent: typed.diffPercent,
    diffPixels: typed.diffPixels,
    regionCount
  };
}

function parseRunNumber(name: string): number | null {
  const match = /^run-(\d+)$/.exec(name);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function getTrend(previous: ReportMetrics, current: ReportMetrics): 'improved' | 'worsened' | 'unchanged' {
  if (current.diffPercent < previous.diffPercent) return 'improved';
  if (current.diffPercent > previous.diffPercent) return 'worsened';
  return 'unchanged';
}

async function nextRunName(baseOutputDir: string): Promise<string> {
  let entries: { isDirectory(): boolean; name: string }[];
  try {
    entries = await fs.readdir(baseOutputDir, { withFileTypes: true });
  } catch {
    return 'run-001';
  }

  let max = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const n = parseRunNumber(entry.name);
    if (n !== null && n > max) max = n;
  }

  return `run-${String(max + 1).padStart(3, '0')}`;
}

async function findPreviousRunReport(baseOutputDir: string, currentRunName: string) {
  try {
    const entries = await fs.readdir(baseOutputDir, { withFileTypes: true });
    const currentRunNumber = parseRunNumber(currentRunName);
    const numberedCandidates: Array<{ name: string; reportPath: string; runNumber: number }> = [];
    const mtimeCandidates: Array<{ name: string; reportPath: string; mtimeMs: number }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === currentRunName) continue;
      const reportPath = path.join(baseOutputDir, entry.name, 'report.json');
      try {
        const stat = await fs.stat(reportPath);
        const runNumber = parseRunNumber(entry.name);
        if (runNumber !== null) {
          numberedCandidates.push({ name: entry.name, reportPath, runNumber });
        } else if (currentRunNumber === null) {
          mtimeCandidates.push({ name: entry.name, reportPath, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // Skip subdirectories whose report.json cannot be read or stat'd
        continue;
      }
    }

    let selected: { name: string; reportPath: string } | null = null;
    if (currentRunNumber !== null) {
      let best = -1;
      for (const candidate of numberedCandidates) {
        if (candidate.runNumber >= currentRunNumber) continue;
        if (candidate.runNumber > best) {
          best = candidate.runNumber;
          selected = { name: candidate.name, reportPath: candidate.reportPath };
        }
      }
    } else if (mtimeCandidates.length > 0) {
      mtimeCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const chosen = mtimeCandidates[0];
      selected = { name: chosen.name, reportPath: chosen.reportPath };
    }

    if (!selected) return null;

    const raw = await fs.readFile(selected.reportPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...selected, report: parsed };
  } catch (err) {
    return null;
  }
}

export async function runScreenUiDiff(input: RunScreenUiDiffInput): Promise<RunScreenUiDiffReport> {
  const { config, configPath } = await loadUiDiffConfig(input.configPath);
  const screenConfig = config.screens[input.screen];

  if (!screenConfig) {
    const screenNames = Object.keys(config.screens);
    const suffix = screenNames.length ? ` Available screens: ${screenNames.join(', ')}` : '';
    throw new Error(`Screen '${input.screen}' not found in ${configPath}.${suffix}`);
  }

  const merged = {
    platform: input.platform ?? screenConfig.platform,
    expectedImage: input.expectedImage ?? screenConfig.expectedImage,
    outputDir: input.outputDir ?? screenConfig.outputDir,
    pixelmatchThreshold: input.pixelmatchThreshold ?? screenConfig.pixelmatchThreshold,
    maxDiffPercent: input.maxDiffPercent ?? screenConfig.maxDiffPercent,
    maxRegions: input.maxRegions ?? screenConfig.maxRegions,
    maxVlmRegions: input.maxVlmRegions ?? screenConfig.maxVlmRegions,
    includeVlmAnalysis: input.includeVlmAnalysis ?? screenConfig.includeVlmAnalysis,
    ignoreRegions: input.ignoreRegions ?? screenConfig.ignoreRegions
  };

  const baseOutputDir = merged.outputDir;
  const resolvedBaseOutputDir = resolveAbsolutePath(baseOutputDir);
  const effectiveRunName = input.runName ?? await nextRunName(resolvedBaseOutputDir);
  const runOutputDir = path.join(baseOutputDir, effectiveRunName);
  const resolvedRunOutputDir = resolveAbsolutePath(runOutputDir);

  const report = await runMobileUiDiff({
    platform: merged.platform,
    expectedImage: merged.expectedImage,
    actualImage: input.actualImage,
    outputDir: runOutputDir,
    pixelmatchThreshold: merged.pixelmatchThreshold,
    maxDiffPercent: merged.maxDiffPercent,
    maxRegions: merged.maxRegions,
    maxVlmRegions: merged.maxVlmRegions,
    includeVlmAnalysis: merged.includeVlmAnalysis,
    ignoreRegions: merged.ignoreRegions
  });

  const reportPath = path.join(resolvedRunOutputDir, 'report.json');
  const run = {
    screen: input.screen,
    name: effectiveRunName,
    outputDir: resolvedRunOutputDir,
    reportPath,
    configPath
  };
  let delta: RunScreenUiDiffDelta | undefined;
  {
    const previous = await findPreviousRunReport(resolvedBaseOutputDir, effectiveRunName);
    const previousMetrics = previous ? toReportMetrics(previous.report) : null;
    const currentMetrics = toReportMetrics(report);

    if (previous && previousMetrics && currentMetrics) {
      const trend = getTrend(previousMetrics, currentMetrics);
      delta = {
        previousRun: {
          name: previous.name,
          reportPath: previous.reportPath,
          status: previousMetrics.status,
          diffPercent: previousMetrics.diffPercent,
          diffPixels: previousMetrics.diffPixels,
          regionCount: previousMetrics.regionCount
        },
        currentRun: {
          name: effectiveRunName,
          reportPath,
          status: currentMetrics.status,
          diffPercent: currentMetrics.diffPercent,
          diffPixels: currentMetrics.diffPixels,
          regionCount: currentMetrics.regionCount
        },
        diffPercentDelta: currentMetrics.diffPercent - previousMetrics.diffPercent,
        diffPixelsDelta: currentMetrics.diffPixels - previousMetrics.diffPixels,
        regionCountDelta: currentMetrics.regionCount - previousMetrics.regionCount,
        statusChanged: previousMetrics.status !== currentMetrics.status,
        trend
      };
    }
  }

  const finalReport: RunScreenUiDiffReport = {
    ...report,
    run,
    delta
  };

  await fs.writeFile(reportPath, JSON.stringify(finalReport, null, 2));
  return finalReport;
}
