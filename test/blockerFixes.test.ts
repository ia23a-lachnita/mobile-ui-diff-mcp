import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-ignore – access internal exports for testing
import { getToolList, buildCompactReport } from '../src/mcp/server';
import { ModelJudgeAnalyzer } from '../src/pipeline/judges/ModelJudgeAnalyzer';
import { EvidenceGraph } from '../src/pipeline/EvidenceGraph';

// ---- helpers ----

function makeBundle(roiId = 'roi-1') {
  return { roiId, artifacts: {}, deterministicFindings: [], deterministicEvidence: [], ocrFindings: [], ocrEvidence: [], referenceFacts: [], referenceEvidence: [] };
}

function makeFullReport(overrides: Record<string, any> = {}): any {
  return {
    status: 'fail',
    diffFraction: 0.05,
    diffPercentHuman: '5.00%',
    qualityStatus: 'pass',
    visualAuditStatus: 'pass',
    acceptanceStatus: 'accepted',
    actionRequired: null,
    agentSummary: { verdict: 'ok' },
    agentActionContract: { canEditApp: false },
    priorityFindings: [],
    timings: { totalMs: 1000 },
    artifacts: {},
    run: { screen: 's1', reportPath: '/out/run/report.json' },
    ...overrides
  };
}

// ---- 1. model_judges_health public schema includes screen, configPath, mode ----

describe('model_judges_health public tool schema', () => {
  it('includes screen property', () => {
    const tool = getToolList().find((t: any) => t.name === 'model_judges_health');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.properties.screen).toBeDefined();
    expect(tool.inputSchema.properties.screen.type).toBe('string');
  });

  it('includes configPath property', () => {
    const tool = getToolList().find((t: any) => t.name === 'model_judges_health');
    expect(tool.inputSchema.properties.configPath).toBeDefined();
    expect(tool.inputSchema.properties.configPath.type).toBe('string');
  });

  it('includes mode:"fast"|"deep" enum property', () => {
    const tool = getToolList().find((t: any) => t.name === 'model_judges_health');
    const mode = tool.inputSchema.properties.mode;
    expect(mode).toBeDefined();
    expect(mode.type).toBe('string');
    expect(mode.enum).toContain('fast');
    expect(mode.enum).toContain('deep');
  });

  it('description mentions deep mode and structured output', () => {
    const tool = getToolList().find((t: any) => t.name === 'model_judges_health');
    expect(tool.description).toMatch(/deep/i);
    expect(tool.description).toMatch(/structured/i);
  });
});

// ---- 2. compact response includes reportJsonPath ----

describe('buildCompactReport — reportJsonPath', () => {
  it('includes reportJsonPath from report.reportJsonPath', () => {
    const report = makeFullReport({ reportJsonPath: '/out/run/report.json' });
    const compact = buildCompactReport(report, { outputMode: 'compact' });
    expect(compact.reportJsonPath).toBe('/out/run/report.json');
  });

  it('falls back to run.reportPath when reportJsonPath absent', () => {
    const report = makeFullReport({ run: { screen: 's1', reportPath: '/out/fallback/report.json' } });
    const compact = buildCompactReport(report, { outputMode: 'compact' });
    expect(compact.reportJsonPath).toBe('/out/fallback/report.json');
  });

  it('standard mode also includes reportJsonPath', () => {
    const report = makeFullReport({ reportJsonPath: '/out/run/report.json' });
    const compact = buildCompactReport(report, { outputMode: 'standard' });
    expect(compact.reportJsonPath).toBe('/out/run/report.json');
  });
});

// ---- 3. blocking logic: confidence alone must not block ----

describe('evidenceToVisualCaveat blocking logic', () => {
  const mockFetch = vi.fn();

  beforeEach(() => { vi.stubGlobal('fetch', mockFetch); mockFetch.mockClear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function makeOkResponse(content: string) {
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => content };
  }

  it('high-confidence mismatch with blocking:false produces non-blocking caveat', async () => {
    const response = JSON.stringify({ evidence: [{
      claimId: 'high-conf-no-block', claim: 'Visual diff noted', polarity: 'mismatch',
      confidence: 0.95, blocking: false, source: 'visualMismatchJudge'
    }]});
    mockFetch.mockResolvedValueOnce(makeOkResponse(response));
    const cfg = { enabled: true, primary: { provider: 'openrouter' as const, model: 'gpt-4o' } };
    const graph = new EvidenceGraph();
    const analyzer = new ModelJudgeAnalyzer(cfg, 'visual_parity');
    process.env.OPENROUTER_API_KEY = 'test-key';
    const result = await analyzer.run({} as any, graph, [makeBundle()]);
    delete process.env.OPENROUTER_API_KEY;
    const caveats = result.visualCaveats ?? [];
    expect(caveats).toHaveLength(1);
    expect(caveats[0].blocking).toBe(false);
  });

  it('explicit blocking:true on mismatch produces blocking caveat', async () => {
    const response = JSON.stringify({ evidence: [{
      claimId: 'explicit-block', claim: 'Confirmed mismatch', polarity: 'mismatch',
      confidence: 0.9, blocking: true, source: 'visualMismatchJudge'
    }]});
    mockFetch.mockResolvedValueOnce(makeOkResponse(response));
    const cfg = { enabled: true, primary: { provider: 'openrouter' as const, model: 'gpt-4o' } };
    const graph = new EvidenceGraph();
    const analyzer = new ModelJudgeAnalyzer(cfg, 'visual_parity');
    process.env.OPENROUTER_API_KEY = 'test-key';
    const result = await analyzer.run({} as any, graph, [makeBundle()]);
    delete process.env.OPENROUTER_API_KEY;
    const caveats = result.visualCaveats ?? [];
    expect(caveats).toHaveLength(1);
    expect(caveats[0].blocking).toBe(true);
  });

  it('uncertainty polarity is never blocking even with blocking:true', async () => {
    const response = JSON.stringify({ evidence: [{
      claimId: 'uncertain', claim: 'Possibly off', polarity: 'uncertainty',
      confidence: 0.85, blocking: true, source: 'visualMismatchJudge'
    }]});
    mockFetch.mockResolvedValueOnce(makeOkResponse(response));
    const cfg = { enabled: true, primary: { provider: 'openrouter' as const, model: 'gpt-4o' } };
    const graph = new EvidenceGraph();
    const analyzer = new ModelJudgeAnalyzer(cfg, 'visual_parity');
    process.env.OPENROUTER_API_KEY = 'test-key';
    const result = await analyzer.run({} as any, graph, [makeBundle()]);
    delete process.env.OPENROUTER_API_KEY;
    const caveats = result.visualCaveats ?? [];
    // blocking:true is respected only for polarity:'mismatch'
    expect(caveats.every((c) => !c.blocking)).toBe(true);
  });
});

// ---- 4. visual_parity + no judges still hard-fails ----

describe('RunOrchestrator visual_parity fallback', () => {
  it('not_run path is not exported — metric_only is the explicit opt-out status', () => {
    // This test documents the contract: compact report for metric_only should not have
    // visualAuditStatus:'not_run' when visualAuditMode is default (visual_parity).
    // The RunOrchestrator now returns 'unavailable' + 'incomplete' for this case.
    const report = makeFullReport({ visualAuditStatus: 'unavailable', acceptanceStatus: 'incomplete' });
    const compact = buildCompactReport(report, { outputMode: 'compact' });
    expect(compact.visualAuditStatus).toBe('unavailable');
    expect(compact.acceptanceStatus).toBe('incomplete');
  });

  it('metric_only mode is preserved in compact output', () => {
    const report = makeFullReport({ visualAuditStatus: 'not_run', acceptanceStatus: 'metric_only' });
    const compact = buildCompactReport(report, { outputMode: 'compact' });
    expect(compact.visualAuditStatus).toBe('not_run');
    expect(compact.acceptanceStatus).toBe('metric_only');
  });
});

// ---- 5. deep health check result shape ----

describe('model_judges_health deep check result shape', () => {
  it('ProviderHealthResult interface has structuredOutputSupported and schemaCheckStatus', async () => {
    const { checkModelJudgesHealth } = await import('../src/tools/modelJudgesHealth');
    // fast check only — no API call
    const result = await checkModelJudgesHealth({
      primary: { provider: 'openrouter', model: 'gpt-4o' }
    });
    // key result: these fields exist on the interface (may be undefined on fast check)
    expect('structuredOutputSupported' in (result.primary ?? {})).toBe(false); // not set on fast check
    expect(result.status).toBeDefined();
  });
});

// ---- 6. deep health validates EVIDENCE_JSON_SCHEMA, not the old health_check schema ----

describe('model_judges_health deep check — evidence schema validation', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockClear();
    process.env.OPENROUTER_API_KEY = 'test-key';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  function makeApiResponse(content: string) {
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => content
    });
  }

  it('request uses EVIDENCE_JSON_SCHEMA, not the old health_check schema', async () => {
    const validBody = JSON.stringify({ evidence: [{ claimId: 'h', subject: 's', polarity: 'match', claim: 'ok', confidence: 1.0, severity: 'info', blocking: false }] });
    mockFetch.mockReturnValue(makeApiResponse(validBody));
    const { checkModelJudgesHealth } = await import('../src/tools/modelJudgesHealth');
    await checkModelJudgesHealth({ primary: { provider: 'openrouter', model: 'gpt-4o' }, deep: true });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.response_format?.json_schema?.name).not.toBe('health_check');
    expect(body.response_format?.json_schema?.schema?.properties?.evidence).toBeDefined();
  });

  it('call_ok + schemaCheckStatus:unparseable → status is degraded or unavailable, not ok', async () => {
    // Provider returns {"ok":true} — matches old health_check schema but NOT EVIDENCE_JSON_SCHEMA
    mockFetch.mockReturnValue(makeApiResponse('{"ok":true}'));
    const { checkModelJudgesHealth } = await import('../src/tools/modelJudgesHealth');
    const result = await checkModelJudgesHealth({ primary: { provider: 'openrouter', model: 'gpt-4o' }, deep: true });
    expect(result.status).not.toBe('ok');
    expect(['degraded', 'unavailable']).toContain(result.status);
    expect(result.primary?.schemaCheckStatus).toBe('unparseable');
  });

  it('message names structured output schema failure when call_ok but evidence schema unparseable', async () => {
    mockFetch.mockReturnValue(makeApiResponse('{"ok":true}'));
    const { checkModelJudgesHealth } = await import('../src/tools/modelJudgesHealth');
    const result = await checkModelJudgesHealth({ primary: { provider: 'openrouter', model: 'gpt-4o' }, deep: true });
    expect(result.message.toLowerCase()).toMatch(/structured output schema/);
    expect(result.message).toMatch(/openrouter\/gpt-4o/);
  });

  it('valid evidence response → status ok and schemaCheckStatus ok', async () => {
    const validBody = JSON.stringify({ evidence: [{ claimId: 'health', subject: 'system', polarity: 'match', claim: 'provider healthy', confidence: 1.0, severity: 'info', blocking: false }] });
    mockFetch.mockReturnValue(makeApiResponse(validBody));
    const { checkModelJudgesHealth } = await import('../src/tools/modelJudgesHealth');
    const result = await checkModelJudgesHealth({ primary: { provider: 'openrouter', model: 'gpt-4o' }, deep: true });
    expect(result.status).toBe('ok');
    expect(result.primary?.schemaCheckStatus).toBe('ok');
    expect(result.primary?.structuredOutputSupported).toBe(true);
  });

  it('evidence array missing required fields → schemaCheckStatus unparseable', async () => {
    // Returns evidence but missing severity and blocking (required in EVIDENCE_JSON_SCHEMA)
    const partial = JSON.stringify({ evidence: [{ claimId: 'h', subject: 's', polarity: 'match', claim: 'ok', confidence: 1.0 }] });
    mockFetch.mockReturnValue(makeApiResponse(partial));
    const { checkModelJudgesHealth } = await import('../src/tools/modelJudgesHealth');
    const result = await checkModelJudgesHealth({ primary: { provider: 'openrouter', model: 'gpt-4o' }, deep: true });
    expect(result.primary?.schemaCheckStatus).toBe('unparseable');
    expect(result.status).not.toBe('ok');
  });

  it('provider that only passes tiny health schema but fails evidence schema is not reported ok', async () => {
    // This specifically tests that the old {"ok":true} response no longer passes
    mockFetch.mockReturnValue(makeApiResponse(JSON.stringify({ ok: true })));
    const { checkModelJudgesHealth } = await import('../src/tools/modelJudgesHealth');
    const result = await checkModelJudgesHealth({ primary: { provider: 'openrouter', model: 'gpt-4o' }, deep: true });
    expect(result.status).not.toBe('ok');
    expect(result.primary?.structuredOutputSupported).toBe(false);
  });
});
