import { describe, it, expect } from 'vitest';
import { logicalToPhysicalPx } from '../src/flutter/anchorDumpParser';
import { parseFlutterAnchorDump } from '../src/flutter/anchorDumpParser';

describe('logicalToPhysicalPx — coordinate math', () => {
  it('DPR 3.0 clean integer case', () => {
    // 12.0 * 3 = 36, (12 + 80) * 3 = 276 — both exact integers
    const result = logicalToPhysicalPx({ x: 12.0, y: 100.0, width: 80.0, height: 24.0 }, 3.0, 1080, 2340);
    expect(result.x).toBe(36);
    expect(result.y).toBe(300);
    expect(result.width).toBe(240);
    expect(result.height).toBe(72);
  });

  it('DPR 2.75 fractional case — floor-left preserves start, ceil-right preserves end', () => {
    // x = floor(10 * 2.75) = floor(27.5) = 27
    // right = ceil((10 + 50) * 2.75) = ceil(165) = 165
    // width = 165 - 27 = 138
    const result = logicalToPhysicalPx({ x: 10.0, y: 20.0, width: 50.0, height: 30.0 }, 2.75, 1440, 3040);
    expect(result.x).toBe(27);
    expect(result.y).toBe(55);   // floor(20 * 2.75) = floor(55) = 55
    expect(result.width).toBe(138);
    expect(result.height).toBe(83);  // ceil((20+30)*2.75)=ceil(137.5)=138, 138-55=83
  });

  it('floor-left / ceil-right — box is never shrunk below logical extent', () => {
    // For any DPR, the physical width >= floor(logical_width * DPR)
    const dpr = 2.75;
    const logical = { x: 0.1, y: 0.1, width: 50.3, height: 20.7 };
    const result = logicalToPhysicalPx(logical, dpr, 1440, 3040);
    const naiveWidth = Math.round(logical.width * dpr);
    // floor-left / ceil-right should be >= naive round-based width in most cases
    // The key property: result never clips edge pixels
    expect(result.width).toBeGreaterThanOrEqual(Math.floor(logical.width * dpr));
  });

  it('all output values are integers', () => {
    const cases = [
      { rect: { x: 0.333, y: 0.666, width: 100.1, height: 50.9 }, dpr: 2.75 },
      { rect: { x: 1.5, y: 2.5, width: 99.9, height: 49.9 }, dpr: 3.0 },
      { rect: { x: 0, y: 0, width: 360, height: 780 }, dpr: 2.625 }
    ];
    for (const { rect, dpr } of cases) {
      const px = logicalToPhysicalPx(rect, dpr, 1080, 2340);
      expect(Number.isInteger(px.x)).toBe(true);
      expect(Number.isInteger(px.y)).toBe(true);
      expect(Number.isInteger(px.width)).toBe(true);
      expect(Number.isInteger(px.height)).toBe(true);
    }
  });

  it('clamping — rect extending beyond screenshot is clamped to bounds', () => {
    // Logical rect goes 350-400 in a 1080px-wide screenshot (DPR=3: 1050-1200 → clamp to 1079)
    const result = logicalToPhysicalPx({ x: 350, y: 0, width: 50, height: 24 }, 3.0, 1080, 2340);
    expect(result.x).toBeLessThan(1080);
    expect(result.x + result.width).toBeLessThanOrEqual(1080);
  });

  it('clamping — rect starting before 0 is clamped to 0', () => {
    const result = logicalToPhysicalPx({ x: -5, y: -10, width: 20, height: 30 }, 3.0, 1080, 2340);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it('minimum width/height is 1 even for tiny rects', () => {
    const result = logicalToPhysicalPx({ x: 100, y: 200, width: 0.1, height: 0.1 }, 3.0, 1080, 2340);
    expect(result.width).toBeGreaterThanOrEqual(1);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });

  it('edge-to-edge rect fills full screenshot width', () => {
    // Full-width logical rect: x=0, width=360 at DPR=3 → x=0, width=1080
    const result = logicalToPhysicalPx({ x: 0, y: 0, width: 360, height: 780 }, 3.0, 1080, 2340);
    expect(result.x).toBe(0);
    expect(result.width).toBe(1080);
    expect(result.y).toBe(0);
    expect(result.height).toBe(2340);
  });

  describe('SafeArea / padding inset fixture', () => {
    it('status bar region (y=0 to statusBarHeight) converts correctly at DPR 3.0', () => {
      // Status bar: logical y=0, height=47 at DPR=3 → physical y=0, height=141
      const result = logicalToPhysicalPx({ x: 0, y: 0, width: 360, height: 47 }, 3.0, 1080, 2340);
      expect(result.y).toBe(0);
      expect(result.height).toBe(141);
    });

    it('content below status bar starts at correct physical y', () => {
      // Logical content at y=47, height=100 → physical y=141, height=300
      const result = logicalToPhysicalPx({ x: 0, y: 47, width: 360, height: 100 }, 3.0, 1080, 2340);
      expect(result.y).toBe(141);
      expect(result.height).toBe(300);
    });
  });
});

describe('parseFlutterAnchorDump — coordinate integration', () => {
  function makeAnchorDump(dpr: number, screenshotW: number, screenshotH: number, anchors: unknown[]) {
    return {
      framework: 'flutter',
      screen: 'TestScreen',
      coordinateSpace: 'flutterLogical',
      coordinateOrigin: 'topLeft',
      device: {
        screenshotWidthPx: screenshotW,
        screenshotHeightPx: screenshotH,
        devicePixelRatio: dpr,
        mediaQuerySizeLogical: { width: screenshotW / dpr, height: screenshotH / dpr },
        paddingLogical: { top: 0, left: 0, right: 0, bottom: 0 },
        viewPaddingLogical: { top: 0, left: 0, right: 0, bottom: 0 },
        viewInsetsLogical: { top: 0, left: 0, right: 0, bottom: 0 }
      },
      anchors
    };
  }

  it('pre-resolves all anchor rects to integer pixels at parse time', () => {
    const raw = makeAnchorDump(3.0, 1080, 2340, [
      {
        id: 'target.a',
        rectLogical: { x: 12, y: 100, width: 80, height: 24 },
        visible: true,
        visibility: { visibleFraction: 1.0, isOffscreen: false }
      }
    ]);
    const result = parseFlutterAnchorDump(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rect = result.data.resolvedRects.get('target.a')!;
    expect(rect.x).toBe(36);
    expect(rect.y).toBe(300);
    expect(rect.width).toBe(240);
    expect(rect.height).toBe(72);
    expect(Number.isInteger(rect.x)).toBe(true);
    expect(Number.isInteger(rect.y)).toBe(true);
    expect(Number.isInteger(rect.width)).toBe(true);
    expect(Number.isInteger(rect.height)).toBe(true);
  });

  it('returns invalid_anchor_dump when DPR is missing', () => {
    const raw = makeAnchorDump(3.0, 1080, 2340, []);
    const dump = raw as Record<string, unknown>;
    (dump.device as Record<string, unknown>)['devicePixelRatio'] = undefined;
    delete (dump.device as Record<string, unknown>)['devicePixelRatio'];

    const result = parseFlutterAnchorDump(dump);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_anchor_dump');
  });

  it('returns invalid_anchor_dump when paddingLogical is missing', () => {
    const raw = makeAnchorDump(3.0, 1080, 2340, []);
    delete (raw.device as Record<string, unknown>)['paddingLogical'];
    const result = parseFlutterAnchorDump(raw);
    expect(result.ok).toBe(false);
  });

  it('returns invalid_anchor_dump when coordinateOrigin is missing', () => {
    const { coordinateOrigin: _, ...raw } = makeAnchorDump(3.0, 1080, 2340, []) as Record<string, unknown>;
    const result = parseFlutterAnchorDump(raw);
    expect(result.ok).toBe(false);
  });

  it('never throws on malformed input', () => {
    expect(() => parseFlutterAnchorDump(null)).not.toThrow();
    expect(() => parseFlutterAnchorDump(undefined)).not.toThrow();
    expect(() => parseFlutterAnchorDump('not json')).not.toThrow();
    expect(() => parseFlutterAnchorDump({ broken: true })).not.toThrow();
  });
});
