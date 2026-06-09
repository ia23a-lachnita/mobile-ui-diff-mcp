import { describe, it, expect } from 'vitest';
import { runDiscovery } from '../src/flutter/discoveryWorkflow';
import { parseFlutterAnchorDump } from '../src/flutter/anchorDumpParser';
import type { SemanticTargetMapParsed } from '../src/flutter/semanticTargetMap';
import type { ProposedCriteria } from '../src/flutter/discoveryWorkflow';

function makeDump(anchors: Array<{ id: string; label?: string; visible?: boolean; visibleFraction?: number }>) {
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
      paddingLogical: { top: 47, left: 0, right: 0, bottom: 0 },
      viewPaddingLogical: { top: 47, left: 0, right: 0, bottom: 0 },
      viewInsetsLogical: { top: 0, left: 0, right: 0, bottom: 0 }
    },
    anchors: anchors.map((a) => ({
      id: a.id,
      label: a.label,
      rectLogical: { x: 12, y: 100, width: 80, height: 24 },
      visible: a.visible ?? true,
      visibility: { visibleFraction: a.visibleFraction ?? 1.0, isOffscreen: false }
    }))
  };
}

const mockCriteriaProposer = async (anchorId: string): Promise<ProposedCriteria[]> => {
  // Mock: proposes legibility criterion for kcal-type anchors
  if (anchorId.includes('kcal')) {
    return [
      {
        id: `${anchorId}.legibility`,
        domain: 'legibility.overlap',
        avoidColors: ['#1FCC74'],
        minClearancePx: 4,
        maxOverlapPercent: 1.0,
        severity: 'warning'
      }
    ];
  }
  return [];
};

describe('runDiscovery — target map generation', () => {
  it('generates a target map entry for today.kcalLeftPill with flutter_anchor locator', async () => {
    const raw = makeDump([
      { id: 'today.kcalLeftPill', label: 'Kcal left pill' }
    ]);
    const parsed = parseFlutterAnchorDump(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await runDiscovery({
      screen: 'TodayScreen',
      anchorDump: parsed.data,
      criteriaProposer: mockCriteriaProposer
    });

    const target = result.proposedTargetMap.targets.find((t) => t.id === 'today.kcalLeftPill');
    expect(target).toBeDefined();
    expect(target?.locator.type).toBe('flutter_anchor');
    expect(target?.locator.anchorId).toBe('today.kcalLeftPill');
    expect(target?.locator.required).toBe(true);
  });

  it('proposed target does not contain static x/y/w/h — only anchor locator', async () => {
    const raw = makeDump([{ id: 'today.kcalLeftPill' }]);
    const parsed = parseFlutterAnchorDump(raw);
    if (!parsed.ok) return;

    const result = await runDiscovery({
      screen: 'TodayScreen',
      anchorDump: parsed.data,
      criteriaProposer: mockCriteriaProposer
    });

    const target = result.proposedTargetMap.targets.find((t) => t.id === 'today.kcalLeftPill')!;
    // No static box coordinates in the locator
    expect((target.locator as Record<string, unknown>)['box']).toBeUndefined();
    expect((target.locator as Record<string, unknown>)['x']).toBeUndefined();
    expect((target.locator as Record<string, unknown>)['y']).toBeUndefined();
  });

  it('proposed criteria come from mock proposer (not from rect calculations)', async () => {
    const raw = makeDump([{ id: 'today.kcalLeftPill' }]);
    const parsed = parseFlutterAnchorDump(raw);
    if (!parsed.ok) return;

    const result = await runDiscovery({
      screen: 'TodayScreen',
      anchorDump: parsed.data,
      criteriaProposer: mockCriteriaProposer
    });

    const target = result.proposedTargetMap.targets.find((t) => t.id === 'today.kcalLeftPill')!;
    expect(target.criteria).toHaveLength(1);
    expect(target.criteria[0].domain).toBe('legibility.overlap');
    expect(target.criteria[0].avoidColors).toContain('#1FCC74');
  });

  it('anchor in dump but missing from existingTargetMap generates missing-anchor suggestion', async () => {
    const raw = makeDump([
      { id: 'today.kcalLeftPill' },
      { id: 'today.newWidget' }   // not in existing map
    ]);
    const parsed = parseFlutterAnchorDump(raw);
    if (!parsed.ok) return;

    const existingMap: SemanticTargetMapParsed = {
      version: '1',
      screen: 'TodayScreen',
      targets: [
        {
          id: 'today.kcalLeftPill',
          locator: { type: 'flutter_anchor', anchorId: 'today.kcalLeftPill', required: true },
          criteria: []
        }
      ]
    };

    const result = await runDiscovery({
      screen: 'TodayScreen',
      anchorDump: parsed.data,
      existingTargetMap: existingMap,
      criteriaProposer: mockCriteriaProposer
    });

    expect(result.missingAnchorSuggestions).toHaveLength(1);
    expect(result.missingAnchorSuggestions[0].anchorId).toBe('today.newWidget');
    expect(result.missingAnchorSuggestions[0].suggestedEntry.locator.type).toBe('flutter_anchor');
  });

  it('target in existingTargetMap with no matching anchor → unmatchedTargetIds', async () => {
    const raw = makeDump([
      { id: 'today.kcalLeftPill' }
    ]);
    const parsed = parseFlutterAnchorDump(raw);
    if (!parsed.ok) return;

    const existingMap: SemanticTargetMapParsed = {
      version: '1',
      screen: 'TodayScreen',
      targets: [
        {
          id: 'today.kcalLeftPill',
          locator: { type: 'flutter_anchor', anchorId: 'today.kcalLeftPill', required: true },
          criteria: []
        },
        {
          id: 'today.deletedWidget',
          locator: { type: 'flutter_anchor', anchorId: 'today.deletedWidget', required: true },
          criteria: []
        }
      ]
    };

    const result = await runDiscovery({
      screen: 'TodayScreen',
      anchorDump: parsed.data,
      existingTargetMap: existingMap
    });

    expect(result.unmatchedTargetIds).toContain('today.deletedWidget');
    expect(result.unmatchedTargetIds).not.toContain('today.kcalLeftPill');
  });

  it('works without a criteriaProposer — criteria array is empty', async () => {
    const raw = makeDump([{ id: 'today.kcalLeftPill' }]);
    const parsed = parseFlutterAnchorDump(raw);
    if (!parsed.ok) return;

    const result = await runDiscovery({
      screen: 'TodayScreen',
      anchorDump: parsed.data
    });

    const target = result.proposedTargetMap.targets[0];
    expect(target.criteria).toHaveLength(0);
  });

  it('proposed target map has correct screen name', async () => {
    const raw = makeDump([{ id: 'today.kcalLeftPill' }]);
    const parsed = parseFlutterAnchorDump(raw);
    if (!parsed.ok) return;

    const result = await runDiscovery({ screen: 'TodayScreen', anchorDump: parsed.data });
    expect(result.proposedTargetMap.screen).toBe('TodayScreen');
  });

  it('empty anchor dump produces empty target map and no suggestions', async () => {
    const raw = makeDump([]);
    const parsed = parseFlutterAnchorDump(raw);
    if (!parsed.ok) return;

    const result = await runDiscovery({ screen: 'TodayScreen', anchorDump: parsed.data });
    expect(result.proposedTargetMap.targets).toHaveLength(0);
    expect(result.missingAnchorSuggestions).toHaveLength(0);
  });
});
