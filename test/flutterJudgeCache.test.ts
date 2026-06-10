import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { JudgeCache, computeCacheKeyString, hashContent, hashRect } from '../src/flutter/judgeCache';
import type { JudgeCacheKey } from '../src/flutter/judgeCache';

function makeKey(overrides: Partial<JudgeCacheKey> = {}): JudgeCacheKey {
  return {
    provider: 'openrouter',
    model: 'qwen/qwen2.5-vl-72b-instruct',
    promptVersion: 'v1',
    targetId: 'today.kcalLeftPill',
    criterionIds: ['today.kcalLeftPill.legibility'],
    actualImageHash: 'aaa111',
    actualCropHash: 'bbb222',
    anchorRectHash: 'ccc333',
    expectedImageHash: 'ddd444',
    sourceFactsHash: 'eee555',
    deterministicMeasurementHash: 'fff666',
    targetMapVersion: '1',
    ...overrides
  };
}

describe('JudgeCache', () => {
  it('returns undefined on cache miss', () => {
    const cache = new JudgeCache();
    expect(cache.get(makeKey())).toBeUndefined();
  });

  it('returns cached result after set', () => {
    const cache = new JudgeCache();
    const key = makeKey();
    cache.set(key, { judgeAuditStatus: 'pass', cachedAt: Date.now() });
    const hit = cache.get(key);
    expect(hit?.judgeAuditStatus).toBe('pass');
  });

  it('has() returns false before set', () => {
    const cache = new JudgeCache();
    expect(cache.has(makeKey())).toBe(false);
  });

  it('has() returns true after set', () => {
    const cache = new JudgeCache();
    const key = makeKey();
    cache.set(key, { judgeAuditStatus: 'pass', cachedAt: Date.now() });
    expect(cache.has(key)).toBe(true);
  });

  it('cache is invalidated when actualCropHash changes', () => {
    const cache = new JudgeCache();
    const key = makeKey({ actualCropHash: 'original' });
    cache.set(key, { judgeAuditStatus: 'pass', cachedAt: Date.now() });

    const changedKey = makeKey({ actualCropHash: 'changed' });
    expect(cache.has(changedKey)).toBe(false);
  });

  it('cache is invalidated when anchorRectHash changes', () => {
    const cache = new JudgeCache();
    const key = makeKey({ anchorRectHash: 'original' });
    cache.set(key, { judgeAuditStatus: 'pass', cachedAt: Date.now() });

    const changedKey = makeKey({ anchorRectHash: 'changed' });
    expect(cache.has(changedKey)).toBe(false);
  });

  it('cache is invalidated when criterionIds change', () => {
    const cache = new JudgeCache();
    const key = makeKey({ criterionIds: ['today.kcalLeftPill.legibility'] });
    cache.set(key, { judgeAuditStatus: 'pass', cachedAt: Date.now() });

    const changedKey = makeKey({ criterionIds: ['today.kcalLeftPill.legibility', 'today.kcalLeftPill.text'] });
    expect(cache.has(changedKey)).toBe(false);
  });

  it('cache is invalidated when provider changes', () => {
    const cache = new JudgeCache();
    cache.set(makeKey({ provider: 'openrouter' }), { judgeAuditStatus: 'pass', cachedAt: Date.now() });
    expect(cache.has(makeKey({ provider: 'nvidia' }))).toBe(false);
  });

  it('cache is invalidated when model changes', () => {
    const cache = new JudgeCache();
    cache.set(makeKey({ model: 'model-a' }), { judgeAuditStatus: 'pass', cachedAt: Date.now() });
    expect(cache.has(makeKey({ model: 'model-b' }))).toBe(false);
  });

  it('cache is invalidated when promptVersion changes', () => {
    const cache = new JudgeCache();
    cache.set(makeKey({ promptVersion: 'v1' }), { judgeAuditStatus: 'pass', cachedAt: Date.now() });
    expect(cache.has(makeKey({ promptVersion: 'v2' }))).toBe(false);
  });

  it('cache is invalidated when sourceFactsHash changes', () => {
    const cache = new JudgeCache();
    cache.set(makeKey({ sourceFactsHash: 'original' }), { judgeAuditStatus: 'pass', cachedAt: Date.now() });
    expect(cache.has(makeKey({ sourceFactsHash: 'changed' }))).toBe(false);
  });

  it('cache is invalidated when targetMapVersion changes', () => {
    const cache = new JudgeCache();
    cache.set(makeKey({ targetMapVersion: '1' }), { judgeAuditStatus: 'pass', cachedAt: Date.now() });
    expect(cache.has(makeKey({ targetMapVersion: '2' }))).toBe(false);
  });

  it('criterionIds order does not matter (order-independent key)', () => {
    const cache = new JudgeCache();
    const key1 = makeKey({ criterionIds: ['a', 'b', 'c'] });
    const key2 = makeKey({ criterionIds: ['c', 'a', 'b'] });
    cache.set(key1, { judgeAuditStatus: 'pass', cachedAt: Date.now() });
    expect(cache.has(key2)).toBe(true);
  });

  it('multiple criteria for same target are batched to single key', () => {
    const cache = new JudgeCache();
    const batchedKey = makeKey({ criterionIds: ['crit.text', 'crit.legibility', 'crit.layout'] });
    cache.set(batchedKey, { judgeAuditStatus: 'pass', cachedAt: Date.now() });

    // Same key in different order — should hit
    const sameInDifferentOrder = makeKey({ criterionIds: ['crit.layout', 'crit.text', 'crit.legibility'] });
    expect(cache.has(sameInDifferentOrder)).toBe(true);
  });

  it('entriesForTarget returns all entries for a target ID', () => {
    const cache = new JudgeCache();
    cache.set(makeKey({ targetId: 'target.a', provider: 'openrouter' }), { judgeAuditStatus: 'pass', cachedAt: Date.now() });
    cache.set(makeKey({ targetId: 'target.a', provider: 'nvidia' }), { judgeAuditStatus: 'caveat', cachedAt: Date.now() });
    cache.set(makeKey({ targetId: 'target.b' }), { judgeAuditStatus: 'fail', cachedAt: Date.now() });

    const entries = cache.entriesForTarget('target.a');
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.originalKey.targetId === 'target.a')).toBe(true);
  });

  it('clear() empties the cache', () => {
    const cache = new JudgeCache();
    cache.set(makeKey(), { judgeAuditStatus: 'pass', cachedAt: Date.now() });
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.has(makeKey())).toBe(false);
  });
});

describe('computeCacheKeyString', () => {
  it('produces the same key for identical inputs', () => {
    const k1 = computeCacheKeyString(makeKey());
    const k2 = computeCacheKeyString(makeKey());
    expect(k1).toBe(k2);
  });

  it('produces different keys for different inputs', () => {
    const k1 = computeCacheKeyString(makeKey({ actualCropHash: 'aaa' }));
    const k2 = computeCacheKeyString(makeKey({ actualCropHash: 'bbb' }));
    expect(k1).not.toBe(k2);
  });

  it('returns a 64-character hex string (SHA-256)', () => {
    const k = computeCacheKeyString(makeKey());
    expect(k).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('hashContent and hashRect', () => {
  it('hashContent produces stable hex for a string', () => {
    const h1 = hashContent('hello world');
    const h2 = hashContent('hello world');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashContent differs for different inputs', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });

  it('hashRect produces stable hex', () => {
    const h = hashRect({ x: 10, y: 20, width: 100, height: 50 });
    expect(h).toBe(hashRect({ x: 10, y: 20, width: 100, height: 50 }));
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashRect differs when rect changes', () => {
    const h1 = hashRect({ x: 10, y: 20, width: 100, height: 50 });
    const h2 = hashRect({ x: 11, y: 20, width: 100, height: 50 });
    expect(h1).not.toBe(h2);
  });
});

describe('JudgeCache — file persistence', () => {
  let tmpFile: string;

  afterEach(async () => {
    if (tmpFile) {
      await fs.rm(tmpFile, { force: true });
      tmpFile = '';
    }
  });

  it('saveToFile + loadFromFile round-trips entries', async () => {
    tmpFile = path.join(os.tmpdir(), `judge-cache-test-${Date.now()}.json`);

    const a = new JudgeCache();
    const key = makeKey();
    a.set(key, { judgeAuditStatus: 'pass', confidence: 0.95, cachedAt: 1000 });
    await a.saveToFile(tmpFile);

    const b = new JudgeCache();
    const loaded = await b.loadFromFile(tmpFile);
    expect(loaded).toBe(true);
    expect(b.size()).toBe(1);
    const hit = b.get(key);
    expect(hit?.judgeAuditStatus).toBe('pass');
    expect(hit?.confidence).toBe(0.95);
  });

  it('loadFromFile returns false for non-existent file', async () => {
    tmpFile = '';
    const cache = new JudgeCache();
    const loaded = await cache.loadFromFile('/nonexistent/path/cache.json');
    expect(loaded).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it('loadFromFile returns false for empty/corrupt file', async () => {
    tmpFile = path.join(os.tmpdir(), `judge-cache-corrupt-${Date.now()}.json`);
    await fs.writeFile(tmpFile, 'not json', 'utf-8');
    const cache = new JudgeCache();
    const loaded = await cache.loadFromFile(tmpFile);
    expect(loaded).toBe(false);
  });

  it('loadFromFile merges into existing in-memory entries', async () => {
    tmpFile = path.join(os.tmpdir(), `judge-cache-merge-${Date.now()}.json`);

    const a = new JudgeCache();
    const k1 = makeKey({ actualCropHash: 'crop-a' });
    a.set(k1, { judgeAuditStatus: 'pass', cachedAt: 1000 });
    await a.saveToFile(tmpFile);

    const b = new JudgeCache();
    const k2 = makeKey({ actualCropHash: 'crop-b' });
    b.set(k2, { judgeAuditStatus: 'fail', cachedAt: 2000 });
    await b.loadFromFile(tmpFile);

    // Should have both k1 (from file) and k2 (in-memory)
    expect(b.size()).toBe(2);
    expect(b.has(k1)).toBe(true);
    expect(b.has(k2)).toBe(true);
  });

  it('persists not_run status across file round-trip', async () => {
    tmpFile = path.join(os.tmpdir(), `judge-cache-notrun-${Date.now()}.json`);
    const a = new JudgeCache();
    const key = makeKey();
    a.set(key, { judgeAuditStatus: 'not_run', cachedAt: 500 });
    await a.saveToFile(tmpFile);

    const b = new JudgeCache();
    await b.loadFromFile(tmpFile);
    expect(b.get(key)?.judgeAuditStatus).toBe('not_run');
  });
});
