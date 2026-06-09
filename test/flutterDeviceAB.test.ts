import { describe, it, expect } from 'vitest';
import { parseFlutterAnchorDump } from '../src/flutter/anchorDumpParser';
import { resolveTargets } from '../src/flutter/targetResolver';
import type { SemanticTargetMapParsed } from '../src/flutter/semanticTargetMap';

/**
 * Device A/B proof:
 * Same semantic target map, two different anchor dumps with different DPR and
 * screenshot dimensions → different resolved pixel rects → no target config change needed.
 */

const SHARED_TARGET_MAP: SemanticTargetMapParsed = {
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
          minClearancePx: 4,
          maxOverlapPercent: 1.0,
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
};

function makeAnchorDump(dpr: number, screenshotW: number, screenshotH: number) {
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
      paddingLogical: { top: 44, left: 0, right: 0, bottom: 34 },
      viewPaddingLogical: { top: 44, left: 0, right: 0, bottom: 34 },
      viewInsetsLogical: { top: 0, left: 0, right: 0, bottom: 0 }
    },
    anchors: [
      {
        id: 'today.kcalLeftPill',
        rectLogical: { x: 12.0, y: 100.0, width: 80.0, height: 24.0 },
        visible: true,
        visibility: { visibleFraction: 1.0, isOffscreen: false }
      },
      {
        id: 'today.macroRingLabel',
        rectLogical: { x: 90.0, y: 200.0, width: 60.0, height: 20.0 },
        visible: true,
        visibility: { visibleFraction: 1.0, isOffscreen: false }
      }
    ]
  };
}

// Device A: Pixel 6 Pro — 1440×3120, DPR=3.5
const DEVICE_A_DUMP = makeAnchorDump(3.5, 1440, 3120);
// Device B: Pixel 4a — 1080×2340, DPR=2.75
const DEVICE_B_DUMP = makeAnchorDump(2.75, 1080, 2340);

describe('Device A/B proof — same target map, different device dumps', () => {
  it('parses both device dumps successfully', () => {
    expect(parseFlutterAnchorDump(DEVICE_A_DUMP).ok).toBe(true);
    expect(parseFlutterAnchorDump(DEVICE_B_DUMP).ok).toBe(true);
  });

  it('resolves to different pixel rects on different devices', () => {
    const parsedA = parseFlutterAnchorDump(DEVICE_A_DUMP);
    const parsedB = parseFlutterAnchorDump(DEVICE_B_DUMP);
    expect(parsedA.ok).toBe(true);
    expect(parsedB.ok).toBe(true);
    if (!parsedA.ok || !parsedB.ok) return;

    const summaryA = resolveTargets(SHARED_TARGET_MAP, parsedA.data);
    const summaryB = resolveTargets(SHARED_TARGET_MAP, parsedB.data);

    const pillA = summaryA.results.find((r) => r.targetId === 'today.kcalLeftPill')!;
    const pillB = summaryB.results.find((r) => r.targetId === 'today.kcalLeftPill')!;

    expect(pillA.source).toBe('flutter_anchor');
    expect(pillB.source).toBe('flutter_anchor');

    // Physical rects must differ because DPR and screenshot size differ
    expect(pillA.rect).not.toEqual(pillB.rect);

    // Device A (DPR 3.5): x = floor(12 * 3.5) = 42
    expect(pillA.rect?.x).toBe(42);
    // Device B (DPR 2.75): x = floor(12 * 2.75) = 33
    expect(pillB.rect?.x).toBe(33);
  });

  it('both resolutions report measurementBoxSource: flutter_anchor', () => {
    const parsedA = parseFlutterAnchorDump(DEVICE_A_DUMP);
    const parsedB = parseFlutterAnchorDump(DEVICE_B_DUMP);
    if (!parsedA.ok || !parsedB.ok) return;

    const summaryA = resolveTargets(SHARED_TARGET_MAP, parsedA.data);
    const summaryB = resolveTargets(SHARED_TARGET_MAP, parsedB.data);

    for (const summary of [summaryA, summaryB]) {
      for (const r of summary.results) {
        expect(r.source).toBe('flutter_anchor');
        expect(r.mappingMetadata?.measurementBoxSource).toBe('flutter_anchor');
      }
    }
  });

  it('all resolved rects are integer pixel values', () => {
    const parsedA = parseFlutterAnchorDump(DEVICE_A_DUMP);
    if (!parsedA.ok) return;
    const summaryA = resolveTargets(SHARED_TARGET_MAP, parsedA.data);

    for (const r of summaryA.results) {
      if (!r.rect) continue;
      expect(Number.isInteger(r.rect.x)).toBe(true);
      expect(Number.isInteger(r.rect.y)).toBe(true);
      expect(Number.isInteger(r.rect.width)).toBe(true);
      expect(Number.isInteger(r.rect.height)).toBe(true);
    }
  });

  it('no target config change required between devices', () => {
    // The target map is IDENTICAL for both devices — this test proves that
    // the same SHARED_TARGET_MAP resolves correctly on both without modification.
    const parsedA = parseFlutterAnchorDump(DEVICE_A_DUMP);
    const parsedB = parseFlutterAnchorDump(DEVICE_B_DUMP);
    if (!parsedA.ok || !parsedB.ok) return;

    const summaryA = resolveTargets(SHARED_TARGET_MAP, parsedA.data);
    const summaryB = resolveTargets(SHARED_TARGET_MAP, parsedB.data);

    // Both devices resolve all targets
    expect(summaryA.resolvedViaFlutterAnchor).toBe(2);
    expect(summaryB.resolvedViaFlutterAnchor).toBe(2);
    expect(summaryA.unresolved).toBe(0);
    expect(summaryB.unresolved).toBe(0);
  });

  it('records correct DPR in mapping metadata per device', () => {
    const parsedA = parseFlutterAnchorDump(DEVICE_A_DUMP);
    const parsedB = parseFlutterAnchorDump(DEVICE_B_DUMP);
    if (!parsedA.ok || !parsedB.ok) return;

    const summaryA = resolveTargets(SHARED_TARGET_MAP, parsedA.data);
    const summaryB = resolveTargets(SHARED_TARGET_MAP, parsedB.data);

    const pillA = summaryA.results.find((r) => r.targetId === 'today.kcalLeftPill')!;
    const pillB = summaryB.results.find((r) => r.targetId === 'today.kcalLeftPill')!;

    expect(pillA.mappingMetadata?.devicePixelRatio).toBe(3.5);
    expect(pillB.mappingMetadata?.devicePixelRatio).toBe(2.75);
  });
});
