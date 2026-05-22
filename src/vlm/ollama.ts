import { VlmAnalysis } from '../types';
import fs from 'fs/promises';

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5vl:7b';
export const DEFAULT_VLM_TIMEOUT_MS = 60000;
export const DEFAULT_VLM_HEALTH_TIMEOUT_MS = 30000;
export const DEFAULT_VLM_KEEP_ALIVE = '10m';

export type OllamaErrorStatus =
  | 'unreachable'
  | 'timeout'
  | 'model_missing'
  | 'resource_limited'
  | 'invalid_response'
  | 'unknown';

export interface OllamaModelInfo {
  name: string;
  size?: number;
}

export interface OllamaLoadCheck {
  attempted: boolean;
  ok: boolean;
  imageInputVerified: boolean;
  status?: OllamaErrorStatus;
  message?: string;
}

export interface OllamaHealthCheckInput {
  provider?: 'ollama';
  baseUrl?: string;
  model?: string;
  fallbackModels?: string[];
  checkLoad?: boolean;
  keepAlive?: string;
  autoPull?: boolean;
  timeoutMs?: number;
}

export interface OllamaHealthCheckResult {
  provider: 'ollama';
  baseUrl: string;
  reachable: boolean;
  selectedModel: string;
  selectedModelInstalled: boolean;
  selectedModelRunning: boolean;
  loadCheck: OllamaLoadCheck;
  installedModels: OllamaModelInfo[];
  runningModels: OllamaModelInfo[];
  usableModels: string[];
  recommendedModel: string | null;
  warnings: string[];
}

export interface OllamaRequestOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  keepAlive?: string;
}

export interface ResolvedOllamaConfig {
  baseUrl: string;
  model: string;
  fallbackModels: string[];
  autoPull?: boolean;
  keepAlive?: string;
  timeoutMs: number;
}

export interface VlmPreflightResult {
  available: boolean;
  selectedModel: string | null;
  fallbackUsed: boolean;
  warnings: string[];
  healthStatus: 'ok' | 'warning' | 'error';
  baseUrl: string;
  timeoutMs: number;
  keepAlive?: string;
  failureMessage?: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function resolveTimeout(timeoutMs?: number): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) return timeoutMs;
  const env = Number.parseInt(process.env.VLM_TIMEOUT_MS || '', 10);
  if (!Number.isNaN(env) && env > 0) return env;
  return DEFAULT_VLM_TIMEOUT_MS;
}

export function resolveOllamaConfig(overrides: Partial<ResolvedOllamaConfig> = {}): ResolvedOllamaConfig {
  const baseUrl = normalizeBaseUrl(overrides.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL);
  const model = overrides.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
  const timeoutMs = resolveTimeout(overrides.timeoutMs);
  return {
    baseUrl,
    model,
    fallbackModels: overrides.fallbackModels ?? [],
    autoPull: overrides.autoPull,
    keepAlive: overrides.keepAlive,
    timeoutMs
  };
}

function ensureErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}

export function classifyOllamaError(error: unknown): OllamaErrorStatus {
  if (!error || typeof error !== 'object') return 'unknown';
  const err = error as { name?: string; type?: string; code?: string; message?: string; status?: number; body?: string };
  const message = (err.message || err.body || '').toLowerCase();
  if (err.name === 'AbortError' || err.type === 'aborted') return 'timeout';
  if (err.code === 'ECONNREFUSED' || message.includes('fetch failed') || message.includes('network')) return 'unreachable';
  if (err.status === 404 && message.includes('model')) return 'model_missing';
  if (message.includes('model') && (message.includes('not found') || message.includes('missing'))) return 'model_missing';
  const resourceKeywords = ['out of memory', 'resource', 'insufficient', 'no available memory', 'gpu'];
  if (resourceKeywords.some((keyword) => message.includes(keyword))) return 'resource_limited';
  if (message.includes('invalid json') || message.includes('unexpected token')) return 'invalid_response';
  return 'unknown';
}

function errorMessageForStatus(status: OllamaErrorStatus): string {
  switch (status) {
    case 'unreachable':
      return 'Ollama unreachable. Is it running?';
    case 'timeout':
      return 'VLM timeout exceeded.';
    case 'model_missing':
      return 'Ollama model missing. Pull it first.';
    case 'resource_limited':
      return 'Model failed to load due to resource limitations.';
    case 'invalid_response':
      return 'Invalid JSON response from VLM.';
    default:
      return 'Ollama request failed.';
  }
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal as any });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJson<T>(url: string, options: RequestInit, timeoutMs: number): Promise<T> {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  if (!response.ok) {
    const text = await response.text();
    const error: any = new Error(`Ollama request failed: ${response.status} ${text}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }
  try {
    return await response.json();
  } catch (err: unknown) {
    const error: any = new Error('Invalid JSON response from Ollama.');
    error.cause = err;
    throw error;
  }
}

export async function getInstalledModels(baseUrl: string, timeoutMs: number): Promise<OllamaModelInfo[]> {
  const data = await fetchJson<{ models?: Array<{ name?: string; size?: number }> }>(
    `${baseUrl}/api/tags`,
    { method: 'GET' },
    timeoutMs
  );
  return (data.models ?? [])
    .filter((model) => typeof model.name === 'string')
    .map((model) => ({ name: model.name as string, size: model.size }));
}

export async function getRunningModels(baseUrl: string, timeoutMs: number): Promise<OllamaModelInfo[]> {
  const data = await fetchJson<{ models?: Array<{ name?: string; size?: number }> }>(
    `${baseUrl}/api/ps`,
    { method: 'GET' },
    timeoutMs
  );
  return (data.models ?? [])
    .filter((model) => typeof model.name === 'string')
    .map((model) => ({ name: model.name as string, size: model.size }));
}

export async function warmModel(baseUrl: string, model: string, keepAlive: string | undefined, timeoutMs: number): Promise<void> {
  const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2QhXwAAAAASUVORK5CYII=';
  const response = await fetchWithTimeout(
    `${baseUrl}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping', images: [tinyPngBase64] }],
        stream: false,
        options: { num_predict: 1 },
        ...(keepAlive ? { keep_alive: keepAlive } : {})
      })
    },
    timeoutMs
  );
  if (!response.ok) {
    const text = await response.text();
    const error: any = new Error(`Ollama request failed: ${response.status} ${text}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }
  try {
    await response.json();
  } catch (err: unknown) {
    const error: any = new Error('Invalid JSON response from Ollama.');
    error.cause = err;
    throw error;
  }
}

export async function checkOllamaHealth(input: OllamaHealthCheckInput): Promise<OllamaHealthCheckResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL);
  const selectedModel = input.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
  const timeoutMs = input.timeoutMs ?? DEFAULT_VLM_HEALTH_TIMEOUT_MS;
  const checkLoad = input.checkLoad ?? true;
  const keepAlive = input.keepAlive ?? DEFAULT_VLM_KEEP_ALIVE;
  const fallbackModels = input.fallbackModels ?? [];
  const candidates = [selectedModel, ...fallbackModels.filter((model) => model && model !== selectedModel)];
  const warnings: string[] = [];
  const loadCheck: OllamaLoadCheck = { attempted: false, ok: false, imageInputVerified: false };
  if (input.provider && input.provider !== 'ollama') {
    warnings.push('Only provider=ollama is supported.');
  }
  if (input.autoPull === true) {
    warnings.push('autoPull is not implemented. Run `ollama pull <model>` manually.');
  }

  let installedModels: OllamaModelInfo[] = [];
  let runningModels: OllamaModelInfo[] = [];

  try {
    installedModels = await getInstalledModels(baseUrl, timeoutMs);
    runningModels = await getRunningModels(baseUrl, timeoutMs);
  } catch (err) {
    const status = classifyOllamaError(err);
    warnings.push(errorMessageForStatus(status));
    return {
      provider: 'ollama',
      baseUrl,
      reachable: false,
      selectedModel,
      selectedModelInstalled: false,
      selectedModelRunning: false,
      loadCheck,
      installedModels: [],
      runningModels: [],
      usableModels: [],
      recommendedModel: null,
      warnings
    };
  }

  const installedSet = new Set(installedModels.map((model) => model.name));
  const runningSet = new Set(runningModels.map((model) => model.name));
  const selectedModelInstalled = installedSet.has(selectedModel);
  const selectedModelRunning = runningSet.has(selectedModel);
  const usableModels: string[] = [];

  if (!selectedModelInstalled) {
    warnings.push('Selected model is not installed. Pull it first.');
  }

  for (const candidate of candidates) {
    if (!installedSet.has(candidate)) continue;
    if (!checkLoad) {
      usableModels.push(candidate);
      continue;
    }
    try {
      await warmModel(baseUrl, candidate, keepAlive, timeoutMs);
      usableModels.push(candidate);
      if (candidate === selectedModel) {
        loadCheck.attempted = true;
        loadCheck.ok = true;
        loadCheck.imageInputVerified = true;
      }
    } catch (err) {
      if (candidate === selectedModel) {
        const status = classifyOllamaError(err);
        loadCheck.attempted = true;
        loadCheck.ok = false;
        loadCheck.status = status;
        loadCheck.message = errorMessageForStatus(status);
        if (status === 'resource_limited') {
          warnings.push('Selected model is installed but failed to load. Try a smaller VLM model or free VRAM/RAM.');
        } else if (status === 'timeout') {
          warnings.push('Selected model load check timed out. Increase timeoutMs or load the model manually.');
        } else if (status === 'unreachable') {
          warnings.push('Ollama is unreachable. Start ollama serve and retry.');
        } else if (status === 'model_missing') {
          warnings.push('Selected model is missing. Pull it before running VLM analysis.');
        }
      }
    }
  }

  return {
    provider: 'ollama',
    baseUrl,
    reachable: true,
    selectedModel,
    selectedModelInstalled,
    selectedModelRunning,
    loadCheck,
    installedModels,
    runningModels,
    usableModels,
    recommendedModel: usableModels.length > 0 ? usableModels[0] : null,
    warnings
  };
}

export async function preflightOllama(config: ResolvedOllamaConfig, checkLoad: boolean): Promise<VlmPreflightResult> {
  const health = await checkOllamaHealth({
    baseUrl: config.baseUrl,
    model: config.model,
    fallbackModels: config.fallbackModels,
    checkLoad,
    keepAlive: config.keepAlive ?? DEFAULT_VLM_KEEP_ALIVE,
    timeoutMs: config.timeoutMs
  });
  const candidates = [config.model, ...config.fallbackModels.filter((model) => model && model !== config.model)];
  let selectedModel: string | null = null;
  for (const candidate of candidates) {
    if (health.usableModels.includes(candidate)) {
      selectedModel = candidate;
      break;
    }
  }

  const fallbackUsed = selectedModel !== null && selectedModel !== config.model;
  const available = selectedModel !== null;
  const warnings = [...health.warnings];
  let failureMessage: string | undefined;

  if (!available) {
    const status = health.loadCheck.status ?? (health.reachable ? 'model_missing' : 'unreachable');
    failureMessage = errorMessageForStatus(status);
  }

  const healthStatus: 'ok' | 'warning' | 'error' = available
    ? (warnings.length > 0 ? 'warning' : 'ok')
    : 'error';

  return {
    available,
    selectedModel,
    fallbackUsed,
    warnings,
    healthStatus,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    keepAlive: config.keepAlive,
    failureMessage
  };
}

export async function explainDiffUsingOllama(
  expectedCropPath: string,
  actualCropPath: string,
  diffCropPath: string,
  options: OllamaRequestOptions = {}
): Promise<{ analysis: VlmAnalysis | null, status: "ok" | "fallback" | "error" }> {
  const fallbackResponse = (msg: string): { analysis: VlmAnalysis, status: "fallback" } => ({
    status: "fallback",
    analysis: {
      type: 'unknown',
      severity: 'medium',
      description: msg,
      likelyFix: 'Inspect the crop manually.'
    }
  });

  const errorResponse = (msg: string): { analysis: VlmAnalysis, status: "error" } => ({
    status: "error",
    analysis: {
      type: 'unknown',
      severity: 'medium',
      description: msg,
      likelyFix: 'Inspect the crop manually.'
    }
  });

  try {
    const expectedBase64 = (await fs.readFile(expectedCropPath)).toString('base64');
    const actualBase64 = (await fs.readFile(actualCropPath)).toString('base64');
    const diffBase64 = (await fs.readFile(diffCropPath)).toString('base64');

    const prompt = `You are comparing a mobile app implementation against a design mockup. You are given three images: expected crop, actual crop, and diff crop. Return JSON only with: label, type, severity, description, likelyFix. label should be a short human-readable region name like "bottom navigation", "header", or "meal card". type must be one of: layout, spacing, color, text, font, icon, missing, extra, size, unknown.`;

    const resolved = resolveOllamaConfig({
      baseUrl: options.baseUrl,
      model: options.model,
      timeoutMs: options.timeoutMs
    });

    let response: Response;
    try {
      response = await fetchWithTimeout(`${resolved.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: resolved.model,
          messages: [
            {
              role: 'user',
              content: prompt,
              images: [expectedBase64, actualBase64, diffBase64]
            }
          ],
          stream: false,
          format: 'json',
          ...(options.keepAlive ? { keep_alive: options.keepAlive } : {})
        })
      }, resolved.timeoutMs);
    } catch (err: unknown) {
      const status = classifyOllamaError(err);
      if (status === 'timeout') return fallbackResponse('VLM timeout exceeded.');
      if (status === 'unreachable') return fallbackResponse('Ollama unreachable. Is it running?');
      if (status === 'model_missing') return fallbackResponse('Ollama model missing. Pull it first.');
      if (status === 'invalid_response') return fallbackResponse('Invalid JSON response from VLM.');
      if (status === 'resource_limited') return fallbackResponse('Ollama failed to load model due to resource limitations.');
      return errorResponse(`Network error: ${ensureErrorMessage(err)}`);
    }

    if (!response.ok) {
      const text = await response.text();
      const error: any = new Error(`Ollama request failed: ${response.status} ${text}`);
      error.status = response.status;
      error.body = text;
      const status = classifyOllamaError(error);
      if (status === 'model_missing') return fallbackResponse('Ollama model missing. Pull it first.');
      if (status === 'resource_limited') return fallbackResponse('Ollama failed to load model due to resource limitations.');
      return errorResponse(`Ollama request failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    const content = data?.message?.content;
    if (!content) return errorResponse('VLM returned empty response.');

    try {
      const parsed = JSON.parse(content);
      return {
        status: "ok",
        analysis: {
          label: typeof parsed.label === 'string' && parsed.label.trim().length > 0 ? parsed.label.trim() : undefined,
          type: parsed.type || 'unknown',
          severity: parsed.severity || 'medium',
          description: parsed.description || 'No description provided.',
          likelyFix: parsed.likelyFix || 'Unknown fix.'
        }
      };
    } catch (e) {
      return fallbackResponse('Invalid JSON response from VLM.');
    }
  } catch (error: unknown) {
    console.error('Failed to explain diff with Ollama:', error);
    return errorResponse(`VLM error: ${ensureErrorMessage(error)}`);
  }
}
