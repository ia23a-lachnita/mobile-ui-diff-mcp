/**
 * Integration tests for run-051 failure class: required judge skipped/empty + overlap per-region.
 *
 * Covers:
 *  1. Primary returns no evidence (empty response) + reviewer succeeds
 *     → visualAuditStatus:'error', actionRequired mentions "primary" not "all outputs were errors"
 *  2. Primary errors out + reviewer succeeds → correct per-provider message
 *  3. Both primary and reviewer succeed → pass
 *  4. Required judge blocked by policy → error (not silent skip)
 *  5. explicit metric_only / enabled:false → skipped_by_config / metric_only allowed
 *  6. overlapLegibility always produces per-region summary (pass, caveat, skipped cases)
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PNG } from 'pngjs';

vi.mock('../../src/pipeline/judges/providers/OpenRouterProvider');
vi.mock('../../src/pipeline/judges/providers/NvidiaProvider');

import { OpenRouterProvider } from '../../src/pipeline/judges/providers/OpenRouterProvider';
import { NvidiaProvider } from '../../src/pipeline/judges/providers/NvidiaProvider';
import { runScreenUiDiff } from '../../src/tools/runScreenUiDiff';

const MockedOpenRouter = vi.mocked(OpenRouterProvider);
const MockedNvidia = vi.mocked(NvidiaProvider);

// ── image helpers ─────────────────────────────────────────────────────────────

function makeWhitePng(width = 100, height = 100): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 240; png.data[i + 1] = 240; png.data[i + 2] = 240; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** Green patch at x:10-39, y:30-59 for overlapLegibility avoid-color detection */
function makeImageWithGreenPatch(width = 100, height = 100): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      if (x >= 10 && x < 40 && y >= 30 && y < 60) {
        png.data[idx] = 0; png.data[idx + 1] = 220; png.data[idx + 2] = 0; png.data[idx + 3] = 255;
      } else {
        png.data[idx] = 240; png.data[idx + 1] = 240; png.data[idx + 2] = 240; png.data[idx + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

// ── test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;
let savedOpenRouterKey: string | undefined;
let savedNvidiaKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-run051-'));
  savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
  savedNvidiaKey = process.env.NVIDIA_API_KEY;
  MockedOpenRouter.mockReset();
  MockedNvidia.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (savedOpenRouterKey !== undefined) process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
  else delete process.env.OPENROUTER_API_KEY;
  if (savedNvidiaKey !== undefined) process.env.NVIDIA_API_KEY = savedNvidiaKey;
  else delete process.env.NVIDIA_API_KEY;
});

async function writePng(name: string, buf: Buffer): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, buf);
  return p;
}

async function writeConfig(screenName: string, screenCfg: Record<string, unknown>): Promise<string> {
  const configPath = path.join(tmpDir, 'ui-diff.config.json');
  await fs.writeFile(configPath, JSON.stringify(
    { screens: { [screenName]: { platform: 'none', ...screenCfg } } },
    null, 2
  ));
  return configPath;
}

// ── describe: Required primary produces no evidence, reviewer succeeds ─────────

describe('run-051: primary returns empty, reviewer succeeds', () => {
  it('sets visualAuditStatus:error and message mentions primary, not "all outputs were errors"', async () => {
    process.env.OPENROUTER_API_KEY = 'key-primary';
    process.env.NVIDIA_API_KEY = 'key-reviewer';

    // Primary returns empty array — no evidence, no errors
    MockedOpenRouter.mockImplementation(function () {
      return { analyze: async () => [] };
    } as any);

    // Reviewer returns valid mismatch evidence
    MockedNvidia.mockImplementation(function () {
      return {
        analyze: async () => [
          {
            source: 'modelJudge',
            claimId: 'nvidia-mismatch-1',
            subject: 'roi:global',
            claim: 'Text color differs from expected',
            confidence: 0.85,
            authority: 'model' as const,
            polarity: 'mismatch',
            blocking: false
          }
        ]
      };
    } as any);

    const expectedPath = await writePng('expected.png', makeWhitePng());
    const actualPath = await writePng('actual.png', makeWhitePng());
    const outDir = path.join(tmpDir, 'out');
    await fs.mkdir(outDir, { recursive: true });
    const configPath = await writeConfig('home', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'visual_parity',
      modelJudges: {
        enabled: true,
        required: true,
        primary: { provider: 'openrouter', model: 'gpt-4o' },
        reviewer: { provider: 'nvidia', model: 'llama-3.2-90b' },
        requireConsensusForCodeHints: true
      }
    });

    const result = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualPath,
      runName: 'run-051-test'
    });

    // Primary produced no evidence → required judge failed
    expect(result.visualAuditStatus).toBe('error');
    expect(result.acceptanceStatus).toBe('rejected');
    expect(result.actionRequired?.type).toBe('model_judges_failed');

    // Message must NOT say "all outputs were errors" — reviewer succeeded
    expect(result.actionRequired?.message).not.toMatch(/all.*outputs.*errors/i);
    expect(result.actionRequired?.message).not.toContain('All judge outputs were errors');

    // Message MUST reference primary failure
    expect(result.actionRequired?.message).toMatch(/primary/i);

    // modelJudgesSummary: primary must be error (not skipped), reviewer must be success
    expect(result.modelJudgesSummary?.primary?.status).not.toBe('skipped');
    expect(result.modelJudgesSummary?.primary?.hadSuccess).toBe(false);
    expect(result.modelJudgesSummary?.primary?.attempted).toBe(true);
    expect(result.modelJudgesSummary?.reviewer?.status).toBe('success');
    expect(result.modelJudgesSummary?.reviewer?.hadSuccess).toBe(true);
    expect(result.modelJudgesSummary?.reviewer?.evidenceCount).toBeGreaterThan(0);
    expect(result.modelJudgesSummary?.reviewer?.attempted).toBe(true);
  });
});

// ── describe: Primary errors, reviewer succeeds ────────────────────────────────

describe('run-051: primary errors, reviewer succeeds', () => {
  it('message says primary failed and reviewer succeeded, not all-outputs-errors', async () => {
    process.env.OPENROUTER_API_KEY = 'key-primary';
    process.env.NVIDIA_API_KEY = 'key-reviewer';

    // Primary returns an error evidence item
    MockedOpenRouter.mockImplementation(function () {
      return {
        analyze: async (bundle: any) => [
          {
            source: 'modelJudge',
            claimId: `openrouter-error-${bundle.roiId}`,
            subject: `roi:${bundle.roiId}`,
            claim: 'OpenRouter analysis failed: 500 Internal Server Error',
            confidence: 0,
            authority: 'model' as const,
            measurements: { error: '500 Internal Server Error' }
          }
        ]
      };
    } as any);

    // Reviewer returns valid evidence
    MockedNvidia.mockImplementation(function () {
      return {
        analyze: async () => [
          {
            source: 'modelJudge',
            claimId: 'nvidia-match-1',
            subject: 'roi:global',
            claim: 'Layout matches expected',
            confidence: 0.9,
            authority: 'model' as const,
            polarity: 'match',
            blocking: false
          }
        ]
      };
    } as any);

    const expectedPath = await writePng('expected.png', makeWhitePng());
    const actualPath = await writePng('actual.png', makeWhitePng());
    const outDir = path.join(tmpDir, 'out');
    await fs.mkdir(outDir, { recursive: true });
    const configPath = await writeConfig('home', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'visual_parity',
      modelJudges: {
        enabled: true,
        required: true,
        primary: { provider: 'openrouter', model: 'gpt-4o' },
        reviewer: { provider: 'nvidia', model: 'llama-3.2-90b' }
      }
    });

    const result = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualPath,
      runName: 'run-051-errors'
    });

    expect(result.visualAuditStatus).toBe('error');
    expect(result.actionRequired?.type).toBe('model_judges_failed');
    expect(result.actionRequired?.message).toMatch(/primary.*failed|failed.*primary/i);
    expect(result.actionRequired?.message).toMatch(/reviewer.*succeeded|succeeded.*reviewer/i);
    expect(result.actionRequired?.message).not.toMatch(/all.*outputs.*errors/i);

    expect(result.modelJudgesSummary?.primary?.status).toBe('error');
    expect(result.modelJudgesSummary?.reviewer?.status).toBe('success');
  });
});

// ── describe: Both primary and reviewer succeed ────────────────────────────────

describe('both primary and reviewer succeed', () => {
  it('resolves to pass when both return polarity:match evidence', async () => {
    process.env.OPENROUTER_API_KEY = 'key-primary';
    process.env.NVIDIA_API_KEY = 'key-reviewer';

    MockedOpenRouter.mockImplementation(function () {
      return {
        analyze: async () => [
          {
            source: 'modelJudge',
            claimId: 'or-match-1',
            subject: 'roi:global',
            claim: 'Layout matches expected',
            confidence: 0.9,
            authority: 'model' as const,
            polarity: 'match',
            blocking: false
          }
        ]
      };
    } as any);

    MockedNvidia.mockImplementation(function () {
      return {
        analyze: async () => [
          {
            source: 'modelJudge',
            claimId: 'nv-match-1',
            subject: 'roi:global',
            claim: 'Colors match expected',
            confidence: 0.88,
            authority: 'model' as const,
            polarity: 'match',
            blocking: false
          }
        ]
      };
    } as any);

    const expectedPath = await writePng('expected.png', makeWhitePng());
    const actualPath = await writePng('actual.png', makeWhitePng());
    const outDir = path.join(tmpDir, 'out');
    await fs.mkdir(outDir, { recursive: true });
    const configPath = await writeConfig('home', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'visual_parity',
      modelJudges: {
        enabled: true,
        required: true,
        primary: { provider: 'openrouter', model: 'gpt-4o' },
        reviewer: { provider: 'nvidia', model: 'llama-3.2-90b' }
      }
    });

    const result = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualPath,
      runName: 'run-both-pass'
    });

    // polarity:match evidence is confirmation, not caveats → should pass
    expect(result.visualAuditStatus).toBe('pass');
    expect(result.acceptanceStatus).toBe('accepted');
    expect(result.actionRequired).toBeFalsy();
    expect(result.modelJudgesSummary?.primary?.status).toBe('success');
    expect(result.modelJudgesSummary?.primary?.attempted).toBe(true);
    expect(result.modelJudgesSummary?.reviewer?.status).toBe('success');
  });
});

// ── describe: Required judge skipped by policy ─────────────────────────────────

describe('required judge skipped by policy', () => {
  it('converts policy skip to error when required:true in visual_parity', async () => {
    process.env.OPENROUTER_API_KEY = 'key-primary';

    MockedOpenRouter.mockImplementation(function () {
      return { analyze: async () => [] };
    } as any);

    const expectedPath = await writePng('expected.png', makeWhitePng());
    const actualPath = await writePng('actual.png', makeWhitePng());
    const outDir = path.join(tmpDir, 'out');
    await fs.mkdir(outDir, { recursive: true });
    const configPath = await writeConfig('home', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'visual_parity',
      modelJudges: {
        enabled: true,
        required: true,
        // on_failed_quality will NOT trigger because quality passes → judges would be skipped
        policy: 'on_failed_quality',
        primary: { provider: 'openrouter', model: 'gpt-4o' }
      }
    });

    const result = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualPath,
      runName: 'run-policy-skip'
    });

    // Required judge in visual_parity cannot be skipped by policy — must be error
    expect(result.visualAuditStatus).toBe('error');
    expect(result.acceptanceStatus).toBe('rejected');
    expect(result.actionRequired?.type).toBe('model_judges_failed');
    expect(result.actionRequired?.message).toMatch(/not attempted|policy.*did not trigger/i);
  });
});

// ── describe: explicit metric_only skip ────────────────────────────────────────

describe('explicit metric_only skip', () => {
  it('allows skipped_by_config when enabled:false with explicitSkipReason', async () => {
    delete process.env.OPENROUTER_API_KEY;

    const expectedPath = await writePng('expected.png', makeWhitePng());
    const actualPath = await writePng('actual.png', makeWhitePng());
    const outDir = path.join(tmpDir, 'out');
    await fs.mkdir(outDir, { recursive: true });
    const configPath = await writeConfig('home', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: false,
        explicitSkipReason: 'CI run does not have VLM keys'
      }
    });

    const result = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualPath,
      runName: 'run-metric-only'
    });

    expect(result.visualAuditStatus).toBe('skipped_by_config');
    expect(result.acceptanceStatus).toBe('metric_only');
    expect(result.actionRequired).toBeFalsy();
  });
});

// ── describe: overlapLegibility per-region summary ────────────────────────────

describe('overlapLegibility per-region summary', () => {
  it('always produces summary with per-region results — no violation (pass)', async () => {
    delete process.env.OPENROUTER_API_KEY;

    // Green patch at x:10-39, y:30-59 — configure pill box FAR from green (x:70-89, y:10-19) → no violation
    const expectedPath = await writePng('expected.png', makeWhitePng());
    const actualPath = await writePng('actual.png', makeImageWithGreenPatch());
    const outDir = path.join(tmpDir, 'out');
    await fs.mkdir(outDir, { recursive: true });
    const configPath = await writeConfig('home', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: { enabled: false, explicitSkipReason: 'test' },
      overlapLegibility: {
        enabled: true,
        regions: [
          {
            id: 'pill-label',
            label: 'Kcal pill',
            box: { x: 70, y: 10, width: 20, height: 10 },
            coordinateSpace: 'expected',
            avoidColors: ['#00dc00'],
            maxOverlapPercent: 0.05,
            severity: 'warning'
          }
        ]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualPath,
      runName: 'run-overlap-pass'
    });

    // Summary must exist with the region listed
    expect(result.overlapLegibilitySummary).toBeDefined();
    expect(result.overlapLegibilitySummary?.enabled).toBe(true);
    expect(result.overlapLegibilitySummary?.regions).toHaveLength(1);

    const r = result.overlapLegibilitySummary!.regions[0];
    expect(r.id).toBe('pill-label');
    expect(r.checked).toBe(true);
    expect(r.status).toBe('pass');
    expect(r.overlapPercent).toBe(0); // no green in box x:70-89, y:10-19

    // Artifact is written even for pass
    expect(r.artifactPath).toBeTruthy();
    await expect(fs.stat(r.artifactPath!)).resolves.toBeDefined();

    // No visual caveats
    expect(result.visualCaveats ?? []).toHaveLength(0);
  });

  it('produces caveat + artifact when violation exists (warning severity)', async () => {
    delete process.env.OPENROUTER_API_KEY;

    // Green patch at x:10-39, y:30-59 — configure pill box overlapping it exactly
    const expectedPath = await writePng('expected.png', makeWhitePng());
    const actualPath = await writePng('actual.png', makeImageWithGreenPatch());
    const outDir = path.join(tmpDir, 'out');
    await fs.mkdir(outDir, { recursive: true });
    const configPath = await writeConfig('home', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: { enabled: false, explicitSkipReason: 'test' },
      overlapLegibility: {
        enabled: true,
        regions: [
          {
            id: 'pill-label',
            label: 'Kcal pill',
            box: { x: 10, y: 30, width: 20, height: 20 },
            coordinateSpace: 'expected',
            avoidColors: ['#00dc00'],
            maxOverlapPercent: 0.01,
            severity: 'warning'
          }
        ]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualPath,
      runName: 'run-overlap-warning'
    });

    expect(result.overlapLegibilitySummary?.regions).toHaveLength(1);
    const r = result.overlapLegibilitySummary!.regions[0];
    expect(r.status).toBe('caveat');
    expect(r.overlapPercent).toBeGreaterThan(0.01);

    // Artifact exists
    expect(r.artifactPath).toBeTruthy();
    await expect(fs.stat(r.artifactPath!)).resolves.toBeDefined();

    // Visual caveat emitted (warning = non-blocking)
    const caveats = result.visualCaveats ?? [];
    expect(caveats.length).toBeGreaterThan(0);
    const caveat = caveats.find((c) => c.id === 'overlap-legibility-pill-label');
    expect(caveat).toBeDefined();
    expect(caveat!.severity).toBe('warning');
    expect(caveat!.blocking).toBe(false);
  });

  it('marks region as skipped with reason when no avoidColors configured', async () => {
    delete process.env.OPENROUTER_API_KEY;

    const expectedPath = await writePng('expected.png', makeWhitePng());
    const actualPath = await writePng('actual.png', makeWhitePng());
    const outDir = path.join(tmpDir, 'out');
    await fs.mkdir(outDir, { recursive: true });
    const configPath = await writeConfig('home', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: { enabled: false, explicitSkipReason: 'test' },
      overlapLegibility: {
        enabled: true,
        regions: [
          {
            id: 'empty-region',
            label: 'No colors',
            box: { x: 0, y: 0, width: 30, height: 30 },
            coordinateSpace: 'expected',
            avoidColors: []
          },
          {
            id: 'valid-region',
            label: 'Valid',
            box: { x: 50, y: 50, width: 20, height: 20 },
            coordinateSpace: 'expected',
            avoidColors: ['#ff0000'],
            maxOverlapPercent: 0.05,
            severity: 'warning'
          }
        ]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualPath,
      runName: 'run-overlap-skip'
    });

    expect(result.overlapLegibilitySummary?.regions).toHaveLength(2);

    const skipped = result.overlapLegibilitySummary!.regions.find((r) => r.id === 'empty-region');
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.checked).toBe(false);
    expect(skipped?.skipReason).toBeTruthy();

    const valid = result.overlapLegibilitySummary!.regions.find((r) => r.id === 'valid-region');
    expect(valid?.status).toBe('pass');
    expect(valid?.checked).toBe(true);
  });

  it('report.json contains overlapLegibilitySummary', async () => {
    delete process.env.OPENROUTER_API_KEY;

    const expectedPath = await writePng('expected.png', makeWhitePng());
    const actualPath = await writePng('actual.png', makeWhitePng());
    const outDir = path.join(tmpDir, 'out');
    await fs.mkdir(outDir, { recursive: true });
    const configPath = await writeConfig('home', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: { enabled: false, explicitSkipReason: 'test' },
      overlapLegibility: {
        enabled: true,
        regions: [
          {
            id: 'pill',
            label: 'Pill',
            box: { x: 10, y: 10, width: 20, height: 10 },
            coordinateSpace: 'expected',
            avoidColors: ['#00dc00'],
            maxOverlapPercent: 0.05,
            severity: 'warning'
          }
        ]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualPath,
      runName: 'run-overlap-json'
    });

    expect(result.reportJsonPath).toBeTruthy();
    const raw = await fs.readFile(result.reportJsonPath!, 'utf8');
    const report = JSON.parse(raw);
    expect(report.overlapLegibilitySummary).toBeDefined();
    expect(report.overlapLegibilitySummary.enabled).toBe(true);
    expect(Array.isArray(report.overlapLegibilitySummary.regions)).toBe(true);
  });
});
