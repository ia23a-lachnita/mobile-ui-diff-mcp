import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

let tmpDir: string;
let savedOpenRouterKey: string | undefined;
let savedNvidiaKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-partial-required-judge-'));
  savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
  savedNvidiaKey = process.env.NVIDIA_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  process.env.NVIDIA_API_KEY = 'test-nvidia-key';
  MockedOpenRouter.mockReset();
  MockedNvidia.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
  if (savedNvidiaKey === undefined) delete process.env.NVIDIA_API_KEY;
  else process.env.NVIDIA_API_KEY = savedNvidiaKey;
});

function makePng(width = 180, height = 240): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      png.data[idx] = 238;
      png.data[idx + 1] = 238;
      png.data[idx + 2] = 238;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function writeFile(name: string, content: Buffer | string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, content);
  return p;
}

async function writeConfig(expectedPath: string, outputDir: string): Promise<string> {
  return writeFile('ui-diff.config.json', JSON.stringify({
    screens: {
      today: {
        platform: 'none',
        expectedImage: expectedPath,
        outputDir,
        maxDiffPercent: 1,
        visualAuditMode: 'visual_parity',
        regionsOfInterest: [
          {
            id: 'macro-rows',
            label: 'Macro rows',
            type: 'component',
            critical: true,
            box: { x: 10, y: 10, width: 70, height: 50 },
            coordinateSpace: 'expected',
            maxDiffPercent: 1
          },
          {
            id: 'macro-ring-hero',
            label: 'Macro ring hero',
            type: 'component',
            critical: true,
            box: { x: 45, y: 75, width: 90, height: 90 },
            coordinateSpace: 'expected',
            maxDiffPercent: 1
          },
          {
            id: 'meal-cards',
            label: 'Meal cards',
            type: 'component',
            critical: true,
            box: { x: 10, y: 170, width: 160, height: 60 },
            coordinateSpace: 'expected',
            maxDiffPercent: 1
          }
        ],
        modelJudges: {
          enabled: true,
          required: true,
          policy: 'always_audit',
          primary: { provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' },
          reviewer: { provider: 'nvidia', model: 'nvidia/nemotron-nano-12b-v2-vl' }
        }
      }
    }
  }, null, 2));
}

describe('visualParity', () => {
  it('partialRequiredJudgeFailureBlocksAcceptance', async () => {
    // Mirrors the real Calorix partial failure: macro-rows succeeds; macro-ring-hero, meal-cards,
    // and global all fail with missing content (OpenRouter returned choices without message.content).
    MockedOpenRouter.mockImplementation(function () {
      return {
        analyze: vi.fn().mockImplementation(async (bundle: any) => {
          if (bundle.roiId === 'macro-rows') {
            return [{
              source: 'modelJudge',
              claimId: 'openrouter-macro-rows-match',
              subject: 'roi:macro-rows',
              claim: 'Macro rows match expected layout.',
              confidence: 0.91,
              authority: 'model',
              polarity: 'match',
              blocking: false
            }];
          }
          const failedRoiId = bundle.roiId as string;
          return [{
            source: 'modelJudge',
            claimId: `openrouter-error-${failedRoiId}`,
            subject: `roi:${failedRoiId}`,
            claim: 'OpenRouter response had no usable message content.',
            confidence: 0,
            authority: 'model',
            polarity: 'error',
            measurements: {
              error: 'provider_response_missing_content',
              failureReason: 'provider_response_missing_content',
              rawResponsePreview: '{"choices":[{"message":{}}]}'
            }
          }];
        })
      };
    } as any);

    MockedNvidia.mockImplementation(function () {
      return {
        analyze: vi.fn().mockImplementation(async (bundle: any) => [{
          source: 'modelJudge',
          claimId: `nvidia-${bundle.roiId}-match`,
          subject: `roi:${bundle.roiId}`,
          claim: `${bundle.roiId} has no visible parity issue.`,
          confidence: 0.88,
          authority: 'model',
          polarity: 'match',
          blocking: false
        }])
      };
    } as any);

    const img = makePng();
    const expectedPath = await writeFile('expected.png', img);
    const actualPath = await writeFile('actual.png', img);
    const configPath = await writeConfig(expectedPath, path.join(tmpDir, 'runs'));

    const report = await runScreenUiDiff({
      screen: 'today',
      configPath,
      actualImage: actualPath,
      runName: 'run-partial-required-judge-failure'
    });

    const reportJson = JSON.stringify(report);
    expect(reportJson).not.toContain('<missing_error_detail>');
    expect(reportJson).not.toContain('unknown_empty_failure');

    expect(report.modelJudgesSummary?.required).toBe(true);
    expect(report.modelJudgesSummary?.primary?.status).toBe('partial');
    expect(report.modelJudgesSummary?.primary?.hadSuccess).toBe(true);
    expect(report.modelJudgesSummary?.primary?.evidenceCount).toBeGreaterThanOrEqual(1);
    // macro-ring-hero + meal-cards + global all fail → at least 3 errors
    expect(report.modelJudgesSummary?.primary?.errorCount).toBeGreaterThanOrEqual(3);
    expect(report.modelJudgesSummary?.reviewer?.status).toBe('success');

    const openRouterEvidence = report.visualCaveats?.find((c) => c.id === 'openrouter-macro-rows-match')
      ?? report.modelJudgesSummary?.failedRois.find((r) => r.roiId === 'macro-rows' && r.provider === 'openrouter');
    expect(openRouterEvidence, 'OpenRouter successful ROI evidence should not be erased').toBeUndefined();
    expect(report.blockedModelFindings ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ claimId: 'openrouter-macro-rows-match' })])
    );

    // All three Calorix-shaped regions must appear as failed OpenRouter ROIs.
    const failedByRoi = (roiId: string) => report.modelJudgesSummary?.failedRois.find(
      (r) => r.provider === 'openrouter' && r.roiId === roiId
    );
    const expectedFailedRois = ['macro-ring-hero', 'meal-cards', 'global'];
    for (const roiId of expectedFailedRois) {
      const failed = failedByRoi(roiId);
      expect(failed, `OpenRouter failed ROI '${roiId}' must appear in failedRois`).toBeDefined();
      expect(failed!.failureReason).toMatch(/^(empty_response|invalid_json|provider_response_missing_content)$/);
      expect(failed!.rawResponsePreview).toBe('{"choices":[{"message":{}}]}');
    }

    expect(report.visualAuditStatus).toBe('error');
    expect(report.acceptanceStatus).toBe('rejected');
    expect(report.actionRequired?.type).toBe('model_judges_failed');
    expect(report.actionRequired?.message).toMatch(/operational|provider|failed|required/i);
    expect(report.actionRequired?.message).not.toMatch(/visual mismatch|visual verdict/i);
  });
});
