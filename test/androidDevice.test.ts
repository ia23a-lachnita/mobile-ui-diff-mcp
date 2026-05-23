import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';

const mockState = vi.hoisted(() => ({
  screenshotSize: { width: 1206, height: 2622 }
}));

vi.mock('../src/utils/exec', () => ({
  execFileAsync: vi.fn(async (command: string, args: string[]) => {
    const joined = args.join(' ');
    if (command === 'adb' && joined === 'get-serialno') return { stdout: 'SERIAL123\n', stderr: '' };
    if (command === 'adb' && joined.includes('getprop ro.product.manufacturer')) return { stdout: 'Samsung\n', stderr: '' };
    if (command === 'adb' && joined.includes('getprop ro.product.model')) return { stdout: 'SM-G780G\n', stderr: '' };
    if (command === 'adb' && joined.includes('getprop ro.build.version.release')) return { stdout: '14\n', stderr: '' };
    if (command === 'adb' && joined.includes('wm size')) return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
    if (command === 'adb' && joined.includes('wm density')) return { stdout: 'Physical density: 480\n', stderr: '' };
    return { stdout: '', stderr: '' };
  })
}));

vi.mock('../src/tools/captureAndroid', () => ({
  captureAndroidScreenshot: vi.fn(async (outputPath: string) => {
    const { PNG } = require('pngjs');
    const fsSync = require('fs');
    const pathSync = require('path');
    fsSync.mkdirSync(pathSync.dirname(outputPath), { recursive: true });
    const png = new PNG({ width: mockState.screenshotSize.width, height: mockState.screenshotSize.height });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 255;
      png.data[i + 1] = 255;
      png.data[i + 2] = 255;
      png.data[i + 3] = 255;
    }
    fsSync.writeFileSync(outputPath, PNG.sync.write(png));
    return { outputPath };
  })
}));

import { calibrateAndroidDevice, getAndroidDeviceInfo } from '../src/tools/androidDevice';

describe('android device calibration', () => {
  const testDir = path.join(__dirname, 'android-device-fixtures');

  beforeEach(async () => {
    mockState.screenshotSize = { width: 1206, height: 2622 };
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('parses adb wm size and density', async () => {
    const info = await getAndroidDeviceInfo();

    expect(info.serial).toBe('SERIAL123');
    expect(info.manufacturer).toBe('Samsung');
    expect(info.model).toBe('SM-G780G');
    expect(info.androidVersion).toBe('14');
    expect(info.wmSize).toEqual({ width: 1080, height: 2400 });
    expect(info.density).toBe(480);
  });

  it('returns a pasteable SM-G780G profile suggestion with right and bottom strip masks', async () => {
    const result = await calibrateAndroidDevice({ outputDir: testDir });
    const suggestion = result.configSuggestions[0];
    const patch = suggestion.suggestedPatch as any;
    const suggestedProfile = patch.deviceProfiles['SM-G780G'];

    expect(result.deviceProfile.id).toBe('SM-G780G');
    expect(result.deviceProfile.autoIgnoreRegions).toEqual([
      { x: 1080, y: 0, width: 126, height: 2622, reason: 'screenshot contains pixels to the right of adb wm size', type: 'system', coordinateSpace: 'actual' },
      { x: 0, y: 2400, width: 1206, height: 222, reason: 'screenshot contains pixels below adb wm size', type: 'system', coordinateSpace: 'actual' }
    ]);
    expect(suggestedProfile).toEqual(expect.objectContaining({
      id: 'SM-G780G',
      serial: 'SERIAL123',
      manufacturer: 'Samsung',
      model: 'SM-G780G',
      androidVersion: '14',
      wmSize: { width: 1080, height: 2400 },
      screenshotSize: { width: 1206, height: 2622 },
      density: 480
    }));
    expect(suggestedProfile.autoIgnoreRegions).toContainEqual(
      { x: 1080, y: 0, width: 126, height: 2622, reason: 'screenshot contains pixels to the right of adb wm size', type: 'system', coordinateSpace: 'actual' }
    );
    expect(suggestedProfile.autoIgnoreRegions).toContainEqual(
      { x: 0, y: 2400, width: 1206, height: 222, reason: 'screenshot contains pixels below adb wm size', type: 'system', coordinateSpace: 'actual' }
    );
  });
});

