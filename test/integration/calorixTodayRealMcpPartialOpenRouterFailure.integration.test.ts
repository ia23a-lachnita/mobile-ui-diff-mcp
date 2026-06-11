/**
 * Real-MCP-path regression for Calorix Today partial OpenRouter primary failure.
 *
 * What is real:
 *   - Expected image: synthetic 1080×2400 px PNG (SM-G780G dimensions) with opaque pixels
 *     in the pill and macro-ring bounding boxes — sufficient for deterministic clearance measurement
 *   - Target map: mirrors real today-anchor-target-map.json (today.kcalLeftPill + today.macroRingHero)
 *   - ROI layout: mirrors Calorix ui-diff.config.json (macro-ring-hero, macro-rows, meal-cards)
 *   - modelJudges config: matches Calorix production (openrouter primary + nvidia reviewer, required)
 *   - Flutter anchor resolution: runs end-to-end (synthesized anchor coordinates, DPR=3, SM-G780G)
 *   - Pipeline entrypoint: runScreenUiDiff (same as all MCP integration tests)
 *   - OpenRouterProvider: REAL class — only the HTTP fetch layer is mocked
 *   - NvidiaProvider: REAL class — only the HTTP fetch layer is mocked
 *   - ModelJudgeAnalyzer, RunOrchestrator: REAL — not mocked
 *
 * What is mocked:
 *   - globalThis.fetch — intercepted per-URL, request-body-aware
 *     - openrouter.ai: macro-rows → success; all other ROIs / global → {choices:[]} (missing content)
 *     - nvidia: reviewer → success for any ROI
 *     - criterion judge calls (CRITERION ID / CRITERIA TO EVALUATE) → pass
 *
 * All fixture content is generated programmatically so the test is fully self-contained.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PNG } from 'pngjs';
import { runScreenUiDiff } from '../../src/tools/runScreenUiDiff';

// ── Fixture dimensions (SM-G780G @ DPR=3) ───────────────────────────────────

const IMG_W = 1080;
const IMG_H = 2400;
const DPR = 3;

// Logical anchor coordinates (Flutter logical pixels)
const PILL_LOGICAL = { x: 128, y: 280, width: 104, height: 22 };
const RING_LOGICAL = { x: 4,   y: 112, width: 352, height: 200 };

// Physical pixel coordinates (logical × DPR)
const PILL_PX = { x: PILL_LOGICAL.x * DPR, y: PILL_LOGICAL.y * DPR, width: PILL_LOGICAL.width * DPR, height: PILL_LOGICAL.height * DPR };
const RING_PX = { x: RING_LOGICAL.x * DPR, y: RING_LOGICAL.y * DPR, width: RING_LOGICAL.width * DPR, height: RING_LOGICAL.height * DPR };

// ── Synthetic image builder ──────────────────────────────────────────────────

function makeSyntheticPng(): Buffer {
  const png = new PNG({ width: IMG_W, height: IMG_H });
  // Fill with dark opaque background — all pixels fully opaque so collectPillMask sees them
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 12;     // r
    png.data[i + 1] = 14; // g
    png.data[i + 2] = 18; // b
    png.data[i + 3] = 255; // a (fully opaque)
  }
  // Pill area: slightly brighter green so it reads as pill content
  for (let y = PILL_PX.y; y < PILL_PX.y + PILL_PX.height; y++) {
    for (let x = PILL_PX.x; x < PILL_PX.x + PILL_PX.width; x++) {
      const idx = (y * IMG_W + x) << 2;
      png.data[idx] = 28; png.data[idx + 1] = 186; png.data[idx + 2] = 100; png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

// ── Fixture JSON builders ────────────────────────────────────────────────────

function makeAnchorJson(): string {
  return JSON.stringify({
    framework: 'flutter',
    screen: 'TodayScreen',
    coordinateSpace: 'flutterLogical',
    coordinateOrigin: 'topLeft',
    device: {
      screenshotWidthPx: IMG_W, screenshotHeightPx: IMG_H,
      devicePixelRatio: DPR,
      mediaQuerySizeLogical: { width: 360, height: 800 },
      paddingLogical: { top: 24, left: 0, right: 0, bottom: 0 },
      viewPaddingLogical: { top: 24, left: 0, right: 0, bottom: 44 },
      viewInsetsLogical: { top: 0, left: 0, right: 0, bottom: 0 }
    },
    anchors: [
      { id: 'today.kcalLeftPill',   rectLogical: PILL_LOGICAL, visible: true, visibility: { visibleFraction: 1, offscreen: false } },
      { id: 'today.macroRingHero', rectLogical: RING_LOGICAL, visible: true, visibility: { visibleFraction: 1, offscreen: false } }
    ]
  }, null, 2);
}

function makeTargetMapJson(): string {
  return JSON.stringify({
    version: '1',
    screen: 'today',
    targets: [
      {
        id: 'today.kcalLeftPill',
        locator: { type: 'flutter_anchor', anchorId: 'today.kcalLeftPill', required: true },
        expectedText: '980 kcal left',
        criteria: [{
          id: 'today.kcalLeftPill.legibility',
          domain: 'legibility.overlap',
          anchorDescription: 'rounded kcal-left pill below the central calorie value, near the lower part of the macro ring',
          mustContainText: ['980 kcal left'],
          mustNotMatch: ['1,420', 'of 2,400', 'central calorie value', 'center calorie text'],
          avoidColors: ['#1FCC74'],
          minClearancePx: 4,
          maxOverlapPercent: 1.0,
          severity: 'warning'
        }]
      },
      {
        id: 'today.macroRingHero',
        locator: { type: 'flutter_anchor', anchorId: 'today.macroRingHero', required: false },
        criteria: []
      }
    ]
  }, null, 2);
}

// ── HTTP mock helpers ─────────────────────────────────────────────────────────

function extractPromptText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textPart = (content as any[]).find((c) => c?.type === 'text');
    return typeof textPart?.text === 'string' ? textPart.text : '';
  }
  return '';
}

/** Minimal valid ROI audit success evidence payload. */
function roiSuccessBody(roiId: string, claimId: string): string {
  return JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          evidence: [{
            claimId,
            subject: `roi:${roiId}`,
            polarity: 'match',
            claim: `${roiId} matches expected layout.`,
            confidence: 0.91,
            severity: 'info',
            blocking: false
          }]
        })
      }
    }]
  });
}

/** Minimal valid reviewer success evidence payload. */
function reviewerSuccessBody(roiId: string): string {
  return JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          evidence: [{
            claimId: `nvidia-${roiId}-no-issues`,
            subject: `roi:${roiId}`,
            polarity: 'match',
            claim: `NVIDIA reviewer: no visual parity issue for ${roiId}.`,
            confidence: 0.87,
            severity: 'info',
            blocking: false
          }]
        })
      }
    }]
  });
}

/** Criterion pass payload — flat object with targetStatus at top level (callCriterionWithRetry shape). */
function criterionPassBody(criterionId: string): string {
  return JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          criterionId,
          targetStatus: 'matched',
          judgeAuditStatus: 'pass',
          reasoning: 'Pill is visible and clear of arc constraint.',
          confidence: 0.80
        })
      }
    }]
  });
}

/** Bad OpenRouter envelope — simulates the actual Calorix Today failure mode. */
const MISSING_CONTENT_BODY = JSON.stringify({
  id: 'calorix-repro-missing-content',
  choices: []
});

function buildFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const prompt = extractPromptText(body?.messages?.[0]?.content ?? '');

    // ── NVIDIA reviewer ───────────────────────────────────────────────────
    if (urlStr.includes('nvidia')) {
      // Criterion calls share the same NVIDIA endpoint — route before ROI reviewer check
      if (prompt.includes('CRITERION ID:') || prompt.includes('CRITERIA TO EVALUATE')) {
        const criterionMatch = /CRITERION ID:\s*(\S+)/.exec(prompt);
        const criterionId = criterionMatch?.[1] ?? 'today.kcalLeftPill.legibility';
        return new Response(criterionPassBody(criterionId), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const roiMatch = /ROI:\s*(\S+)/.exec(prompt);
      const roiId = roiMatch?.[1] ?? 'global';
      return new Response(reviewerSuccessBody(roiId), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // ── OpenRouter ────────────────────────────────────────────────────────
    if (urlStr.includes('openrouter.ai')) {
      // Criterion judge calls (single or batch)
      if (prompt.includes('CRITERION ID:') || prompt.includes('CRITERIA TO EVALUATE')) {
        const criterionMatch = /CRITERION ID:\s*(\S+)/.exec(prompt);
        const criterionId = criterionMatch?.[1] ?? 'today.kcalLeftPill.legibility';
        return new Response(criterionPassBody(criterionId), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // ROI audit: macro-rows is the one success — mirrors the real failure where
      // the ring/meal/global bundles got {choices:[]} from OpenRouter.
      if (prompt.includes('ROI: macro-rows')) {
        return new Response(roiSuccessBody('macro-rows', 'openrouter-macro-rows-match'), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // All other ROI / global audit calls → missing content (real failure mode)
      return new Response(MISSING_CONTENT_BODY, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    throw new Error(`[test] Unexpected fetch URL — add a handler: ${urlStr}`);
  });
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

let tmpDir: string;
let savedOpenRouterKey: string | undefined;
let savedNvidiaKey: string | undefined;
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'calorix-today-mcp-real-'));
  savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
  savedNvidiaKey = process.env.NVIDIA_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-calorix-real';
  process.env.NVIDIA_API_KEY = 'test-nvidia-calorix-real';
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
  if (savedNvidiaKey === undefined) delete process.env.NVIDIA_API_KEY;
  else process.env.NVIDIA_API_KEY = savedNvidiaKey;
});

async function buildAnchorDir(): Promise<string> {
  const dir = path.join(tmpDir, 'flutter-anchors');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'flutter-anchors.json'), makeAnchorJson());
  await fs.writeFile(path.join(dir, 'flutter-anchors.done'), '');
  return dir;
}

async function buildConfig(expectedImagePath: string, outputDir: string): Promise<string> {
  const configPath = path.join(tmpDir, 'ui-diff.config.json');
  await fs.writeFile(configPath, JSON.stringify({
    screens: {
      today: {
        platform: 'none',
        expectedImage: expectedImagePath,
        outputDir,
        maxDiffPercent: 1,
        visualAuditMode: 'visual_parity',
        regionsOfInterest: [
          {
            id: 'macro-ring-hero',
            label: 'Macro Ring Hero Card',
            type: 'component',
            critical: true,
            box: { x: 0.01, y: 0.14, width: 0.98, height: 0.25 },
            coordinateSpace: 'normalized',
            maxDiffPercent: 0.12
          },
          {
            id: 'macro-rows',
            label: 'Macro Progress Rows',
            type: 'component',
            box: { x: 0.01, y: 0.39, width: 0.98, height: 0.12 },
            coordinateSpace: 'normalized',
            maxDiffPercent: 0.15
          },
          {
            id: 'meal-cards',
            label: 'Meal Cards Section',
            type: 'component',
            box: { x: 0.01, y: 0.51, width: 0.98, height: 0.40 },
            coordinateSpace: 'normalized',
            maxDiffPercent: 0.25
          }
        ],
        modelJudges: {
          enabled: true,
          required: true,
          policy: 'always_audit',
          primary: { provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' },
          reviewer: { provider: 'nvidia', model: 'nvidia/nemotron-nano-12b-v2-vl' },
          requireConsensusForCodeHints: true,
          allowEditSuggestionsOnPass: false,
          timeoutMs: 45000,
          maxRetries: 1,
          retryOnParseError: true
        }
      }
    }
  }, null, 2));
  return configPath;
}

// ── Test ──────────────────────────────────────────────────────────────────────

describe('calorixTodayRealMcpPartialOpenRouterFailure', () => {
  it('partialPrimaryFailureBlocksAcceptanceWithRealProviders', { timeout: 30000 }, async () => {
    // Patch globalThis.fetch directly — vi.stubGlobal does not reliably intercept
    // the Node.js built-in undici fetch used by provider modules at call time.
    const mockFetch = buildFetchMock();
    globalThis.fetch = mockFetch as any;

    // Build synthetic expected image (1080×2400, SM-G780G dimensions, fully opaque)
    const expectedImagePath = path.join(tmpDir, 'expected.png');
    await fs.writeFile(expectedImagePath, makeSyntheticPng());

    const outputDir = path.join(tmpDir, 'output');
    await fs.mkdir(outputDir, { recursive: true });
    const anchorDir = await buildAnchorDir();
    const configPath = await buildConfig(expectedImagePath, outputDir);

    const targetMapPath = path.join(tmpDir, 'target-map.json');
    await fs.writeFile(targetMapPath, makeTargetMapJson());

    // Run the real MCP pipeline — same entrypoint used by all integration tests.
    // actualImage = expectedImage → zero pixel diff, isolates model judge path.
    const report = await runScreenUiDiff({
      screen: 'today',
      configPath,
      actualImage: expectedImagePath,
      runName: 'calorix-today-real-mcp-partial',
      targetMapPath,
      flutterAnchorsPath: anchorDir
    });

    // ── Sentinel leak guard ───────────────────────────────────────────────
    const reportJson = JSON.stringify(report);
    expect(reportJson, 'report must not contain <missing_error_detail>').not.toContain('<missing_error_detail>');
    expect(reportJson, 'report must not contain unknown_empty_failure').not.toContain('unknown_empty_failure');
    expect(reportJson, 'report must not contain empty rawResponsePreview string').not.toMatch(/"rawResponsePreview":""/);

    // ── Required judge failure blocks acceptance ───────────────────────────
    expect(report.modelJudgesSummary?.required, 'modelJudges must be required').toBe(true);
    expect(report.visualAuditStatus, 'visualAuditStatus must be error').toBe('error');
    expect(report.acceptanceStatus, 'acceptanceStatus must be rejected').toBe('rejected');
    expect(report.actionRequired?.type, 'actionRequired.type must be model_judges_failed').toBe('model_judges_failed');
    expect(report.actionRequired?.message, 'failure message must not say visual mismatch').not.toMatch(/visual mismatch|visual verdict/i);

    // ── Primary partial success ───────────────────────────────────────────
    const primary = report.modelJudgesSummary?.primary;
    expect(primary, 'primary summary must exist').toBeDefined();
    expect(primary!.status, 'primary status must be partial').toBe('partial');
    expect(primary!.hadSuccess, 'primary had at least one success (macro-rows)').toBe(true);
    expect(primary!.evidenceCount, 'primary has success evidence').toBeGreaterThanOrEqual(1);
    expect(primary!.errorCount, 'primary has at least one error').toBeGreaterThanOrEqual(1);
    expect(primary!.provider, 'primary provider is openrouter').toBe('openrouter');
    expect(primary!.model, 'primary model is qwen3').toBe('qwen/qwen3-vl-235b-a22b-instruct');

    // ── Exact Calorix failure topology ────────────────────────────────────
    // macro-ring-hero, meal-cards, and global must each appear in failedRois.
    // macro-rows must not — it was the one ROI that returned valid evidence.
    const failedRois = report.modelJudgesSummary?.failedRois ?? [];
    const openrouterFailed = failedRois.filter((r) => r.provider === 'openrouter');

    const failedIds = failedRois.map((r) => r.roiId);
    expect(failedIds, 'macro-rows succeeded and must not be in failedRois').not.toContain('macro-rows');

    const EXPECTED_FAILED = ['macro-ring-hero', 'meal-cards', 'global'] as const;
    const VALID_FAILURE_REASONS = new Set(['provider_response_missing_content', 'empty_response']);

    for (const roiId of EXPECTED_FAILED) {
      const entry = openrouterFailed.find((r) => r.roiId === roiId);
      expect(entry, `${roiId} must be present in failedRois`).toBeDefined();
      expect(
        VALID_FAILURE_REASONS.has(entry!.failureReason),
        `${roiId} failureReason must be provider_response_missing_content or empty_response, got '${entry!.failureReason}'`
      ).toBe(true);
      expect(entry!.rawResponsePreview, `${roiId} rawResponsePreview must be non-empty`).toBeTruthy();
      expect(entry!.rawResponsePreview, `${roiId} must not have empty string preview`).not.toBe('');
      expect(entry!.rawResponsePreview, `${roiId} must not have <missing_error_detail> sentinel`).not.toBe('<missing_error_detail>');
      expect(entry!.failureReason, `${roiId} must not have unknown_empty_failure sentinel`).not.toBe('unknown_empty_failure');
    }

    // Exactly those three failed — not more, not fewer from OpenRouter primary
    const openrouterFailedIds = openrouterFailed.map((r) => r.roiId).sort();
    expect(openrouterFailedIds, 'OpenRouter primary failed on exactly macro-ring-hero, meal-cards, global').toEqual(
      [...EXPECTED_FAILED].sort()
    );

    // ── Flutter anchor target resolution ──────────────────────────────────
    expect(
      report.targetResolutionSummary?.resolvedViaFlutterAnchor,
      'today.kcalLeftPill must resolve via flutter_anchor'
    ).toBeGreaterThanOrEqual(1);
    expect(
      report.targetResolutionSummary?.resolvedViaManualFallback,
      'no target must fall back to manual ROI box'
    ).toBe(0);
    expect(report.measurementBoxSource, 'measurementBoxSource must be flutter_anchor').toBe('flutter_anchor');

    // ── Deterministic pill criterion ran ─────────────────────────────────
    const legibilityRegion = report.overlapLegibilitySummary?.regions.find(
      (r) => r.id === 'today.kcalLeftPill.legibility'
    );
    expect(legibilityRegion, 'today.kcalLeftPill.legibility region must be present in overlapLegibilitySummary').toBeDefined();
    expect(legibilityRegion!.targetStatus, 'pill criterion target must be matched').toBe('matched');
    expect(
      ['pass', 'caveat', 'fail'],
      'pill criterion measurement must produce an honest result (not forced pass)'
    ).toContain(legibilityRegion!.measurementStatus);
    expect(legibilityRegion!.pillMaskPixelCount, 'pill mask must have pixels (pill box is non-empty)').toBeGreaterThan(0);
    expect(legibilityRegion!.diagnosticLayers, 'diagnostic layers must use renamed pill_mask label').toContain('pill_mask');
    expect(legibilityRegion!.diagnosticLayers, 'must not contain legacy pill_text_mask label').not.toContain('pill_text_mask');

    // ── Reviewer success does not override required primary failure ────────
    const reviewer = report.modelJudgesSummary?.reviewer;
    if (reviewer?.attempted) {
      expect(report.visualAuditStatus, 'reviewer success must not flip visualAuditStatus').toBe('error');
      expect(report.acceptanceStatus, 'reviewer success must not flip acceptanceStatus').toBe('rejected');
    }

    // ── Operational failure must not appear as a visual caveat ────────────
    const caveats = report.visualCaveats ?? [];
    for (const failed of openrouterFailed) {
      const matchingCaveat = caveats.find(
        (c) => c.source === 'modelJudge' && c.subject?.includes(failed.roiId)
      );
      expect(
        matchingCaveat,
        `provider_response_missing_content for ${failed.roiId} must not become a visual caveat`
      ).toBeUndefined();
    }

    // ── Mock routing counts — real pipeline generated the expected calls ──
    // Separate criterion calls from ROI/global audit calls by inspecting the prompt.
    const isRoiAuditCall = ([, init]: [unknown, RequestInit | undefined]) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const prompt = extractPromptText(body?.messages?.[0]?.content ?? '');
      return !prompt.includes('CRITERION ID:') && !prompt.includes('CRITERIA TO EVALUATE');
    };

    const openrouterAllCalls = mockFetch.mock.calls.filter(([u]) => String(u).includes('openrouter.ai'));
    expect(openrouterAllCalls.length, 'OpenRouter must have been called at least once').toBeGreaterThanOrEqual(1);

    // ROI audit calls: exactly 4 (macro-ring-hero, macro-rows, meal-cards, global) — no retries
    // because provider_response_missing_content is a hard return, not a parse-error retry.
    const openrouterRoiAuditCalls = openrouterAllCalls.filter(isRoiAuditCall);
    expect(openrouterRoiAuditCalls.length, 'OpenRouter must receive exactly 4 ROI/global audit calls').toBe(4);

    // Verify each of the 3 failing ROIs and global actually triggered an OpenRouter call.
    // This proves the real pipeline constructed and dispatched those bundles.
    for (const roiId of [...EXPECTED_FAILED, 'macro-rows'] as const) {
      const call = openrouterRoiAuditCalls.find(([, init]) => {
        const body = JSON.parse((init?.body as string) ?? '{}');
        const prompt = extractPromptText(body?.messages?.[0]?.content ?? '');
        return prompt.includes(`ROI: ${roiId}`);
      });
      expect(call, `OpenRouter must have received a ROI audit call for ${roiId}`).toBeDefined();
    }

    // No OpenRouter request fell through an unrecognized route — the mock only returns
    // MISSING_CONTENT for non-macro-rows, non-criterion calls and throws on unknown URLs.
  });
});
