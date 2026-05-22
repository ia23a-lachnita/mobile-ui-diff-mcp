import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { PNG } from 'pngjs';
import { checkOllamaHealth } from '../src/vlm/ollama';
import { runScreenUiDiff } from '../src/tools/runScreenUiDiff';

function mockResponse(status: number, body: any): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  } as Response;
}

async function createTestImage(filePath: string, draw: (png: PNG) => void) {
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
  await fs.writeFile(filePath, PNG.sync.write(png));
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('vlm health', () => {
  it('marks Ollama as unreachable when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const result = await checkOllamaHealth({
      baseUrl: 'http://localhost:59999',
      model: 'qwen2.5vl:7b',
      checkLoad: true,
      timeoutMs: 50
    });
    expect(result.reachable).toBe(false);
    expect(result.warnings[0]).toContain('Ollama unreachable');
    expect(result.loadCheck.imageInputVerified).toBe(false);
  });

  it('reports load failure when model is installed but warmup fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const urlString = String(url);
      if (urlString.endsWith('/api/tags')) {
        return mockResponse(200, { models: [{ name: 'qwen2.5vl:7b', size: 6000000000 }] });
      }
      if (urlString.endsWith('/api/ps')) {
        return mockResponse(200, { models: [] });
      }
      if (urlString.endsWith('/api/chat')) {
        return mockResponse(500, 'out of memory');
      }
      throw new Error(`Unexpected fetch URL: ${urlString}`);
    }));

    const result = await checkOllamaHealth({
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5vl:7b',
      checkLoad: true,
      timeoutMs: 50
    });
    expect(result.selectedModelInstalled).toBe(true);
    expect(result.loadCheck.attempted).toBe(true);
    expect(result.loadCheck.ok).toBe(false);
    expect(result.loadCheck.status).toBe('resource_limited');
    expect(result.loadCheck.imageInputVerified).toBe(false);
  });

  it('reports success and imageInputVerified when warmup succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const urlString = String(url);
      if (urlString.endsWith('/api/tags')) {
        return mockResponse(200, { models: [{ name: 'qwen2.5vl:7b', size: 6000000000 }] });
      }
      if (urlString.endsWith('/api/ps')) {
        return mockResponse(200, { models: [] });
      }
      if (urlString.endsWith('/api/chat')) {
        return mockResponse(200, { message: { content: JSON.stringify({ ok: true }) } });
      }
      throw new Error(`Unexpected fetch URL: ${urlString}`);
    }));

    const result = await checkOllamaHealth({
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5vl:7b',
      checkLoad: true,
      timeoutMs: 50
    });
    expect(result.selectedModelInstalled).toBe(true);
    expect(result.loadCheck.attempted).toBe(true);
    expect(result.loadCheck.ok).toBe(true);
    expect(result.loadCheck.imageInputVerified).toBe(true);
    expect(result.usableModels).toContain('qwen2.5vl:7b');
    expect(result.recommendedModel).toBe('qwen2.5vl:7b');
  });

  it('selects a fallback model when primary fails to warm but fallback succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const urlString = String(url);
      if (urlString.endsWith('/api/tags')) {
        return mockResponse(200, { models: [{ name: 'primary-model' }, { name: 'fallback-model' }] });
      }
      if (urlString.endsWith('/api/ps')) {
        return mockResponse(200, { models: [] });
      }
      if (urlString.endsWith('/api/chat')) {
        const body = JSON.parse((options?.body as string) || '{}');
        if (body.model === 'primary-model') {
          return mockResponse(500, 'out of memory');
        }
        return mockResponse(200, { message: { content: JSON.stringify({ ok: true }) } });
      }
      throw new Error(`Unexpected fetch URL: ${urlString}`);
    }));

    const result = await checkOllamaHealth({
      baseUrl: 'http://localhost:11434',
      model: 'primary-model',
      fallbackModels: ['fallback-model'],
      checkLoad: true,
      timeoutMs: 50
    });

    expect(result.selectedModelInstalled).toBe(true);
    expect(result.usableModels).toContain('fallback-model');
    expect(result.recommendedModel).toBe('fallback-model');
  });

  it('warns explicitly when autoPull=true', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const urlString = String(url);
      if (urlString.endsWith('/api/tags')) {
        return mockResponse(200, { models: [] });
      }
      if (urlString.endsWith('/api/ps')) {
        return mockResponse(200, { models: [] });
      }
      throw new Error(`Unexpected fetch URL: ${urlString}`);
    }));

    const result = await checkOllamaHealth({
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5vl:7b',
      autoPull: true,
      checkLoad: false,
      timeoutMs: 50
    });
    expect(result.warnings).toContain('autoPull is not implemented. Run `ollama pull qwen2.5vl:7b` manually.');
  });
});

describe('runScreenUiDiff VLM preflight', () => {
  const testDir = path.join(__dirname, 'vlm-health-fixtures');
  const expectedPath = path.join(testDir, 'expected.png');
  const actualPath = path.join(testDir, 'actual.png');
  const shiftedPath = path.join(testDir, 'shifted.png');
  const configPath = path.join(testDir, 'ui-diff.config.json');
  const outputDir = path.join(testDir, 'runs');

  beforeAll(async () => {
    await fs.mkdir(testDir, { recursive: true });
    await createTestImage(expectedPath, (png) => {
      drawRect(png, 10, 10, 20, 20, [0, 0, 0]);
    });
    await createTestImage(actualPath, (png) => {
      drawRect(png, 10, 10, 20, 20, [0, 0, 0]);
    });
    await createTestImage(shiftedPath, (png) => {
      drawRect(png, 15, 10, 20, 20, [0, 0, 0]);
    });

    const config = {
      screens: {
        reportProfile: {
          platform: 'none',
          expectedImage: expectedPath,
          outputDir
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
        },
        profileOverride: {
          platform: 'none',
          expectedImage: expectedPath,
          outputDir,
          includeVlmAnalysis: true,
          maxRegions: 1,
          maxVlmRegions: 1,
          vlm: {
            model: 'profile-model'
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

  it('includes a vlm summary in the run report', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const run = await runScreenUiDiff({
      screen: 'reportProfile',
      configPath,
      actualImage: actualPath,
      includeVlmAnalysis: true,
      maxRegions: 1,
      maxVlmRegions: 1
    });

    expect(run.vlm).toBeDefined();
    expect(run.vlm?.requested).toBe(true);
    expect(run.vlm?.provider).toBe('ollama');
    expect(run.vlm?.healthStatus).toBe('error');
  });

  it('fails early when requireVlmAnalysis=true and no model is usable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    await expect(runScreenUiDiff({
      screen: 'requireTopLevel',
      configPath,
      actualImage: shiftedPath
    })).rejects.toThrow('VLM analysis is required but no configured Ollama model could be loaded. Run vlm_health for details.');
  });

  it('continues and warns when requireVlmAnalysis=false and no model is usable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const run = await runScreenUiDiff({
      screen: 'reportProfile',
      configPath,
      actualImage: shiftedPath,
      includeVlmAnalysis: true,
      requireVlmAnalysis: false,
      maxRegions: 1,
      maxVlmRegions: 1
    });

    expect(run.warnings).toContain('VLM analysis was requested but unavailable. Region analysis fell back to error/fallback statuses. Run vlm_health or start Ollama.');
    expect(run.regions[0].analysisStatus).toBe('fallback');
    expect(run.vlm?.required).toBe(false);
  });

  it('honors screen profile requireVlmAnalysis', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    await expect(runScreenUiDiff({
      screen: 'requireTopLevel',
      configPath,
      actualImage: shiftedPath,
      includeVlmAnalysis: true
    })).rejects.toThrow('VLM analysis is required but no configured Ollama model could be loaded. Run vlm_health for details.');
  });

  it('lets screen profile vlm.model override the env model', async () => {
    process.env.OLLAMA_MODEL = 'env-model';
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const urlString = String(url);
      if (urlString.endsWith('/api/tags')) {
        return mockResponse(200, { models: [{ name: 'env-model' }, { name: 'profile-model' }] });
      }
      if (urlString.endsWith('/api/ps')) {
        return mockResponse(200, { models: [] });
      }
      if (urlString.endsWith('/api/chat')) {
        const body = JSON.parse((options?.body as string) || '{}');
        if (body.model !== 'profile-model') {
          return mockResponse(404, 'model not found');
        }
        return mockResponse(200, { message: { content: JSON.stringify({ type: 'layout', severity: 'low', description: 'ok', likelyFix: 'fix' }) } });
      }
      throw new Error(`Unexpected fetch URL: ${urlString}`);
    }));

    const run = await runScreenUiDiff({
      screen: 'profileOverride',
      configPath,
      actualImage: shiftedPath
    });

    expect(run.vlm?.selectedModel).toBe('profile-model');
    expect(run.vlm?.healthStatus).not.toBe('error');
  });

  it('emits an explicit autoPull warning from screen profile config', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const run = await runScreenUiDiff({
      screen: 'autoPullProfile',
      configPath,
      actualImage: shiftedPath,
      maxRegions: 1,
      maxVlmRegions: 1
    });

    expect(run.warnings).toContain('autoPull is not implemented. Run `ollama pull qwen2.5vl:7b` manually.');
    expect(run.vlm?.warnings).toContain('autoPull is not implemented. Run `ollama pull qwen2.5vl:7b` manually.');
  });
});
