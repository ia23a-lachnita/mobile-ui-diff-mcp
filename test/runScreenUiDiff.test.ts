import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PNG } from 'pngjs';
import fs from 'fs/promises';
import path from 'path';
import { runScreenUiDiff } from '../src/tools/runScreenUiDiff';
import { getToolList } from '../src/mcp/server';

async function createTestImage(p: string, draw: (png: PNG) => void) {
  const png = new PNG({ width: 100, height: 100 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = 255;
      png.data[idx + 1] = 255;
      png.data[idx + 2] = 255;
      png.data[idx + 3] = 255;
    }
  }
  draw(png);
  await fs.writeFile(p, PNG.sync.write(png));
}

function drawRect(png: PNG, rx: number, ry: number, rw: number, rh: number, color: [number, number, number]) {
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      if (x < 0 || x >= png.width || y < 0 || y >= png.height) continue;
      const idx = (png.width * y + x) << 2;
      png.data[idx] = color[0];
      png.data[idx + 1] = color[1];
      png.data[idx + 2] = color[2];
      png.data[idx + 3] = 255;
    }
  }
}

describe('runScreenUiDiff', () => {
  const testDir = path.join(__dirname, 'screen-fixtures');
  const expectedPath = path.join(testDir, 'expected.png');
  const actualIdentical = path.join(testDir, 'actual-identical.png');
  const actualShifted = path.join(testDir, 'actual-shifted.png');
  const configPath = path.join(testDir, 'ui-diff.config.json');
  const outputDir = path.join(testDir, 'runs');

  beforeAll(async () => {
    await fs.mkdir(testDir, { recursive: true });
    await createTestImage(expectedPath, (png) => {
      drawRect(png, 10, 10, 20, 20, [0, 0, 0]);
    });
    await createTestImage(actualIdentical, (png) => {
      drawRect(png, 10, 10, 20, 20, [0, 0, 0]);
    });
    await createTestImage(actualShifted, (png) => {
      drawRect(png, 15, 10, 20, 20, [0, 0, 0]);
    });

    const config = {
      screens: {
        home: {
          platform: 'none',
          expectedImage: expectedPath,
          outputDir
        },
        settings: {
          platform: 'none',
          expectedImage: expectedPath,
          outputDir
        },
        vlmProfile: {
          platform: 'none',
          expectedImage: expectedPath,
          outputDir,
          includeVlmAnalysis: true,
          maxRegions: 1,
          maxVlmRegions: 1,
          vlm: {
            model: 'profile-model'
          }
        },
        requireTopLevel: {
          platform: 'none',
          expectedImage: expectedPath,
          outputDir,
          includeVlmAnalysis: true,
          requireVlmAnalysis: true
        },
        autoPullProfile: {
          platform: 'none',
          expectedImage: expectedPath,
          outputDir,
          includeVlmAnalysis: true,
          vlm: {
            autoPull: true
          }
        }
      }
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.OLLAMA_MODEL;
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('rejects unknown screens with available list', async () => {
    await expect(runScreenUiDiff({
      screen: 'missing',
      configPath,
      actualImage: actualIdentical
    })).rejects.toThrow(/Available screens:/);
  });

  it('auto-assigns run folders, persists final report, and computes numbered deltas + trend', async () => {
    await fs.rm(outputDir, { recursive: true, force: true });

    const run1 = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualIdentical
    });
    expect(run1.run.name).toBe('run-001');
    expect(run1.run.outputDir).toBe(path.resolve(outputDir, 'run-001'));
    expect(run1.run.configPath).toBe(path.resolve(configPath));
    expect(run1.delta).toBeUndefined();

    const run2 = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualShifted
    });
    expect(run2.run.name).toBe('run-002');
    expect(run2.delta?.previousRun.name).toBe('run-001');
    expect(run2.delta?.trend).toBe('worsened');

    const reportPath = path.join(outputDir, 'run-002', 'report.json');
    const persisted = JSON.parse(await fs.readFile(reportPath, 'utf-8'));
    expect(persisted).toEqual(run2);

    const run1ReportPath = path.join(outputDir, 'run-001', 'report.json');
    const future = new Date(Date.now() + 5000);
    await fs.utimes(run1ReportPath, future, future);

    const run3 = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualIdentical
    });
    expect(run3.run.name).toBe('run-003');
    expect(run3.delta?.previousRun.name).toBe('run-002');
    expect(run3.delta?.trend).toBe('improved');

    const run4 = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualIdentical
    });
    expect(run4.run.name).toBe('run-004');
    expect(run4.delta?.previousRun.name).toBe('run-003');
    expect(run4.delta?.trend).toBe('unchanged');
  });

  it('lists tool descriptions that prefer compare_images when actualImage is provided', () => {
    const tools = getToolList();
    expect(JSON.stringify(tools)).toContain('prefer compare_images');
  });

  it('selects fallback VLM model when primary fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const urlString = String(url);
      if (urlString.endsWith('/api/tags')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'primary-model' }, { name: 'fallback-model' }] }),
          text: async () => ''
        } as Response;
      }
      if (urlString.endsWith('/api/ps')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [] }),
          text: async () => ''
        } as Response;
      }
      if (urlString.endsWith('/api/chat')) {
        const body = JSON.parse((options?.body as string) || '{}');
        if (body.model === 'primary-model') {
          return {
            ok: false,
            status: 500,
            json: async () => ({}),
            text: async () => 'out of memory'
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ message: { content: JSON.stringify({ type: 'layout', severity: 'low', description: 'ok', likelyFix: 'fix' }) } }),
          text: async () => ''
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${urlString}`);
    }));

    const run = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualShifted,
      includeVlmAnalysis: true,
      maxRegions: 1,
      maxVlmRegions: 1,
      vlm: {
        model: 'primary-model',
        fallbackModels: ['fallback-model']
      }
    });

    expect(run.vlm?.selectedModel).toBe('fallback-model');
    expect(run.vlm?.fallbackUsed).toBe(true);
    expect(run.vlm?.warnings.length).toBeGreaterThan(0);
  });

  it('fails early when VLM is required but unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    await expect(runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualShifted,
      includeVlmAnalysis: true,
      requireVlmAnalysis: true
    })).rejects.toThrow('VLM analysis is required but no configured Ollama model could be loaded. Run vlm_health for details.');
  });

  it('honors top-level screen profile requireVlmAnalysis', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    await expect(runScreenUiDiff({
      screen: 'requireTopLevel',
      configPath,
      actualImage: actualShifted
    })).rejects.toThrow('VLM analysis is required but no configured Ollama model could be loaded. Run vlm_health for details.');
  });

  it('continues with warning when VLM is unavailable but not required', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const run = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualShifted,
      includeVlmAnalysis: true,
      requireVlmAnalysis: false,
      maxRegions: 1,
      maxVlmRegions: 1
    });
    expect(run.warnings).toContain('VLM analysis was requested but unavailable. Region analysis fell back to error/fallback statuses. Run vlm_health or start Ollama.');
    expect(run.regions[0].analysisStatus).toBe('fallback');
  });

  it('includes vlm summary when VLM analysis is enabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const run = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualShifted,
      includeVlmAnalysis: true,
      maxRegions: 1,
      maxVlmRegions: 1
    });
    expect(run.vlm).toBeDefined();
    expect(run.vlm?.requested).toBe(true);
    expect(run.vlm?.provider).toBe('ollama');
  });

  it('uses screen profile VLM model overrides', async () => {
    process.env.OLLAMA_MODEL = 'env-model';
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const urlString = String(url);
      if (urlString.endsWith('/api/tags')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'profile-model' }] }),
          text: async () => ''
        } as Response;
      }
      if (urlString.endsWith('/api/ps')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [] }),
          text: async () => ''
        } as Response;
      }
      if (urlString.endsWith('/api/chat')) {
        const body = JSON.parse((options?.body as string) || '{}');
        if (body.model !== 'profile-model') {
          return {
            ok: false,
            status: 404,
            json: async () => ({}),
            text: async () => 'model not found'
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ message: { content: JSON.stringify({ type: 'layout', severity: 'low', description: 'ok', likelyFix: 'fix' }) } }),
          text: async () => ''
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${urlString}`);
    }));

    const run = await runScreenUiDiff({
      screen: 'vlmProfile',
      configPath,
      actualImage: actualShifted
    });

    expect(run.vlm?.selectedModel).toBe('profile-model');
    expect(run.vlm?.healthStatus).not.toBe('error');
  });

  it('emits explicit autoPull warning when autoPull=true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const run = await runScreenUiDiff({
      screen: 'autoPullProfile',
      configPath,
      actualImage: actualShifted,
      maxRegions: 1,
      maxVlmRegions: 1
    });
    expect(run.warnings).toContain('autoPull is not implemented. Run `ollama pull qwen2.5vl:7b` manually.');
    expect(run.vlm?.warnings).toContain('autoPull is not implemented. Run `ollama pull qwen2.5vl:7b` manually.');
  });
});
