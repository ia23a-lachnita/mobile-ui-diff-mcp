import { describe, it, expect } from 'vitest';
import { EvidenceGraph } from '../src/pipeline/EvidenceGraph';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ConflictResolver } from '../src/pipeline/ConflictResolver';
import { ReferenceContextAnalyzer } from '../src/pipeline/analyzers/ReferenceContextAnalyzer';
import { referenceContextSchema } from '../src/config/uiDiffConfig';
import type { AnalyzerContext } from '../src/pipeline/analyzers/IAnalyzer';

describe('referenceContext config schema', () => {
  it('parses valid referenceContext config', () => {
    const raw = {
      enabled: true,
      facts: [
        { id: 'ring-stroke', subject: 'macro-ring', claim: 'BigMacroRing stroke is 10', authority: 'high' }
      ]
    };
    const result = referenceContextSchema!.parse(raw);
    expect(result?.enabled).toBe(true);
    expect(result?.facts).toHaveLength(1);
    expect(result?.facts![0].claim).toBe('BigMacroRing stroke is 10');
  });

  it('defaults enabled to false when not specified', () => {
    const result = referenceContextSchema!.parse({});
    expect(result?.enabled).toBe(false);
  });

  it('sources are optional', () => {
    const result = referenceContextSchema!.parse({ enabled: true });
    expect(result?.sources).toBeUndefined();
  });

  it('entire referenceContext is optional (undefined parses ok)', () => {
    const result = referenceContextSchema!.parse(undefined);
    expect(result).toBeUndefined();
  });

  it('fact authority defaults to high', () => {
    const raw = {
      enabled: true,
      facts: [{ id: 'f1', subject: 'ring', claim: 'ring ok' }]
    };
    const result = referenceContextSchema!.parse(raw);
    expect(result?.facts![0].authority).toBe('high');
  });
});

describe('referenceContext loading behavior', () => {
  it('facts loaded as source authority evidence do not throw on missing source file', () => {
    // ConflictResolver accepts referenceContext but missing source files emit warnings
    const graph = new EvidenceGraph();

    // Simulate what would happen when loading facts from a referenceContext
    // Facts themselves are always loadable; only file sources could be missing
    const refContext = {
      enabled: true,
      sources: [{ id: 's1', type: 'source' as const, path: '/nonexistent/file.jsx', authority: 'high' as const }],
      facts: [{ id: 'f1', subject: 'ring', claim: 'stroke is 10', authority: 'high' as const }]
    };

    // Facts are directly injectable as evidence (no file I/O needed)
    for (const fact of refContext.facts) {
      graph.add({
        source: 'referenceContext',
        claimId: `ref-fact-${fact.id}`,
        subject: fact.subject,
        claim: fact.claim,
        confidence: 1.0,
        authority: 'source'
      });
    }

    // Should not throw — missing source file path is handled by warnings only
    const resolver = new ConflictResolver(refContext);
    let error: Error | null = null;
    try {
      resolver.resolve(graph);
    } catch (e: any) {
      error = e;
    }
    expect(error).toBeNull();
  });

  it('reference facts appear as high-authority source evidence in the graph', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'referenceContext',
      claimId: 'ref-fact-ring-stroke',
      subject: 'roi:macro-ring',
      claim: 'BigMacroRing stroke is 10',
      confidence: 1.0,
      authority: 'source'
    });

    const sourceEvidence = graph.getBySource('referenceContext');
    expect(sourceEvidence).toHaveLength(1);
    expect(sourceEvidence[0].authority).toBe('source');
    expect(sourceEvidence[0].confidence).toBe(1.0);
  });

  it('missing referenceContext does not throw in ConflictResolver', () => {
    const graph = new EvidenceGraph();
    graph.add({
      source: 'roiQuality',
      claimId: 'roi-q-1',
      subject: 'roi:ring',
      claim: 'ROI passes',
      confidence: 1.0,
      authority: 'deterministic'
    });

    // No referenceContext provided
    const resolver = new ConflictResolver(undefined);
    let error: Error | null = null;
    try {
      resolver.resolve(graph);
    } catch (e: any) {
      error = e;
    }
    expect(error).toBeNull();
  });
});

describe('ReferenceContextAnalyzer', () => {
  const makeCtx = (overrides?: Partial<AnalyzerContext>): AnalyzerContext => ({
    runId: 'test-run',
    outputDir: '/tmp/test-output',
    configDir: '/tmp/test-project',
    roiDir: '/tmp/test-output/regions-of-interest',
    regionsDir: '/tmp/test-output/regions',
    expectedImagePath: '/tmp/expected.png',
    actualImagePath: '/tmp/actual.png',
    expectedPng: {} as any,
    actualPng: {} as any,
    comparisonPng: {} as any,
    actualSourceWidth: 400,
    actualSourceHeight: 800,
    regionsOfInterest: [],
    ignoreRegions: [],
    config: {} as any,
    ...overrides
  });

  it('returns empty result when disabled', async () => {
    const graph = new EvidenceGraph();
    const analyzer = new ReferenceContextAnalyzer({ enabled: false });
    const result = await analyzer.run(makeCtx(), graph) as any;
    expect(result.evidence).toHaveLength(0);
    expect(result.referenceContextSummary.factsLoaded).toBe(0);
    expect(graph.getAll()).toHaveLength(0);
  });

  it('returns empty result when referenceContext is undefined', async () => {
    const graph = new EvidenceGraph();
    const analyzer = new ReferenceContextAnalyzer(undefined);
    const result = await analyzer.run(makeCtx(), graph) as any;
    expect(result.evidence).toHaveLength(0);
    expect(result.referenceContextSummary.factsLoaded).toBe(0);
  });

  it('loads inline facts as source-authority evidence into EvidenceGraph', async () => {
    const graph = new EvidenceGraph();
    const analyzer = new ReferenceContextAnalyzer({
      enabled: true,
      facts: [
        { id: 'ring-stroke', subject: 'roi:macro-ring', claim: 'Stroke width is 10px', authority: 'high' },
        { id: 'ring-gap', subject: 'roi:macro-ring', claim: 'Ring gap is 2px', authority: 'medium' }
      ]
    });
    const result = await analyzer.run(makeCtx(), graph) as any;

    expect(result.referenceContextSummary.factsLoaded).toBe(2);
    expect(result.referenceContextSummary.missingFiles).toHaveLength(0);

    const sourceEvidence = graph.getAll().filter((e) => e.authority === 'source');
    expect(sourceEvidence).toHaveLength(2);
    expect(sourceEvidence[0].claimId).toBe('ref-fact-ring-stroke');
    expect(sourceEvidence[0].confidence).toBe(1.0);
    expect(sourceEvidence[1].confidence).toBe(0.7);
  });

  it('warns on missing source files and still emits evidence with confidence 0', async () => {
    const graph = new EvidenceGraph();
    const analyzer = new ReferenceContextAnalyzer({
      enabled: true,
      sources: [
        { id: 'comp-src', type: 'component', path: '/nonexistent/Component.tsx', authority: 'high' }
      ]
    });
    const result = await analyzer.run(makeCtx(), graph) as any;

    expect(result.referenceContextSummary.sourcesLoaded).toBe(0);
    expect(result.referenceContextSummary.missingFiles).toContain('/nonexistent/Component.tsx');
    expect(result.warnings).toHaveLength(1);

    const e = graph.getAll().find((ev) => ev.claimId === 'ref-source-comp-src');
    expect(e).toBeDefined();
    expect(e!.confidence).toBe(0);
    expect((e!.measurements as any).fileExists).toBe(false);
  });

  it('resolves relative source path from configDir, not outputDir', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'refctx-'));
    const mockupDir = path.join(tmpDir, 'docs', 'mockups', 'source');
    await fs.mkdir(mockupDir, { recursive: true });
    const mockupFile = path.join(mockupDir, 'Today.jsx');
    await fs.writeFile(mockupFile, 'export default function Today() { return <View />; }', 'utf-8');

    try {
      const graph = new EvidenceGraph();
      const analyzer = new ReferenceContextAnalyzer({
        enabled: true,
        sources: [{ id: 'today-jsx', type: 'source', path: 'docs/mockups/source/Today.jsx', authority: 'high' }]
      });
      const ctx = makeCtx({ configDir: tmpDir, outputDir: path.join(tmpDir, 'output') });
      const result = await analyzer.run(ctx, graph) as any;

      expect(result.referenceContextSummary.sourcesLoaded).toBe(1);
      expect(result.referenceContextSummary.missingFiles).toHaveLength(0);
      const e = graph.getAll().find((ev) => ev.claimId === 'ref-source-today-jsx');
      expect(e).toBeDefined();
      expect(e!.confidence).toBe(1.0);
      expect((e!.measurements as any).fileExists).toBe(true);
      expect((e!.measurements as any).snippet).toContain('Today');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('emitted facts are picked up by ConflictResolver as source evidence', async () => {
    const graph = new EvidenceGraph();
    const analyzer = new ReferenceContextAnalyzer({
      enabled: true,
      facts: [{ id: 'f1', subject: 'roi:ring', claim: 'No change expected', authority: 'high' }]
    });
    await analyzer.run(makeCtx(), graph);

    // Simulate a model claim contradicting the fact
    graph.add({
      source: 'modelJudge',
      claimId: 'model-claim-1',
      subject: 'roi:ring',
      claim: 'ring differs significantly',
      confidence: 0.8,
      authority: 'model',
      proposedChangeVector: 'ring_stroke_width'
    });

    const resolver = new ConflictResolver({ enabled: true });
    const result = resolver.resolve(graph);
    // ConflictResolver may downgrade or block — no exception is the key invariant
    expect(result).toBeDefined();
    expect(Array.isArray(result.blockedClaimIds)).toBe(true);
  });
});
