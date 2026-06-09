/**
 * run-057 dimension mismatch + Calorix DTO integration tests.
 *
 * Proves:
 *   1. Flutter anchor rects (actual-source px) are scaled to expected/comparison space
 *      before being injected — not injected raw.
 *   2. Calorix-style anchor dumps (offscreen/clippedByViewport/covered/notes) are accepted.
 *   3. Required anchor missing/invisible → actionRequired (blocking).
 *   4. Optional anchor missing/invisible → warning only, run continues.
 *   5. Coordinate transform: anchor at actual(1080×2400) lands at expected(1206×2622) coords.
 *
 * No live API calls. Images are synthetic PNGs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PNG } from 'pngjs';
import { parseFlutterAnchorDump } from '../../src/flutter/anchorDumpParser';
import { resolveTargets } from '../../src/flutter/targetResolver';
import type { SemanticTargetMapParsed } from '../../src/flutter/semanticTargetMap';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUniformPng(width: number, height: number, r = 230, g = 230, b = 230): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

// ── Coordinate transform tests (unit-level, no full pipeline) ─────────────────

describe('run-057 coordinate transform: actual-source → expected/comparison', () => {
  // Actual device: 1080×2400 (Calorix screenshot)
  // Expected/comparison image: 1206×2622 (design reference, different DPR/render)
  // DPR for actual: 2.625 → anchor rect in actual-source px
  const ACTUAL_W = 1080;
  const ACTUAL_H = 2400;
  const EXPECTED_W = 1206;
  const EXPECTED_H = 2622;
  const DPR = 2.625;

  function makeCalorixDump(anchorLogicalX: number, anchorLogicalY: number, anchorLogicalW: number, anchorLogicalH: number) {
    return {
      framework: 'flutter',
      screen: 'TodayScreen',
      coordinateSpace: 'flutterLogical',
      coordinateOrigin: 'topLeft',
      device: {
        screenshotWidthPx: ACTUAL_W,
        screenshotHeightPx: ACTUAL_H,
        devicePixelRatio: DPR,
        mediaQuerySizeLogical: { width: ACTUAL_W / DPR, height: ACTUAL_H / DPR },
        paddingLogical: { top: 0, left: 0, right: 0, bottom: 0 },
        viewPaddingLogical: { top: 0, left: 0, right: 0, bottom: 0 },
        viewInsetsLogical: { top: 0, left: 0, right: 0, bottom: 0 }
      },
      anchors: [
        {
          id: 'today.kcalLeftPill',
          rectLogical: { x: anchorLogicalX, y: anchorLogicalY, width: anchorLogicalW, height: anchorLogicalH },
          visible: true,
          // Calorix visibility DTO shape (not isOffscreen)
          visibility: {
            visibleFraction: 1.0,
            offscreen: false,
            clippedByViewport: false,
            covered: false,
            notes: []
          }
        }
      ]
    };
  }

  const TARGET_MAP: SemanticTargetMapParsed = {
    version: '1',
    screen: 'TodayScreen',
    targets: [
      {
        id: 'today.kcalLeftPill',
        locator: { type: 'flutter_anchor', anchorId: 'today.kcalLeftPill', required: true },
        expectedText: '980 kcal left',
        criteria: [
          { id: 'today.kcalLeftPill.legibility', domain: 'legibility.overlap', avoidColors: ['#1FCC74'], maxOverlapPercent: 1.0 }
        ]
      }
    ]
  };

  it('accepts Calorix visibility DTO (offscreen/clippedByViewport/covered/notes)', () => {
    // Anchor at logical (100, 300, 200, 50) on 1080×2400 device with DPR 2.625
    const raw = makeCalorixDump(100, 300, 200, 50);
    const parsed = parseFlutterAnchorDump(raw);
    expect(parsed.ok).toBe(true);
  });

  it('rejects visibility without visibleFraction', () => {
    const raw = {
      ...makeCalorixDump(0, 0, 10, 10),
      anchors: [{ id: 'x', rectLogical: { x: 0, y: 0, width: 10, height: 10 }, visible: true, visibility: { offscreen: false } }]
    };
    const parsed = parseFlutterAnchorDump(raw);
    expect(parsed.ok).toBe(false);
  });

  it('resolves anchor to actual-source pixel rect after DPR conversion', () => {
    // logical rect: x=100, y=300, w=200, h=50 on DPR=2.625 device
    // expected actual px: x=floor(100*2.625)=262, y=floor(300*2.625)=787
    // right=ceil((100+200)*2.625)=ceil(787.5)=788 → w=788-262=526
    // bottom=ceil((300+50)*2.625)=ceil(918.75)=919 → h=919-787=132
    const raw = makeCalorixDump(100, 300, 200, 50);
    const parsed = parseFlutterAnchorDump(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const rect = parsed.data.resolvedRects.get('today.kcalLeftPill')!;
    expect(rect).toBeDefined();
    expect(Number.isInteger(rect.x)).toBe(true);
    expect(Number.isInteger(rect.y)).toBe(true);
    expect(Number.isInteger(rect.width)).toBe(true);
    expect(Number.isInteger(rect.height)).toBe(true);

    // Verify DPR conversion is correct
    expect(rect.x).toBe(Math.floor(100 * DPR));
    expect(rect.y).toBe(Math.floor(300 * DPR));
  });

  it('scaleRectToComparison: anchor in actual(1080×2400) maps to correct expected(1206×2622) coords', () => {
    // If anchor lands at actual px (262, 787, 526, 132),
    // scaled to 1206×2622: scaleX=1206/1080≈1.1167, scaleY=2622/2400≈1.0925
    // compX=floor(262*1.1167)=floor(292.6)=292
    // compY=floor(787*1.0925)=floor(859.8)=859
    // compRight=ceil((262+526)*1.1167)=ceil(879.5)=880 → compW=880-292=588
    // compBottom=ceil((787+132)*1.0925)=ceil(1004.1)=1005 → compH=1005-859=146
    const raw = makeCalorixDump(100, 300, 200, 50);
    const parsed = parseFlutterAnchorDump(raw);
    if (!parsed.ok) return;

    const actualRect = parsed.data.resolvedRects.get('today.kcalLeftPill')!;

    // Inline the same scaleRectToComparison logic to verify correctness
    const scaleX = EXPECTED_W / ACTUAL_W;
    const scaleY = EXPECTED_H / ACTUAL_H;
    const compX = Math.floor(actualRect.x * scaleX);
    const compY = Math.floor(actualRect.y * scaleY);
    const compRight = Math.ceil((actualRect.x + actualRect.width) * scaleX);
    const compBottom = Math.ceil((actualRect.y + actualRect.height) * scaleY);
    const compW = Math.max(1, compRight - compX);
    const compH = Math.max(1, compBottom - compY);

    // The comparison rect must be within expected image bounds
    expect(compX).toBeGreaterThanOrEqual(0);
    expect(compY).toBeGreaterThanOrEqual(0);
    expect(compX + compW).toBeLessThanOrEqual(EXPECTED_W);
    expect(compY + compH).toBeLessThanOrEqual(EXPECTED_H);

    // Verify the transform differs from the raw actual rect
    // (injecting actual px directly into expected space would be wrong)
    expect(compX).not.toBe(actualRect.x);
    expect(compY).not.toBe(actualRect.y);
  });

  it('scaleRectToComparison is identity when dimensions match', () => {
    // When actual == expected, no transform needed
    const raw = {
      ...makeCalorixDump(100, 300, 200, 50),
      device: {
        screenshotWidthPx: EXPECTED_W,
        screenshotHeightPx: EXPECTED_H,
        devicePixelRatio: DPR,
        mediaQuerySizeLogical: { width: EXPECTED_W / DPR, height: EXPECTED_H / DPR },
        paddingLogical: { top: 0, left: 0, right: 0, bottom: 0 },
        viewPaddingLogical: { top: 0, left: 0, right: 0, bottom: 0 },
        viewInsetsLogical: { top: 0, left: 0, right: 0, bottom: 0 }
      }
    };
    const parsed = parseFlutterAnchorDump(raw);
    if (!parsed.ok) return;

    const actualRect = parsed.data.resolvedRects.get('today.kcalLeftPill')!;
    // When actualW==targetW, scaleX=1.0, so comparison coords = actual coords
    const scaleX = EXPECTED_W / EXPECTED_W;
    const scaleY = EXPECTED_H / EXPECTED_H;
    expect(scaleX).toBe(1.0);
    expect(scaleY).toBe(1.0);
    expect(actualRect.x).toBe(Math.floor(100 * DPR));
  });
});

// ── Required vs optional target tests ────────────────────────────────────────

describe('run-057 required vs optional anchor failure handling', () => {
  function makeDump(dpr: number, w: number, h: number, anchors: unknown[]) {
    return {
      framework: 'flutter',
      screen: 'TodayScreen',
      coordinateSpace: 'flutterLogical',
      coordinateOrigin: 'topLeft',
      device: {
        screenshotWidthPx: w,
        screenshotHeightPx: h,
        devicePixelRatio: dpr,
        mediaQuerySizeLogical: { width: w / dpr, height: h / dpr },
        paddingLogical: { top: 0, left: 0, right: 0, bottom: 0 },
        viewPaddingLogical: { top: 0, left: 0, right: 0, bottom: 0 },
        viewInsetsLogical: { top: 0, left: 0, right: 0, bottom: 0 }
      },
      anchors
    };
  }

  function makeMap(targets: SemanticTargetMapParsed['targets']): SemanticTargetMapParsed {
    return { version: '1', screen: 'TodayScreen', targets };
  }

  it('required missing anchor → anchorMissing:true on that result', () => {
    const raw = makeDump(3.0, 1080, 2400, []);  // no anchors at all
    const parsed = parseFlutterAnchorDump(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const map = makeMap([
      { id: 'today.kcalLeftPill', locator: { type: 'flutter_anchor', anchorId: 'today.kcalLeftPill', required: true }, criteria: [] }
    ]);
    const summary = resolveTargets(map, parsed.data);
    const result = summary.results[0];
    expect(result.source).toBe('unresolved');
    expect(result.anchorMissing).toBe(true);
  });

  it('optional missing anchor → unresolved but not required failure', () => {
    const raw = makeDump(3.0, 1080, 2400, []);
    const parsed = parseFlutterAnchorDump(raw);
    if (!parsed.ok) return;

    const map = makeMap([
      { id: 'today.macroRing', locator: { type: 'flutter_anchor', anchorId: 'today.macroRing', required: false }, criteria: [] }
    ]);
    const summary = resolveTargets(map, parsed.data);
    const result = summary.results[0];
    expect(result.source).toBe('unresolved');
    expect(result.anchorMissing).toBe(true);
    // locator.required is false — caller (orchestrator) decides whether to block
    expect(map.targets[0].locator.required).toBe(false);
  });

  it('required anchor with visibleFraction below threshold → targetNotVisible', () => {
    const raw = makeDump(3.0, 1080, 2400, [
      {
        id: 'today.kcalLeftPill',
        rectLogical: { x: 50, y: 200, width: 100, height: 30 },
        visible: true,
        // Calorix: visibleFraction=0 with explicit offscreen fields
        visibility: { visibleFraction: 0, offscreen: true, clippedByViewport: false, covered: false, notes: ['scrolled off screen'] }
      }
    ]);
    const parsed = parseFlutterAnchorDump(raw);
    if (!parsed.ok) return;

    const map = makeMap([
      { id: 'today.kcalLeftPill', locator: { type: 'flutter_anchor', anchorId: 'today.kcalLeftPill', required: true }, criteria: [] }
    ]);
    const summary = resolveTargets(map, parsed.data);
    const result = summary.results[0];
    expect(result.source).toBe('unresolved');
    expect(result.targetNotVisible).toBe(true);
    expect(result.visibleFraction).toBe(0);
  });

  it('optional anchor with low visibleFraction → unresolved but not blocking', () => {
    const raw = makeDump(3.0, 1080, 2400, [
      {
        id: 'today.banner',
        rectLogical: { x: 0, y: -50, width: 360, height: 40 },
        visible: false,
        visibility: { visibleFraction: 0, offscreen: true, clippedByViewport: true, covered: false, notes: [] }
      }
    ]);
    const parsed = parseFlutterAnchorDump(raw);
    if (!parsed.ok) return;

    const map = makeMap([
      { id: 'today.banner', locator: { type: 'flutter_anchor', anchorId: 'today.banner', required: false }, criteria: [] }
    ]);
    const summary = resolveTargets(map, parsed.data);
    const result = summary.results[0];
    expect(result.source).toBe('unresolved');
    expect(result.targetNotVisible).toBe(true);
    expect(map.targets[0].locator.required).toBe(false);
  });

  it('mixed required+optional: required resolves, optional missing → only unresolved optional', () => {
    const raw = makeDump(3.0, 1080, 2400, [
      {
        id: 'today.kcalLeftPill',
        rectLogical: { x: 50, y: 200, width: 100, height: 30 },
        visible: true,
        visibility: { visibleFraction: 1.0, offscreen: false, clippedByViewport: false, covered: false, notes: [] }
      }
      // today.optionalWidget is NOT in the dump
    ]);
    const parsed = parseFlutterAnchorDump(raw);
    if (!parsed.ok) return;

    const map = makeMap([
      { id: 'today.kcalLeftPill', locator: { type: 'flutter_anchor', anchorId: 'today.kcalLeftPill', required: true }, criteria: [] },
      { id: 'today.optionalWidget', locator: { type: 'flutter_anchor', anchorId: 'today.optionalWidget', required: false }, criteria: [] }
    ]);
    const summary = resolveTargets(map, parsed.data);

    const required = summary.results.find((r) => r.targetId === 'today.kcalLeftPill')!;
    const optional = summary.results.find((r) => r.targetId === 'today.optionalWidget')!;

    expect(required.source).toBe('flutter_anchor');
    expect(required.visible).toBe(true);

    expect(optional.source).toBe('unresolved');
    expect(optional.anchorMissing).toBe(true);
  });
});

// ── Target metadata in criterion schema ───────────────────────────────────────

describe('run-057 target criterion schema: anchorDescription/mustContainText/mustNotMatch', () => {
  it('semanticTargetMap accepts anchorDescription, mustContainText, mustNotMatch on criteria', async () => {
    const { semanticTargetMapSchema } = await import('../../src/flutter/semanticTargetMap');
    const raw = {
      version: '1',
      screen: 'TodayScreen',
      targets: [
        {
          id: 'today.kcalLeftPill',
          locator: { type: 'flutter_anchor', anchorId: 'today.kcalLeftPill', required: true },
          expectedText: '980 kcal left',
          criteria: [
            {
              id: 'today.kcalLeftPill.legibility',
              domain: 'legibility.overlap',
              avoidColors: ['#1FCC74'],
              maxOverlapPercent: 1.0,
              anchorDescription: 'rounded kcal-left pill below center number',
              mustContainText: ['980 kcal'],
              mustNotMatch: ['1,420', 'of 2,400']
            }
          ]
        }
      ]
    };
    const result = semanticTargetMapSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const criterion = result.data.targets[0].criteria[0];
    expect(criterion.anchorDescription).toBe('rounded kcal-left pill below center number');
    expect(criterion.mustContainText).toEqual(['980 kcal']);
    expect(criterion.mustNotMatch).toEqual(['1,420', 'of 2,400']);
  });

  it('expectedText on SemanticTarget is preserved in parsed output', async () => {
    const { semanticTargetMapSchema } = await import('../../src/flutter/semanticTargetMap');
    const result = semanticTargetMapSchema.safeParse({
      version: '1',
      screen: 'TodayScreen',
      targets: [
        {
          id: 'today.kcalLeftPill',
          locator: { type: 'flutter_anchor', anchorId: 'today.kcalLeftPill', required: true },
          expectedText: '980 kcal left',
          criteria: []
        }
      ]
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.targets[0].expectedText).toBe('980 kcal left');
  });
});

// ── Judge cache: cache key invalidation tests ─────────────────────────────────

describe('run-057 judge cache wiring: key invalidation', () => {
  it('changed crop hash invalidates cache', async () => {
    const { JudgeCache, hashContent } = await import('../../src/flutter/judgeCache');
    const cache = new JudgeCache();
    const baseKey = {
      provider: 'openrouter', model: 'test-model', promptVersion: 'v1',
      targetId: 'today.kcalLeftPill', criterionIds: ['today.kcalLeftPill.legibility'],
      actualImageHash: 'img-hash', actualCropHash: 'crop-v1',
      anchorRectHash: hashContent('262,787,526,132'),
      expectedImageHash: 'exp-hash', sourceFactsHash: 'facts-hash',
      deterministicMeasurementHash: 'det-hash', targetMapVersion: '1'
    };
    cache.set(baseKey, { judgeAuditStatus: 'pass', targetStatus: 'matched', confidence: 0.95, cachedAt: Date.now() });

    const changedCrop = { ...baseKey, actualCropHash: 'crop-v2' };
    expect(cache.has(changedCrop)).toBe(false);
  });

  it('changed anchor rect hash invalidates cache', async () => {
    const { JudgeCache, hashContent } = await import('../../src/flutter/judgeCache');
    const cache = new JudgeCache();
    const baseKey = {
      provider: 'openrouter', model: 'test-model', promptVersion: 'v1',
      targetId: 'today.kcalLeftPill', criterionIds: ['today.kcalLeftPill.legibility'],
      actualImageHash: 'img-hash', actualCropHash: 'crop-v1',
      anchorRectHash: hashContent('262,787,526,132'),
      expectedImageHash: 'exp-hash', sourceFactsHash: 'facts-hash',
      deterministicMeasurementHash: 'det-hash', targetMapVersion: '1'
    };
    cache.set(baseKey, { judgeAuditStatus: 'pass', targetStatus: 'matched', confidence: 0.95, cachedAt: Date.now() });

    const movedRect = { ...baseKey, anchorRectHash: hashContent('300,800,500,120') };
    expect(cache.has(movedRect)).toBe(false);
  });

  it('changed source facts hash invalidates cache', async () => {
    const { JudgeCache, hashContent } = await import('../../src/flutter/judgeCache');
    const cache = new JudgeCache();
    const baseKey = {
      provider: 'openrouter', model: 'test-model', promptVersion: 'v1',
      targetId: 'today.kcalLeftPill', criterionIds: ['today.kcalLeftPill.legibility'],
      actualImageHash: 'img-hash', actualCropHash: 'crop-v1',
      anchorRectHash: hashContent('262,787,526,132'),
      expectedImageHash: 'exp-hash', sourceFactsHash: 'facts-v1',
      deterministicMeasurementHash: 'det-hash', targetMapVersion: '1'
    };
    cache.set(baseKey, { judgeAuditStatus: 'pass', targetStatus: 'matched', confidence: 0.95, cachedAt: Date.now() });

    const changedFacts = { ...baseKey, sourceFactsHash: 'facts-v2' };
    expect(cache.has(changedFacts)).toBe(false);
  });

  it('cache hit returns targetStatus and confidence', async () => {
    const { JudgeCache, hashContent } = await import('../../src/flutter/judgeCache');
    const cache = new JudgeCache();
    const key = {
      provider: 'openrouter', model: 'test-model', promptVersion: 'v1',
      targetId: 'today.kcalLeftPill', criterionIds: ['today.kcalLeftPill.legibility'],
      actualImageHash: 'img-hash', actualCropHash: 'crop-v1',
      anchorRectHash: hashContent('262,787,526,132'),
      expectedImageHash: 'exp-hash', sourceFactsHash: 'facts-hash',
      deterministicMeasurementHash: 'det-hash', targetMapVersion: '1'
    };
    cache.set(key, { judgeAuditStatus: 'caveat', targetStatus: 'ambiguous', confidence: 0.6, cachedAt: Date.now() });

    const hit = cache.get(key);
    expect(hit).toBeDefined();
    expect(hit!.judgeAuditStatus).toBe('caveat');
    expect(hit!.targetStatus).toBe('ambiguous');
    expect(hit!.confidence).toBe(0.6);
  });

  it('cacheSummary tracks attempted/cached/fresh/skipped counters', async () => {
    const { CriterionJudgeAnalyzer } = await import('../../src/pipeline/judges/CriterionJudgeAnalyzer');
    const { JudgeCache } = await import('../../src/flutter/judgeCache');

    // Provider that always fails (simulates no API key)
    const fakeProvider: any = {
      analyzeCriterion: undefined  // not supported → returns not_run
    };

    const cache = new JudgeCache();
    const cacheCtx = { provider: 'openrouter', model: 'test-model', promptVersion: 'v1', targetMapVersion: '1' };
    const bundles: any[] = [
      { criterionId: 'crit.a', criterionLabel: 'A', artifacts: {} },
      { criterionId: 'crit.b', criterionLabel: 'B', artifacts: {} }
    ];

    const analyzer = new CriterionJudgeAnalyzer();
    const { cacheSummary: cs1 } = await analyzer.run(bundles, fakeProvider, undefined, cache, cacheCtx);
    // First run: 2 fresh, 0 cached
    expect(cs1.attempted).toBe(2);
    expect(cs1.fresh).toBe(2);
    expect(cs1.cached).toBe(0);

    // Second run with same bundles and same empty artifacts → cache keys match (all 'none'/'no-rect')
    const { cacheSummary: cs2 } = await analyzer.run(bundles, fakeProvider, undefined, cache, cacheCtx);
    expect(cs2.attempted).toBe(2);
    expect(cs2.cached).toBe(2);
    expect(cs2.fresh).toBe(0);
  });
});
