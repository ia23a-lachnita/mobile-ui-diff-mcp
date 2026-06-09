/**
 * Integration tests for run-057: Flutter anchor-based target resolution.
 *
 * Proves that:
 *   1. parseFlutterAnchorDump + resolveTargets produces flutter_anchor source
 *   2. No static phone x/y/w/h is required in the target map
 *   3. Missing anchor → not_evaluated / unresolved
 *   4. target_not_visible → unresolved, no measurement
 *   5. Device A/B: same target map, different anchor dumps, different rects
 *   6. Judge cache: multiple criteria → single batch key; changed crop → miss
 *   7. Anchor artifact reader: full round-trip with valid dump file
 *
 * No live API calls. No real Android device. No Today_1080.png.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { parseFlutterAnchorDump } from '../../src/flutter/anchorDumpParser';
import { resolveTargets } from '../../src/flutter/targetResolver';
import { waitForAnchorArtifact } from '../../src/flutter/anchorArtifactReader';
import { JudgeCache, hashRect, hashContent } from '../../src/flutter/judgeCache';
import { runDiscovery } from '../../src/flutter/discoveryWorkflow';
import type { SemanticTargetMapParsed } from '../../src/flutter/semanticTargetMap';

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const TARGET_MAP: SemanticTargetMapParsed = {
  version: '1',
  screen: 'TodayScreen',
  targets: [
    {
      id: 'today.kcalLeftPill',
      locator: { type: 'flutter_anchor', anchorId: 'today.kcalLeftPill', required: true },
      expectedText: '980 kcal left',
      criteria: [
        { id: 'today.kcalLeftPill.text', domain: 'text.content' },
        { id: 'today.kcalLeftPill.legibility', domain: 'legibility.overlap', avoidColors: ['#1FCC74'], maxOverlapPercent: 1.0, severity: 'warning' }
      ]
    },
    {
      id: 'today.macroRingLabel',
      locator: { type: 'flutter_anchor', anchorId: 'today.macroRingLabel', required: true },
      criteria: []
    }
  ]
};

function makeAnchorDump(dpr: number, screenshotW: number, screenshotH: number, anchors?: unknown[]) {
  const logicalW = screenshotW / dpr;
  const logicalH = screenshotH / dpr;
  return {
    framework: 'flutter',
    screen: 'TodayScreen',
    coordinateSpace: 'flutterLogical',
    coordinateOrigin: 'topLeft',
    device: {
      screenshotWidthPx: screenshotW,
      screenshotHeightPx: screenshotH,
      devicePixelRatio: dpr,
      mediaQuerySizeLogical: { width: logicalW, height: logicalH },
      paddingLogical: { top: 47, left: 0, right: 0, bottom: 0 },
      viewPaddingLogical: { top: 47, left: 0, right: 0, bottom: 0 },
      viewInsetsLogical: { top: 0, left: 0, right: 0, bottom: 0 }
    },
    anchors: anchors ?? [
      { id: 'today.kcalLeftPill', rectLogical: { x: 12, y: 100, width: 80, height: 24 }, visible: true, visibility: { visibleFraction: 1.0, isOffscreen: false } },
      { id: 'today.macroRingLabel', rectLogical: { x: 90, y: 200, width: 60, height: 20 }, visible: true, visibility: { visibleFraction: 1.0, isOffscreen: false } }
    ]
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('run-057 Flutter anchor validation — integration', () => {

  describe('Assertion 1: Basic resolution with flutter_anchor source', () => {
    it('resolves all targets to flutter_anchor source', () => {
      const raw = makeAnchorDump(3.0, 1080, 2340);
      const parsed = parseFlutterAnchorDump(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const summary = resolveTargets(TARGET_MAP, parsed.data);
      expect(summary.resolvedViaFlutterAnchor).toBe(2);
      expect(summary.unresolved).toBe(0);
      for (const r of summary.results) {
        expect(r.source).toBe('flutter_anchor');
        expect(r.mappingMetadata?.measurementBoxSource).toBe('flutter_anchor');
      }
    });

    it('no target map field contains static x/y/w/h pixel values', () => {
      for (const target of TARGET_MAP.targets) {
        const locator = target.locator as Record<string, unknown>;
        expect(locator['x']).toBeUndefined();
        expect(locator['y']).toBeUndefined();
        expect(locator['width']).toBeUndefined();
        expect(locator['height']).toBeUndefined();
        expect(locator['box']).toBeUndefined();
      }
    });
  });

  describe('Assertion 2: Missing anchor → unresolved, not_evaluated', () => {
    it('missing anchor ID in dump → anchorMissing: true, no rect', () => {
      const raw = makeAnchorDump(3.0, 1080, 2340, [
        // macroRingLabel is missing
        { id: 'today.kcalLeftPill', rectLogical: { x: 12, y: 100, width: 80, height: 24 }, visible: true, visibility: { visibleFraction: 1.0, isOffscreen: false } }
      ]);
      const parsed = parseFlutterAnchorDump(raw);
      if (!parsed.ok) return;

      const summary = resolveTargets(TARGET_MAP, parsed.data);
      const missing = summary.results.find((r) => r.targetId === 'today.macroRingLabel')!;
      expect(missing.source).toBe('unresolved');
      expect(missing.anchorMissing).toBe(true);
      expect(missing.rect).toBeUndefined();
    });
  });

  describe('Assertion 3: target_not_visible → unresolved, no measurement', () => {
    it('anchor.visible=false → targetNotVisible, no rect', () => {
      const raw = makeAnchorDump(3.0, 1080, 2340, [
        { id: 'today.kcalLeftPill', rectLogical: { x: 12, y: 100, width: 80, height: 24 }, visible: false, visibility: { visibleFraction: 0, isOffscreen: true } },
        { id: 'today.macroRingLabel', rectLogical: { x: 90, y: 200, width: 60, height: 20 }, visible: true, visibility: { visibleFraction: 1.0, isOffscreen: false } }
      ]);
      const parsed = parseFlutterAnchorDump(raw);
      if (!parsed.ok) return;

      const summary = resolveTargets(TARGET_MAP, parsed.data);
      const notVisible = summary.results.find((r) => r.targetId === 'today.kcalLeftPill')!;
      expect(notVisible.source).toBe('unresolved');
      expect(notVisible.targetNotVisible).toBe(true);
      expect(notVisible.rect).toBeUndefined();
      expect(summary.notVisible).toBe(1);
    });
  });

  describe('Assertion 4: Device A/B — same target map, different rects', () => {
    it('Pixel 6 Pro (DPR=3.5) vs Pixel 4a (DPR=2.75) produce different pixel rects', () => {
      const parsedA = parseFlutterAnchorDump(makeAnchorDump(3.5, 1440, 3120));
      const parsedB = parseFlutterAnchorDump(makeAnchorDump(2.75, 1080, 2340));
      expect(parsedA.ok).toBe(true);
      expect(parsedB.ok).toBe(true);
      if (!parsedA.ok || !parsedB.ok) return;

      const sumA = resolveTargets(TARGET_MAP, parsedA.data);
      const sumB = resolveTargets(TARGET_MAP, parsedB.data);

      const pillA = sumA.results.find((r) => r.targetId === 'today.kcalLeftPill')!.rect!;
      const pillB = sumB.results.find((r) => r.targetId === 'today.kcalLeftPill')!.rect!;

      expect(pillA).not.toEqual(pillB);
      // DPR 3.5: floor(12*3.5)=42; DPR 2.75: floor(12*2.75)=33
      expect(pillA.x).toBe(42);
      expect(pillB.x).toBe(33);
    });

    it('both devices resolve full target map without config changes', () => {
      for (const [dpr, w, h] of [[3.5, 1440, 3120], [2.75, 1080, 2340]] as [number, number, number][]) {
        const parsed = parseFlutterAnchorDump(makeAnchorDump(dpr, w, h));
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const summary = resolveTargets(TARGET_MAP, parsed.data);
        expect(summary.resolvedViaFlutterAnchor).toBe(2);
        expect(summary.unresolved).toBe(0);
      }
    });
  });

  describe('Assertion 5: Judge cache — batch key and invalidation', () => {
    it('multiple criteria for same target batch to one cache key', () => {
      const cache = new JudgeCache();
      const baseKey = {
        provider: 'openrouter', model: 'test-model', promptVersion: 'v1',
        targetId: 'today.kcalLeftPill',
        criterionIds: ['today.kcalLeftPill.text', 'today.kcalLeftPill.legibility'],
        actualImageHash: 'img1', actualCropHash: 'crop1', anchorRectHash: 'rect1',
        expectedImageHash: 'exp1', sourceFactsHash: 'sf1',
        deterministicMeasurementHash: 'dm1', targetMapVersion: '1'
      };
      cache.set(baseKey, { judgeAuditStatus: 'pass', cachedAt: Date.now() });
      expect(cache.size()).toBe(1);

      // Same key with criteria in different order — hits cache
      const sameKeyDifferentOrder = { ...baseKey, criterionIds: ['today.kcalLeftPill.legibility', 'today.kcalLeftPill.text'] };
      expect(cache.has(sameKeyDifferentOrder)).toBe(true);
    });

    it('changed crop hash invalidates cache entry', () => {
      const cache = new JudgeCache();
      const key = {
        provider: 'openrouter', model: 'test-model', promptVersion: 'v1',
        targetId: 'today.kcalLeftPill', criterionIds: ['crit.a'],
        actualImageHash: 'img1', actualCropHash: 'crop-original', anchorRectHash: 'rect1',
        expectedImageHash: 'exp1', sourceFactsHash: 'sf1',
        deterministicMeasurementHash: 'dm1', targetMapVersion: '1'
      };
      cache.set(key, { judgeAuditStatus: 'pass', cachedAt: Date.now() });

      const changedCrop = { ...key, actualCropHash: 'crop-changed' };
      expect(cache.has(changedCrop)).toBe(false);
    });

    it('changed anchor rect hash invalidates cache', () => {
      const cache = new JudgeCache();
      const key = {
        provider: 'openrouter', model: 'test-model', promptVersion: 'v1',
        targetId: 'today.kcalLeftPill', criterionIds: ['crit.a'],
        actualImageHash: 'img1', actualCropHash: 'crop1',
        anchorRectHash: hashRect({ x: 36, y: 300, width: 240, height: 72 }),
        expectedImageHash: 'exp1', sourceFactsHash: 'sf1',
        deterministicMeasurementHash: 'dm1', targetMapVersion: '1'
      };
      cache.set(key, { judgeAuditStatus: 'pass', cachedAt: Date.now() });

      const shiftedRect = { ...key, anchorRectHash: hashRect({ x: 42, y: 350, width: 210, height: 70 }) };
      expect(cache.has(shiftedRect)).toBe(false);
    });
  });

  describe('Assertion 6: Discovery — generates targets without static rects', () => {
    it('discovery output contains flutter_anchor locator with no box coordinates', async () => {
      const raw = makeAnchorDump(3.0, 1080, 2340);
      const parsed = parseFlutterAnchorDump(raw);
      if (!parsed.ok) return;

      const result = await runDiscovery({ screen: 'TodayScreen', anchorDump: parsed.data });
      for (const target of result.proposedTargetMap.targets) {
        expect(target.locator.type).toBe('flutter_anchor');
        expect((target.locator as Record<string, unknown>)['box']).toBeUndefined();
      }
    });
  });

  describe('Assertion 7: Artifact reader — round-trip', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run057-anchor-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('reads a valid anchor dump from filesystem and resolves targets', async () => {
      const dump = makeAnchorDump(3.0, 1080, 2340);
      await fs.writeFile(path.join(tmpDir, 'flutter-anchors.json'), JSON.stringify(dump), 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'flutter-anchors.done'), '', 'utf-8');

      const artifact = await waitForAnchorArtifact({ artifactDir: tmpDir, timeoutMs: 2000, pollIntervalMs: 50 });
      expect(artifact.status).toBe('ready');
      expect(artifact.parsed).toBeDefined();

      const summary = resolveTargets(TARGET_MAP, artifact.parsed!);
      expect(summary.resolvedViaFlutterAnchor).toBe(2);
    });

    it('anchor artifact timeout produces anchor_artifact_timeout status', async () => {
      const artifact = await waitForAnchorArtifact({ artifactDir: tmpDir, timeoutMs: 200, pollIntervalMs: 50 });
      expect(artifact.status).toBe('anchor_artifact_timeout');
    });
  });

  describe('Assertion 8: Coordinate correctness — no floats passed to image operations', () => {
    it('all resolved rects are strictly integer values', () => {
      const raw = makeAnchorDump(2.75, 1080, 2340);
      const parsed = parseFlutterAnchorDump(raw);
      if (!parsed.ok) return;

      const summary = resolveTargets(TARGET_MAP, parsed.data);
      for (const r of summary.results) {
        if (!r.rect) continue;
        const { x, y, width, height } = r.rect;
        expect(Number.isInteger(x)).toBe(true);
        expect(Number.isInteger(y)).toBe(true);
        expect(Number.isInteger(width)).toBe(true);
        expect(Number.isInteger(height)).toBe(true);
      }
    });

    it('hashRect and hashContent produce stable hex for use in cache keys', () => {
      const raw = makeAnchorDump(3.0, 1080, 2340);
      const parsed = parseFlutterAnchorDump(raw);
      if (!parsed.ok) return;

      const rect = parsed.data.resolvedRects.get('today.kcalLeftPill')!;
      const h1 = hashRect(rect);
      const h2 = hashRect(rect);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[a-f0-9]{64}$/);

      const imgHash = hashContent(Buffer.from('fake-image-bytes'));
      expect(imgHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
