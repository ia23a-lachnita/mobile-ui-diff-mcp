import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PNG } from 'pngjs';
import { runScreenUiDiff } from '../../src/tools/runScreenUiDiff';

function makePng(width = 120, height = 200, rgb: [number, number, number] = [200, 200, 200]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

let tmpDir: string;
let savedOpenRouterKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-openrouter-diagnostics-'));
  savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (savedOpenRouterKey === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
  }
});

async function writeFile(name: string, content: Buffer | string): Promise<string> {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, content);
  return filePath;
}

async function writeConfig(expectedPath: string): Promise<string> {
  const configPath = path.join(tmpDir, 'ui-diff.config.json');
  await fs.writeFile(configPath, JSON.stringify({
    screens: {
      today: {
        platform: 'none',
        expectedImage: expectedPath,
        outputDir: path.join(tmpDir, 'runs'),
        visualAuditMode: 'visual_parity',
        modelJudges: {
          enabled: true,
          required: true,
          policy: 'always_audit',
          maxRetries: 0,
          primary: { provider: 'openrouter', model: 'test-model' }
        }
      }
    }
  }, null, 2));
  return configPath;
}

describe('runScreenUiDiff with real OpenRouterProvider diagnostics', () => {
  it('preserves invalid JSON provider diagnostics and blocks required visual parity acceptance', async () => {
    const badJson = 'not valid structured judge json';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: badJson } }] }),
      text: async () => ''
    });
    vi.stubGlobal('fetch', mockFetch);

    const expectedPath = await writeFile('expected.png', makePng());
    const actualPath = await writeFile('actual.png', makePng(120, 200, [180, 200, 210]));
    const configPath = await writeConfig(expectedPath);

    const report = await runScreenUiDiff({
      screen: 'today',
      configPath,
      actualImage: actualPath,
      runName: 'run-real-openrouter-invalid-json'
    });

    expect(mockFetch).toHaveBeenCalled();
    expect(report.modelJudgesSummary?.required).toBe(true);
    expect(report.visualAuditStatus).toBe('error');
    expect(report.acceptanceStatus).toBe('rejected');
    expect(report.actionRequired?.type).toBe('model_judges_failed');

    const primary = report.modelJudgesSummary?.primary;
    expect(primary?.attempted).toBe(true);
    expect(primary?.status).toBe('error');
    expect(primary?.errorCount).toBeGreaterThanOrEqual(1);

    const failed = report.modelJudgesSummary?.failedRois.find((roi) => roi.provider === 'openrouter');
    expect(failed).toBeDefined();
    expect(failed?.failureReason).toBe('invalid_json');
    expect(failed?.rawResponsePreview).toBe(badJson);
    expect(failed?.schemaErrorPreview).toContain('JSON');
    expect(failed?.rawResponsePreview).not.toBe('<missing_error_detail>');
  });
});
