import { describe, it, expect } from 'vitest';
import { parseFlutterAnchorDump } from '../src/flutter/anchorDumpParser';

function makeBaseDump(anchorOverrides: Record<string, unknown> = {}) {
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
        visibility: { visibleFraction: 1.0, isOffscreen: false },
        ...anchorOverrides
      }
    ]
  };
}

const CLEAN_DUMP = makeBaseDump();

const DUMP_WITH_FRAMEWORK_FIELDS = makeBaseDump({
  renderObject: { type: 'RenderBox', size: { width: 80, height: 24 } },
  context: { widget: 'Container' }
});

describe('anchor dump warning propagation', () => {
  it('clean dump produces no warnings', () => {
    const result = parseFlutterAnchorDump(CLEAN_DUMP);
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeUndefined();
  });

  it('dump with renderObject produces anchor_dump_extra_framework_fields_stripped warning', () => {
    const result = parseFlutterAnchorDump(DUMP_WITH_FRAMEWORK_FIELDS);
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('anchor_dump_extra_framework_fields_stripped'))).toBe(true);
    expect(result.warnings!.some((w) => w.includes('today.kcalLeftPill'))).toBe(true);
  });

  it('warning lists the specific stripped field names', () => {
    const result = parseFlutterAnchorDump(DUMP_WITH_FRAMEWORK_FIELDS);
    const combined = result.warnings!.join(' ');
    expect(combined).toContain('renderObject');
  });

  it('warnings would reach report.warnings via RunOrchestrator push', () => {
    // Simulate the RunOrchestrator wiring: if (artifact.warnings?.length) warnings.push(...artifact.warnings)
    const result = parseFlutterAnchorDump(DUMP_WITH_FRAMEWORK_FIELDS);
    const reportWarnings: string[] = [];
    if (result.warnings?.length) reportWarnings.push(...result.warnings);
    expect(reportWarnings.some((w) => w.includes('anchor_dump_extra_framework_fields_stripped'))).toBe(true);
  });

  it('parse still succeeds with framework fields — non-fatal', () => {
    const result = parseFlutterAnchorDump(DUMP_WITH_FRAMEWORK_FIELDS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.dump.anchors).toHaveLength(1);
      expect(result.data.dump.anchors[0].id).toBe('today.kcalLeftPill');
    }
  });
});
