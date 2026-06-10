import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export interface JudgeCacheKey {
  provider: string;
  model: string;
  promptVersion: string;
  targetId: string;
  criterionIds: string[];
  actualImageHash: string;
  actualCropHash: string;
  anchorRectHash: string;
  expectedImageHash: string;
  sourceFactsHash: string;
  deterministicMeasurementHash: string;
  targetMapVersion: string;
  /** Hash of the full expected screen sent to the judge. */
  fullExpectedScreenHash?: string;
  /** Hash of the full actual screen sent to the judge. */
  fullActualScreenHash?: string;
  /** Hash of the annotated actual screen (with box overlay). */
  annotatedActualScreenHash?: string;
  /** Hash of the deterministic diagnostic artifact image. */
  diagnosticArtifactHash?: string;
  /** Criterion description / target contract text. */
  criterionDescription?: string;
}

export interface CachedJudgeProvenanceResult {
  targetStatus: string;
  judgeAuditStatus: string;
  confidence?: number;
  reasoning?: string;
}

export interface CachedJudgeResult {
  judgeAuditStatus: 'pass' | 'caveat' | 'fail' | 'target_mismatch' | 'unavailable' | 'not_run';
  targetStatus?: 'matched' | 'not_matched' | 'ambiguous' | 'not_checked';
  confidence?: number;
  inheritedFromRun?: string;
  cachedAt: number;
  /** The canonical key string used for storage. */
  cacheKey: string;
  /** Primary judge result preserved for provenance. */
  primaryResult?: CachedJudgeProvenanceResult;
  /** Reviewer judge result preserved for provenance (absent when no reviewer configured). */
  reviewerResult?: CachedJudgeProvenanceResult;
  /** Provider name used for the primary judge. */
  primaryProvider?: string;
  /** Model used for the primary judge. */
  primaryModel?: string;
  /** Provider name used for the reviewer judge (absent when no reviewer). */
  reviewerProvider?: string;
  /** Model used for the reviewer judge (absent when no reviewer). */
  reviewerModel?: string;
}

export interface JudgeCacheEntry extends CachedJudgeResult {
  originalKey: JudgeCacheKey;
}

export interface CacheSummary {
  attempted: number;
  cached: number;
  skipped: number;
  fresh: number;
  /** Absolute path to the persisted cache file (set when persistence is active). */
  persistedPath?: string;
  /** True when the cache file was successfully loaded from disk before this run. */
  loadedFromDisk?: boolean;
  /** True when the cache file was successfully saved to disk after this run. */
  savedToDisk?: boolean;
}

/**
 * Compute a stable, order-independent cache key string from a JudgeCacheKey.
 * criterionIds are sorted to ensure order independence.
 */
export function computeCacheKeyString(key: JudgeCacheKey): string {
  const normalized = {
    ...key,
    criterionIds: [...key.criterionIds].sort(),
    fullExpectedScreenHash: key.fullExpectedScreenHash ?? 'none',
    fullActualScreenHash: key.fullActualScreenHash ?? 'none',
    annotatedActualScreenHash: key.annotatedActualScreenHash ?? 'none',
    diagnosticArtifactHash: key.diagnosticArtifactHash ?? 'none',
    criterionDescription: key.criterionDescription ?? 'none'
  };
  const json = JSON.stringify(normalized, Object.keys(normalized).sort());
  return crypto.createHash('sha256').update(json).digest('hex');
}

/**
 * Hash arbitrary content (Buffer, string, or JSON-serializable value) for use in cache keys.
 */
export function hashContent(content: Buffer | string | unknown): string {
  const data =
    content instanceof Buffer
      ? content
      : typeof content === 'string'
      ? Buffer.from(content, 'utf-8')
      : Buffer.from(JSON.stringify(content), 'utf-8');
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Hash a pixel rect for use in anchorRectHash.
 */
export function hashRect(rect: { x: number; y: number; width: number; height: number }): string {
  return hashContent(`${rect.x},${rect.y},${rect.width},${rect.height}`);
}

/**
 * In-memory judge result cache with optional file persistence.
 * Keyed by the string produced by computeCacheKeyString.
 *
 * Cross-run persistence: call loadFromFile() at startup and saveToFile() after each run
 * to avoid redundant LLM calls across runs when pixels haven't changed.
 */
export class JudgeCache {
  private store = new Map<string, JudgeCacheEntry>();

  get(key: JudgeCacheKey): CachedJudgeResult | undefined {
    const k = computeCacheKeyString(key);
    return this.store.get(k);
  }

  set(key: JudgeCacheKey, result: Omit<CachedJudgeResult, 'cacheKey'>): void {
    const k = computeCacheKeyString(key);
    this.store.set(k, { ...result, cacheKey: k, originalKey: key });
  }

  has(key: JudgeCacheKey): boolean {
    return this.store.has(computeCacheKeyString(key));
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  /** Return cache entries matching a target ID (for debugging/reporting). */
  entriesForTarget(targetId: string): JudgeCacheEntry[] {
    return [...this.store.values()].filter((e) => e.originalKey.targetId === targetId);
  }

  /**
   * Persist all cache entries to a JSON file for cross-run reuse.
   * Creates or overwrites the file at the given path.
   */
  async saveToFile(filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload = {
      version: 1,
      savedAt: Date.now(),
      entries: [...this.store.values()]
    };
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  /**
   * Load cache entries from a previously saved file, merging into the current store.
   * Returns true if the file was loaded, false if it did not exist or was invalid.
   * Never throws — an unreadable or corrupt cache file is silently ignored.
   */
  async loadFromFile(filePath: string): Promise<boolean> {
    try {
      const text = await fs.readFile(filePath, 'utf-8');
      const payload = JSON.parse(text) as { version?: number; entries?: unknown[] };
      if (!Array.isArray(payload.entries)) return false;
      let loaded = 0;
      for (const entry of payload.entries) {
        const e = entry as JudgeCacheEntry;
        if (e && typeof e.cacheKey === 'string' && e.originalKey) {
          this.store.set(e.cacheKey, e);
          loaded++;
        }
      }
      return loaded > 0;
    } catch {
      return false;
    }
  }
}
