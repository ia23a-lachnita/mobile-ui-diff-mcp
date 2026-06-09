import { flutterAnchorDumpSchema } from './anchorDumpSchema';
import type { FlutterAnchorDump, ParsedAnchorDump, RectLogical, RectPx } from './types';

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
 */
export function parseFlutterAnchorDump(raw: unknown): ParseResult | ParseError {
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
    data: { dump, resolvedRects, anchorIndex }
  };
}
