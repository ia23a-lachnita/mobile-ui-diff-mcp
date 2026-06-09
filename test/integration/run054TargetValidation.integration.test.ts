/**
 * Integration tests for run-054 architecture refactor: criterion audit packets + target validation.
 *
 * The root failure in run-054: kcal-left-pill overlapLegibility reported "pass" but the
 * diagnostic artifact showed the box targeting the central "1,420 / of 2,400" text, not
 * the actual "980 kcal left" pill. The deterministic analyzer and judges both looked at the
 * wrong crop and reported confident results.
 *
 * New architecture invariants tested here:
 *  A. Wrong-box (targeting central calorie text) → invalid_target, acceptanceStatus rejected
 *  B. Correct-box (targeting actual pill area with green arc nearby) → targetStatus matched
 *  C. Criterion judge packet includes full-screen + annotated + generous crops (not only ROI crops)
 *  D. Criterion-specific prompt asks target validation first; target_mismatch is a valid outcome
 *  E. Report-contract: invalid_target → acceptanceStatus rejected, agentActionContract explains
 *  F. Old architecture guard: overlap/legibility judge packets must include full-screen context
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { criterionTargetSchema } from '../../src/config/uiDiffConfig';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PNG } from 'pngjs';

vi.mock('../../src/pipeline/judges/providers/OpenRouterProvider');
vi.mock('../../src/pipeline/judges/providers/NvidiaProvider');

import { OpenRouterProvider } from '../../src/pipeline/judges/providers/OpenRouterProvider';
import { runScreenUiDiff } from '../../src/tools/runScreenUiDiff';
import type { CriterionAuditBundle, CriterionJudgeResult } from '../../src/types';

const MockedProvider = vi.mocked(OpenRouterProvider);

// ── image helpers ─────────────────────────────────────────────────────────────

const IMG_W = 400;
const IMG_H = 600;

/**
 * Synthetic "macro-ring" image with three distinct regions:
 *  - Central calorie text zone (x:100-300, y:100-200): light grey background (neutral)
 *  - "980 kcal left" pill zone (x:50-200, y:300-360): slightly off-white background
 *  - Green arc (x:30-370, y:260-400 band): bright green pixels forming a ring segment
 *
 * The green arc is near the pill zone, which is the correct target for kcal-left-pill.
 * The central calorie zone has NO green pixels — the deterministic measurement over it
 * would report 0% overlap (false pass if the wrong box is used).
 */
function makeMacroRingImage(): Buffer {
  const png = new PNG({ width: IMG_W, height: IMG_H });

  // Base: light grey background
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 230; png.data[i + 1] = 230; png.data[i + 2] = 230; png.data[i + 3] = 255;
  }

  // Green arc band: bright green pixels at y:260-280 running across x:30-370
  // This simulates the green arc that should be near the kcal-left-pill
  for (let y = 260; y < 285; y++) {
    for (let x = 30; x < 370; x++) {
      const idx = (y * IMG_W + x) << 2;
      png.data[idx] = 0; png.data[idx + 1] = 200; png.data[idx + 2] = 0; png.data[idx + 3] = 255;
    }
  }

  // "980 kcal left" pill zone (x:50-200, y:300-360): slightly different background, near green arc
  for (let y = 300; y < 360; y++) {
    for (let x = 50; x < 200; x++) {
      const idx = (y * IMG_W + x) << 2;
      png.data[idx] = 245; png.data[idx + 1] = 245; png.data[idx + 2] = 245; png.data[idx + 3] = 255;
    }
  }

  // Central calorie text zone (x:100-300, y:100-200): neutral grey, NO green pixels
  for (let y = 100; y < 200; y++) {
    for (let x = 100; x < 300; x++) {
      const idx = (y * IMG_W + x) << 2;
      png.data[idx] = 220; png.data[idx + 1] = 220; png.data[idx + 2] = 220; png.data[idx + 3] = 255;
    }
  }

  return PNG.sync.write(png);
}

function makeWhitePng(width = IMG_W, height = IMG_H): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 240; png.data[i + 1] = 240; png.data[i + 2] = 240; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

// ── test setup ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let savedApiKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-run054-'));
  savedApiKey = process.env.OPENROUTER_API_KEY;
  MockedProvider.mockReset();
  process.env.OPENROUTER_API_KEY = 'test-key-run054';
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (savedApiKey !== undefined) process.env.OPENROUTER_API_KEY = savedApiKey;
  else delete process.env.OPENROUTER_API_KEY;
});

async function writeFile(name: string, buf: Buffer): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, buf);
  return p;
}

interface ScreenCfg {
  expectedImage: string;
  outputDir: string;
  maxDiffPercent?: number;
  visualAuditMode?: string;
  modelJudges?: Record<string, unknown>;
  overlapLegibility?: Record<string, unknown>;
}

async function writeConfig(screenName: string, cfg: ScreenCfg): Promise<string> {
  const configPath = path.join(tmpDir, 'ui-diff.config.json');
  await fs.writeFile(configPath, JSON.stringify(
    { screens: { [screenName]: { platform: 'none', ...cfg } } },
    null, 2
  ));
  return configPath;
}

// ── wrong-box (central calorie text): configuration coordinates that target the wrong element ──
// In normalized space over a 400×600 image:
//   x:0.25-0.75, y:0.167-0.333 → pixel x:100-300, y:100-200 (central calorie text, NO green pixels)
const WRONG_BOX = { x: 0.25, y: 0.167, width: 0.50, height: 0.167 };

// ── correct-box (kcal-left-pill): coordinates targeting the actual pill near the green arc ──
// In normalized space: x:0.125-0.50, y:0.50-0.60 → pixel x:50-200, y:300-360
const CORRECT_BOX = { x: 0.125, y: 0.50, width: 0.375, height: 0.10 };

// ── Test A: Wrong-box → invalid_target, acceptanceStatus rejected ───────────────

describe('Test A — run-054 false-pass regression: wrong box → invalid_target', () => {
  it('reports invalid_target when criterion judge returns not_matched for wrong-box config', async () => {
    // Mock: analyze() returns empty (no blocking evidence from main judge)
    // analyzeCriterion() returns not_matched — judge can see the box targets the wrong element
    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockResolvedValue({
          criterionId: 'kcal-left-pill',
          targetStatus: 'not_matched',
          judgeAuditStatus: 'target_mismatch',
          reasoning: 'The highlighted box covers the central "1,420 / of 2,400" text area, not the "980 kcal left" pill.',
          confidence: 0.92
        } satisfies CriterionJudgeResult)
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-a');
    await fs.mkdir(outDir, { recursive: true });

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: WRONG_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'high'
        }]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'today',
      configPath,
      actualImage: actualPath,
      runName: 'run-054-wrong-box'
    });

    // Wrong box → must NOT report pass
    expect(result.status).not.toBe('pass');

    const region = result.overlapLegibilitySummary?.regions.find((r) => r.id === 'kcal-left-pill');
    expect(region).toBeDefined();

    // targetStatus must reflect criterion judge result
    expect(region!.targetStatus).toBe('not_matched');

    // measurementStatus must be not_evaluated when target is wrong
    expect(region!.measurementStatus).toBe('not_evaluated');

    // status must be invalid_target, not pass/caveat
    expect(region!.status).toBe('invalid_target');

    // judgeAuditStatus must reflect criterion judge
    expect(region!.judgeAuditStatus).toBe('target_mismatch');

    // acceptanceStatus must not be accepted
    expect(result.acceptanceStatus).not.toBe('accepted');
    expect(result.acceptanceStatus).toBe('rejected');

    // agentActionContract must not authorize edits
    expect(result.agentActionContract?.canEditApp).toBe(false);

    // actionRequired must explain the invalid target
    expect(result.actionRequired).toBeTruthy();
    expect(result.actionRequired?.type).toBe('invalid_overlap_target');
  });

  it('reports invalid_target when criterion judge returns ambiguous for wrong-box config', async () => {
    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockResolvedValue({
          criterionId: 'kcal-left-pill',
          targetStatus: 'ambiguous',
          judgeAuditStatus: 'unavailable',
          reasoning: 'Cannot determine which element the box targets from the annotated screen.',
          confidence: 0.3
        } satisfies CriterionJudgeResult)
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-a2');
    await fs.mkdir(outDir, { recursive: true });

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: WRONG_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'high'
        }]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-ambiguous'
    });

    const region = result.overlapLegibilitySummary?.regions.find((r) => r.id === 'kcal-left-pill');
    expect(region!.targetStatus).toBe('ambiguous');
    expect(region!.measurementStatus).toBe('not_evaluated');
    expect(region!.status).toBe('invalid_target');
    expect(result.acceptanceStatus).toBe('rejected');
  });
});

// ── Test B: Correct-box → targetStatus matched ────────────────────────────────

describe('Test B — corrected target: correct box → targetStatus matched', () => {
  it('reports matched and credible measurement when correct box is used', async () => {
    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockResolvedValue({
          criterionId: 'kcal-left-pill',
          targetStatus: 'matched',
          measurementCredible: true,
          judgeAuditStatus: 'caveat',
          reasoning: 'The highlighted box correctly covers the "980 kcal left" pill area. Green arc is nearby and within the clearance zone.',
          confidence: 0.88
        } satisfies CriterionJudgeResult)
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-b');
    await fs.mkdir(outDir, { recursive: true });

    // CORRECT box: targets the pill zone at y:300-360, near the green arc at y:260-285
    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: CORRECT_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'high'
        }]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-correct'
    });

    const region = result.overlapLegibilitySummary?.regions.find((r) => r.id === 'kcal-left-pill');
    expect(region).toBeDefined();

    // Target correctly identified
    expect(region!.targetStatus).toBe('matched');

    // checked should be true — the deterministic measurement ran
    expect(region!.checked).toBe(true);

    // status should NOT be invalid_target
    expect(region!.status).not.toBe('invalid_target');

    // resolvedBox should exist and be within image bounds
    expect(region!.resolvedBox).toBeDefined();
    expect(region!.resolvedBox!.x).toBeGreaterThanOrEqual(0);
    expect(region!.resolvedBox!.y).toBeGreaterThanOrEqual(0);
    expect(region!.resolvedBox!.x + region!.resolvedBox!.width).toBeLessThanOrEqual(IMG_W);
    expect(region!.resolvedBox!.y + region!.resolvedBox!.height).toBeLessThanOrEqual(IMG_H);

    // measurementStatus must be set (not not_evaluated)
    expect(region!.measurementStatus).not.toBe('not_evaluated');
    expect(['pass', 'caveat', 'fail']).toContain(region!.measurementStatus);

    // artifactPath must exist on disk
    expect(region!.artifactPath).toBeTruthy();
    await expect(fs.access(region!.artifactPath!)).resolves.toBeUndefined();

    // judgeAuditStatus reflects criterion judge outcome
    expect(region!.judgeAuditStatus).toBe('caveat');

    // acceptanceStatus: not rejected due to invalid_target (may be rejected for other reasons)
    // The key invariant: invalid_overlap_target must NOT be in actionRequired
    expect(result.actionRequired?.type).not.toBe('invalid_overlap_target');
  });
});

// ── Test C: Criterion judge packet includes full-screen context ───────────────

describe('Test C — criterion judge packet construction', () => {
  it('criterion analyze call receives annotated full-screen, crops — not only tight ROI crops', async () => {
    const capturedPackets: CriterionAuditBundle[] = [];

    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockImplementation(async (packet: CriterionAuditBundle) => {
          capturedPackets.push(packet);
          return {
            criterionId: packet.criterionId,
            targetStatus: 'matched',
            judgeAuditStatus: 'pass',
            reasoning: 'Test',
            confidence: 0.9
          } satisfies CriterionJudgeResult;
        })
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-c');
    await fs.mkdir(outDir, { recursive: true });

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: CORRECT_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'warning'
        }]
      }
    });

    await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-packet'
    });

    // analyzeCriterion must have been called
    expect(capturedPackets.length).toBeGreaterThan(0);
    const packet = capturedPackets[0];

    // Packet must include the full expected screen path (design reference)
    expect(packet.artifacts.fullExpectedScreen).toBeTruthy();
    await expect(fs.access(packet.artifacts.fullExpectedScreen!)).resolves.toBeUndefined();
    // Full expected screen must be a real PNG
    const expectedScreenBuf = await fs.readFile(packet.artifacts.fullExpectedScreen!);
    const expectedScreenPng = PNG.sync.read(expectedScreenBuf);
    expect(expectedScreenPng.width).toBe(IMG_W);
    expect(expectedScreenPng.height).toBe(IMG_H);

    // Packet must include the full actual screen path (not just a crop)
    expect(packet.artifacts.fullActualScreen).toBeTruthy();
    await expect(fs.access(packet.artifacts.fullActualScreen!)).resolves.toBeUndefined();

    // Packet must include annotated actual screen (full actual with highlighted box)
    expect(packet.artifacts.annotatedActualScreen).toBeTruthy();
    await expect(fs.access(packet.artifacts.annotatedActualScreen!)).resolves.toBeUndefined();

    // The annotated screen must be a real PNG file
    const annotatedBuf = await fs.readFile(packet.artifacts.annotatedActualScreen!);
    const annotatedPng = PNG.sync.read(annotatedBuf);
    // Must be full-size (not a tiny tight crop)
    expect(annotatedPng.width).toBe(IMG_W);
    expect(annotatedPng.height).toBe(IMG_H);

    // Packet must include generous expected crop
    expect(packet.artifacts.expectedCrop).toBeTruthy();
    await expect(fs.access(packet.artifacts.expectedCrop!)).resolves.toBeUndefined();

    // Packet must include generous actual crop (original pixels)
    expect(packet.artifacts.actualCrop).toBeTruthy();
    await expect(fs.access(packet.artifacts.actualCrop!)).resolves.toBeUndefined();

    // The actual crop must be LARGER than the tight configured box
    // CORRECT_BOX in pixels: x:50-200, y:300-360 → width=150, height=60
    // Generous crop with margin must be wider
    const actualCropBuf = await fs.readFile(packet.artifacts.actualCrop!);
    const actualCropPng = PNG.sync.read(actualCropBuf);
    expect(actualCropPng.width).toBeGreaterThan(150); // wider than the box alone
    expect(actualCropPng.height).toBeGreaterThan(60); // taller than the box alone

    // Packet may include diagnostic artifact as supporting evidence
    // but the packet is NOT composed solely of diagnostic artifacts
    const nonDiagnosticImages = [
      packet.artifacts.fullActualScreen,
      packet.artifacts.annotatedActualScreen,
      packet.artifacts.expectedCrop,
      packet.artifacts.actualCrop
    ].filter(Boolean);
    expect(nonDiagnosticImages.length).toBeGreaterThanOrEqual(3);

    // Deterministic summary must be present
    expect(packet.deterministicSummary).toBeTruthy();
    expect(typeof packet.deterministicSummary).toBe('string');
  });
});

// ── Test D: Criterion-specific prompt behavior ────────────────────────────────

describe('Test D — criterion-specific prompt: target validation first, target_mismatch outcome', () => {
  it('analyzeCriterion is called with a packet that has a meaningful criterionLabel', async () => {
    const capturedPackets: CriterionAuditBundle[] = [];

    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockImplementation(async (packet: CriterionAuditBundle) => {
          capturedPackets.push(packet);
          return {
            criterionId: packet.criterionId,
            targetStatus: 'not_matched',
            judgeAuditStatus: 'target_mismatch',
            reasoning: 'Box targets wrong element',
            confidence: 0.95
          } satisfies CriterionJudgeResult;
        })
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-d');
    await fs.mkdir(outDir, { recursive: true });

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: WRONG_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'warning'
        }]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-prompt'
    });

    expect(capturedPackets.length).toBeGreaterThan(0);
    const packet = capturedPackets[0];

    // Packet carries the human-readable criterion label
    expect(packet.criterionLabel).toBe('980 kcal left pill');
    expect(packet.criterionId).toBe('kcal-left-pill');

    // The result correctly maps target_mismatch to invalid_target
    const region = result.overlapLegibilitySummary?.regions.find((r) => r.id === 'kcal-left-pill');
    expect(region!.judgeAuditStatus).toBe('target_mismatch');
    expect(region!.targetStatus).toBe('not_matched');
    expect(region!.status).toBe('invalid_target');
  });

  it('provider that does not implement analyzeCriterion yields targetStatus not_checked — no invalid_target', async () => {
    // Mock without analyzeCriterion — simulates a provider that only has analyze()
    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([])
        // No analyzeCriterion
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-d2');
    await fs.mkdir(outDir, { recursive: true });

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: CORRECT_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'warning'
        }]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-no-criterion'
    });

    const region = result.overlapLegibilitySummary?.regions.find((r) => r.id === 'kcal-left-pill');
    expect(region).toBeDefined();

    // not_checked means criterion judge didn't run — NOT an error condition
    expect(region!.targetStatus).toBe('not_checked');
    expect(region!.judgeAuditStatus).toBe('not_run');

    // status must NOT be invalid_target when targetStatus is not_checked
    expect(region!.status).not.toBe('invalid_target');

    // acceptanceStatus must not be rejected due to invalid_overlap_target
    expect(result.actionRequired?.type).not.toBe('invalid_overlap_target');
  });
});

// ── Test E: Report-contract consistency ──────────────────────────────────────

describe('Test E — report-contract consistency: invalid_target → rejected, actionRequired explains', () => {
  it('acceptanceStatus is rejected and actionRequired explains invalid measurement target', async () => {
    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockResolvedValue({
          criterionId: 'kcal-left-pill',
          targetStatus: 'not_matched',
          judgeAuditStatus: 'target_mismatch',
          reasoning: 'Box covers wrong element',
          confidence: 0.9
        } satisfies CriterionJudgeResult)
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-e');
    await fs.mkdir(outDir, { recursive: true });

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: WRONG_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'high'
        }]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-contract'
    });

    // Core invariant: invalid_target → rejected
    expect(result.acceptanceStatus).toBe('rejected');

    // agentActionContract must not authorize app edits
    expect(result.agentActionContract?.canEditApp).toBe(false);

    // actionRequired must exist and explain the invalid target
    expect(result.actionRequired).toBeTruthy();
    expect(result.actionRequired?.type).toBe('invalid_overlap_target');
    expect(result.actionRequired?.severity).toBe('blocking');
    expect(result.actionRequired?.message).toMatch(/kcal-left-pill/);

    // reasonSummary or message must reference the invalid measurement
    const explanation = (result.agentActionContract?.reasonSummary ?? '') + (result.actionRequired?.message ?? '');
    expect(explanation.toLowerCase()).toMatch(/invalid|target|wrong|box|measurement/);

    // Report JSON is persisted with the correct structure
    const reportJson = JSON.parse(await fs.readFile(result.run.reportPath, 'utf-8'));
    expect(reportJson.acceptanceStatus).toBe('rejected');
    const persistedRegion = reportJson.overlapLegibilitySummary?.regions?.find((r: any) => r.id === 'kcal-left-pill');
    expect(persistedRegion?.status).toBe('invalid_target');
    expect(persistedRegion?.targetStatus).toBe('not_matched');
    expect(persistedRegion?.measurementStatus).toBe('not_evaluated');
  });

  it('accepted status is NOT set when any required criterion has invalid_target', async () => {
    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockResolvedValue({
          criterionId: 'kcal-left-pill',
          targetStatus: 'not_matched',
          judgeAuditStatus: 'target_mismatch',
          reasoning: 'Wrong element',
          confidence: 0.85
        } satisfies CriterionJudgeResult)
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-e2');
    await fs.mkdir(outDir, { recursive: true });

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: WRONG_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'warning'
        }]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-not-accepted'
    });

    // Even with severity:warning, invalid_target must force rejection — not accepted
    expect(result.acceptanceStatus).not.toBe('accepted');
  });
});

// ── Test F: Old architecture guard ────────────────────────────────────────────

describe('Test F — old architecture guard: overlap packets must include full-screen context', () => {
  it('criterion audit packet includes more than just tight ROI crops and diagnostic artifacts', async () => {
    const capturedPackets: CriterionAuditBundle[] = [];

    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockImplementation(async (packet: CriterionAuditBundle) => {
          capturedPackets.push(packet);
          return {
            criterionId: packet.criterionId,
            targetStatus: 'matched',
            judgeAuditStatus: 'pass',
            reasoning: 'Guard test',
            confidence: 0.9
          } satisfies CriterionJudgeResult;
        })
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-f');
    await fs.mkdir(outDir, { recursive: true });

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: CORRECT_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'warning'
        }]
      }
    });

    await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-guard'
    });

    expect(capturedPackets.length).toBeGreaterThan(0);
    const packet = capturedPackets[0];

    // GUARD: full actual screen must be present (prevents old ROI-crop-only architecture)
    expect(packet.artifacts.fullActualScreen).toBeTruthy();

    // GUARD: annotated actual screen must be present (judges need to verify target)
    expect(packet.artifacts.annotatedActualScreen).toBeTruthy();

    // GUARD: annotated screen must be full-size — not a tiny crop
    const annotatedPng = PNG.sync.read(await fs.readFile(packet.artifacts.annotatedActualScreen!));
    expect(annotatedPng.width).toBeGreaterThanOrEqual(IMG_W);

    // GUARD: at least one non-diagnostic image must be present
    const hasFullScreenContext = !!(packet.artifacts.fullActualScreen || packet.artifacts.annotatedActualScreen);
    expect(hasFullScreenContext).toBe(true);

    // GUARD: packet must not be composed only of the diagnostic artifact
    // (diagnostic is in artifacts.diagnosticArtifact — supporting evidence only)
    const nonDiagnostic = [
      packet.artifacts.fullActualScreen,
      packet.artifacts.annotatedActualScreen,
      packet.artifacts.expectedCrop,
      packet.artifacts.actualCrop
    ].filter(Boolean);
    expect(nonDiagnostic.length).toBeGreaterThanOrEqual(2);

    // Verify the annotated screen has the magenta border pixels (proves the box was drawn)
    const buf = await fs.readFile(packet.artifacts.annotatedActualScreen!);
    const png = PNG.sync.read(buf);
    // Find any magenta pixel (R=255, G=0, B=255)
    let hasMagentaPixel = false;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i] === 255 && png.data[i + 1] === 0 && png.data[i + 2] === 255) {
        hasMagentaPixel = true;
        break;
      }
    }
    expect(hasMagentaPixel).toBe(true);
  });
});

// ── Test G: visual_parity + required hard-fail when criterion audit unavailable ─

describe('Test G — visual_parity required: hard-fail when primary lacks analyzeCriterion', () => {
  it('rejects run with invalid_overlap_target when primary provider has no analyzeCriterion in visual_parity mode', async () => {
    // Provider without analyzeCriterion (metric_only / legacy provider)
    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([])
        // No analyzeCriterion
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-g');
    await fs.mkdir(outDir, { recursive: true });

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'visual_parity',
      modelJudges: {
        enabled: true,
        required: true,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: CORRECT_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'high'
        }]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-g'
    });

    // Must be rejected — criterion audit required but unavailable
    expect(result.acceptanceStatus).not.toBe('accepted');
    expect(result.actionRequired?.type).toBe('invalid_overlap_target');
    expect(result.actionRequired?.severity).toBe('blocking');
    expect(result.agentActionContract?.canEditApp).toBe(false);
  });

  it('no hard-fail when visualAuditMode is metric_only even if primary lacks analyzeCriterion', async () => {
    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([])
        // No analyzeCriterion
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-g2');
    await fs.mkdir(outDir, { recursive: true });

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: CORRECT_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'warning'
        }]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-g2'
    });

    // metric_only: not_checked is allowed
    const region = result.overlapLegibilitySummary?.regions.find((r) => r.id === 'kcal-left-pill');
    expect(region!.targetStatus).toBe('not_checked');
    // Must NOT set invalid_overlap_target from criterion audit alone
    expect(result.actionRequired?.type).not.toBe('invalid_overlap_target');
  });
});

// ── Test H: reviewer disagreement → final targetStatus ambiguous ───────────────

import { NvidiaProvider } from '../../src/pipeline/judges/providers/NvidiaProvider';

const MockedNvidiaProvider = vi.mocked(NvidiaProvider);

describe('Test H — reviewer disagreement: primary matched + reviewer not_matched → ambiguous', () => {
  it('final targetStatus is ambiguous when primary says matched but reviewer says not_matched', async () => {
    // Primary: matched
    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockResolvedValue({
          criterionId: 'kcal-left-pill',
          targetStatus: 'matched',
          judgeAuditStatus: 'pass',
          reasoning: 'Box correctly covers the pill.',
          confidence: 0.85
        } satisfies CriterionJudgeResult)
      };
    } as any);

    // Reviewer: not_matched (disagrees)
    MockedNvidiaProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockResolvedValue({
          criterionId: 'kcal-left-pill',
          targetStatus: 'not_matched',
          judgeAuditStatus: 'target_mismatch',
          reasoning: 'Box appears to cover the central calorie text, not the pill.',
          confidence: 0.80
        } satisfies CriterionJudgeResult)
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-h');
    await fs.mkdir(outDir, { recursive: true });

    process.env.NVIDIA_API_KEY = 'test-nvidia-key-h';

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' },
        reviewer: { provider: 'nvidia', model: 'test-nvidia-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: CORRECT_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'high'
        }]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-h'
    });

    const region = result.overlapLegibilitySummary?.regions.find((r) => r.id === 'kcal-left-pill');
    expect(region).toBeDefined();

    // Disagreement: final must be ambiguous (not matched, not not_matched)
    expect(region!.targetStatus).toBe('ambiguous');

    // Per-provider results must be stored
    expect(region!.primaryCriterionResult?.targetStatus).toBe('matched');
    expect(region!.reviewerCriterionResult?.targetStatus).toBe('not_matched');

    // Ambiguous → invalid_target → rejected
    expect(region!.status).toBe('invalid_target');
    expect(region!.measurementStatus).toBe('not_evaluated');
    expect(result.acceptanceStatus).not.toBe('accepted');

    // criterionJudgesSummary must reflect both providers ran
    expect(result.criterionJudgesSummary).toBeDefined();
    const entry = result.criterionJudgesSummary?.entries.find((e) => e.criterionId === 'kcal-left-pill');
    expect(entry).toBeDefined();
    expect(entry!.primaryTargetStatus).toBe('matched');
    expect(entry!.reviewerTargetStatus).toBe('not_matched');
    expect(entry!.finalTargetStatus).toBe('ambiguous');
  });

  it('final targetStatus is matched when both primary and reviewer agree on matched', async () => {
    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockResolvedValue({
          criterionId: 'kcal-left-pill',
          targetStatus: 'matched',
          judgeAuditStatus: 'pass',
          reasoning: 'Correct target.',
          confidence: 0.9
        } satisfies CriterionJudgeResult)
      };
    } as any);

    MockedNvidiaProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockResolvedValue({
          criterionId: 'kcal-left-pill',
          targetStatus: 'matched',
          judgeAuditStatus: 'pass',
          reasoning: 'Confirmed correct target.',
          confidence: 0.88
        } satisfies CriterionJudgeResult)
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-h2');
    await fs.mkdir(outDir, { recursive: true });

    process.env.NVIDIA_API_KEY = 'test-nvidia-key-h2';

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' },
        reviewer: { provider: 'nvidia', model: 'test-nvidia-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: CORRECT_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'high'
        }]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-h2'
    });

    const region = result.overlapLegibilitySummary?.regions.find((r) => r.id === 'kcal-left-pill');
    expect(region!.targetStatus).toBe('matched');
    expect(region!.status).not.toBe('invalid_target');
    expect(result.actionRequired?.type).not.toBe('invalid_overlap_target');
  });
});

// ── Test I: target config → criterionDescription contains constraints ──────────

describe('Test I — target config: criterionDescription carries mustNotMatch and expectedText', () => {
  it('packet criterionDescription includes mustNotMatch constraints from target config', async () => {
    const capturedPackets: CriterionAuditBundle[] = [];

    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockImplementation(async (packet: CriterionAuditBundle) => {
          capturedPackets.push(packet);
          return {
            criterionId: packet.criterionId,
            targetStatus: 'matched',
            judgeAuditStatus: 'pass',
            reasoning: 'Target contract satisfied.',
            confidence: 0.9
          } satisfies CriterionJudgeResult;
        })
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-i');
    await fs.mkdir(outDir, { recursive: true });

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: CORRECT_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'high',
          target: {
            expectedText: '980 kcal left',
            anchorDescription: 'rounded kcal-left pill below the center calorie number',
            mustNotMatch: ['1,420', 'of 2,400']
          }
        }]
      }
    });

    await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-i'
    });

    expect(capturedPackets.length).toBeGreaterThan(0);
    const packet = capturedPackets[0];

    // criterionDescription must be populated from the target config
    expect(packet.criterionDescription).toBeTruthy();
    expect(packet.criterionDescription).toContain('980 kcal left');
    expect(packet.criterionDescription).toContain('1,420');
    expect(packet.criterionDescription).toContain('of 2,400');
    expect(packet.criterionDescription).toContain('rounded kcal-left pill');

    // mustNotMatch constraint must appear
    expect(packet.criterionDescription).toMatch(/must not match|Must NOT match/i);
  });

  it('packet criterionDescription is undefined when no target config is set', async () => {
    const capturedPackets: CriterionAuditBundle[] = [];

    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockImplementation(async (packet: CriterionAuditBundle) => {
          capturedPackets.push(packet);
          return {
            criterionId: packet.criterionId,
            targetStatus: 'matched',
            judgeAuditStatus: 'pass',
            reasoning: 'OK',
            confidence: 0.9
          } satisfies CriterionJudgeResult;
        })
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-i2');
    await fs.mkdir(outDir, { recursive: true });

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: CORRECT_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5
        }]
      }
    });

    await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-i2'
    });

    expect(capturedPackets.length).toBeGreaterThan(0);
    // No target config → criterionDescription should be undefined
    expect(capturedPackets[0].criterionDescription).toBeUndefined();
  });
});

// ── Test J: criterionJudgesSummary report fields ──────────────────────────────

describe('Test J — criterionJudgesSummary report fields', () => {
  it('report includes criterionJudgesSummary with per-region entries after criterion audit', async () => {
    MockedProvider.mockImplementation(function () {
      return {
        analyze: vi.fn().mockResolvedValue([]),
        analyzeCriterion: vi.fn().mockResolvedValue({
          criterionId: 'kcal-left-pill',
          targetStatus: 'matched',
          judgeAuditStatus: 'pass',
          reasoning: 'Correct target.',
          confidence: 0.9
        } satisfies CriterionJudgeResult)
      };
    } as any);

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeMacroRingImage());
    const outDir = path.join(tmpDir, 'out-j');
    await fs.mkdir(outDir, { recursive: true });

    const configPath = await writeConfig('today', {
      expectedImage: expectedPath,
      outputDir: outDir,
      maxDiffPercent: 1,
      visualAuditMode: 'metric_only',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{
          id: 'kcal-left-pill',
          label: '980 kcal left pill',
          coordinateSpace: 'normalized',
          box: CORRECT_BOX,
          avoidColors: ['#00c800'],
          maxOverlapPercent: 5,
          severity: 'high'
        }]
      }
    });

    const result = await runScreenUiDiff({
      screen: 'today', configPath, actualImage: actualPath, runName: 'run-054-j'
    });

    // criterionJudgesSummary must exist
    expect(result.criterionJudgesSummary).toBeDefined();
    const summary = result.criterionJudgesSummary!;

    expect(summary.totalRegions).toBe(1);
    expect(summary.attempted).toBe(1);
    expect(summary.hadSuccess).toBe(true);
    expect(summary.errorCount).toBe(0);
    expect(summary.entries).toHaveLength(1);

    const entry = summary.entries[0];
    expect(entry.criterionId).toBe('kcal-left-pill');
    expect(entry.finalTargetStatus).toBe('matched');
    expect(entry.finalJudgeAuditStatus).toBe('pass');
    expect(entry.artifactPathsSent.length).toBeGreaterThan(0);

    // Report JSON must persist criterionJudgesSummary
    const reportJson = JSON.parse(await fs.readFile(result.run.reportPath, 'utf-8'));
    expect(reportJson.criterionJudgesSummary).toBeDefined();
    expect(reportJson.criterionJudgesSummary.entries[0].criterionId).toBe('kcal-left-pill');
  });
});

// ── Test K: criterionTargetSchema no longer accepts onMismatch ────────────────

describe('Test K — criterionTargetSchema rejects onMismatch', () => {
  it('rejects target config containing onMismatch (field removed from schema)', () => {
    const result = criterionTargetSchema.strict().safeParse({
      expectedText: '980 kcal left',
      onMismatch: 'warn'
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid target config without onMismatch', () => {
    const result = criterionTargetSchema.strict().safeParse({
      expectedText: '980 kcal left',
      anchorDescription: 'rounded kcal-left pill',
      mustNotMatch: ['1,420', 'of 2,400']
    });
    expect(result.success).toBe(true);
  });
});
