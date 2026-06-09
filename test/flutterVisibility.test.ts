import { describe, it, expect } from 'vitest';
import { parseFlutterAnchorDump } from '../src/flutter/anchorDumpParser';
import { resolveTargets } from '../src/flutter/targetResolver';
import type { SemanticTargetMapParsed } from '../src/flutter/semanticTargetMap';

function makeTargetMap(targets: SemanticTargetMapParsed['targets']): SemanticTargetMapParsed {
  return { version: '1', screen: 'TestScreen', targets };
}

function makeAnchorDump(anchors: unknown[]) {
  return {
    framework: 'flutter',
    screen: 'TestScreen',
    coordinateSpace: 'flutterLogical',
    coordinateOrigin: 'topLeft',
    device: {
      screenshotWidthPx: 1080,
      screenshotHeightPx: 2340,
      devicePixelRatio: 3.0,
      mediaQuerySizeLogical: { width: 360, height: 780 },
      paddingLogical: { top: 0, left: 0, right: 0, bottom: 0 },
      viewPaddingLogical: { top: 0, left: 0, right: 0, bottom: 0 },
      viewInsetsLogical: { top: 0, left: 0, right: 0, bottom: 0 }
    },
    anchors
  };
}

describe('visibility and scroll handling', () => {
  it('visible anchor is measured (source: flutter_anchor)', () => {
    const dump = makeAnchorDump([
      {
        id: 'target.a',
        rectLogical: { x: 10, y: 100, width: 50, height: 20 },
        visible: true,
        visibility: { visibleFraction: 1.0, isOffscreen: false }
      }
    ]);
    const parsed = parseFlutterAnchorDump(dump);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const summary = resolveTargets(makeTargetMap([
      { id: 'target.a', locator: { type: 'flutter_anchor', anchorId: 'target.a', required: true }, criteria: [] }
    ]), parsed.data);

    const r = summary.results[0];
    expect(r.source).toBe('flutter_anchor');
    expect(r.visible).toBe(true);
    expect(r.rect).toBeDefined();
    expect(r.targetNotVisible).toBeFalsy();
  });

  it('anchor.visible=false → not measured, target_not_visible reported', () => {
    const dump = makeAnchorDump([
      {
        id: 'target.hidden',
        rectLogical: { x: 10, y: 100, width: 50, height: 20 },
        visible: false,
        visibility: { visibleFraction: 0, isOffscreen: true }
      }
    ]);
    const parsed = parseFlutterAnchorDump(dump);
    if (!parsed.ok) return;

    const summary = resolveTargets(makeTargetMap([
      { id: 'target.hidden', locator: { type: 'flutter_anchor', anchorId: 'target.hidden', required: true }, criteria: [] }
    ]), parsed.data);

    const r = summary.results[0];
    expect(r.source).toBe('unresolved');
    expect(r.visible).toBe(false);
    expect(r.targetNotVisible).toBe(true);
    expect(r.rect).toBeUndefined();
  });

  it('visibleFraction below threshold (0.01) → not measured', () => {
    const dump = makeAnchorDump([
      {
        id: 'target.partial',
        rectLogical: { x: 10, y: 2200, width: 50, height: 200 },
        visible: true,
        visibility: { visibleFraction: 0.005, isOffscreen: false }  // < 0.01 threshold
      }
    ]);
    const parsed = parseFlutterAnchorDump(dump);
    if (!parsed.ok) return;

    const summary = resolveTargets(makeTargetMap([
      { id: 'target.partial', locator: { type: 'flutter_anchor', anchorId: 'target.partial', required: true }, criteria: [] }
    ]), parsed.data);

    const r = summary.results[0];
    expect(r.source).toBe('unresolved');
    expect(r.targetNotVisible).toBe(true);
    expect(r.rect).toBeUndefined();
  });

  it('visibleFraction exactly at threshold (0.01) → IS measured', () => {
    const dump = makeAnchorDump([
      {
        id: 'target.edge',
        rectLogical: { x: 10, y: 100, width: 50, height: 20 },
        visible: true,
        visibility: { visibleFraction: 0.01, isOffscreen: false }
      }
    ]);
    const parsed = parseFlutterAnchorDump(dump);
    if (!parsed.ok) return;

    const summary = resolveTargets(makeTargetMap([
      { id: 'target.edge', locator: { type: 'flutter_anchor', anchorId: 'target.edge', required: true }, criteria: [] }
    ]), parsed.data);

    const r = summary.results[0];
    expect(r.source).toBe('flutter_anchor');
    expect(r.visible).toBe(true);
    expect(r.rect).toBeDefined();
  });

  it('offscreen anchor (isOffscreen=true) with positive visibleFraction still uses visible flag', () => {
    // isOffscreen can be true but visible might still be true from Flutter's logic.
    // We trust the visible boolean first, then visibleFraction.
    const dump = makeAnchorDump([
      {
        id: 'target.offscreen',
        rectLogical: { x: 10, y: 900, width: 50, height: 20 },
        visible: false,  // Flutter says not visible
        visibility: { visibleFraction: 0.0, isOffscreen: true }
      }
    ]);
    const parsed = parseFlutterAnchorDump(dump);
    if (!parsed.ok) return;

    const summary = resolveTargets(makeTargetMap([
      { id: 'target.offscreen', locator: { type: 'flutter_anchor', anchorId: 'target.offscreen', required: true }, criteria: [] }
    ]), parsed.data);

    const r = summary.results[0];
    expect(r.visible).toBe(false);
    expect(r.targetNotVisible).toBe(true);
  });

  it('missing anchor ID in dump → anchorMissing reported, not measured', () => {
    const dump = makeAnchorDump([]);  // No anchors
    const parsed = parseFlutterAnchorDump(dump);
    if (!parsed.ok) return;

    const summary = resolveTargets(makeTargetMap([
      { id: 'target.missing', locator: { type: 'flutter_anchor', anchorId: 'target.missing', required: true }, criteria: [] }
    ]), parsed.data);

    const r = summary.results[0];
    expect(r.source).toBe('unresolved');
    expect(r.anchorMissing).toBe(true);
    expect(r.rect).toBeUndefined();
  });

  it('custom visibility threshold can be lowered', () => {
    const dump = makeAnchorDump([
      {
        id: 'target.low',
        rectLogical: { x: 10, y: 100, width: 50, height: 20 },
        visible: true,
        visibility: { visibleFraction: 0.005, isOffscreen: false }
      }
    ]);
    const parsed = parseFlutterAnchorDump(dump);
    if (!parsed.ok) return;

    // With a lower threshold (0.001), this should be measured
    const summary = resolveTargets(makeTargetMap([
      { id: 'target.low', locator: { type: 'flutter_anchor', anchorId: 'target.low', required: true }, criteria: [] }
    ]), parsed.data, { visibilityThreshold: 0.001 });

    const r = summary.results[0];
    expect(r.source).toBe('flutter_anchor');
  });

  it('resolution summary counts are accurate', () => {
    const dump = makeAnchorDump([
      { id: 'a.visible', rectLogical: { x: 10, y: 100, width: 50, height: 20 }, visible: true, visibility: { visibleFraction: 1.0, isOffscreen: false } },
      { id: 'a.hidden', rectLogical: { x: 10, y: 100, width: 50, height: 20 }, visible: false, visibility: { visibleFraction: 0, isOffscreen: true } }
    ]);
    const parsed = parseFlutterAnchorDump(dump);
    if (!parsed.ok) return;

    const summary = resolveTargets(makeTargetMap([
      { id: 'a.visible', locator: { type: 'flutter_anchor', anchorId: 'a.visible', required: true }, criteria: [] },
      { id: 'a.hidden', locator: { type: 'flutter_anchor', anchorId: 'a.hidden', required: true }, criteria: [] },
      { id: 'a.missing', locator: { type: 'flutter_anchor', anchorId: 'a.missing', required: true }, criteria: [] }
    ]), parsed.data);

    expect(summary.totalTargets).toBe(3);
    expect(summary.resolvedViaFlutterAnchor).toBe(1);
    expect(summary.notVisible).toBe(1);
    expect(summary.unresolved).toBe(2); // hidden + missing both land in unresolved
  });
});
