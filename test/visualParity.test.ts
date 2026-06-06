import { describe, it, expect, vi } from 'vitest';
import { PNG } from 'pngjs';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getToolList } from '../src/mcp/server';
import { checkModelJudgesHealth } from '../src/tools/modelJudgesHealth';
import { ModelJudgeAnalyzer } from '../src/pipeline/judges/ModelJudgeAnalyzer';
import { OverlapLegibilityAnalyzer } from '../src/pipeline/analyzers/OverlapLegibilityAnalyzer';
import { EvidenceGraph } from '../src/pipeline/EvidenceGraph';
import { AnalyzerContext } from '../src/pipeline/analyzers/IAnalyzer';

function makeContext(overrides: Partial<AnalyzerContext> = {}): AnalyzerContext {
  const png = new PNG({ width: 10, height: 10 });
  // Fill with white pixels
  png.data.fill(255);
  return {
    runId: 'test-run',
    outputDir: os.tmpdir(),
    configDir: os.tmpdir(),
    roiDir: os.tmpdir(),
    regionsDir: os.tmpdir(),
    expectedImagePath: '/fake/expected.png',
    actualImagePath: '/fake/actual.png',
    expectedPng: png,
    actualPng: png,
    comparisonPng: png,
    actualSourceWidth: 10,
    actualSourceHeight: 10,
    regionsOfInterest: [],
    ignoreRegions: [],
    config: {
      expectedImage: '/fake/expected.png',
      actualImage: '/fake/actual.png',
      outputDir: os.tmpdir()
    },
    ...overrides
  };
}

describe('model_judges_health MCP tool', () => {
  it('is registered in the MCP tool list', () => {
    const tools = getToolList();
    const health = tools.find((t) => t.name === 'model_judges_health');
    expect(health).toBeDefined();
    expect(health?.description).toBeTruthy();
    expect(health?.inputSchema).toBeDefined();
  });

  it('returns unavailable when no providers configured', async () => {
    const result = await checkModelJudgesHealth({});
    expect(result.status).toBe('unavailable');
    expect(result.warnings).toBeInstanceOf(Array);
  });

  it('returns missing_key status when OPENROUTER_API_KEY absent', async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const result = await checkModelJudgesHealth({
        primary: { provider: 'openrouter', model: 'test-model' }
      });
      expect(result.status).toBe('unavailable');
      expect(result.primary?.status).toBe('missing_key');
      expect(result.primary?.apiKeyPresent).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
    } finally {
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
    }
  });

  it('returns ok when API key is present', async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test-key';
    try {
      const result = await checkModelJudgesHealth({
        primary: { provider: 'openrouter', model: 'test-model' }
      });
      expect(result.status).toBe('ok');
      expect(result.primary?.status).toBe('ready');
      expect(result.primary?.apiKeyPresent).toBe(true);
    } finally {
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('returns degraded when primary ready but reviewer missing key', async () => {
    const savedOR = process.env.OPENROUTER_API_KEY;
    const savedNV = process.env.NVIDIA_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test-key';
    delete process.env.NVIDIA_API_KEY;
    try {
      const result = await checkModelJudgesHealth({
        primary: { provider: 'openrouter', model: 'test-model' },
        reviewer: { provider: 'nvidia', model: 'nvidia-model' }
      });
      expect(result.status).toBe('degraded');
      expect(result.primary?.status).toBe('ready');
      expect(result.reviewer?.status).toBe('missing_key');
    } finally {
      if (savedOR !== undefined) process.env.OPENROUTER_API_KEY = savedOR;
      else delete process.env.OPENROUTER_API_KEY;
      if (savedNV !== undefined) process.env.NVIDIA_API_KEY = savedNV;
    }
  });

  it('loads screen config from file and reports willFailHard when provider key is missing', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mj-health-'));
    const configPath = path.join(configDir, 'ui-diff.config.json');
    await fs.writeFile(configPath, JSON.stringify({
      screens: {
        today: {
          platform: 'none',
          expectedImage: '/fake/today.png',
          outputDir: os.tmpdir(),
          modelJudges: {
            enabled: true,
            primary: { provider: 'openrouter', model: 'test-model' }
          }
        }
      }
    }));
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const result = await checkModelJudgesHealth({ screen: 'today', configPath });
      expect(result.effectivePolicy).toBeDefined();
      expect(result.effectivePolicy!.enabled).toBe(true);
      expect(result.effectivePolicy!.willFailHard).toBe(true);
      expect(result.effectivePolicy!.missingKeys.length).toBeGreaterThan(0);
    } finally {
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('visual parity enforcement — visualAuditStatus ordering', () => {
  it('model_judges_unavailable actionRequired type is defined in ActionRequired union', () => {
    // Type-level check: ensure the type compiles and is accessible
    const ar: import('../src/types').ActionRequired = {
      type: 'model_judges_unavailable',
      severity: 'blocking',
      message: 'test',
      recommendedUserPrompt: 'test',
      suggestedFixes: []
    };
    expect(ar.type).toBe('model_judges_unavailable');
  });

  it('model_judges_failed actionRequired type is valid', () => {
    const ar: import('../src/types').ActionRequired = {
      type: 'model_judges_failed',
      severity: 'blocking',
      message: 'test',
      recommendedUserPrompt: 'test',
      suggestedFixes: []
    };
    expect(ar.type).toBe('model_judges_failed');
  });

  it('VisualAuditStatus covers all expected values including pass_with_caveats', () => {
    const values: import('../src/types').VisualAuditStatus[] = [
      'pass', 'pass_with_caveats', 'fail', 'not_run', 'skipped_by_config', 'unavailable', 'error'
    ];
    expect(values).toHaveLength(7);
  });

  it('AcceptanceStatus covers all expected values', () => {
    const values: import('../src/types').AcceptanceStatus[] = [
      'accepted', 'rejected', 'incomplete', 'metric_only'
    ];
    expect(values).toHaveLength(4);
  });
});

describe('OverlapLegibilityAnalyzer', () => {
  it('returns empty visualCaveats when overlapLegibility not configured', async () => {
    const ctx = makeContext();
    const graph = new EvidenceGraph();
    const analyzer = new OverlapLegibilityAnalyzer();
    const result = await analyzer.run(ctx, graph);
    expect(result.visualCaveats).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('returns empty visualCaveats when enabled:false', async () => {
    const ctx = makeContext({
      config: {
        expectedImage: '/fake/expected.png',
        actualImage: '/fake/actual.png',
        outputDir: os.tmpdir(),
        overlapLegibility: { enabled: false, regions: [] }
      }
    });
    const result = await new OverlapLegibilityAnalyzer().run(ctx, new EvidenceGraph());
    expect(result.visualCaveats).toEqual([]);
  });

  it('emits no caveat when no avoidColors configured for a region', async () => {
    const ctx = makeContext({
      config: {
        expectedImage: '/fake/expected.png',
        actualImage: '/fake/actual.png',
        outputDir: os.tmpdir(),
        overlapLegibility: {
          enabled: true,
          regions: [{ id: 'pill', box: { x: 0, y: 0, width: 5, height: 5 } }]
        }
      }
    });
    const result = await new OverlapLegibilityAnalyzer().run(ctx, new EvidenceGraph());
    expect(result.visualCaveats).toEqual([]);
  });

  it('emits a blocking VisualCaveat when avoid-color pixels exceed threshold', async () => {
    // Build a 10x10 image with the top-left 5x5 filled with green (#00FF00)
    const png = new PNG({ width: 10, height: 10 });
    png.data.fill(0);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const idx = (y * 10 + x) << 2;
        png.data[idx] = 0;     // R
        png.data[idx + 1] = 255; // G
        png.data[idx + 2] = 0;   // B
        png.data[idx + 3] = 255; // A
      }
    }

    const ctx = makeContext({
      actualPng: png,
      config: {
        expectedImage: '/fake/expected.png',
        actualImage: '/fake/actual.png',
        outputDir: os.tmpdir(),
        overlapLegibility: {
          enabled: true,
          regions: [{
            id: 'pill',
            label: '980 kcal pill',
            box: { x: 0, y: 0, width: 5, height: 5 },
            avoidColors: ['#00FF00'],
            maxOverlapPercent: 5,
            severity: 'high'
          }]
        }
      }
    });

    const result = await new OverlapLegibilityAnalyzer().run(ctx, new EvidenceGraph());
    expect(result.visualCaveats).toHaveLength(1);
    expect(result.visualCaveats![0].id).toBe('overlap-legibility-pill');
    expect(result.visualCaveats![0].blocking).toBe(true);
    expect(result.visualCaveats![0].severity).toBe('high');
    expect(result.visualCaveats![0].measurements?.overlapPercent).toBeGreaterThan(0.05);
  });

  it('does not emit caveat when overlap is within threshold', async () => {
    // All-white image — no green pixels
    const png = new PNG({ width: 10, height: 10 });
    png.data.fill(255);

    const ctx = makeContext({
      actualPng: png,
      config: {
        expectedImage: '/fake/expected.png',
        actualImage: '/fake/actual.png',
        outputDir: os.tmpdir(),
        overlapLegibility: {
          enabled: true,
          regions: [{
            id: 'pill',
            box: { x: 0, y: 0, width: 10, height: 10 },
            avoidColors: ['#00FF00'],
            maxOverlapPercent: 5
          }]
        }
      }
    });

    const result = await new OverlapLegibilityAnalyzer().run(ctx, new EvidenceGraph());
    expect(result.visualCaveats).toHaveLength(0);
  });
});

describe('ModelJudgeAnalyzer — visual_parity loophole coverage', () => {
  it('hard-fails when enabled:true but no primary provider configured', async () => {
    const ctx = makeContext();
    const graph = new EvidenceGraph();
    const analyzer = new ModelJudgeAnalyzer({ enabled: true }, 'visual_parity');
    const result = await analyzer.run(ctx, graph, []);
    expect(result.actionRequired).toBeDefined();
    expect(result.actionRequired!.type).toBe('model_judges_unavailable');
    expect(result.actionRequired!.severity).toBe('blocking');
  });

  it('does not hard-fail for enabled:true/no-primary in metric_only mode', async () => {
    const ctx = makeContext();
    const graph = new EvidenceGraph();
    const analyzer = new ModelJudgeAnalyzer({ enabled: true }, 'metric_only');
    const result = await analyzer.run(ctx, graph, []);
    expect(result.actionRequired).toBeUndefined();
  });

  it('defaults policy to always_audit in visual_parity mode — missing API key triggers blocking fail', async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const ctx = makeContext();
      const graph = new EvidenceGraph();
      // policy intentionally omitted — should default to always_audit in visual_parity mode
      const analyzer = new ModelJudgeAnalyzer(
        { enabled: true, primary: { provider: 'openrouter', model: 'test-model' } },
        'visual_parity'
      );
      const result = await analyzer.run(ctx, graph, []);
      expect(result.actionRequired).toBeDefined();
      expect(result.actionRequired!.type).toBe('model_judges_unavailable');
      expect(result.actionRequired!.severity).toBe('blocking');
    } finally {
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('skips silently when policy omitted in metric_only mode (disabled default)', async () => {
    const ctx = makeContext();
    const graph = new EvidenceGraph();
    const analyzer = new ModelJudgeAnalyzer(
      { enabled: true, primary: { provider: 'openrouter', model: 'test-model' } },
      'metric_only'
    );
    const result = await analyzer.run(ctx, graph, []);
    expect(result.actionRequired).toBeUndefined();
    expect(result.evidence).toEqual([]);
  });
});

describe('model_judges_health — disabledWithoutSkip detection', () => {
  it('willFailHard when visual_parity + modelJudges present but enabled omitted (defaults false) + no explicitSkipReason', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mj-health-disabled-'));
    const configPath = path.join(configDir, 'ui-diff.config.json');
    await fs.writeFile(configPath, JSON.stringify({
      screens: {
        today: {
          platform: 'none',
          expectedImage: '/fake/today.png',
          outputDir: os.tmpdir(),
          modelJudges: {
            primary: { provider: 'openrouter', model: 'test-model' }
            // enabled omitted — defaults to false
          }
        }
      }
    }));
    try {
      const result = await checkModelJudgesHealth({ screen: 'today', configPath });
      expect(result.effectivePolicy).toBeDefined();
      expect(result.effectivePolicy!.willFailHard).toBe(true);
      expect(result.warnings.some((w) => w.includes('explicitSkipReason'))).toBe(true);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('willFailHard when visual_parity + enabled:false + no explicitSkipReason', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mj-health-disabled2-'));
    const configPath = path.join(configDir, 'ui-diff.config.json');
    await fs.writeFile(configPath, JSON.stringify({
      screens: {
        today: {
          platform: 'none',
          expectedImage: '/fake/today.png',
          outputDir: os.tmpdir(),
          modelJudges: { enabled: false }
        }
      }
    }));
    try {
      const result = await checkModelJudgesHealth({ screen: 'today', configPath });
      expect(result.effectivePolicy).toBeDefined();
      expect(result.effectivePolicy!.enabled).toBe(false);
      expect(result.effectivePolicy!.willFailHard).toBe(true);
      expect(result.warnings.some((w) => w.includes('explicitSkipReason'))).toBe(true);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('willFailHard false when visual_parity + enabled:false + explicitSkipReason set', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mj-health-skip-'));
    const configPath = path.join(configDir, 'ui-diff.config.json');
    await fs.writeFile(configPath, JSON.stringify({
      screens: {
        today: {
          platform: 'none',
          expectedImage: '/fake/today.png',
          outputDir: os.tmpdir(),
          modelJudges: { enabled: false, explicitSkipReason: 'CI run — no API keys' }
        }
      }
    }));
    try {
      const result = await checkModelJudgesHealth({ screen: 'today', configPath });
      expect(result.effectivePolicy).toBeDefined();
      expect(result.effectivePolicy!.enabled).toBe(false);
      expect(result.effectivePolicy!.willFailHard).toBe(false);
      expect(result.effectivePolicy!.explicitSkipReason).toBe('CI run — no API keys');
      expect(result.status).toBe('metric_only');
      expect(result.message).toMatch(/metric-only/i);
      expect(result.message).toMatch(/not full visual parity/i);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('model_judges_health — willFailHard for enabled:true/no-primary', () => {
  it('willFailHard is true when enabled:true but no primary provider in visual_parity screen', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mj-health-noprimary-'));
    const configPath = path.join(configDir, 'ui-diff.config.json');
    await fs.writeFile(configPath, JSON.stringify({
      screens: {
        today: {
          platform: 'none',
          expectedImage: '/fake/expected.png',
          outputDir: os.tmpdir(),
          modelJudges: { enabled: true }
          // no primary — the loophole
        }
      }
    }));
    try {
      const result = await checkModelJudgesHealth({ screen: 'today', configPath });
      expect(result.effectivePolicy).toBeDefined();
      expect(result.effectivePolicy!.enabled).toBe(true);
      expect(result.effectivePolicy!.willFailHard).toBe(true);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('effectivePolicy.policy defaults to always_audit when enabled:true and policy omitted in visual_parity', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mj-health-policy-'));
    const configPath = path.join(configDir, 'ui-diff.config.json');
    const savedKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test-key';
    await fs.writeFile(configPath, JSON.stringify({
      screens: {
        today: {
          platform: 'none',
          expectedImage: '/fake/expected.png',
          outputDir: os.tmpdir(),
          modelJudges: { enabled: true, primary: { provider: 'openrouter', model: 'test-model' } }
          // policy omitted — should report always_audit
        }
      }
    }));
    try {
      const result = await checkModelJudgesHealth({ screen: 'today', configPath });
      expect(result.effectivePolicy).toBeDefined();
      expect(result.effectivePolicy!.policy).toBe('always_audit');
    } finally {
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
      else delete process.env.OPENROUTER_API_KEY;
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});

// ---- helper: minimal EvidenceBundle for testing ----
function makeBundle(roiId: string): import('../src/pipeline/types').EvidenceBundle {
  return {
    roiId,
    artifacts: {},
    deterministicFindings: [],
    deterministicEvidence: [],
    ocrFindings: [],
    ocrEvidence: [],
    referenceFacts: [],
    referenceEvidence: []
  };
}

describe('ModelJudgeAnalyzer — provider errors are separated from visual evidence', () => {
  it('provider HTTP error returns JudgeProviderError, not added to EvidenceGraph', async () => {
    const savedKey = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('Network failure'));
    const originalFetch = global.fetch;
    (global as any).fetch = fetchMock;
    try {
      const ctx = makeContext();
      const graph = new EvidenceGraph();
      const analyzer = new ModelJudgeAnalyzer(
        { enabled: true, primary: { provider: 'nvidia', model: 'test-model' }, required: true },
        'visual_parity'
      );
      const result = await analyzer.run(ctx, graph, [makeBundle('macro-ring-hero')]);

      // Provider error must be in judgeProviderErrors, NOT in evidence or graph
      expect(result.judgeProviderErrors).toBeDefined();
      expect(result.judgeProviderErrors!.length).toBeGreaterThan(0);
      expect(result.judgeProviderErrors![0].source).toBe('modelJudgeRuntime');
      expect(result.judgeProviderErrors![0].kind).toBe('provider_error');
      expect(result.judgeProviderErrors![0].provider).toBe('nvidia');
      expect(result.judgeProviderErrors![0].roiId).toBe('macro-ring-hero');

      // No error items in evidence array or graph
      expect(result.evidence.filter(e => String(e.measurements?.error ?? '').length > 0)).toHaveLength(0);
      expect(graph.getAll().filter(e => e.claimId.includes('error'))).toHaveLength(0);

      // Required judge with all errors → actionRequired = model_judges_failed
      expect(result.actionRequired).toBeDefined();
      expect(result.actionRequired!.type).toBe('model_judges_failed');
      expect(result.judgeHadSuccessfulResults).toBe(false);
    } finally {
      (global as any).fetch = originalFetch;
      if (savedKey !== undefined) process.env.NVIDIA_API_KEY = savedKey;
      else delete process.env.NVIDIA_API_KEY;
    }
  });

  it('nvidia-error claimId pattern is not added to graph', async () => {
    const savedKey = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = 'test-key';
    const originalFetch = global.fetch;
    // Simulate non-ok HTTP response — NvidiaProvider throws and returns nvidia-error-* Evidence
    (global as any).fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable'
    });
    try {
      const ctx = makeContext();
      const graph = new EvidenceGraph();
      const analyzer = new ModelJudgeAnalyzer(
        { enabled: true, primary: { provider: 'nvidia', model: 'test-model' }, required: true },
        'visual_parity'
      );
      const result = await analyzer.run(ctx, graph, [makeBundle('macro-rows')]);

      // nvidia-error-macro-rows must not be in graph
      const errorInGraph = graph.getAll().find(e => e.claimId.includes('nvidia-error'));
      expect(errorInGraph).toBeUndefined();

      expect(result.judgeProviderErrors!.length).toBeGreaterThan(0);
      expect(result.actionRequired!.type).toBe('model_judges_failed');
    } finally {
      (global as any).fetch = originalFetch;
      if (savedKey !== undefined) process.env.NVIDIA_API_KEY = savedKey;
      else delete process.env.NVIDIA_API_KEY;
    }
  });

  it('optional provider errors do not set actionRequired', async () => {
    const savedKey = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = 'test-key';
    const originalFetch = global.fetch;
    (global as any).fetch = vi.fn().mockRejectedValueOnce(new Error('timeout'));
    try {
      const ctx = makeContext();
      const graph = new EvidenceGraph();
      const analyzer = new ModelJudgeAnalyzer(
        { enabled: true, primary: { provider: 'nvidia', model: 'test-model' }, required: false },
        'visual_parity'
      );
      const result = await analyzer.run(ctx, graph, [makeBundle('meal-cards')]);

      expect(result.judgeProviderErrors).toBeDefined();
      expect(result.judgeProviderErrors!.length).toBeGreaterThan(0);
      // optional — no actionRequired
      expect(result.actionRequired).toBeUndefined();
      expect(result.judgeHadSuccessfulResults).toBe(false);
    } finally {
      (global as any).fetch = originalFetch;
      if (savedKey !== undefined) process.env.NVIDIA_API_KEY = savedKey;
      else delete process.env.NVIDIA_API_KEY;
    }
  });

  it('judgeHadSuccessfulResults is reported in AnalyzerResult', async () => {
    // Verifies the field exists at the type level
    const ctx = makeContext();
    const graph = new EvidenceGraph();
    const analyzer = new ModelJudgeAnalyzer({ enabled: true }, 'visual_parity');
    const result = await analyzer.run(ctx, graph, []);
    // No primary configured → actionRequired, judgeHadSuccessfulResults still present
    expect('judgeHadSuccessfulResults' in result).toBe(true);
  });
});

describe('VisualAuditStatus pass_with_caveats semantics', () => {
  it('pass_with_caveats is a valid VisualAuditStatus', () => {
    const status: import('../src/types').VisualAuditStatus = 'pass_with_caveats';
    expect(status).toBe('pass_with_caveats');
  });

  it('JudgeProviderError interface has correct shape', () => {
    const err: import('../src/pipeline/types').JudgeProviderError = {
      source: 'modelJudgeRuntime',
      kind: 'provider_error',
      provider: 'nvidia',
      model: 'google/gemma-3-27b-it',
      roiId: 'macro-ring-hero',
      blocking: true,
      message: 'NVIDIA API error 503: Service Unavailable'
    };
    expect(err.source).toBe('modelJudgeRuntime');
    expect(err.kind).toBe('provider_error');
    expect(err.blocking).toBe(true);
  });
});

describe('OverlapLegibilityAnalyzer — caveat survives ROI pass', () => {
  it('emits visualCaveat for configured kcal-left-pill region even when ROI passes', async () => {
    // Build a 20x20 image with green arc pixels in the pill region
    const png = new PNG({ width: 20, height: 20 });
    png.data.fill(200); // light gray background
    // Paint green pixels in top-left 8x8 (simulating arc intersecting pill)
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const idx = (y * 20 + x) << 2;
        png.data[idx] = 0;
        png.data[idx + 1] = 200;
        png.data[idx + 2] = 0;
        png.data[idx + 3] = 255;
      }
    }

    const ctx = makeContext({
      actualPng: png,
      actualSourceWidth: 20,
      actualSourceHeight: 20,
      config: {
        expectedImage: '/fake/expected.png',
        actualImage: '/fake/actual.png',
        outputDir: os.tmpdir(),
        overlapLegibility: {
          enabled: true,
          regions: [{
            id: 'kcal-left-pill',
            label: '980 kcal left pill',
            box: { x: 0, y: 0, width: 8, height: 8 },
            avoidColors: ['#00C800'],
            maxOverlapPercent: 5,
            severity: 'warning'
          }]
        }
      }
    });

    // ROI passes deterministically (add no failing ROI evidence to graph)
    const graph = new EvidenceGraph();
    graph.add({
      source: 'roiQuality',
      claimId: 'det-macro-ring-pass',
      subject: 'roi:macro-ring-hero',
      claim: 'ROI passes diff threshold',
      confidence: 1.0,
      authority: 'deterministic',
      measurements: { status: 'pass', diffPercent: 0.001 }
    });

    const analyzer = new OverlapLegibilityAnalyzer();
    const result = await analyzer.run(ctx, graph);

    // Overlap caveat must still be emitted despite ROI pass
    expect(result.visualCaveats).toBeDefined();
    expect(result.visualCaveats!.some(c => c.id === 'overlap-legibility-kcal-left-pill')).toBe(true);
    const caveat = result.visualCaveats!.find(c => c.id === 'overlap-legibility-kcal-left-pill')!;
    expect(caveat.severity).toBe('warning');
    // canEditApp would be false on pass (Rule 6 — tested via VerdictEngine, not here)
  });
});

describe('model_judges_health — deep mode interface', () => {
  it('deep check returns call_failed status when API call fails', async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test-key';
    const originalFetch = global.fetch;
    (global as any).fetch = vi.fn().mockRejectedValueOnce(new Error('connection refused'));
    try {
      const result = await checkModelJudgesHealth({
        primary: { provider: 'openrouter', model: 'google/gemini-2.5-flash' },
        deep: true
      });
      expect(result.primary).toBeDefined();
      expect(result.primary!.status).toBe('call_failed');
      expect(result.primary!.deepCheckError).toBeDefined();
      expect(result.warnings.some(w => w.includes('Deep check failed'))).toBe(true);
      expect(result.status).not.toBe('ok');
    } finally {
      (global as any).fetch = originalFetch;
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('deep check returns call_ok status when API responds successfully', async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test-key';
    const originalFetch = global.fetch;
    const validEvidence = JSON.stringify({ evidence: [{ claimId: 'health', subject: 'system', polarity: 'match', claim: 'provider healthy', confidence: 1.0, severity: 'info', blocking: false }] });
    (global as any).fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: validEvidence } }] })
    });
    try {
      const result = await checkModelJudgesHealth({
        primary: { provider: 'openrouter', model: 'google/gemini-2.5-flash' },
        deep: true
      });
      expect(result.primary!.status).toBe('call_ok');
      expect(result.primary!.schemaCheckStatus).toBe('ok');
      expect(result.primary!.structuredOutputSupported).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.message).toMatch(/deep call verified/i);
    } finally {
      (global as any).fetch = originalFetch;
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });
});
