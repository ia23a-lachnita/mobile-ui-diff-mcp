/**
 * Regression test for the Calorix silent-failure mode:
 *
 *   acceptanceStatus: rejected
 *   visualAuditStatus: error
 *   actionRequired.type: model_judges_failed
 *   primary.status: error
 *   primary.attempted: true
 *   primary.hadSuccess: false
 *   primary.evidenceCount: 0
 *   primary.errorCount: 0          ← invalid — fixed by Math.max(1, errorCount)
 *   primary.failureReason: undefined ← invalid — fixed by per-bundle empty detection
 *   primary.rawResponsePreview: undefined ← invalid
 *
 * The test exercises the real RunOrchestrator / ModelJudgeAnalyzer / report path
 * with a mocked primary provider. It must fail on the old behavior and pass after the fix.
 *
 * Two scenarios:
 *  1. Primary analyze() returns []  — empty evidence array (unknown_empty_failure)
 *  2. Primary analyze() returns an error-evidence item — parse/invalid-json failure
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PNG } from 'pngjs';

// vi.mock must appear before any import that transitively loads the module
vi.mock('../../src/pipeline/judges/providers/OpenRouterProvider');
vi.mock('../../src/pipeline/judges/providers/NvidiaProvider');

import { OpenRouterProvider } from '../../src/pipeline/judges/providers/OpenRouterProvider';
import { NvidiaProvider } from '../../src/pipeline/judges/providers/NvidiaProvider';
import { runScreenUiDiff } from '../../src/tools/runScreenUiDiff';
import { ensureJudgeErrorHasDiagnostics } from '../../src/pipeline/judges/ModelJudgeAnalyzer';

const MockedOpenRouter = vi.mocked(OpenRouterProvider);
const MockedNvidia = vi.mocked(NvidiaProvider);

// ── image helpers ─────────────────────────────────────────────────────────────

function makeGrayPng(width = 120, height = 200): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200; png.data[i + 1] = 200; png.data[i + 2] = 200; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** Slightly different image so pixel diff is non-zero */
function makeSlightlyDifferentPng(width = 120, height = 200): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 180; png.data[i + 1] = 200; png.data[i + 2] = 210; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

// ── test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;
let savedOpenRouterKey: string | undefined;
let savedNvidiaKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-judge-silent-'));
  savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
  savedNvidiaKey = process.env.NVIDIA_API_KEY;
  MockedOpenRouter.mockReset();
  MockedNvidia.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (savedOpenRouterKey !== undefined) {
    process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
  } else {
    delete process.env.OPENROUTER_API_KEY;
  }
  if (savedNvidiaKey !== undefined) {
    process.env.NVIDIA_API_KEY = savedNvidiaKey;
  } else {
    delete process.env.NVIDIA_API_KEY;
  }
});

async function writeFile(name: string, buf: Buffer | string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, buf);
  return p;
}

async function writeConfig(screenName: string, screenConfig: Record<string, unknown>): Promise<string> {
  const configPath = path.join(tmpDir, 'ui-diff.config.json');
  await fs.writeFile(configPath, JSON.stringify({ screens: { [screenName]: screenConfig } }, null, 2));
  return configPath;
}

/** Minimal Calorix-shaped config: visual_parity, required primary openrouter, reviewer nvidia */
async function buildCalorixConfig(expectedPath: string): Promise<string> {
  return writeConfig('today', {
    platform: 'none',
    expectedImage: expectedPath,
    outputDir: path.join(tmpDir, 'runs'),
    visualAuditMode: 'visual_parity',
    modelJudges: {
      enabled: true,
      required: true,
      primary: { provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' },
      reviewer: { provider: 'nvidia', model: 'nvidia/nemotron-nano-12b-v2-vl' }
    }
  });
}

// ── invariant unit tests ───────────────────────────────────────────────────────

describe('ensureJudgeErrorHasDiagnostics invariant', () => {
  it('passes through errors that already have diagnostics', () => {
    const err = {
      source: 'modelJudgeRuntime' as const,
      kind: 'provider_error' as const,
      provider: 'openrouter',
      model: 'qwen3',
      roiId: 'global',
      blocking: true,
      message: 'parse failed',
      failureReason: 'invalid_json',
      rawResponsePreview: 'Not valid JSON...'
    };
    expect(ensureJudgeErrorHasDiagnostics(err)).toEqual(err);
  });

  it('marks internal diagnostic gaps without treating missing detail as provider root cause', () => {
    const err = {
      source: 'modelJudgeRuntime' as const,
      kind: 'provider_error' as const,
      provider: 'openrouter',
      roiId: 'roi1',
      blocking: true,
      message: 'some error'
    };
    const normalized = ensureJudgeErrorHasDiagnostics(err);
    expect(normalized.failureReason).toBe('unknown_empty_failure');
    expect(normalized.rawResponsePreview).toBe('<missing_error_detail>');
    expect((normalized as any).diagnosticIntegrity).toBe('internal_missing_error_detail');
  });

  it('fills rawResponsePreview sentinel when only failureReason is provided', () => {
    const err = {
      source: 'modelJudgeRuntime' as const,
      kind: 'provider_error' as const,
      provider: 'openrouter',
      roiId: 'roi1',
      blocking: true,
      message: 'timeout',
      failureReason: 'timeout'
    };
    const normalized = ensureJudgeErrorHasDiagnostics(err);
    expect(normalized.failureReason).toBe('timeout');
    expect(normalized.rawResponsePreview).toBe('<missing_error_detail>');
    expect((normalized as any).diagnosticIntegrity).toBe('internal_missing_error_detail');
  });
});

// ── Scenario 1: Primary returns [] (empty evidence array) ────────────────────

describe('Calorix silent failure: primary analyze() returns empty array', () => {
  it('modelJudgeAnalyzer.convertsEmptyEvidenceArrayAfterAttemptIntoProviderErrorEvidence', async () => {
    // Primary returns [] — valid parse, no items, no explicit error
    MockedOpenRouter.mockImplementation(function () {
      return { analyze: vi.fn().mockResolvedValue([]) };
    } as any);
    // Reviewer (nvidia) — not setting NVIDIA_API_KEY → buildProvider returns null → unavailable
    // requireConsensusForCodeHints is not set (false), so reviewer unavailable is non-blocking

    process.env.OPENROUTER_API_KEY = 'test-key-silent-failure';
    delete process.env.NVIDIA_API_KEY;

    const expectedPath = await writeFile('expected.png', makeGrayPng());
    const configPath = await buildCalorixConfig(expectedPath);

    const report = await runScreenUiDiff({
      screen: 'today',
      configPath,
      actualImage: await writeFile('actual.png', makeSlightlyDifferentPng()),
      runName: 'run-calorix-silent'
    });

    // ── top-level report status ────────────────────────────────────────────
    expect(report.acceptanceStatus).toMatch(/rejected|incomplete/);
    expect(report.visualAuditStatus).toBe('error');
    expect(report.actionRequired).toBeDefined();
    expect(report.actionRequired!.type).toBe('model_judges_failed');
    expect(report.actionRequired!.severity).toBe('blocking');

    // ── modelJudgesSummary.primary ─────────────────────────────────────────
    const primary = report.modelJudgesSummary?.primary;
    expect(primary).toBeDefined();
    expect(primary!.attempted).toBe(true);
    expect(primary!.hadSuccess).toBe(false);
    expect(primary!.status).toBe('error');
    expect(primary!.errorCount).toBeGreaterThanOrEqual(1);
    expect(primary!.evidenceCount).toBe(0);

    // ── failedRois must carry diagnostic fields ────────────────────────────
    const failedRois = report.modelJudgesSummary?.failedRois ?? [];
    expect(failedRois.length).toBeGreaterThanOrEqual(1);

    const primaryFailed = failedRois.find((r) => r.provider === 'openrouter');
    expect(primaryFailed).toBeDefined();
    expect(primaryFailed!.failureReason).toBe('provider_returned_no_evidence');
    expect(primaryFailed!.rawResponsePreview).toBe('<provider_adapter_returned_empty_array>');
    expect((primaryFailed as any).diagnosticIntegrity).toBe('adapter_defect');

    // ── suggestedFixes must NOT contain required:false in visual_parity ────
    const fixes = report.actionRequired?.suggestedFixes ?? [];
    for (const fix of fixes) {
      expect(fix).not.toMatch(/required.*false|make.*required.*optional|disable.*required/i);
    }
  });

  it('reportContract.neverEmitsMissingErrorDetailForAttemptedJudgeFailure', async () => {
    MockedOpenRouter.mockImplementation(function () {
      return { analyze: vi.fn().mockResolvedValue([]) };
    } as any);

    process.env.OPENROUTER_API_KEY = 'test-key-contract';
    delete process.env.NVIDIA_API_KEY;

    const expectedPath = await writeFile('expected-contract.png', makeGrayPng());
    const configPath = await buildCalorixConfig(expectedPath);

    const report = await runScreenUiDiff({
      screen: 'today',
      configPath,
      actualImage: await writeFile('actual-contract.png', makeSlightlyDifferentPng()),
      runName: 'run-report-contract'
    });

    expect(report.modelJudgesSummary?.failedRois.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(report)).not.toContain('<missing_error_detail>');
    expect(JSON.stringify(report)).not.toContain('unknown_empty_failure');
  });

  it('visualParity.requiredJudgeOperationalFailureBlocksAcceptance', async () => {
    MockedOpenRouter.mockImplementation(function () {
      return { analyze: vi.fn().mockResolvedValue([]) };
    } as any);

    process.env.OPENROUTER_API_KEY = 'test-key-blocks-acceptance';
    delete process.env.NVIDIA_API_KEY;

    const expectedPath = await writeFile('expected-blocking.png', makeGrayPng());
    const configPath = await buildCalorixConfig(expectedPath);

    const report = await runScreenUiDiff({
      screen: 'today',
      configPath,
      actualImage: await writeFile('actual-blocking.png', makeSlightlyDifferentPng()),
      runName: 'run-required-blocks'
    });

    expect(report.modelJudgesSummary?.required).toBe(true);
    expect(report.visualAuditStatus).toBe('error');
    expect(report.acceptanceStatus).not.toMatch(/accepted|pass/);
    expect(report.actionRequired?.type).toBe('model_judges_failed');
    expect(report.actionRequired?.message).toMatch(/required|judge|failed|evidence/i);

    const failedRoi = report.modelJudgesSummary?.failedRois.find((r) => r.provider === 'openrouter');
    expect(failedRoi?.failureReason).toBe('provider_returned_no_evidence');
    expect(failedRoi?.rawResponsePreview).toBe('<provider_adapter_returned_empty_array>');
  });

});

// ── Scenario 2: Primary returns error evidence (invalid JSON / parse failure) ─

describe('Calorix silent failure: primary analyze() returns parse error evidence', () => {
  it('report includes failureReason and rawResponsePreview for invalid JSON response', async () => {
    // Mock simulates what callWithRetry returns after a non-empty unparseable response
    MockedOpenRouter.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([{
          source: 'modelJudge',
          claimId: 'openrouter-parse-error-global',
          subject: 'roi:global',
          claim: 'OpenRouter returned unparseable response after 2 attempt(s): Unexpected token \'I\'',
          confidence: 0,
          authority: 'model',
          measurements: {
            error: 'parse_error_after_retry',
            failureReason: 'invalid_json',
            rawResponsePreview: 'I cannot analyze this as structured JSON. The image shows a mobile UI with...'
          }
        }])
      };
    } as any);

    process.env.OPENROUTER_API_KEY = 'test-key-parse-error';
    delete process.env.NVIDIA_API_KEY;

    const expectedPath = await writeFile('expected2.png', makeGrayPng());
    const configPath = await buildCalorixConfig(expectedPath);

    const report = await runScreenUiDiff({
      screen: 'today',
      configPath,
      actualImage: await writeFile('actual2.png', makeSlightlyDifferentPng()),
      runName: 'run-calorix-parse-error'
    });

    // ── top-level report status ────────────────────────────────────────────
    expect(report.acceptanceStatus).toMatch(/rejected|incomplete/);
    expect(report.visualAuditStatus).toBe('error');
    expect(report.actionRequired).toBeDefined();
    expect(report.actionRequired!.type).toBe('model_judges_failed');
    expect(report.actionRequired!.severity).toBe('blocking');

    // ── modelJudgesSummary.primary ─────────────────────────────────────────
    const primary = report.modelJudgesSummary?.primary;
    expect(primary).toBeDefined();
    expect(primary!.attempted).toBe(true);
    expect(primary!.hadSuccess).toBe(false);
    expect(primary!.status).toBe('error');
    expect(primary!.errorCount).toBeGreaterThanOrEqual(1);

    // ── failedRois must carry parse diagnostic fields ──────────────────────
    const failedRois = report.modelJudgesSummary?.failedRois ?? [];
    expect(failedRois.length).toBeGreaterThanOrEqual(1);

    const primaryFailed = failedRois.find((r) => r.provider === 'openrouter');
    expect(primaryFailed).toBeDefined();
    expect(primaryFailed!.failureReason).toBe('invalid_json');
    expect(primaryFailed!.rawResponsePreview).toMatch(/I cannot analyze|structured JSON/);

    // ── suggestedFixes must NOT contain required:false in visual_parity ────
    const fixes = report.actionRequired?.suggestedFixes ?? [];
    for (const fix of fixes) {
      expect(fix).not.toMatch(/required.*false|make.*required.*optional|disable.*required/i);
    }
  });

  it('report includes empty_response sentinel (empty HTTP content)', async () => {
    // Mock simulates what callWithRetry returns for empty HTTP body (responseText = '')
    MockedOpenRouter.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([{
          source: 'modelJudge',
          claimId: 'openrouter-parse-error-global',
          subject: 'roi:global',
          claim: 'OpenRouter returned unparseable response after 2 attempt(s): Unexpected end of JSON input',
          confidence: 0,
          authority: 'model',
          measurements: {
            error: 'parse_error_after_retry',
            failureReason: 'empty_response',
            rawResponsePreview: '<empty_response>'
          }
        }])
      };
    } as any);

    process.env.OPENROUTER_API_KEY = 'test-key-empty-response';
    delete process.env.NVIDIA_API_KEY;

    const expectedPath = await writeFile('expected3.png', makeGrayPng());
    const configPath = await buildCalorixConfig(expectedPath);

    const report = await runScreenUiDiff({
      screen: 'today',
      configPath,
      actualImage: await writeFile('actual3.png', makeSlightlyDifferentPng()),
      runName: 'run-calorix-empty-response'
    });

    const failedRois = report.modelJudgesSummary?.failedRois ?? [];
    expect(failedRois.length).toBeGreaterThanOrEqual(1);

    const primaryFailed = failedRois.find((r) => r.provider === 'openrouter');
    expect(primaryFailed).toBeDefined();
    expect(primaryFailed!.failureReason).toBe('empty_response');
    expect(primaryFailed!.rawResponsePreview).toBe('<empty_response>');

    expect(report.actionRequired!.type).toBe('model_judges_failed');
    expect(report.actionRequired!.severity).toBe('blocking');

    const fixes = report.actionRequired?.suggestedFixes ?? [];
    for (const fix of fixes) {
      expect(fix).not.toMatch(/required.*false|make.*required.*optional|disable.*required/i);
    }
  });
});

// ── Scenario 3: Reviewer required (requireConsensusForCodeHints:true), returns [] ─

describe('Calorix silent failure: required reviewer analyze() returns empty array', () => {
  it('reviewer failedRois carries failureReason and rawResponsePreview', async () => {
    // Primary succeeds with a valid match evidence item
    MockedOpenRouter.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([{
          source: 'visualMismatchJudge',
          claimId: 'openrouter-today-visual-ok',
          subject: 'roi:today',
          claim: 'Visual appearance matches expected mockup',
          confidence: 0.85,
          authority: 'model',
          polarity: 'match',
          blocking: false
        }])
      };
    } as any);

    // Reviewer returns [] — empty evidence array (unknown_empty_failure)
    MockedNvidia.mockImplementation(function () {
      return { analyze: vi.fn().mockResolvedValue([]) };
    } as any);

    process.env.OPENROUTER_API_KEY = 'test-key-reviewer-empty';
    process.env.NVIDIA_API_KEY = 'test-key-nvidia-reviewer';

    const expectedPath = await writeFile('expected4.png', makeGrayPng());
    const configPath = await writeConfig('today', {
      platform: 'none',
      expectedImage: expectedPath,
      outputDir: path.join(tmpDir, 'runs'),
      visualAuditMode: 'visual_parity',
      modelJudges: {
        enabled: true,
        required: true,
        requireConsensusForCodeHints: true,
        primary: { provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' },
        reviewer: { provider: 'nvidia', model: 'nvidia/nemotron-nano-12b-v2-vl' }
      }
    });

    const report = await runScreenUiDiff({
      screen: 'today',
      configPath,
      actualImage: await writeFile('actual4.png', makeSlightlyDifferentPng()),
      runName: 'run-reviewer-empty'
    });

    // Reviewer failure blocks when requireConsensusForCodeHints:true
    expect(report.actionRequired).toBeDefined();
    expect(report.actionRequired!.type).toBe('model_judges_failed');
    expect(report.actionRequired!.severity).toBe('blocking');

    // ── reviewer summary ───────────────────────────────────────────────────
    const reviewer = report.modelJudgesSummary?.reviewer;
    expect(reviewer).toBeDefined();
    expect(reviewer!.attempted).toBe(true);
    expect(reviewer!.hadSuccess).toBe(false);
    expect(reviewer!.status).toBe('error');
    expect(reviewer!.errorCount).toBeGreaterThanOrEqual(1);

    // ── failedRois must carry reviewer diagnostic fields ───────────────────
    const failedRois = report.modelJudgesSummary?.failedRois ?? [];
    const reviewerFailed = failedRois.find((r) => r.provider === 'nvidia');
    expect(reviewerFailed).toBeDefined();
    expect(reviewerFailed!.failureReason).toBe('provider_returned_no_evidence');
    expect(reviewerFailed!.rawResponsePreview).toBe('<provider_adapter_returned_empty_array>');
    expect((reviewerFailed as any).diagnosticIntegrity).toBe('adapter_defect');
  });

  it('reviewer returns malformed error evidence — failureReason and rawResponsePreview still present', async () => {
    // Primary succeeds
    MockedOpenRouter.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([{
          source: 'visualMismatchJudge',
          claimId: 'openrouter-today-visual-ok-2',
          subject: 'roi:today',
          claim: 'UI layout matches mockup',
          confidence: 0.9,
          authority: 'model',
          polarity: 'match',
          blocking: false
        }])
      };
    } as any);

    // Reviewer returns error evidence without failureReason/rawResponsePreview
    // — ensureJudgeErrorHasDiagnostics must fill the sentinels
    MockedNvidia.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([{
          source: 'modelJudge',
          claimId: 'nvidia-error-today',
          subject: 'roi:today',
          claim: 'Reviewer analysis failed',
          confidence: 0,
          authority: 'model',
          measurements: { error: 'provider_timeout' }
          // intentionally no failureReason or rawResponsePreview
        }])
      };
    } as any);

    process.env.OPENROUTER_API_KEY = 'test-key-reviewer-malformed';
    process.env.NVIDIA_API_KEY = 'test-key-nvidia-malformed';

    const expectedPath = await writeFile('expected5.png', makeGrayPng());
    const configPath = await writeConfig('today', {
      platform: 'none',
      expectedImage: expectedPath,
      outputDir: path.join(tmpDir, 'runs'),
      visualAuditMode: 'visual_parity',
      modelJudges: {
        enabled: true,
        required: true,
        requireConsensusForCodeHints: true,
        primary: { provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' },
        reviewer: { provider: 'nvidia', model: 'nvidia/nemotron-nano-12b-v2-vl' }
      }
    });

    const report = await runScreenUiDiff({
      screen: 'today',
      configPath,
      actualImage: await writeFile('actual5.png', makeSlightlyDifferentPng()),
      runName: 'run-reviewer-malformed'
    });

    const failedRois = report.modelJudgesSummary?.failedRois ?? [];
    const reviewerFailed = failedRois.find((r) => r.provider === 'nvidia');
    expect(reviewerFailed).toBeDefined();
    // ensureJudgeErrorHasDiagnostics must have filled in sentinels
    expect(reviewerFailed!.failureReason).toBe('unknown_empty_failure');
    expect(reviewerFailed!.rawResponsePreview).toBe('<missing_error_detail>');
  });
});
