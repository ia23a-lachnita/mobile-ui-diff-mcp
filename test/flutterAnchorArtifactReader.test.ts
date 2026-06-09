import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { waitForAnchorArtifact } from '../src/flutter/anchorArtifactReader';

function makeValidDumpJson(): string {
  return JSON.stringify({
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
    anchors: [
      {
        id: 'today.kcalLeftPill',
        rectLogical: { x: 12, y: 100, width: 80, height: 24 },
        visible: true,
        visibility: { visibleFraction: 1.0, isOffscreen: false }
      }
    ]
  });
}

describe('waitForAnchorArtifact', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anchor-artifact-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns ready when done file and valid JSON both exist', async () => {
    const jsonPath = path.join(tmpDir, 'flutter-anchors.json');
    const donePath = path.join(tmpDir, 'flutter-anchors.done');
    await fs.writeFile(jsonPath, makeValidDumpJson(), 'utf-8');
    await fs.writeFile(donePath, '', 'utf-8');

    const result = await waitForAnchorArtifact({
      artifactDir: tmpDir,
      timeoutMs: 2000,
      pollIntervalMs: 50
    });

    expect(result.status).toBe('ready');
    expect(result.parsed).toBeDefined();
    expect(result.parsed?.dump.screen).toBe('TodayScreen');
  });

  it('returns ready when file is stable (no done flag)', async () => {
    const jsonPath = path.join(tmpDir, 'flutter-anchors.json');
    await fs.writeFile(jsonPath, makeValidDumpJson(), 'utf-8');
    // No .done file — stability polling should work

    const result = await waitForAnchorArtifact({
      artifactDir: tmpDir,
      timeoutMs: 3000,
      pollIntervalMs: 50,
      stablePollCount: 2
    });

    expect(result.status).toBe('ready');
  });

  it('returns anchor_artifact_timeout when file never appears', async () => {
    const result = await waitForAnchorArtifact({
      artifactDir: tmpDir,
      timeoutMs: 300,
      pollIntervalMs: 50
    });

    expect(result.status).toBe('anchor_artifact_timeout');
    expect(result.error).toMatch(/Timed out/);
  });

  it('returns invalid_anchor_dump when done file exists but JSON is invalid', async () => {
    const jsonPath = path.join(tmpDir, 'flutter-anchors.json');
    const donePath = path.join(tmpDir, 'flutter-anchors.done');
    await fs.writeFile(jsonPath, '{ broken json ]]', 'utf-8');
    await fs.writeFile(donePath, '', 'utf-8');

    const result = await waitForAnchorArtifact({
      artifactDir: tmpDir,
      timeoutMs: 1000,
      pollIntervalMs: 50
    });

    expect(result.status).toBe('invalid_anchor_dump');
  });

  it('returns invalid_anchor_dump when JSON is valid but schema fails', async () => {
    const jsonPath = path.join(tmpDir, 'flutter-anchors.json');
    const donePath = path.join(tmpDir, 'flutter-anchors.done');
    // Valid JSON but missing required fields
    await fs.writeFile(jsonPath, JSON.stringify({ framework: 'flutter', screen: 'Test' }), 'utf-8');
    await fs.writeFile(donePath, '', 'utf-8');

    const result = await waitForAnchorArtifact({
      artifactDir: tmpDir,
      timeoutMs: 1000,
      pollIntervalMs: 50
    });

    expect(result.status).toBe('invalid_anchor_dump');
  });

  it('waits when no file exists yet, then succeeds once done flag appears', async () => {
    // File does not exist at start — reader should poll and wait.
    // After 150ms write the valid JSON + done flag.
    const jsonPath = path.join(tmpDir, 'flutter-anchors.json');
    const donePath = path.join(tmpDir, 'flutter-anchors.done');

    let wroteFiles = false;
    const writeTimer = setTimeout(async () => {
      wroteFiles = true;
      await fs.writeFile(jsonPath, makeValidDumpJson(), 'utf-8');
      await fs.writeFile(donePath, '', 'utf-8');
    }, 200);

    const result = await waitForAnchorArtifact({
      artifactDir: tmpDir,
      timeoutMs: 3000,
      pollIntervalMs: 50,
      stablePollCount: 2
    });

    clearTimeout(writeTimer);
    expect(wroteFiles).toBe(true);
    expect(result.status).toBe('ready');
  });

  it('returns stable invalid_anchor_dump when file is stable but has wrong schema', async () => {
    // Write a valid JSON object that fails schema validation
    const jsonPath = path.join(tmpDir, 'flutter-anchors.json');
    await fs.writeFile(jsonPath, JSON.stringify({ notFlutter: true, anchors: [] }), 'utf-8');

    const result = await waitForAnchorArtifact({
      artifactDir: tmpDir,
      timeoutMs: 2000,
      pollIntervalMs: 50,
      stablePollCount: 2
    });

    expect(result.status).toBe('invalid_anchor_dump');
  });

  it('does not crash when artifactDir does not exist', async () => {
    const result = await waitForAnchorArtifact({
      artifactDir: path.join(tmpDir, 'nonexistent-subdir'),
      timeoutMs: 300,
      pollIntervalMs: 50
    });

    expect(result.status).toBe('anchor_artifact_timeout');
  });
});
