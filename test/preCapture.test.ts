import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

const callOrder: string[] = [];

vi.mock('../src/utils/exec', () => ({
  execFileAsync: vi.fn(async (command: string, args: string[]) => {
    callOrder.push(`execFileAsync:${command} ${args.join(' ')}`);
    const joined = args.join(' ');
    if (command === 'adb' && joined === 'get-serialno') return { stdout: 'SERIAL123\n', stderr: '' };
    if (command === 'adb' && joined.includes('getprop ro.product.model')) return { stdout: 'SM-G780G\n', stderr: '' };
    if (command === 'adb' && joined.includes('getprop ro.product.manufacturer')) return { stdout: 'Samsung\n', stderr: '' };
    if (command === 'adb' && joined.includes('getprop ro.build.version.release')) return { stdout: '14\n', stderr: '' };
    if (command === 'adb' && joined.includes('wm size')) return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
    if (command === 'adb' && joined.includes('wm density')) return { stdout: 'Physical density: 480\n', stderr: '' };
    return { stdout: '', stderr: '' };
  })
}));

vi.mock('../src/tools/captureAndroid', () => ({
  captureAndroidScreenshot: vi.fn(async (outputPath: string) => {
    callOrder.push('captureAndroidScreenshot');
    return { outputPath };
  })
}));

vi.mock('../src/tools/captureIosSimulator', () => ({
  captureIosSimulatorScreenshot: vi.fn(async (outputPath: string) => {
    callOrder.push('captureIosSimulatorScreenshot');
    return { outputPath };
  })
}));

vi.mock('../src/tools/compareImages', () => ({
  compareImages: vi.fn(async () => {
    callOrder.push('compareImages');
    return {
      status: 'pass',
      diffPixels: 0,
      totalPixels: 1,
      diffPercent: 0,
      pixelmatchThreshold: 0.1,
      maxDiffPercent: 0.1,
      regions: [],
      artifacts: {
        expected: 'expected.png',
        actual: 'actual.png',
        diff: 'diff.png',
        regionsDir: 'regions'
      }
    };
  })
}));

import { runMobileUiDiff } from '../src/tools/runMobileUiDiff';
import { runScreenUiDiff } from '../src/tools/runScreenUiDiff';
import { compareImages } from '../src/tools/compareImages';

describe('preCapture orchestration', () => {
  const testDir = path.join(__dirname, 'pre-capture-fixtures');
  const expectedImage = path.join(testDir, 'expected.png');
  const outputDir = path.join(testDir, 'out');
  const configPath = path.join(testDir, 'ui-diff.config.json');

  beforeEach(async () => {
    callOrder.length = 0;
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(expectedImage, Buffer.from('fake'));
    await fs.writeFile(configPath, JSON.stringify({
      screens: {
        today: {
          platform: 'android',
          expectedImage,
          outputDir,
          preCapture: [
            {
              type: 'adbShell',
              command: 'input tap 108 2280',
              description: 'Switch to Today tab'
            }
          ]
        }
      }
    }, null, 2));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('runs android preCapture before screenshot capture when actualImage is absent', async () => {
    const result = await runMobileUiDiff({
      platform: 'android',
      expectedImage,
      outputDir,
      preCapture: [
        {
          type: 'adbShell',
          command: 'input tap 108 2280',
          description: 'Switch to Today tab'
        }
      ]
    } as any);

    expect(result.status).toBe('pass');
    expect(callOrder[0]).toContain('execFileAsync:adb shell input tap 108 2280');
    expect(callOrder[1]).toBe('captureAndroidScreenshot');
    expect(callOrder[2]).toBe('compareImages');
  });

  it('skips preCapture when actualImage is already provided to mobile diff', async () => {
    const result = await runMobileUiDiff({
      platform: 'android',
      expectedImage,
      actualImage: expectedImage,
      outputDir,
      preCapture: [
        {
          type: 'adbShell',
          command: 'input tap 108 2280',
          description: 'Switch to Today tab'
        }
      ]
    } as any);

    expect(result.status).toBe('pass');
    expect(callOrder).not.toContain('execFileAsync:adb shell input tap 108 2280');
    expect(callOrder).not.toContain('captureAndroidScreenshot');
    expect(callOrder).toContain('compareImages');
  });

  it.each([
    'input tap 108 2280; rm -rf .',
    'input tap 108 2280 | sh'
  ])('rejects unsafe preCapture command: %s', async (command) => {
    await expect(
      runMobileUiDiff({
        platform: 'android',
        expectedImage,
        outputDir,
        preCapture: [
          {
            type: 'adbShell',
            command,
            description: 'Unsafe'
          }
        ]
      } as any)
    ).rejects.toThrow(/Unsafe preCapture command/);

    expect(callOrder).not.toContain('captureAndroidScreenshot');
    expect(callOrder).not.toContain('compareImages');
  });

  it('does not run or report preCapture when actualImage is provided to run_screen_ui_diff', async () => {
    const result = await runScreenUiDiff({
      screen: 'today',
      configPath,
      platform: 'android',
      actualImage: expectedImage
    } as any);

    expect(result.preCapture).toBeUndefined();
    expect(callOrder).not.toContain('execFileAsync:adb shell input tap 108 2280');
    expect(callOrder).not.toContain('captureAndroidScreenshot');
    expect(callOrder).toEqual(['compareImages']);
  });

  it('threads screen-profile preCapture into final report', async () => {
    const result = await runScreenUiDiff({
      screen: 'today',
      configPath,
      platform: 'android'
    } as any);

    expect(result.preCapture).toEqual([
      {
        description: 'Switch to Today tab',
        ok: true,
        command: 'input tap 108 2280'
      }
    ]);
    expect(callOrder[0]).toContain('execFileAsync:adb shell input tap 108 2280');
    expect(callOrder[1]).toBe('captureAndroidScreenshot');
    expect(callOrder[2]).toBe('compareImages');
  });

  it('resolves normalized adb taps against runtime device dimensions', async () => {
    const result = await runMobileUiDiff({
      platform: 'android',
      expectedImage,
      outputDir,
      preCaptureDeviceSize: { width: 1000, height: 2000 },
      preCapture: [
        {
          type: 'adbTapNormalized',
          x: 0.1,
          y: 0.95,
          description: 'Tap Today tab'
        }
      ]
    });

    expect(result.preCapture).toEqual([
      {
        description: 'Tap Today tab',
        ok: true,
        command: 'input tap 100 1900',
        resolved: { x: 100, y: 1900, width: 1000, height: 2000 }
      }
    ]);
    expect(callOrder[0]).toContain('execFileAsync:adb shell input tap 100 1900');
  });

  it('merges matching device profile masks and reports generated auto masks separately', async () => {
    const profileMask = { x: 1000, y: 0, width: 80, height: 2400, reason: 'saved right strip', type: 'system' as const, coordinateSpace: 'actual' as const };
    const screenMask = { x: 0, y: 0, width: 1080, height: 72, reason: 'status bar', type: 'system' as const, coordinateSpace: 'actual' as const };
    await fs.writeFile(configPath, JSON.stringify({
      deviceProfiles: {
        'SM-G780G': {
          id: 'SM-G780G',
          serial: 'SERIAL123',
          model: 'SM-G780G',
          wmSize: { width: 1080, height: 2400 },
          screenshotSize: { width: 1206, height: 2622 },
          systemUiEstimates: {
            bottomStrip: { x: 0, y: 2400, width: 1206, height: 222, reason: 'bottom strip', type: 'system', coordinateSpace: 'actual' }
          },
          autoIgnoreRegions: [profileMask]
        }
      },
      screens: {
        today: {
          platform: 'android',
          expectedImage,
          outputDir,
          autoIgnore: { enabled: true, screenshotOutOfBounds: true },
          ignoreRegions: [screenMask]
        }
      }
    }, null, 2));

    await runScreenUiDiff({
      screen: 'today',
      configPath,
      actualImage: expectedImage
    });

    expect(compareImages).toHaveBeenLastCalledWith(expect.objectContaining({
      ignoreRegions: [profileMask, screenMask],
      autoMaskedRegions: [
        { x: 0, y: 2400, width: 1206, height: 222, reason: 'bottom strip', type: 'system', coordinateSpace: 'actual' }
      ],
      appliedDeviceProfile: expect.objectContaining({ id: 'SM-G780G' })
    }));
  });
});
