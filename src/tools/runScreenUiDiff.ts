import fs from 'fs/promises';
import path from 'path';
import { loadUiDiffConfig } from '../config/uiDiffConfig';
import { AutoIgnoreConfig, BoxLike, ConfigSuggestion, DeviceProfile, DiffReport, IgnoreRegion, VlmConfig, PreCaptureStep, RegionOfInterestConfig, VisualAssertionConfig, FloorDetectionConfig, HotspotDetectionConfig, VlmPolicy } from '../types';
import { resolveAbsolutePath } from '../utils/fs';
import { runMobileUiDiff } from './runMobileUiDiff';
import { preflightOllama, resolveOllamaConfig, VlmPreflightResult } from '../vlm/ollama';
import { buildAutoMasksFromDeviceProfile, getAndroidDeviceInfo, matchDeviceProfile } from './androidDevice';
import type { ReferenceContextConfig } from '../pipeline/ConflictResolver';
import type { ModelJudgesConfig } from '../pipeline/judges/ModelJudgeAnalyzer';
import type { CompareImagesInput } from './compareImages';

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
  requireVlmAnalysis?: boolean;
  vlmPolicy?: VlmPolicy;
  vlm?: VlmConfig;
  ignoreRegions?: IgnoreRegion[];
  dataRegions?: IgnoreRegion[];
  autoIgnore?: AutoIgnoreConfig;
  preCapture?: PreCaptureStep[];
  deviceId?: string;
  appContentBounds?: BoxLike & { coordinateSpace?: 'normalized' | 'expected' | 'actual' };
  regionsOfInterest?: RegionOfInterestConfig[];
  visualAssertions?: VisualAssertionConfig[];
  floorDetection?: FloorDetectionConfig;
  hotspotDetection?: HotspotDetectionConfig;
  referenceContext?: ReferenceContextConfig;
  modelJudges?: ModelJudgesConfig;
  visualAuditMode?: 'visual_parity' | 'metric_only';
  overlapLegibility?: CompareImagesInput['overlapLegibility'];
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

function buildDeviceProfileSuggestion(device: Awaited<ReturnType<typeof getAndroidDeviceInfo>>): ConfigSuggestion {
  const profile: DeviceProfile = {
    id: device.model ?? device.serial,
    serial: device.serial,
    manufacturer: device.manufacturer,
    model: device.model,
    androidVersion: device.androidVersion,
    wmSize: device.wmSize,
    density: device.density,
    autoIgnoreRegions: []
  };

  return {
    kind: 'deviceProfile',
    confidence: 0.8,
    reason: 'No matching device profile was found for the current adb device.',
    risk: 'Low. Saving a profile separates device calibration from screen visual contracts; review generated masks before adding them.',
    suggestedPatch: {
      deviceProfiles: {
        [profile.id]: profile
      }
    }
  };
}

function sameSize(a: { width: number; height: number } | undefined, b: { width: number; height: number } | undefined): boolean {
  return !!a && !!b && a.width === b.width && a.height === b.height;
}

function normalizeScreenBox(
  box: BoxLike & { coordinateSpace?: 'normalized' | 'expected' | 'actual' },
  expectedSize: { width: number; height: number },
  actualSize: { width: number; height: number }
): BoxLike {
  const coordinateSpace = box.coordinateSpace ?? 'expected';
  if (coordinateSpace === 'normalized') {
    return {
      x: Math.floor(box.x * expectedSize.width),
      y: Math.floor(box.y * expectedSize.height),
      width: Math.ceil(box.width * expectedSize.width),
      height: Math.ceil(box.height * expectedSize.height)
    };
  }
  if (coordinateSpace === 'actual') {
    const scaleX = expectedSize.width / Math.max(1, actualSize.width);
    const scaleY = expectedSize.height / Math.max(1, actualSize.height);
    return {
      x: Math.floor(box.x * scaleX),
      y: Math.floor(box.y * scaleY),
      width: Math.ceil(box.width * scaleX),
      height: Math.ceil(box.height * scaleY)
    };
  }
  return box;
}

function containsBox(outer: BoxLike, inner: BoxLike): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
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
        }
        mtimeCandidates.push({ name: entry.name, reportPath, mtimeMs: stat.mtimeMs });
      } catch {
        // Skip subdirectories whose report.json cannot be read or stat'ed
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
  const configDir = path.dirname(configPath);
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
    requireVlmAnalysis: input.requireVlmAnalysis ?? screenConfig.requireVlmAnalysis,
    vlmPolicy: input.vlmPolicy ?? screenConfig.vlmPolicy,
    ignoreRegions: input.ignoreRegions ?? screenConfig.ignoreRegions,
    dataRegions: input.dataRegions ?? screenConfig.dataRegions,
    autoIgnore: {
      ...(config.autoIgnore ?? {}),
      ...(screenConfig.autoIgnore ?? {}),
      ...(input.autoIgnore ?? {})
    },
    preCapture: input.preCapture ?? screenConfig.preCapture,
    appContentBounds: input.appContentBounds ?? screenConfig.appContentBounds,
    regionsOfInterest: input.regionsOfInterest ?? screenConfig.regionsOfInterest,
    visualAssertions: input.visualAssertions ?? screenConfig.visualAssertions,
    floorDetection: input.floorDetection ?? screenConfig.floorDetection,
    hotspotDetection: input.hotspotDetection ?? screenConfig.hotspotDetection,
    referenceContext: input.referenceContext ?? screenConfig.referenceContext,
    modelJudges: input.modelJudges ?? screenConfig.modelJudges,
    visualAuditMode: input.visualAuditMode ?? screenConfig.visualAuditMode,
    overlapLegibility: input.overlapLegibility ?? screenConfig.overlapLegibility
  };

  const includeVlmAnalysis = merged.includeVlmAnalysis ?? false;
  const resolvedVlmOverrides = input.vlm ?? {};
  const screenVlm = screenConfig.vlm ?? {};
  const autoPullEnabled = (resolvedVlmOverrides.autoPull ?? screenVlm.autoPull) === true;
  const resolvedVlmPolicy = merged.vlmPolicy ?? (
    !includeVlmAnalysis
      ? 'disabled'
      : ((merged.requireVlmAnalysis ?? resolvedVlmOverrides.require ?? screenVlm.require) === true ? 'required' : 'ask_user')
  );
  const requireVlmAnalysis = includeVlmAnalysis
    ? resolvedVlmPolicy === 'required'
    : false;
  const resolvedVlmConfig = resolveOllamaConfig({
    baseUrl: resolvedVlmOverrides.baseUrl ?? screenVlm.baseUrl,
    model: resolvedVlmOverrides.model ?? screenVlm.model,
    fallbackModels: resolvedVlmOverrides.fallbackModels ?? screenVlm.fallbackModels ?? [],
    keepAlive: resolvedVlmOverrides.keepAlive ?? screenVlm.keepAlive,
    timeoutMs: resolvedVlmOverrides.timeoutMs ?? screenVlm.timeoutMs,
    autoPull: autoPullEnabled
  });
  const autoPullWarning = `autoPull is not implemented. Run \`ollama pull ${resolvedVlmConfig.model}\` manually.`;
  const preflightEnabled = (resolvedVlmOverrides.preflight ?? screenVlm.preflight) !== false;
  let vlmPreflight: VlmPreflightResult | undefined;

  if (includeVlmAnalysis && resolvedVlmPolicy !== 'disabled') {
    if (preflightEnabled || requireVlmAnalysis) {
      vlmPreflight = await preflightOllama(resolvedVlmConfig, true);
      if (autoPullEnabled) {
        vlmPreflight.warnings.push(autoPullWarning);
      }
      if (requireVlmAnalysis && !vlmPreflight.available) {
        throw new Error('VLM analysis is required but no configured Ollama model could be loaded. Run vlm_health for details.');
      }
    } else {
      vlmPreflight = {
        available: true,
        selectedModel: resolvedVlmConfig.model,
        fallbackUsed: false,
        warnings: ['VLM preflight disabled. Availability has not been verified.'],
        healthStatus: 'warning',
        baseUrl: resolvedVlmConfig.baseUrl,
        timeoutMs: resolvedVlmConfig.timeoutMs,
        keepAlive: resolvedVlmConfig.keepAlive
      };
      if (autoPullEnabled) {
        vlmPreflight.warnings.push(autoPullWarning);
      }
    }
  }

  const baseOutputDir = merged.outputDir;
  const resolvedBaseOutputDir = resolveAbsolutePath(baseOutputDir);
  const effectiveRunName = input.runName ?? await nextRunName(resolvedBaseOutputDir);
  const runOutputDir = path.join(baseOutputDir, effectiveRunName);
  const resolvedRunOutputDir = resolveAbsolutePath(runOutputDir);

  const previous = await findPreviousRunReport(resolvedBaseOutputDir, effectiveRunName);
  const warnings: string[] = [];
  const configSuggestions: ConfigSuggestion[] = [];
  let detectedDevice: Awaited<ReturnType<typeof getAndroidDeviceInfo>> | null = null;
  let appliedDeviceProfile: DeviceProfile | null = null;

  const hasNormalizedPreCapture = (merged.preCapture ?? []).some((step) => step.type === 'adbTapNormalized');
  const needsAndroidDetection = merged.platform === 'android'
    && (
      !!input.deviceId
      || hasNormalizedPreCapture
      || !!config.deviceProfiles
      || merged.autoIgnore.enabled === true
    );

  if (needsAndroidDetection) {
    try {
      detectedDevice = await getAndroidDeviceInfo(input.deviceId);
      appliedDeviceProfile = matchDeviceProfile(config.deviceProfiles, detectedDevice);
      if (!appliedDeviceProfile) {
        warnings.push('No matching Android device profile found. Run calibrate_android_device and save the reviewed profile in ui-diff.config.json.');
        configSuggestions.push(buildDeviceProfileSuggestion(detectedDevice));
      }
    } catch (error: any) {
      if (!input.actualImage) {
        warnings.push(`Could not detect Android device before capture: ${error?.message ?? String(error)}`);
      } else {
        warnings.push(`Could not detect Android device for profile matching: ${error?.message ?? String(error)}`);
      }
    }
  }

  const deviceIgnoreRegions = appliedDeviceProfile?.autoIgnoreRegions ?? [];
  const explicitIgnoreRegions = [
    ...deviceIgnoreRegions,
    ...(merged.ignoreRegions ?? [])
  ];
  const autoMaskedRegions = buildAutoMasksFromDeviceProfile(appliedDeviceProfile, merged.autoIgnore);
  const preCaptureDeviceSize = appliedDeviceProfile?.wmSize ?? detectedDevice?.wmSize ?? appliedDeviceProfile?.screenshotSize;

  const report = await runMobileUiDiff({
    platform: merged.platform,
    expectedImage: merged.expectedImage,
    actualImage: input.actualImage,
    outputDir: runOutputDir,
    configDir,
    pixelmatchThreshold: merged.pixelmatchThreshold,
    maxDiffPercent: merged.maxDiffPercent,
    maxRegions: merged.maxRegions,
    maxVlmRegions: merged.maxVlmRegions,
    includeVlmAnalysis: includeVlmAnalysis,
    requireVlmAnalysis,
    vlmPolicy: resolvedVlmPolicy,
    vlmConfig: resolvedVlmConfig,
    vlmPreflight,
    ignoreRegions: explicitIgnoreRegions,
    dataRegions: merged.dataRegions,
    autoMaskedRegions,
    appliedDeviceProfile,
    configSuggestions,
    appContentBounds: merged.appContentBounds,
    preCapture: merged.preCapture,
    preCaptureDeviceSize,
    deviceId: detectedDevice?.serial ?? input.deviceId,
    previousReport: previous?.report,
    runDelta: previous?.report?.delta,
    floorDetection: merged.floorDetection,
    hotspotDetection: merged.hotspotDetection,
    regionsOfInterest: merged.regionsOfInterest,
    visualAssertions: merged.visualAssertions,
    referenceContext: merged.referenceContext,
    modelJudges: merged.modelJudges,
    visualAuditMode: merged.visualAuditMode,
    overlapLegibility: merged.overlapLegibility
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

  if (appliedDeviceProfile?.screenshotSize && report.imageSizes?.actualSource && !sameSize(appliedDeviceProfile.screenshotSize, report.imageSizes.actualSource)) {
    warnings.push(`Current screenshot size ${report.imageSizes.actualSource.width}x${report.imageSizes.actualSource.height} does not match device profile '${appliedDeviceProfile.id}' screenshotSize ${appliedDeviceProfile.screenshotSize.width}x${appliedDeviceProfile.screenshotSize.height}. Run calibrate_android_device and review the profile.`);
    configSuggestions.push({
      kind: 'deviceProfile',
      confidence: 0.85,
      reason: 'The captured screenshot dimensions differ from the matched device profile.',
      risk: 'Low. Device-level masks and normalized tap coordinates may be stale until recalibrated.',
      suggestedPatch: {
        deviceProfiles: {
          [appliedDeviceProfile.id]: {
            screenshotSize: report.imageSizes.actualSource
          }
        }
      }
    });
  }

  if (detectedDevice?.wmSize && appliedDeviceProfile?.wmSize && !sameSize(detectedDevice.wmSize, appliedDeviceProfile.wmSize)) {
    warnings.push(`Current adb wm size ${detectedDevice.wmSize.width}x${detectedDevice.wmSize.height} does not match device profile '${appliedDeviceProfile.id}' wmSize ${appliedDeviceProfile.wmSize.width}x${appliedDeviceProfile.wmSize.height}. Run calibrate_android_device.`);
  }

  if (merged.appContentBounds && report.imageSizes?.expected && report.imageSizes.actualSource) {
    const bounds = normalizeScreenBox(merged.appContentBounds, report.imageSizes.expected, report.imageSizes.actualSource);
    for (const hotspot of report.localHotspots ?? []) {
      if (!containsBox(bounds, hotspot.box)) {
        warnings.push(`Large hotspot '${hotspot.regionId}' is outside appContentBounds and may be a system/artifact region.`);
        configSuggestions.push({
          kind: 'deviceProfile',
          confidence: 0.7,
          reason: `Hotspot '${hotspot.regionId}' falls outside appContentBounds and is labeled ${hotspot.fallbackLabel}.`,
          risk: 'Medium. Review the crop before adding a device mask so real off-canvas app UI is not hidden.',
          suggestedPatch: {
            deviceProfiles: {
              [appliedDeviceProfile?.id ?? '<deviceProfileId>']: {
                autoIgnoreRegions: [{
                  ...hotspot.box,
                  reason: `Possible system/artifact region from ${input.screen}`,
                  type: 'system',
                  coordinateSpace: 'expected'
                }]
              }
            }
          }
        });
      }
    }
  }

  for (const roi of report.regionsOfInterest ?? []) {
    if (report.diffPercent > 0 && roi.intersectingRegionIds.length === 0 && (roi.critical || roi.weight > 1)) {
      warnings.push(`ROI '${roi.label}' does not overlap any meaningful changed region in this run. If the screen layout changed, the ROI config may be stale.`);
      configSuggestions.push({
        kind: 'roiUpdate',
        confidence: 0.45,
        reason: `ROI '${roi.label}' had no changed-region intersections while the screen still has differences.`,
        risk: 'Medium. A quiet ROI may be correct; update only if the component moved or resized.',
        suggestedPatch: {
          screens: {
            [input.screen]: {
              regionsOfInterest: 'review ROI boxes against current mockup and screenshot'
            }
          }
        }
      });
    }
  }

  const mergedWarnings = [...(report.warnings ?? []), ...warnings];
  const mergedSuggestions = [...(report.configSuggestions ?? []), ...configSuggestions]
    .filter((suggestion, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(suggestion)) === index);

  const finalReport: RunScreenUiDiffReport = {
    ...report,
    run,
    delta,
    warnings: mergedWarnings.length ? Array.from(new Set(mergedWarnings)) : undefined,
    configSuggestions: mergedSuggestions.length ? mergedSuggestions : undefined
  };

  if (autoPullEnabled) {
    if (!finalReport.warnings?.includes(autoPullWarning)) {
      finalReport.warnings = [...(finalReport.warnings ?? []), autoPullWarning];
    }
    if (finalReport.vlm) {
      if (!finalReport.vlm.warnings.includes(autoPullWarning)) {
        finalReport.vlm.warnings = [...finalReport.vlm.warnings, autoPullWarning];
      }
      if (finalReport.vlm.healthStatus === 'ok') {
        finalReport.vlm.healthStatus = 'warning';
      }
    }
  }

  finalReport.reportJsonPath = reportPath;
  await fs.writeFile(reportPath, JSON.stringify(finalReport, null, 2));
  return finalReport;
}
