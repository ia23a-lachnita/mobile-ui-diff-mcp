import crypto from 'crypto';

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
}

export interface CachedJudgeResult {
  judgeAuditStatus: 'pass' | 'caveat' | 'fail' | 'target_mismatch' | 'unavailable';
  inheritedFromRun?: string;
  cachedAt: number;
  /** The canonical key string used for storage. */
  cacheKey: string;
}

export interface JudgeCacheEntry extends CachedJudgeResult {
  originalKey: JudgeCacheKey;
}

export interface CacheSummary {
  attempted: number;
  cached: number;
  skipped: number;
  fresh: number;
}

/**
 * Compute a stable, order-independent cache key string from a JudgeCacheKey.
 * criterionIds are sorted to ensure order independence.
 */
export function computeCacheKeyString(key: JudgeCacheKey): string {
  const normalized = {
    ...key,
    criterionIds: [...key.criterionIds].sort()
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
 * In-memory judge result cache.
 * Keyed by the string produced by computeCacheKeyString.
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
}
