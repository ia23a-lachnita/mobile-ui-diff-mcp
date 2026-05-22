import { describe, it, expect, afterEach, vi } from 'vitest';
import { checkOllamaHealth } from '../src/vlm/ollama';

function mockResponse(status: number, body: any): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  } as Response;
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
    expect(result.warnings).toContain('autoPull is not implemented. Run `ollama pull <model>` manually.');
  });
});
