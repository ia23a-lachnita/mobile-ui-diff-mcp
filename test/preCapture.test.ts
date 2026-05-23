import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

const callOrder: string[] = [];

vi.mock('../src/utils/exec', () => ({
  execFileAsync: vi.fn(async (command: string, args: string[]) => {
    callOrder.push(`execFileAsync:${command} ${args.join(' ')}`);
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

  it('runs safe preCapture steps before capture', async () => {
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

  it('skips preCapture when actualImage is already provided', async () => {
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

  it('rejects unsafe preCapture commands', async () => {
    await expect(runMobileUiDiff({
      platform: 'android',
      expectedImage,
      outputDir,
      preCapture: [
        {
          type: 'adbShell',
          command: 'input tap 108 2280 && reboot',
          description: 'Unsafe'
        }
      ]
    } as any)).rejects.toThrow(/Unsafe preCapture command/);
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
  });
});
