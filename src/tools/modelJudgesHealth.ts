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
  status: 'ready' | 'missing_key' | 'unknown';
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
  status: 'ok' | 'degraded' | 'unavailable';
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

export async function checkModelJudgesHealth(input: ModelJudgesHealthInput): Promise<ModelJudgesHealthResult> {
  const warnings: string[] = [];
  let primaryResult: ProviderHealthResult | undefined;
  let reviewerResult: ProviderHealthResult | undefined;
  let effectivePolicy: EffectivePolicyReport | undefined;

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

  const allConfigured = [primaryResult, reviewerResult].filter(Boolean) as ProviderHealthResult[];
  const allReady = allConfigured.every((r) => r.status === 'ready');
  const noneConfigured = allConfigured.length === 0;

  let status: ModelJudgesHealthResult['status'];
  let message: string;

  if (noneConfigured) {
    status = 'unavailable';
    message = 'No providers configured. Pass primary and/or reviewer to check readiness, or pass screen and configPath to load from config.';
  } else if (allReady) {
    status = 'ok';
    message = `All ${allConfigured.length} configured provider(s) ready.`;
  } else {
    const missingCount = allConfigured.filter((r) => r.status !== 'ready').length;
    status = missingCount === allConfigured.length ? 'unavailable' : 'degraded';
    message = `${missingCount} of ${allConfigured.length} provider(s) missing API keys.`;
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
