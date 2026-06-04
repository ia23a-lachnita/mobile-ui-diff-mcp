import { describe, it, expect } from 'vitest';
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

  it('VisualAuditStatus covers all expected values', () => {
    const values: import('../src/types').VisualAuditStatus[] = [
      'pass', 'fail', 'not_run', 'skipped_by_config', 'unavailable', 'error'
    ];
    expect(values).toHaveLength(6);
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
            maxOverlapPercent: 0.05,
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
            maxOverlapPercent: 0.05
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
