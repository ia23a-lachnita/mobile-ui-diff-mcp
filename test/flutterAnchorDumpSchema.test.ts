import { describe, it, expect } from 'vitest';
import { flutterAnchorDumpSchema } from '../src/flutter/anchorDumpSchema';

function makeValidDump(overrides: Record<string, unknown> = {}) {
  return {
    framework: 'flutter',
    screen: 'TodayScreen',
    coordinateSpace: 'flutterLogical',
    coordinateOrigin: 'topLeft',
    device: {
      screenshotWidthPx: 1080,
      screenshotHeightPx: 2340,
      devicePixelRatio: 3.0,
      mediaQuerySizeLogical: { width: 360, height: 780 },
      paddingLogical: { top: 47.0, left: 0, right: 0, bottom: 0 },
      viewPaddingLogical: { top: 47.0, left: 0, right: 0, bottom: 0 },
      viewInsetsLogical: { top: 0, left: 0, right: 0, bottom: 0 }
    },
    anchors: [
      {
        id: 'today.kcalLeftPill',
        label: 'Kcal left pill',
        rectLogical: { x: 12.0, y: 100.0, width: 80.0, height: 24.0 },
        visible: true,
        visibility: { visibleFraction: 1.0, isOffscreen: false }
      }
    ],
    ...overrides
  };
}

describe('flutterAnchorDumpSchema', () => {
  it('accepts a valid dump', () => {
    const result = flutterAnchorDumpSchema.safeParse(makeValidDump());
    expect(result.success).toBe(true);
  });

  it('requires framework: "flutter"', () => {
    const result = flutterAnchorDumpSchema.safeParse(makeValidDump({ framework: 'react-native' }));
    expect(result.success).toBe(false);
  });

  it('requires coordinateSpace: "flutterLogical"', () => {
    const result = flutterAnchorDumpSchema.safeParse(makeValidDump({ coordinateSpace: 'physical' }));
    expect(result.success).toBe(false);
  });

  it('requires coordinateOrigin', () => {
    const { coordinateOrigin: _, ...dump } = makeValidDump() as Record<string, unknown>;
    const result = flutterAnchorDumpSchema.safeParse(dump);
    expect(result.success).toBe(false);
  });

  it('requires device.devicePixelRatio', () => {
    const dump = makeValidDump();
    const { devicePixelRatio: _, ...deviceWithout } = dump.device as Record<string, unknown>;
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, device: deviceWithout });
    expect(result.success).toBe(false);
  });

  it('requires device.paddingLogical', () => {
    const dump = makeValidDump();
    const { paddingLogical: _, ...deviceWithout } = dump.device as Record<string, unknown>;
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, device: deviceWithout });
    expect(result.success).toBe(false);
  });

  it('requires device.viewPaddingLogical', () => {
    const dump = makeValidDump();
    const { viewPaddingLogical: _, ...deviceWithout } = dump.device as Record<string, unknown>;
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, device: deviceWithout });
    expect(result.success).toBe(false);
  });

  it('requires device.viewInsetsLogical', () => {
    const dump = makeValidDump();
    const { viewInsetsLogical: _, ...deviceWithout } = dump.device as Record<string, unknown>;
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, device: deviceWithout });
    expect(result.success).toBe(false);
  });

  it('requires device.screenshotWidthPx', () => {
    const dump = makeValidDump();
    const { screenshotWidthPx: _, ...deviceWithout } = dump.device as Record<string, unknown>;
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, device: deviceWithout });
    expect(result.success).toBe(false);
  });

  it('requires device.screenshotHeightPx', () => {
    const dump = makeValidDump();
    const { screenshotHeightPx: _, ...deviceWithout } = dump.device as Record<string, unknown>;
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, device: deviceWithout });
    expect(result.success).toBe(false);
  });

  it('requires anchor.visible boolean', () => {
    const dump = makeValidDump();
    const anchors = [
      {
        id: 'today.kcalLeftPill',
        rectLogical: { x: 12, y: 100, width: 80, height: 24 },
        // visible is missing
        visibility: { visibleFraction: 1.0, isOffscreen: false }
      }
    ];
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, anchors });
    expect(result.success).toBe(false);
  });

  it('requires anchor.visibility object', () => {
    const dump = makeValidDump();
    const anchors = [{ id: 'today.kcalLeftPill', rectLogical: { x: 12, y: 100, width: 80, height: 24 }, visible: true }];
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, anchors });
    expect(result.success).toBe(false);
  });

  it('rejects extra root-level fields (strict mode)', () => {
    const dump = makeValidDump({ renderTree: { type: 'widget', children: [] } });
    const result = flutterAnchorDumpSchema.safeParse(dump);
    expect(result.success).toBe(false);
  });

  it('strips extra anchor-level fields (Calorix extended DTO) rather than passing them through', () => {
    // Calorix may emit extra diagnostic fields. They must parse successfully but be stripped
    // from the result — we must not allow raw framework objects to propagate.
    const dump = makeValidDump();
    const anchors = [
      {
        id: 'today.kcalLeftPill',
        rectLogical: { x: 12, y: 100, width: 80, height: 24 },
        visible: true,
        visibility: { visibleFraction: 1.0, offscreen: false, clippedByViewport: false, covered: false, notes: [] },
        renderObject: { size: { width: 80, height: 24 } }
      }
    ];
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, anchors });
    expect(result.success).toBe(true);
    // renderObject must be stripped — it must not appear in the parsed output.
    if (result.success) {
      expect((result.data.anchors[0] as any).renderObject).toBeUndefined();
    }
  });

  it('strips renderObject and other framework-like fields from anchor entries', () => {
    const dump = makeValidDump();
    const anchors = [
      {
        id: 'today.kcalLeftPill',
        rectLogical: { x: 12, y: 100, width: 80, height: 24 },
        visible: true,
        visibility: { visibleFraction: 1.0 },
        renderObject: { diagnostics: ['size: Size(80.0, 24.0)'] },
        context: { widget: 'Container' },
        owner: { debugDoingLayout: false }
      }
    ];
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, anchors });
    expect(result.success).toBe(true);
    if (result.success) {
      const anchor = result.data.anchors[0] as any;
      expect(anchor.renderObject).toBeUndefined();
      expect(anchor.context).toBeUndefined();
      expect(anchor.owner).toBeUndefined();
    }
  });

  it('accepts Calorix visibility DTO shape (offscreen/clippedByViewport/covered/notes)', () => {
    const dump = makeValidDump();
    const anchors = [
      {
        id: 'today.kcalLeftPill',
        rectLogical: { x: 12, y: 100, width: 80, height: 24 },
        visible: true,
        visibility: {
          visibleFraction: 0.85,
          offscreen: false,
          clippedByViewport: true,
          covered: false,
          notes: ['partially clipped by bottom navbar']
        }
      }
    ];
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, anchors });
    expect(result.success).toBe(true);
  });

  it('accepts legacy isOffscreen field for backward compat', () => {
    const dump = makeValidDump();
    const anchors = [
      {
        id: 'today.kcalLeftPill',
        rectLogical: { x: 12, y: 100, width: 80, height: 24 },
        visible: true,
        visibility: { visibleFraction: 1.0, isOffscreen: false }
      }
    ];
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, anchors });
    expect(result.success).toBe(true);
  });

  it('accepts visibility with only visibleFraction (minimal Calorix shape)', () => {
    const dump = makeValidDump();
    const anchors = [
      {
        id: 'today.kcalLeftPill',
        rectLogical: { x: 12, y: 100, width: 80, height: 24 },
        visible: false,
        visibility: { visibleFraction: 0 }
      }
    ];
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, anchors });
    expect(result.success).toBe(true);
  });

  it('accepts anchors array with no entries', () => {
    const result = flutterAnchorDumpSchema.safeParse(makeValidDump({ anchors: [] }));
    expect(result.success).toBe(true);
  });

  it('requires device.devicePixelRatio to be positive', () => {
    const dump = makeValidDump();
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, device: { ...dump.device, devicePixelRatio: 0 } });
    expect(result.success).toBe(false);
  });

  it('requires screenshotWidthPx to be a positive integer', () => {
    const dump = makeValidDump();
    const result = flutterAnchorDumpSchema.safeParse({ ...dump, device: { ...dump.device, screenshotWidthPx: 1080.5 } });
    expect(result.success).toBe(false);
  });
});
