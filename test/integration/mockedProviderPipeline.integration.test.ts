/**
 * Integration tests requiring a mocked OpenRouterProvider to exercise the full
 * runScreenUiDiff → report.json path without real network calls.
 *
 * Covers 4 assertions that the earlier integration tests could not make:
 *  1. timeoutMs / maxRetries / retryOnParseError reach the OpenRouterProvider constructor
 *  2. overlapLegibility severity drives visualAuditStatus and produces on-disk artifacts
 *  3. referenceContext.facts blocking seed_data removes the claim end-to-end
 *  4. ConflictResolver-blocked model claim is absent from the final report (selective filter)
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PNG } from 'pngjs';

// vi.mock is hoisted by vitest — must appear before any import that loads the module
vi.mock('../../src/pipeline/judges/providers/OpenRouterProvider');

import { OpenRouterProvider } from '../../src/pipeline/judges/providers/OpenRouterProvider';
import { runScreenUiDiff } from '../../src/tools/runScreenUiDiff';

const MockedProvider = vi.mocked(OpenRouterProvider);

// ── image helpers ─────────────────────────────────────────────────────────────

function makeWhitePng(width = 100, height = 100): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 240; png.data[i + 1] = 240; png.data[i + 2] = 240; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** Green patch at x:10-39, y:30-59 — avoidColor #00dc00 lands inside the overlap region. */
function makeImageWithGreenPatch(width = 100, height = 100): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      if (x >= 10 && x < 40 && y >= 30 && y < 60) {
        png.data[idx] = 0; png.data[idx + 1] = 220; png.data[idx + 2] = 0; png.data[idx + 3] = 255;
      } else {
        png.data[idx] = 240; png.data[idx + 1] = 240; png.data[idx + 2] = 240; png.data[idx + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

// ── test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;
let savedApiKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-mock-prov-'));
  savedApiKey = process.env.OPENROUTER_API_KEY;
  MockedProvider.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (savedApiKey !== undefined) {
    process.env.OPENROUTER_API_KEY = savedApiKey;
  } else {
    delete process.env.OPENROUTER_API_KEY;
  }
});

async function writeFile(name: string, buf: Buffer | string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, buf);
  return p;
}

async function writeConfig(screenName: string, screenConfig: Record<string, unknown>): Promise<string> {
  const configPath = path.join(tmpDir, 'ui-diff.config.json');
  await fs.writeFile(configPath, JSON.stringify({ screens: { [screenName]: screenConfig } }, null, 2));
  return configPath;
}

// ── 1. timeoutMs / maxRetries / retryOnParseError reach provider constructor ──

describe('modelJudges timeout/retry config reaches OpenRouterProvider constructor', () => {
  it('passes timeoutMs, maxRetries, retryOnParseError from config to the provider constructor', async () => {
    // Must use a regular function (not arrow) — arrow functions cannot be used as constructors
    MockedProvider.mockImplementation(function() { return { analyze: vi.fn().mockResolvedValue([]) }; } as any);
    process.env.OPENROUTER_API_KEY = 'test-key-constructor-check';

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const configPath = await writeConfig('home', {
      platform: 'none',
      expectedImage: expectedPath,
      outputDir: path.join(tmpDir, 'runs'),
      visualAuditMode: 'visual_parity',
      modelJudges: {
        enabled: true,
        required: false,
        timeoutMs: 7500,
        maxRetries: 3,
        retryOnParseError: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      }
    });

    await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: await writeFile('actual.png', makeWhitePng()),
      runName: 'run-ctor'
    });

    // buildProvider passes: (apiKey, model, timeoutMs, maxRetries, retryOnParseError)
    expect(MockedProvider).toHaveBeenCalled();
    const primaryCall = MockedProvider.mock.calls[0];
    expect(primaryCall[2]).toBe(7500);   // timeoutMs
    expect(primaryCall[3]).toBe(3);      // maxRetries
    expect(primaryCall[4]).toBe(false);  // retryOnParseError
  });
});

// ── 2. overlapLegibility severity drives visualAuditStatus and artifact ───────

describe('overlapLegibility severity drives visualAuditStatus via runScreenUiDiff', () => {
  // Region covers the green patch (x:10-39, y:30-59) — ~44% overlap well above any threshold
  const overlapRegion = {
    id: 'pill',
    box: { x: 5, y: 25, width: 45, height: 45 },
    avoidColors: ['#00dc00'],
    maxOverlapPercent: 1
  };

  it('warning severity produces pass_with_caveats, non-blocking caveat, and artifact on disk', async () => {
    // Must set API key so buildProvider constructs the mock (not null) — otherwise policy='always_audit'
    // triggers actionRequired:model_judges_unavailable which overrides overlap-driven visualAuditStatus.
    // analyze returns [] — no bundles (no ROIs) so primaryHadSuccess=false, required:false → else branch.
    MockedProvider.mockImplementation(function() { return { analyze: vi.fn().mockResolvedValue([]) }; } as any);
    process.env.OPENROUTER_API_KEY = 'test-key-overlap-warn';

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeImageWithGreenPatch());
    const configPath = await writeConfig('home', {
      platform: 'none',
      expectedImage: expectedPath,
      outputDir: path.join(tmpDir, 'runs'),
      visualAuditMode: 'visual_parity',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{ ...overlapRegion, severity: 'warning' }]
      }
    });

    const run = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualPath,
      runName: 'run-warn'
    });

    // Non-blocking overlap caveat → pass_with_caveats
    expect(run.visualAuditStatus).toBe('pass_with_caveats');

    // visualCaveats contains the overlap finding
    const overlapCaveat = run.visualCaveats?.find((c) => c.id === 'overlap-legibility-pill');
    expect(overlapCaveat).toBeDefined();
    expect(overlapCaveat!.blocking).toBe(false);
    expect(overlapCaveat!.severity).toBe('warning');

    // Artifact PNG was written to disk
    expect(overlapCaveat!.artifacts).toBeDefined();
    expect(overlapCaveat!.artifacts!.length).toBeGreaterThan(0);
    await expect(fs.access(overlapCaveat!.artifacts![0])).resolves.toBeUndefined();

    // report.json on disk mirrors the in-memory report
    const persisted = JSON.parse(await fs.readFile(run.run.reportPath, 'utf-8'));
    const persistedCaveat = persisted.visualCaveats?.find((c: any) => c.id === 'overlap-legibility-pill');
    expect(persistedCaveat).toBeDefined();
    expect(persistedCaveat.blocking).toBe(false);
    expect(persistedCaveat.artifacts).toContain(overlapCaveat!.artifacts![0]);
  });

  it('high severity produces fail, blocking caveat, and artifact on disk', async () => {
    MockedProvider.mockImplementation(function() { return { analyze: vi.fn().mockResolvedValue([]) }; } as any);
    process.env.OPENROUTER_API_KEY = 'test-key-overlap-high';

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const actualPath = await writeFile('actual.png', makeImageWithGreenPatch());
    const configPath = await writeConfig('home', {
      platform: 'none',
      expectedImage: expectedPath,
      outputDir: path.join(tmpDir, 'runs'),
      visualAuditMode: 'visual_parity',
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      overlapLegibility: {
        regions: [{ ...overlapRegion, severity: 'high' }]
      }
    });

    const run = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: actualPath,
      runName: 'run-high'
    });

    // Blocking overlap caveat → fail / rejected
    expect(run.visualAuditStatus).toBe('fail');
    expect(run.acceptanceStatus).toBe('rejected');

    const overlapCaveat = run.visualCaveats?.find((c) => c.id === 'overlap-legibility-pill');
    expect(overlapCaveat).toBeDefined();
    expect(overlapCaveat!.blocking).toBe(true);
    expect(overlapCaveat!.severity).toBe('high');

    // Artifact on disk
    expect(overlapCaveat!.artifacts?.length).toBeGreaterThan(0);
    await expect(fs.access(overlapCaveat!.artifacts![0])).resolves.toBeUndefined();

    // report.json mirrors
    const persisted = JSON.parse(await fs.readFile(run.run.reportPath, 'utf-8'));
    const persistedCaveat = persisted.visualCaveats?.find((c: any) => c.id === 'overlap-legibility-pill');
    expect(persistedCaveat?.blocking).toBe(true);
    expect(persisted.visualAuditStatus).toBe('fail');
    expect(persisted.acceptanceStatus).toBe('rejected');
  });
});

// ── 3. Full-path source-contradiction: config referenceContext blocks seed_data ─

describe('full-path source-contradiction via referenceContext config and runScreenUiDiff', () => {
  it('reference fact blocking seed_data removes caveat from report and allowedChangeVectors', async () => {
    // Mock provider returns a seed_data mismatch claim that would ordinarily surface as a blocking caveat
    MockedProvider.mockImplementation(function() { return {
      analyze: vi.fn().mockResolvedValue([{
        source: 'modelJudge',
        claimId: 'judge-seed-mismatch',
        subject: 'roi:test-roi',
        claim: 'Arc sweep shorter than expected — possible seed/plan data mismatch',
        confidence: 0.85,
        authority: 'model',
        polarity: 'mismatch',
        blocking: true,
        proposedChangeVector: 'seed_data'
      }])
    }; } as any);
    process.env.OPENROUTER_API_KEY = 'test-key-seed-block';

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const configPath = await writeConfig('home', {
      platform: 'none',
      expectedImage: expectedPath,
      outputDir: path.join(tmpDir, 'runs'),
      visualAuditMode: 'visual_parity',
      regionsOfInterest: [{
        id: 'test-roi',
        label: 'Macro Ring',
        type: 'component',
        critical: false,
        box: { x: 0, y: 0, width: 100, height: 100 }
      }],
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      referenceContext: {
        enabled: true,
        facts: [{
          id: 'macro-match',
          subject: 'global',
          claim: 'Carbs 132/250, Protein 96/170 — current macro values match the reference fixture',
          authority: 'high',
          blocksChangeVectors: ['seed_data', 'fixture_plan']
        }]
      }
    });

    const run = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: await writeFile('actual.png', makeWhitePng()),
      runName: 'run-seed-block'
    });

    // The seed_data mismatch caveat must be absent from the live report
    expect(run.visualCaveats?.find((c) => c.id === 'judge-seed-mismatch')).toBeUndefined();

    // agentActionContract must not offer seed_data as an allowed change
    const seedVector = run.agentActionContract?.allowedChangeVectors?.find(
      (v: any) => v.vector === 'seed_data'
    );
    expect(seedVector).toBeUndefined();

    // report.json on disk must agree
    const persisted = JSON.parse(await fs.readFile(run.run.reportPath, 'utf-8'));
    expect(persisted.visualCaveats?.find((c: any) => c.id === 'judge-seed-mismatch')).toBeUndefined();

    // A conflict/blocking warning must appear somewhere in the report
    const allWarnings: string[] = [
      ...(persisted.warnings ?? []),
      ...(run.agentSummary?.warnings ?? [])
    ];
    expect(
      allWarnings.some((w) =>
        w.toLowerCase().includes('blocked') ||
        w.toLowerCase().includes('contradiction') ||
        w.toLowerCase().includes('seed')
      )
    ).toBe(true);
  });
});

// ── 3b. Recent Scans green-pill contradiction via blocksClaimsMatching ────────

describe('Recent Scans source-fact: blocksClaimsMatching removes green-pill claim', () => {
  it('model claim matching blocksClaimsMatching phrase is absent from visualCaveats', async () => {
    MockedProvider.mockImplementation(function() { return {
      analyze: vi.fn().mockResolvedValue([
        {
          source: 'modelJudge',
          claimId: 'judge-recent-scans-green-pill',
          subject: 'roi:test-roi',
          claim: 'Recent scans label appears as a green filled pill but muted text is expected',
          confidence: 0.87,
          authority: 'model',
          polarity: 'mismatch',
          blocking: true,
          proposedChangeVector: 'ui_style'
        },
        {
          source: 'modelJudge',
          claimId: 'judge-unrelated-claim',
          subject: 'roi:test-roi',
          claim: 'Macro ring arc shorter than expected',
          confidence: 0.78,
          authority: 'model',
          polarity: 'mismatch',
          blocking: true,
          proposedChangeVector: 'seed_data'
        }
      ])
    }; } as any);
    process.env.OPENROUTER_API_KEY = 'test-key-green-pill';

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const configPath = await writeConfig('home', {
      platform: 'none',
      expectedImage: expectedPath,
      outputDir: path.join(tmpDir, 'runs'),
      visualAuditMode: 'visual_parity',
      regionsOfInterest: [{
        id: 'test-roi',
        label: 'Test Region',
        type: 'component',
        critical: false,
        box: { x: 0, y: 0, width: 100, height: 100 }
      }],
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      referenceContext: {
        enabled: true,
        facts: [{
          id: 'recent-scans-is-muted-text',
          subject: 'global',
          claim: 'Recent scans label renders as muted text — the green filled pill style is a reference fixture artifact, not a real UI state',
          authority: 'high',
          blocksClaimsMatching: ['green filled pill', 'recent scans']
        }]
      }
    });

    const run = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: await writeFile('actual.png', makeWhitePng()),
      runName: 'run-green-pill'
    });

    // The green-pill claim must be blocked and absent from visualCaveats
    expect(run.visualCaveats?.find((c) => c.id === 'judge-recent-scans-green-pill')).toBeUndefined();

    // The unrelated claim must survive (proves selective filtering)
    expect(run.visualCaveats?.find((c) => c.id === 'judge-unrelated-claim')).toBeDefined();

    // report.json must agree
    const persisted = JSON.parse(await fs.readFile(run.run.reportPath, 'utf-8'));
    expect(persisted.visualCaveats?.find((c: any) => c.id === 'judge-recent-scans-green-pill')).toBeUndefined();
    expect(persisted.visualCaveats?.find((c: any) => c.id === 'judge-unrelated-claim')).toBeDefined();

    // A blocking warning must appear somewhere
    const allWarnings: string[] = [
      ...(persisted.warnings ?? []),
      ...(run.agentSummary?.warnings ?? [])
    ];
    expect(
      allWarnings.some((w) =>
        w.toLowerCase().includes('blocked') &&
        (w.toLowerCase().includes('green') || w.toLowerCase().includes('recent'))
      )
    ).toBe(true);
  });
});

// ── 4. Blocked claim excluded from final report; unblocked claim retained ─────

describe('ConflictResolver-blocked model caveat is excluded from final report', () => {
  it('blocked seed_data caveat absent from report.json; unblocked text_style caveat present', async () => {
    // Two claims: one will be blocked by the reference fact, one will not
    MockedProvider.mockImplementation(function() { return {
      analyze: vi.fn().mockResolvedValue([
        {
          source: 'modelJudge',
          claimId: 'judge-seed-blocked',
          subject: 'roi:test-roi',
          claim: 'Values suggest seed/plan data mismatch — arc shorter than expected',
          confidence: 0.82,
          authority: 'model',
          polarity: 'mismatch',
          blocking: true,
          proposedChangeVector: 'seed_data'
        },
        {
          source: 'modelJudge',
          claimId: 'judge-text-unblocked',
          subject: 'roi:test-roi',
          claim: 'Label text appears lighter than expected — check text_style token',
          confidence: 0.75,
          authority: 'model',
          polarity: 'mismatch',
          blocking: false,
          proposedChangeVector: 'text_style'
        }
      ])
    }; } as any);
    process.env.OPENROUTER_API_KEY = 'test-key-filter-check';

    const expectedPath = await writeFile('expected.png', makeWhitePng());
    const configPath = await writeConfig('home', {
      platform: 'none',
      expectedImage: expectedPath,
      outputDir: path.join(tmpDir, 'runs'),
      visualAuditMode: 'visual_parity',
      regionsOfInterest: [{
        id: 'test-roi',
        label: 'Test Region',
        type: 'component',
        critical: false,
        box: { x: 0, y: 0, width: 100, height: 100 }
      }],
      modelJudges: {
        enabled: true,
        required: false,
        primary: { provider: 'openrouter', model: 'test-model' }
      },
      referenceContext: {
        enabled: true,
        facts: [{
          id: 'macro-values-match',
          subject: 'global',
          claim: 'Macro values confirmed — no seed or fixture change warranted',
          authority: 'high',
          blocksChangeVectors: ['seed_data']
        }]
      }
    });

    const run = await runScreenUiDiff({
      screen: 'home',
      configPath,
      actualImage: await writeFile('actual.png', makeWhitePng()),
      runName: 'run-filter'
    });

    // Blocked claim must not appear in visualCaveats
    expect(run.visualCaveats?.find((c) => c.id === 'judge-seed-blocked')).toBeUndefined();

    // Unblocked claim must appear (proves the filter is selective, not a blanket wipe)
    const textCaveat = run.visualCaveats?.find((c) => c.id === 'judge-text-unblocked');
    expect(textCaveat).toBeDefined();
    expect(textCaveat!.proposedChangeVector).toBe('text_style');

    // Verify selective filtering in persisted report.json
    const persisted = JSON.parse(await fs.readFile(run.run.reportPath, 'utf-8'));
    expect(persisted.visualCaveats?.find((c: any) => c.id === 'judge-seed-blocked')).toBeUndefined();
    expect(persisted.visualCaveats?.find((c: any) => c.id === 'judge-text-unblocked')).toBeDefined();
  });
});
