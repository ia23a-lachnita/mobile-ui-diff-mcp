import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { IgnoreRegion, DeviceProfile, ConfigSuggestion, DeviceSize, SystemUiEstimates } from '../types';
import { execFileAsync } from '../utils/exec';
import { captureAndroidScreenshot } from './captureAndroid';
import { loadImageAsPng } from '../image/load';

const ADB_ID_PATTERN = /^[a-zA-Z0-9.:_-]+$/;

export interface AndroidDeviceInfo {
  serial: string;
  manufacturer?: string;
  model?: string;
  androidVersion?: string;
  wmSize?: DeviceSize;
  density?: number;
}

export interface AndroidCalibrationResult {
  adbSerial: string;
  manufacturer?: string;
  model?: string;
  androidVersion?: string;
  wmSize?: DeviceSize;
  density?: number;
  screenshotSize: DeviceSize;
  systemUiEstimates: SystemUiEstimates;
  screenshotVsWm: {
    widthDelta: number | null;
    heightDelta: number | null;
  };
  deviceProfile: DeviceProfile;
  configSuggestions: ConfigSuggestion[];
}

function validateDeviceId(deviceId?: string): string | undefined {
  if (!deviceId) return undefined;
  if (!ADB_ID_PATTERN.test(deviceId)) {
    throw new Error('Invalid deviceId format');
  }
  return deviceId;
}

function adbArgs(serial: string | undefined, args: string[]): string[] {
  return serial ? ['-s', serial, ...args] : args;
}

function trimOutput(value: unknown): string {
  return String(value ?? '').trim();
}

async function adb(serial: string | undefined, args: string[]): Promise<string> {
  const result = await execFileAsync('adb', adbArgs(serial, args));
  return trimOutput((result as { stdout?: unknown }).stdout);
}

function parseSize(output: string): DeviceSize | undefined {
  const matches = [...output.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
  const match = matches[matches.length - 1];
  if (!match) return undefined;
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10)
  };
}

function parseDensity(output: string): number | undefined {
  const matches = [...output.matchAll(/(?:Physical|Override) density:\s*(\d+)/g)];
  const match = matches[matches.length - 1];
  if (!match) return undefined;
  return Number.parseInt(match[1], 10);
}

export async function getAndroidDeviceInfo(deviceId?: string): Promise<AndroidDeviceInfo> {
  const requestedSerial = validateDeviceId(deviceId);
  const serial = requestedSerial ?? await adb(undefined, ['get-serialno']);
  if (!serial || serial === 'unknown') {
    throw new Error('No Android device detected by adb.');
  }

  const [manufacturer, model, androidVersion, wmOutput, densityOutput] = await Promise.all([
    adb(serial, ['shell', 'getprop', 'ro.product.manufacturer']).catch(() => ''),
    adb(serial, ['shell', 'getprop', 'ro.product.model']).catch(() => ''),
    adb(serial, ['shell', 'getprop', 'ro.build.version.release']).catch(() => ''),
    adb(serial, ['shell', 'wm', 'size']).catch(() => ''),
    adb(serial, ['shell', 'wm', 'density']).catch(() => '')
  ]);

  return {
    serial,
    manufacturer: manufacturer || undefined,
    model: model || undefined,
    androidVersion: androidVersion || undefined,
    wmSize: parseSize(wmOutput),
    density: parseDensity(densityOutput)
  };
}

function buildStripRegions(wmSize: DeviceSize | undefined, screenshotSize: DeviceSize): SystemUiEstimates {
  const estimates: SystemUiEstimates = {};
  if (!wmSize) return estimates;

  if (screenshotSize.width > wmSize.width) {
    estimates.rightStrip = {
      x: wmSize.width,
      y: 0,
      width: screenshotSize.width - wmSize.width,
      height: screenshotSize.height,
      reason: 'screenshot contains pixels to the right of adb wm size',
      type: 'system',
      coordinateSpace: 'actual'
    };
  }

  if (screenshotSize.height > wmSize.height) {
    estimates.bottomStrip = {
      x: 0,
      y: wmSize.height,
      width: screenshotSize.width,
      height: screenshotSize.height - wmSize.height,
      reason: 'screenshot contains pixels below adb wm size',
      type: 'system',
      coordinateSpace: 'actual'
    };
  }

  const topEstimate = Math.round(screenshotSize.height * 0.03);
  if (topEstimate > 0) {
    estimates.statusBar = {
      x: 0,
      y: 0,
      width: screenshotSize.width,
      height: topEstimate,
      reason: 'estimated Android status bar',
      type: 'system',
      coordinateSpace: 'actual'
    };
  }

  const navEstimate = Math.round(screenshotSize.height * 0.035);
  if (navEstimate > 0) {
    estimates.navigationBar = {
      x: 0,
      y: Math.max(0, screenshotSize.height - navEstimate),
      width: screenshotSize.width,
      height: navEstimate,
      reason: 'estimated Android navigation bar / gesture area',
      type: 'system',
      coordinateSpace: 'actual'
    };
  }

  return estimates;
}

function screenshotVsWmRegions(estimates: SystemUiEstimates): IgnoreRegion[] {
  return [estimates.rightStrip, estimates.bottomStrip].filter((region): region is IgnoreRegion => !!region);
}

function deviceProfileSuggestion(profileKey: string, deviceProfile: DeviceProfile, stripRegions: IgnoreRegion[]): ConfigSuggestion | null {
  if (stripRegions.length === 0) return null;
  const suggestedProfile: DeviceProfile = {
    ...deviceProfile,
    autoIgnoreRegions: stripRegions
  };
  return {
    kind: 'deviceProfile',
    confidence: 0.9,
    reason: 'Screenshot dimensions extend beyond adb wm size. These strips look device-specific, not app UI.',
    risk: 'Low if the strips are outside app content; review before saving because profile masks apply whenever this device profile is matched.',
    suggestedPatch: {
      deviceProfiles: {
        [profileKey]: suggestedProfile
      }
    }
  };
}

export async function calibrateAndroidDevice(input: { deviceId?: string; outputDir?: string } = {}): Promise<AndroidCalibrationResult> {
  const info = await getAndroidDeviceInfo(input.deviceId);
  const outputDir = input.outputDir ?? path.join(os.tmpdir(), 'mobile-ui-diff-calibration');
  await fs.mkdir(outputDir, { recursive: true });
  const screenshotPath = path.join(outputDir, `${info.serial.replace(/[^a-zA-Z0-9._-]/g, '_')}-calibration.png`);
  const capture = await captureAndroidScreenshot(screenshotPath, info.serial);
  const png = await loadImageAsPng(capture.outputPath);
  const screenshotSize = { width: png.width, height: png.height };
  const systemUiEstimates = buildStripRegions(info.wmSize, screenshotSize);
  const modelId = info.model || info.serial;
  const profileKey = modelId || info.serial;
  const stripRegions = screenshotVsWmRegions(systemUiEstimates);
  const deviceProfile: DeviceProfile = {
    id: profileKey,
    serial: info.serial,
    manufacturer: info.manufacturer,
    model: info.model,
    androidVersion: info.androidVersion,
    wmSize: info.wmSize,
    screenshotSize,
    density: info.density,
    systemUiEstimates,
    autoIgnoreRegions: stripRegions
  };
  const suggestion = deviceProfileSuggestion(profileKey, deviceProfile, stripRegions);

  return {
    adbSerial: info.serial,
    manufacturer: info.manufacturer,
    model: info.model,
    androidVersion: info.androidVersion,
    wmSize: info.wmSize,
    density: info.density,
    screenshotSize,
    systemUiEstimates,
    screenshotVsWm: {
      widthDelta: info.wmSize ? screenshotSize.width - info.wmSize.width : null,
      heightDelta: info.wmSize ? screenshotSize.height - info.wmSize.height : null
    },
    deviceProfile,
    configSuggestions: suggestion ? [suggestion] : []
  };
}

export function buildAutoMasksFromDeviceProfile(profile: DeviceProfile | null | undefined, autoIgnore: {
  enabled?: boolean;
  screenshotOutOfBounds?: boolean;
  systemBars?: boolean;
  edgePanels?: boolean;
} | undefined): IgnoreRegion[] {
  if (!autoIgnore?.enabled || !profile) return [];
  const estimates = profile.systemUiEstimates ?? {};
  const masks: IgnoreRegion[] = [];

  if (autoIgnore.screenshotOutOfBounds !== false) {
    if (estimates.rightStrip) masks.push(estimates.rightStrip);
    if (estimates.bottomStrip) masks.push(estimates.bottomStrip);
  }

  if (autoIgnore.edgePanels && estimates.rightStrip) {
    masks.push(estimates.rightStrip);
  }

  if (autoIgnore.systemBars) {
    if (estimates.statusBar) masks.push(estimates.statusBar);
    if (estimates.navigationBar) masks.push(estimates.navigationBar);
  }

  return masks.filter((region, index, all) => {
    return all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(region)) === index;
  });
}

export function matchDeviceProfile(
  profiles: Record<string, DeviceProfile> | undefined,
  device: AndroidDeviceInfo | null
): DeviceProfile | null {
  if (!profiles || !device) return null;
  const entries = Object.entries(profiles);
  const normalizedModel = (device.model ?? '').toLowerCase();
  const normalizedSerial = device.serial.toLowerCase();

  for (const [key, profile] of entries) {
    const candidates = [key, profile.id, profile.serial, profile.model].filter(Boolean).map((value) => String(value).toLowerCase());
    if (candidates.includes(normalizedSerial) || (normalizedModel && candidates.includes(normalizedModel))) {
      return profile;
    }
  }

  return null;
}
