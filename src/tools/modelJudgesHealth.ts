import { loadUiDiffConfig } from '../config/uiDiffConfig';

export interface ModelJudgesHealthInput {
  primary?: { provider: 'openrouter' | 'nvidia'; model: string };
  reviewer?: { provider: 'openrouter' | 'nvidia'; model: string };
  screen?: string;
  configPath?: string;
  deep?: boolean;
}

export interface ProviderHealthResult {
  provider: 'openrouter' | 'nvidia';
  model: string;
  apiKeyPresent: boolean;
  envVar: string;
  status: 'ready' | 'missing_key' | 'unknown' | 'call_ok' | 'call_failed';
  deepCheckError?: string;
}

export interface EffectivePolicyReport {
  visualAuditMode?: string;
  enabled: boolean;
  required: boolean;
  policy?: string;
  explicitSkipReason?: string;
  allowEditSuggestionsOnPass: boolean;
  willFailHard: boolean;
  missingKeys: string[];
}

export interface ModelJudgesHealthResult {
  status: 'ok' | 'degraded' | 'unavailable' | 'metric_only';
  primary?: ProviderHealthResult;
  reviewer?: ProviderHealthResult;
  effectivePolicy?: EffectivePolicyReport;
  warnings: string[];
  message: string;
}

function providerEnvVar(provider: 'openrouter' | 'nvidia'): string {
  return provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'NVIDIA_API_KEY';
}

function checkProvider(cfg: { provider: 'openrouter' | 'nvidia'; model: string }): ProviderHealthResult {
  const envVar = providerEnvVar(cfg.provider);
  const apiKeyPresent = !!(process.env[envVar]);
  return {
    provider: cfg.provider,
    model: cfg.model,
    apiKeyPresent,
    envVar,
    status: apiKeyPresent ? 'ready' : 'missing_key'
  };
}

async function deepCheckProvider(cfg: { provider: 'openrouter' | 'nvidia'; model: string }): Promise<Pick<ProviderHealthResult, 'status' | 'deepCheckError'>> {
  const envVar = providerEnvVar(cfg.provider);
  const apiKey = process.env[envVar] ?? '';
  if (!apiKey) return { status: 'missing_key' };

  const url = cfg.provider === 'openrouter'
    ? 'https://openrouter.ai/api/v1/chat/completions'
    : 'https://integrate.api.nvidia.com/v1/chat/completions';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { status: 'call_failed', deepCheckError: `HTTP ${response.status}: ${text.slice(0, 200)}` };
    }
    return { status: 'call_ok' };
  } catch (err: any) {
    return { status: 'call_failed', deepCheckError: err?.message ?? String(err) };
  }
}

export async function checkModelJudgesHealth(input: ModelJudgesHealthInput): Promise<ModelJudgesHealthResult> {
  const warnings: string[] = [];
  let primaryResult: ProviderHealthResult | undefined;
  let reviewerResult: ProviderHealthResult | undefined;
  let effectivePolicy: EffectivePolicyReport | undefined;
  let isExplicitSkip = false;

  if (input.screen) {
    try {
      const { config } = await loadUiDiffConfig(input.configPath);
      const screen = config.screens[input.screen];
      if (!screen) {
        warnings.push(`Screen '${input.screen}' not found in config.`);
      } else {
        const mj = screen.modelJudges;
        const enabled = mj?.enabled ?? false;
        const required = mj?.required ?? enabled;
        const missingKeys: string[] = [];

        if (enabled && mj?.primary) {
          const r = checkProvider(mj.primary);
          if (!r.apiKeyPresent) missingKeys.push(r.envVar);
          if (!input.primary) primaryResult = r;
        }
        if (enabled && mj?.reviewer) {
          const r = checkProvider(mj.reviewer);
          if (!r.apiKeyPresent) missingKeys.push(r.envVar);
          if (!input.reviewer) reviewerResult = r;
        }

        const isVisualParity = (screen.visualAuditMode ?? 'visual_parity') !== 'metric_only';
        const noPrimaryConfigured = enabled && !mj?.primary;
        const disabledWithoutSkip = isVisualParity && mj !== undefined && !enabled && !mj?.explicitSkipReason;
        isExplicitSkip = mj !== undefined && !enabled && !!mj?.explicitSkipReason;
        effectivePolicy = {
          visualAuditMode: screen.visualAuditMode,
          enabled,
          required,
          policy: mj?.policy ?? (isVisualParity && enabled ? 'always_audit' : undefined),
          explicitSkipReason: mj?.explicitSkipReason,
          allowEditSuggestionsOnPass: mj?.allowEditSuggestionsOnPass ?? false,
          willFailHard:
            (enabled && required && missingKeys.length > 0) ||
            (isVisualParity && mj === undefined) ||
            (isVisualParity && noPrimaryConfigured) ||
            disabledWithoutSkip,
          missingKeys
        };
        if (disabledWithoutSkip) {
          warnings.push(
            'visual_parity mode requires model judges or an explicit skip reason. ' +
            'Judges are disabled without explicitSkipReason — RunOrchestrator will block with model_judges_unavailable.'
          );
        }
      }
    } catch (err: any) {
      warnings.push(`Could not load config: ${err?.message ?? String(err)}`);
    }
  }

  if (input.primary) {
    primaryResult = checkProvider(input.primary);
    if (!primaryResult.apiKeyPresent) {
      warnings.push(`Primary provider '${input.primary.provider}' requires ${primaryResult.envVar} env var (not set).`);
    }
  }

  if (input.reviewer) {
    reviewerResult = checkProvider(input.reviewer);
    if (!reviewerResult.apiKeyPresent) {
      warnings.push(`Reviewer provider '${input.reviewer.provider}' requires ${reviewerResult.envVar} env var (not set).`);
    }
  }

  // Deep mode: make a minimal test call to each ready provider to validate model/API compatibility
  if (input.deep) {
    const toDeepCheck: Array<{ cfg: { provider: 'openrouter' | 'nvidia'; model: string }; result: ProviderHealthResult }> = [];
    if (primaryResult?.status === 'ready' && (input.primary ?? (primaryResult ? { provider: primaryResult.provider, model: primaryResult.model } : undefined))) {
      const cfg = input.primary ?? { provider: primaryResult.provider, model: primaryResult.model };
      toDeepCheck.push({ cfg, result: primaryResult });
    }
    if (reviewerResult?.status === 'ready' && (input.reviewer ?? (reviewerResult ? { provider: reviewerResult.provider, model: reviewerResult.model } : undefined))) {
      const cfg = input.reviewer ?? { provider: reviewerResult.provider, model: reviewerResult.model };
      toDeepCheck.push({ cfg, result: reviewerResult });
    }
    for (const { cfg, result } of toDeepCheck) {
      const deepResult = await deepCheckProvider(cfg);
      result.status = deepResult.status;
      if (deepResult.deepCheckError) {
        result.deepCheckError = deepResult.deepCheckError;
        warnings.push(`Deep check failed for ${cfg.provider}/${cfg.model}: ${deepResult.deepCheckError}`);
      }
    }
  }

  const allConfigured = [primaryResult, reviewerResult].filter(Boolean) as ProviderHealthResult[];
  const allReady = allConfigured.every((r) => r.status === 'ready' || r.status === 'call_ok');
  const noneConfigured = allConfigured.length === 0;

  let status: ModelJudgesHealthResult['status'];
  let message: string;

  if (isExplicitSkip) {
    status = 'metric_only';
    message = `Model judges explicitly disabled (${effectivePolicy!.explicitSkipReason}). Run is metric-only, not full visual parity.`;
  } else if (noneConfigured) {
    status = 'unavailable';
    message = 'No providers configured. Pass primary and/or reviewer to check readiness, or pass screen and configPath to load from config.';
  } else if (allReady) {
    status = 'ok';
    message = `All ${allConfigured.length} configured provider(s) ready${input.deep ? ' (deep call verified)' : ''}.`;
  } else {
    const failedCount = allConfigured.filter((r) => r.status !== 'ready' && r.status !== 'call_ok').length;
    status = failedCount === allConfigured.length ? 'unavailable' : 'degraded';
    const reason = allConfigured.some((r) => r.status === 'call_failed') ? 'API call failed' : 'missing API keys';
    message = `${failedCount} of ${allConfigured.length} provider(s) failed (${reason}).`;
  }

  return {
    status,
    ...(primaryResult ? { primary: primaryResult } : {}),
    ...(reviewerResult ? { reviewer: reviewerResult } : {}),
    ...(effectivePolicy ? { effectivePolicy } : {}),
    warnings,
    message
  };
}
