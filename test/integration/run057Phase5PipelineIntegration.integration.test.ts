/**
 * Phase 5 integration test for run-057: Flutter anchor pipeline wiring.
 *
 * Proves that the full runScreenUiDiff → RunOrchestrator pipeline:
 *   A. Accepts targetMapPath and flutterAnchorsPath inputs
 *   B. Resolves semantic targets to flutter_anchor physical rects
 *   C. Populates report.targetResolutionSummary with per-target results
 *   D. Sets report.measurementBoxSource to 'flutter_anchor' when anchors resolve
 *   E. Injects resolved anchor rects into overlapLegibility analysis
 *   F. Degrades gracefully when flutterAnchorsPath times out (warns, no crash)
 *
 * No live API calls. No real Android device. Images are synthetic PNGs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PNG } from 'pngjs';
import { runScreenUiDiff } from '../../src/tools/runScreenUiDiff';

// ── Image helpers ─────────────────────────────────────────────────────────────

function makeUniformPng(width = 200, height = 400, r = 230, g = 230, b = 230): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

// ── Fixture builders ──────────────────────────────────────────────────────────

const IMG_W = 300;
const IMG_H = 600;
const DPR = 3.0;

function makeAnchorDumpJson(): string {
  const logicalW = IMG_W / DPR;
  const logicalH = IMG_H / DPR;
  return JSON.stringify({
    framework: 'flutter',
    screen: 'TodayScreen',
    coordinateSpace: 'flutterLogical',
    coordinateOrigin: 'topLeft',
    device: {
      screenshotWidthPx: IMG_W,
      screenshotHeightPx: IMG_H,
      devicePixelRatio: DPR,
      mediaQuerySizeLogical: { width: logicalW, height: logicalH },
      paddingLogical: { top: 47, left: 0, right: 0, bottom: 0 },
      viewPaddingLogical: { top: 47, left: 0, right: 0, bottom: 0 },
      viewInsetsLogical: { top: 0, left: 0, right: 0, bottom: 0 }
    },
    anchors: [
      {
        id: 'today.kcalLeftPill',
        rectLogical: { x: 5, y: 80, width: 40, height: 12 },
        visible: true,
        visibility: { visibleFraction: 1.0, isOffscreen: false }
      },
      {
        id: 'today.macroRingLabel',
        rectLogical: { x: 20, y: 120, width: 30, height: 10 },
        visible: true,
        visibility: { visibleFraction: 1.0, isOffscreen: false }
      }
    ]
  });
}

function makeTargetMapJson(): string {
  return JSON.stringify({
    version: '1',
    screen: 'TodayScreen',
    targets: [
      {
        id: 'today.kcalLeftPill',
        locator: { type: 'flutter_anchor', anchorId: 'today.kcalLeftPill', required: true },
        criteria: [
          {
            id: 'today.kcalLeftPill.legibility',
            domain: 'legibility.overlap',
            avoidColors: ['#1FCC74'],
            maxOverlapPercent: 5.0,
            severity: 'warning'
          }
        ]
      },
      {
        id: 'today.macroRingLabel',
        locator: { type: 'flutter_anchor', anchorId: 'today.macroRingLabel', required: true },
        criteria: []
      }
    ]
  });
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-run057-phase5-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(name: string, content: Buffer | string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, content);
  return p;
}

async function writeConfig(screenConfig: Record<string, unknown>): Promise<string> {
  const p = path.join(tmpDir, 'ui-diff.config.json');
  await fs.writeFile(p, JSON.stringify({ screens: { TodayScreen: screenConfig } }, null, 2));
  return p;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('run-057 Phase 5 — Flutter anchor pipeline integration', () => {

  describe('Assertion A+B+C+D: full pipeline with anchor dump → flutter_anchor report fields', () => {
    it('report.measurementBoxSource is flutter_anchor and targetResolutionSummary is populated', async () => {
      const img = makeUniformPng(IMG_W, IMG_H);
      const expectedPath = await writeFile('expected.png', img);
      const actualPath = await writeFile('actual.png', img);
      const outputDir = path.join(tmpDir, 'runs');

      // Write anchor dump + done sentinel
      const anchorDir = path.join(tmpDir, 'anchors');
      await fs.mkdir(anchorDir, { recursive: true });
      await fs.writeFile(path.join(anchorDir, 'flutter-anchors.json'), makeAnchorDumpJson());
      await fs.writeFile(path.join(anchorDir, 'flutter-anchors.done'), '');

      // Write semantic target map
      const targetMapPath = await writeFile('target-map.json', makeTargetMapJson());

      const configPath = await writeConfig({
        platform: 'none',
        expectedImage: expectedPath,
        outputDir,
        visualAuditMode: 'metric_only'
      });

      const run = await runScreenUiDiff({
        screen: 'TodayScreen',
        configPath,
        actualImage: actualPath,
        runName: 'run-057-phase5',
        targetMapPath,
        flutterAnchorsPath: anchorDir
      });

      expect(run).toBeDefined();

      // D: measurementBoxSource must be 'flutter_anchor'
      expect(run.measurementBoxSource).toBe('flutter_anchor');

      // C: targetResolutionSummary must be present and correct
      const trs = run.targetResolutionSummary;
      expect(trs).toBeDefined();
      expect(trs!.totalTargets).toBe(2);
      expect(trs!.resolvedViaFlutterAnchor).toBe(2);
      expect(trs!.unresolved).toBe(0);

      // B: Each resolved result has flutter_anchor source and integer rect
      for (const result of trs!.results) {
        expect(result.source).toBe('flutter_anchor');
        expect(result.rect).toBeDefined();
        const { x, y, width, height } = result.rect!;
        expect(Number.isInteger(x)).toBe(true);
        expect(Number.isInteger(y)).toBe(true);
        expect(Number.isInteger(width)).toBe(true);
        expect(Number.isInteger(height)).toBe(true);
      }
    });
  });

  describe('Assertion E: overlapLegibility region injected from flutter anchor', () => {
    it('overlapLegibilitySummary is present when legibility.overlap criterion is in target map', async () => {
      const img = makeUniformPng(IMG_W, IMG_H);
      const expectedPath = await writeFile('expected2.png', img);
      const actualPath = await writeFile('actual2.png', img);
      const outputDir = path.join(tmpDir, 'runs2');

      const anchorDir = path.join(tmpDir, 'anchors2');
      await fs.mkdir(anchorDir, { recursive: true });
      await fs.writeFile(path.join(anchorDir, 'flutter-anchors.json'), makeAnchorDumpJson());
      await fs.writeFile(path.join(anchorDir, 'flutter-anchors.done'), '');

      const targetMapPath = await writeFile('target-map2.json', makeTargetMapJson());

      const configPath = await writeConfig({
        platform: 'none',
        expectedImage: expectedPath,
        outputDir,
        visualAuditMode: 'metric_only'
      });

      const run = await runScreenUiDiff({
        screen: 'TodayScreen',
        configPath,
        actualImage: actualPath,
        runName: 'run-057-phase5-overlap',
        targetMapPath,
        flutterAnchorsPath: anchorDir
      });

      // OverlapLegibilityAnalyzer should have been triggered by injected anchor regions
      expect(run.overlapLegibilitySummary).toBeDefined();
      expect(run.overlapLegibilitySummary!.enabled).toBe(true);
    });
  });

  describe('Assertion F: graceful degradation — anchor artifact timeout', () => {
    it('run completes without crash when flutterAnchorsPath points to empty dir (timeout)', async () => {
      const img = makeUniformPng(IMG_W, IMG_H);
      const expectedPath = await writeFile('expected3.png', img);
      const actualPath = await writeFile('actual3.png', img);
      const outputDir = path.join(tmpDir, 'runs3');

      // Empty anchor dir — no JSON, no done sentinel → will time out
      const anchorDir = path.join(tmpDir, 'anchors-empty');
      await fs.mkdir(anchorDir, { recursive: true });

      const targetMapPath = await writeFile('target-map3.json', makeTargetMapJson());

      const configPath = await writeConfig({
        platform: 'none',
        expectedImage: expectedPath,
        outputDir,
        visualAuditMode: 'metric_only'
      });

      // Use very short timeout via a custom flutterAnchorsPath with no files — should warn, not throw
      const run = await runScreenUiDiff({
        screen: 'TodayScreen',
        configPath,
        actualImage: actualPath,
        runName: 'run-057-phase5-timeout',
        targetMapPath,
        flutterAnchorsPath: anchorDir
      });

      expect(run).toBeDefined();
      // measurementBoxSource must NOT be flutter_anchor since resolution was skipped
      expect(run.measurementBoxSource).toBeUndefined();
      // targetResolutionSummary must NOT be present (no resolution performed)
      expect(run.targetResolutionSummary).toBeUndefined();
      // warnings must mention the anchor artifact failure
      const warnings = run.warnings ?? [];
      expect(warnings.some((w) => w.includes('flutterAnchorsPath'))).toBe(true);
    }, 45000);
  });

  describe('Assertion G: targetMapPath only (no anchor dump) — warns and skips resolution', () => {
    it('run completes without anchor resolution when flutterAnchorsPath is omitted', async () => {
      const img = makeUniformPng(IMG_W, IMG_H);
      const expectedPath = await writeFile('expected4.png', img);
      const actualPath = await writeFile('actual4.png', img);
      const outputDir = path.join(tmpDir, 'runs4');

      const targetMapPath = await writeFile('target-map4.json', makeTargetMapJson());

      const configPath = await writeConfig({
        platform: 'none',
        expectedImage: expectedPath,
        outputDir,
        visualAuditMode: 'metric_only'
      });

      const run = await runScreenUiDiff({
        screen: 'TodayScreen',
        configPath,
        actualImage: actualPath,
        runName: 'run-057-phase5-no-anchors',
        targetMapPath
        // flutterAnchorsPath intentionally omitted
      });

      expect(run).toBeDefined();
      // No flutter anchor resolution → no targetResolutionSummary
      expect(run.targetResolutionSummary).toBeUndefined();
      expect(run.measurementBoxSource).toBeUndefined();
    });
  });
});
