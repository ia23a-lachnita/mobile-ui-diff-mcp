import { flutterAnchorDumpSchema } from './anchorDumpSchema';
import type { FlutterAnchorDump, ParsedAnchorDump, RectLogical, RectPx } from './types';

const KNOWN_ANCHOR_KEYS = new Set(['id', 'label', 'rectLogical', 'visible', 'visibility']);
const KNOWN_VISIBILITY_KEYS = new Set(['visibleFraction', 'offscreen', 'clippedByViewport', 'covered', 'notes', 'isOffscreen']);

/** Detect extra fields that will be silently stripped by the Zod schema and surface them as warnings. */
function detectStrippedFields(raw: unknown): string[] {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).anchors)) {
    return warnings;
  }
  for (const anchor of (raw as Record<string, unknown>).anchors as unknown[]) {
    if (!anchor || typeof anchor !== 'object') continue;
    const a = anchor as Record<string, unknown>;
    const anchorId = typeof a.id === 'string' ? a.id : 'unknown';
    const extraAnchorKeys = Object.keys(a).filter(k => !KNOWN_ANCHOR_KEYS.has(k));
    if (extraAnchorKeys.length > 0) {
      warnings.push(
        `anchor_dump_extra_framework_fields_stripped: anchor '${anchorId}' extra fields stripped: ${extraAnchorKeys.join(', ')}`
      );
    }
    if (a.visibility && typeof a.visibility === 'object') {
      const extraVisKeys = Object.keys(a.visibility as object).filter(k => !KNOWN_VISIBILITY_KEYS.has(k));
      if (extraVisKeys.length > 0) {
        warnings.push(
          `anchor_dump_extra_framework_fields_stripped: anchor '${anchorId}' visibility extra fields stripped: ${extraVisKeys.join(', ')}`
        );
      }
    }
  }
  return warnings;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Convert a Flutter logical rect to integer screenshot-pixel coordinates.
 *
 * Uses floor-left / ceil-right to preserve full box coverage.
 * Plain round() can shrink the box and clip edge pixels.
 * Result is clamped to [0, screenshotDim) bounds.
 * No floats are returned — all values are integers.
 */
export function logicalToPhysicalPx(
  rect: RectLogical,
  dpr: number,
  screenshotW: number,
  screenshotH: number
): RectPx {
  const x = Math.floor(rect.x * dpr);
  const y = Math.floor(rect.y * dpr);
  const right = Math.ceil((rect.x + rect.width) * dpr);
  const bottom = Math.ceil((rect.y + rect.height) * dpr);

  const cx = clamp(x, 0, screenshotW - 1);
  const cy = clamp(y, 0, screenshotH - 1);
  const cr = clamp(right, cx + 1, screenshotW);
  const cb = clamp(bottom, cy + 1, screenshotH);

  return {
    x: cx,
    y: cy,
    width: Math.max(1, cr - cx),
    height: Math.max(1, cb - cy)
  };
}

export interface ParseResult {
  ok: true;
  data: ParsedAnchorDump;
  /** Non-fatal warnings about extra fields stripped from the raw dump (e.g. framework objects). */
  warnings?: string[];
}

export interface ParseError {
  ok: false;
  reason: 'invalid_anchor_dump';
  message: string;
}

/**
 * Parse and validate a Flutter anchor dump from raw JSON input.
 * Returns a ParsedAnchorDump with pre-resolved physical pixel rects.
 * Never throws — returns a ParseError on any failure.
 * On success, `warnings` lists any extra anchor/visibility fields that were stripped.
 */
export function parseFlutterAnchorDump(raw: unknown): ParseResult | ParseError {
  const warnings = detectStrippedFields(raw);
  const result = flutterAnchorDumpSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      reason: 'invalid_anchor_dump',
      message: `Flutter anchor dump schema validation failed: ${result.error.message}`
    };
  }

  const dump = result.data as FlutterAnchorDump;
  const { devicePixelRatio, screenshotWidthPx, screenshotHeightPx } = dump.device;

  const resolvedRects = new Map<string, RectPx>();
  const anchorIndex = new Map(dump.anchors.map((a) => [a.id, a]));

  for (const anchor of dump.anchors) {
    const px = logicalToPhysicalPx(anchor.rectLogical, devicePixelRatio, screenshotWidthPx, screenshotHeightPx);
    resolvedRects.set(anchor.id, px);
  }

  return {
    ok: true,
    data: { dump, resolvedRects, anchorIndex },
    ...(warnings.length > 0 ? { warnings } : {})
  };
}
