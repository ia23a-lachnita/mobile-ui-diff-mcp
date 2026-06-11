import fs from 'fs/promises';
import path from 'path';
import { PNG } from 'pngjs';
import {
  BoxLike,
  RadialChartGeometryDiagnosticsConfig,
  RadialChartGeometryDiagnosticsResult,
  RadialChartGeometryFinding,
  RadialChartGeometryMetrics
} from '../types';

interface Point {
  x: number;
  y: number;
  color: string;
}

interface AnalyzedChart {
  metrics?: RadialChartGeometryMetrics;
  points: Point[];
  confidence: number;
  warnings: string[];
  mask: PNG;
}

export interface RadialChartDiagnosticsInput {
  roiId: string;
  expectedCropPath: string;
  actualCropPath: string;
  outputDir: string;
  config: RadialChartGeometryDiagnosticsConfig;
  dynamicSubregions?: BoxLike[];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function parseHexColor(color: string): [number, number, number] | null {
  const normalized = color.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16)
  ];
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function saturationAndValue(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  return { saturation, value: max / 255 };
}

function colorDistance(a: [number, number, number], b: [number, number, number]) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function isMasked(x: number, y: number, boxes: BoxLike[]) {
  return boxes.some((box) =>
    x >= box.x &&
    y >= box.y &&
    x < box.x + box.width &&
    y < box.y + box.height
  );
}

function setPixel(png: PNG, x: number, y: number, color: [number, number, number], alpha = 255) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx] = color[0];
  png.data[idx + 1] = color[1];
  png.data[idx + 2] = color[2];
  png.data[idx + 3] = alpha;
}

function makeBlank(width: number, height: number, color: [number, number, number, number] = [255, 255, 255, 255]) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      png.data[idx] = color[0];
      png.data[idx + 1] = color[1];
      png.data[idx + 2] = color[2];
      png.data[idx + 3] = color[3];
    }
  }
  return png;
}

function solve3x3(matrix: number[][], vector: number[]) {
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let c = col; c < 4; c++) a[col][c] /= divisor;
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let c = col; c < 4; c++) a[row][c] -= factor * a[col][c];
    }
  }
  return [a[0][3], a[1][3], a[2][3]];
}

function fitCircle(points: Point[]) {
  let sumX = 0;
  let sumY = 0;
  let sumOne = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  let sumXB = 0;
  let sumYB = 0;
  let sumB = 0;

  for (const point of points) {
    const b = -(point.x ** 2 + point.y ** 2);
    sumX += point.x;
    sumY += point.y;
    sumOne += 1;
    sumXX += point.x ** 2;
    sumYY += point.y ** 2;
    sumXY += point.x * point.y;
    sumXB += point.x * b;
    sumYB += point.y * b;
    sumB += b;
  }

  const solution = solve3x3(
    [
      [sumXX, sumXY, sumX],
      [sumXY, sumYY, sumY],
      [sumX, sumY, sumOne]
    ],
    [sumXB, sumYB, sumB]
  );
  if (!solution) return null;
  const [d, e, f] = solution;
  const cx = -d / 2;
  const cy = -e / 2;
  const radiusSq = cx ** 2 + cy ** 2 - f;
  if (!Number.isFinite(radiusSq) || radiusSq <= 0) return null;
  return { x: cx, y: cy, radius: Math.sqrt(radiusSq) };
}

function percentile(sorted: number[], pct: number) {
  if (sorted.length === 0) return 0;
  const index = clamp((sorted.length - 1) * pct, 0, sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function normalizeAngle360(deg: number) {
  return ((deg % 360) + 360) % 360;
}

function normalizeAngle180(deg: number) {
  const normalized = normalizeAngle360(deg);
  return normalized > 180 ? normalized - 360 : normalized;
}

function circularDeltaDeg(actual: number, expected: number) {
  return normalizeAngle180(actual - expected);
}

function estimateArcAngles(points: Point[], center: { x: number; y: number }) {
  if (points.length === 0) return { startAngleDeg: 0, endAngleDeg: 0, sweepDeg: 0 };
  const angles = points
    .map((point) => normalizeAngle360(Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI))
    .sort((a, b) => a - b);
  if (angles.length === 1) {
    const angle = normalizeAngle180(angles[0]);
    return { startAngleDeg: angle, endAngleDeg: angle, sweepDeg: 0 };
  }

  let largestGap = -1;
  let gapIndex = 0;
  for (let i = 0; i < angles.length; i++) {
    const current = angles[i];
    const next = i === angles.length - 1 ? angles[0] + 360 : angles[i + 1];
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = i;
    }
  }

  const start = normalizeAngle360(angles[(gapIndex + 1) % angles.length]);
  const end = normalizeAngle360(angles[gapIndex]);
  const sweep = clamp(360 - largestGap, 0, 360);
  return {
    startAngleDeg: round(normalizeAngle180(start), 1),
    endAngleDeg: round(normalizeAngle180(end), 1),
    sweepDeg: round(sweep, 1)
  };
}

function radiusClusters(radii: number[]) {
  if (radii.length === 0) return [];
  const sorted = [...radii].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];
  const gapThreshold = Math.max(3, (sorted[sorted.length - 1] - sorted[0]) * 0.12);
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const lastCluster = clusters[clusters.length - 1];
    if (current - lastCluster[lastCluster.length - 1] > gapThreshold) {
      clusters.push([current]);
    } else {
      lastCluster.push(current);
    }
  }
  return clusters.filter((cluster) => cluster.length >= Math.max(8, radii.length * 0.05));
}

function analyzePng(png: PNG, config: RadialChartGeometryDiagnosticsConfig, dynamicSubregions: BoxLike[]): AnalyzedChart {
  const hints = (config.colorHints ?? [])
    .map((hint) => ({ hex: hint.toUpperCase(), rgb: parseHexColor(hint) }))
    .filter((hint): hint is { hex: string; rgb: [number, number, number] } => hint.rgb !== null);
  const mask = makeBlank(png.width, png.height, [0, 0, 0, 0]);
  const points: Point[] = [];
  const warnings: string[] = [];

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (config.maskDynamicSubregions && isMasked(x, y, dynamicSubregions)) continue;
      const idx = (png.width * y + x) << 2;
      const alpha = png.data[idx + 3];
      if (alpha === 0) continue;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const { saturation, value } = saturationAndValue(r, g, b);
      if (saturation < 0.30 || value < 0.16) continue;

      let color = rgbToHex(r, g, b);
      if (hints.length > 0) {
        const nearest = hints
          .map((hint) => ({ ...hint, distance: colorDistance([r, g, b], hint.rgb) }))
          .sort((a, b) => a.distance - b.distance)[0];
        if (!nearest || nearest.distance > 110) continue;
        color = nearest.hex;
      }
      points.push({ x, y, color });
      setPixel(mask, x, y, [r, g, b], 255);
    }
  }

  // Color segmentation is a diagnostic heuristic — it is not a source of truth for arc ownership.
  // Results depend on rendered colors and may be unreliable under theming, anti-aliasing, or low saturation.
  if (hints.length === 0) {
    warnings.push('No colorHints provided; arc pixels identified by saturation only (heuristic — not exact arc geometry).');
  } else {
    warnings.push(`Arc pixels identified by color proximity to ${hints.length} hint(s) (heuristic — not exact arc geometry).`);
  }

  if (points.length < 40) {
    warnings.push('Insufficient high-saturation radial arc pixels were detected.');
    return { points, mask, confidence: 0, warnings };
  }

  const fit = fitCircle(points);
  if (!fit) {
    warnings.push('Circle fit failed for detected radial arc pixels.');
    return { points, mask, confidence: 0, warnings };
  }

  const radii = points.map((point) => Math.sqrt((point.x - fit.x) ** 2 + (point.y - fit.y) ** 2)).sort((a, b) => a - b);
  const clusters = radiusClusters(radii);
  const innerRadiusPx = percentile(radii, 0.05);
  const outerRadiusPx = percentile(radii, 0.95);
  const strokeWidths = clusters.map((cluster) => percentile(cluster, 0.95) - percentile(cluster, 0.05));
  const strokeWidthPx = strokeWidths.length > 0
    ? strokeWidths.sort((a, b) => a - b)[Math.floor(strokeWidths.length / 2)]
    : outerRadiusPx - innerRadiusPx;
  const gaps = clusters.slice(1).map((cluster, index) => percentile(cluster, 0.05) - percentile(clusters[index], 0.95));
  const ringGapPx = gaps.length > 0 ? Math.max(0, Math.min(...gaps)) : 0;
  const residual = Math.sqrt(radii.reduce((sum, radius) => sum + (radius - fit.radius) ** 2, 0) / radii.length);
  const confidence = round(clamp((points.length / 400) * (1 - clamp(residual / Math.max(outerRadiusPx, 1), 0, 0.7)), 0.15, 0.95), 2);

  const byColor = new Map<string, Point[]>();
  for (const point of points) {
    byColor.set(point.color, [...(byColor.get(point.color) ?? []), point]);
  }

  const arcs = [...byColor.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([color, colorPoints]) => {
      const colorRadii = colorPoints.map((point) => Math.sqrt((point.x - fit.x) ** 2 + (point.y - fit.y) ** 2)).sort((a, b) => a - b);
      const colorInner = percentile(colorRadii, 0.05);
      const colorOuter = percentile(colorRadii, 0.95);
      const angles = estimateArcAngles(colorPoints, fit);
      return {
        color,
        ...angles,
        meanRadiusPx: round(percentile(colorRadii, 0.5), 1),
        meanRadiusNorm: round(percentile(colorRadii, 0.5) / png.width),
        strokeWidthPx: round(colorOuter - colorInner, 1),
        strokeWidthNorm: round((colorOuter - colorInner) / png.width)
      };
    });

  const metrics: RadialChartGeometryMetrics = {
    centerPx: { x: round(fit.x, 1), y: round(fit.y, 1) },
    centerNorm: { x: round(fit.x / png.width), y: round(fit.y / png.height) },
    outerRadiusPx: round(outerRadiusPx, 1),
    outerRadiusNorm: round(outerRadiusPx / png.width),
    innerRadiusPx: round(innerRadiusPx, 1),
    innerRadiusNorm: round(innerRadiusPx / png.width),
    strokeWidthPx: round(strokeWidthPx, 1),
    strokeWidthNorm: round(strokeWidthPx / png.width),
    ringGapPx: round(ringGapPx, 1),
    ringGapNorm: round(ringGapPx / png.width),
    arcs
  };

  return { metrics, points, mask, confidence, warnings };
}

function findingSeverity(delta: number, tolerance: number): 'low' | 'medium' | 'high' {
  const magnitude = Math.abs(delta);
  if (magnitude > tolerance * 3) return 'high';
  if (magnitude > tolerance * 1.7) return 'medium';
  return 'low';
}

function compareMetrics(
  expected: RadialChartGeometryMetrics,
  actual: RadialChartGeometryMetrics,
  config: RadialChartGeometryDiagnosticsConfig
) {
  const findings: RadialChartGeometryFinding[] = [];
  const centerTolerance = config.centerToleranceNorm ?? 0.02;
  const radiusTolerance = config.radiusToleranceNorm ?? 0.02;
  const strokeTolerance = config.strokeToleranceNorm ?? 0.015;
  const angleTolerance = config.angleToleranceDeg ?? 6;

  const dxNorm = round(actual.centerNorm.x - expected.centerNorm.x);
  const dyNorm = round(actual.centerNorm.y - expected.centerNorm.y);
  const centerMagnitude = Math.sqrt(dxNorm ** 2 + dyNorm ** 2);
  if (centerMagnitude > centerTolerance) {
    findings.push({
      kind: 'centerShift',
      severity: findingSeverity(centerMagnitude, centerTolerance),
      message: `Actual radial center is shifted by ${round(centerMagnitude)} normalized ROI units.`,
      dxNorm,
      dyNorm
    });
  }

  const radiusDelta = round(actual.outerRadiusNorm - expected.outerRadiusNorm);
  if (Math.abs(radiusDelta) > radiusTolerance) {
    findings.push({
      kind: 'relativeRadiusMismatch',
      severity: findingSeverity(radiusDelta, radiusTolerance),
      message: `Actual outer radius differs by ${round(radiusDelta)} relative to ROI width.`,
      expectedNorm: expected.outerRadiusNorm,
      actualNorm: actual.outerRadiusNorm,
      deltaNorm: radiusDelta
    });
  }

  const strokeDelta = round(actual.strokeWidthNorm - expected.strokeWidthNorm);
  if (Math.abs(strokeDelta) > strokeTolerance) {
    findings.push({
      kind: 'strokeWidthMismatch',
      severity: findingSeverity(strokeDelta, strokeTolerance),
      message: `Actual stroke width differs by ${round(strokeDelta)} relative to ROI width.`,
      expectedNorm: expected.strokeWidthNorm,
      actualNorm: actual.strokeWidthNorm,
      deltaNorm: strokeDelta
    });
  }

  const gapDelta = round(actual.ringGapNorm - expected.ringGapNorm);
  if (Math.abs(gapDelta) > strokeTolerance) {
    findings.push({
      kind: 'ringGapMismatch',
      severity: findingSeverity(gapDelta, strokeTolerance),
      message: `Actual ring gap differs by ${round(gapDelta)} relative to ROI width.`,
      expectedNorm: expected.ringGapNorm,
      actualNorm: actual.ringGapNorm,
      deltaNorm: gapDelta
    });
  }

  for (const expectedArc of expected.arcs) {
    const actualArc = actual.arcs.find((arc) => arc.color === expectedArc.color);
    if (!actualArc) {
      findings.push({
        kind: 'missingArc',
        severity: 'high',
        color: expectedArc.color,
        message: `Expected ${expectedArc.color} arc was not detected in the actual ROI crop.`
      });
      continue;
    }

    const arcRadiusDelta = round(actualArc.meanRadiusNorm - expectedArc.meanRadiusNorm);
    if (Math.abs(arcRadiusDelta) > radiusTolerance) {
      findings.push({
        kind: 'relativeRadiusMismatch',
        severity: findingSeverity(arcRadiusDelta, radiusTolerance),
        color: expectedArc.color,
        message: `Actual ${expectedArc.color} arc radius differs by ${arcRadiusDelta} relative to ROI width.`,
        expectedNorm: expectedArc.meanRadiusNorm,
        actualNorm: actualArc.meanRadiusNorm,
        deltaNorm: arcRadiusDelta
      });
    }

    const arcStrokeDelta = round(actualArc.strokeWidthNorm - expectedArc.strokeWidthNorm);
    if (Math.abs(arcStrokeDelta) > strokeTolerance) {
      findings.push({
        kind: 'strokeWidthMismatch',
        severity: findingSeverity(arcStrokeDelta, strokeTolerance),
        color: expectedArc.color,
        message: `Actual ${expectedArc.color} arc stroke width differs by ${arcStrokeDelta} relative to ROI width.`,
        expectedNorm: expectedArc.strokeWidthNorm,
        actualNorm: actualArc.strokeWidthNorm,
        deltaNorm: arcStrokeDelta
      });
    }

    const deltaStart = round(circularDeltaDeg(actualArc.startAngleDeg, expectedArc.startAngleDeg), 1);
    const deltaEnd = round(circularDeltaDeg(actualArc.endAngleDeg, expectedArc.endAngleDeg), 1);
    if (Math.abs(deltaStart) > angleTolerance && Math.abs(deltaEnd) > angleTolerance) {
      findings.push({
        kind: 'angleMismatch',
        severity: findingSeverity(Math.max(Math.abs(deltaStart), Math.abs(deltaEnd)), angleTolerance),
        color: expectedArc.color,
        message: `Actual ${expectedArc.color} arc start/end angles differ by ${deltaStart}/${deltaEnd} degrees.`,
        deltaStartDeg: deltaStart,
        deltaEndDeg: deltaEnd
      });
    }

    const deltaSweep = round(actualArc.sweepDeg - expectedArc.sweepDeg, 1);
    if (Math.abs(deltaSweep) > angleTolerance) {
      findings.push({
        kind: 'sweepMismatch',
        severity: findingSeverity(deltaSweep, angleTolerance),
        color: expectedArc.color,
        message: `Actual ${expectedArc.color} arc sweep differs by ${deltaSweep} degrees.`,
        deltaSweepDeg: deltaSweep
      });
    }
  }

  if (findings.length === 0) {
    const centerPxDelta = Math.sqrt((actual.centerPx.x - expected.centerPx.x) ** 2 + (actual.centerPx.y - expected.centerPx.y) ** 2);
    const radiusPxDelta = actual.outerRadiusPx - expected.outerRadiusPx;
    const strokePxDelta = actual.strokeWidthPx - expected.strokeWidthPx;
    if (centerPxDelta > 2 || Math.abs(radiusPxDelta) > 1.5 || Math.abs(strokePxDelta) > 1.5) {
      findings.push({
        kind: 'scaleOnlyMismatch',
        severity: 'low',
        message: 'Absolute radial geometry differs by a few pixels while normalized geometry is within tolerance.',
        deltaNorm: round(actual.outerRadiusNorm - expected.outerRadiusNorm)
      });
    }
  }

  return findings;
}

function buildAgentHint(findings: RadialChartGeometryFinding[]) {
  if (findings.length === 0) return 'Radial chart normalized geometry is within configured tolerances.';

  const severityRank: Record<RadialChartGeometryFinding['severity'], number> = {
    high: 3,
    medium: 2,
    low: 1
  };
  const kindRank: Record<RadialChartGeometryFinding['kind'], number> = {
    missingArc: 9,
    relativeRadiusMismatch: 8,
    strokeWidthMismatch: 7,
    ringGapMismatch: 6,
    angleMismatch: 5,
    sweepMismatch: 4,
    centerShift: 3,
    scaleOnlyMismatch: 2,
    capMismatch: 1,
    haloOrTrackMismatch: 1,
    insufficientSignal: 0
  };
  const sorted = [...findings].sort((a, b) => {
    const severityDelta = severityRank[b.severity] - severityRank[a.severity];
    if (severityDelta !== 0) return severityDelta;
    return kindRank[b.kind] - kindRank[a.kind];
  });
  const findingLabel = (finding: RadialChartGeometryFinding) => {
    const subject = finding.color ? `${finding.color} ` : '';
    if (finding.kind === 'missingArc') return `${subject}missing arc`;
    if (finding.kind === 'relativeRadiusMismatch') return `${subject}radius`;
    if (finding.kind === 'strokeWidthMismatch') return `${subject}stroke width`;
    if (finding.kind === 'ringGapMismatch') return `${subject}ring gap`;
    if (finding.kind === 'angleMismatch') return `${subject}start/end angle`;
    if (finding.kind === 'sweepMismatch') return `${subject}sweep`;
    if (finding.kind === 'centerShift') return 'center shift';
    if (finding.kind === 'scaleOnlyMismatch') return 'pixel-scale drift with close normalized geometry';
    if (finding.kind === 'capMismatch') return `${subject}cap style`;
    if (finding.kind === 'haloOrTrackMismatch') return `${subject}halo or inactive track`;
    return `${subject}insufficient signal`;
  };
  const topFindings = sorted.slice(0, 3).map(findingLabel).join('; ');
  const topKinds = new Set(sorted.slice(0, 3).map((finding) => finding.kind));
  const actions: string[] = [];
  if (topKinds.has('missingArc')) actions.push('arc color/progress/rendering');
  if (topKinds.has('relativeRadiusMismatch')) actions.push('ring size or radius formula');
  if (topKinds.has('strokeWidthMismatch')) actions.push('strokeWidth or canvas scale');
  if (topKinds.has('ringGapMismatch')) actions.push('per-ring gap formula');
  if (topKinds.has('angleMismatch')) actions.push('startAngle mapping');
  if (topKinds.has('sweepMismatch')) actions.push('progress-to-sweep mapping');
  if (topKinds.has('centerShift')) actions.push('chart alignment or padding');
  if (topKinds.has('scaleOnlyMismatch')) actions.push('source scale context before changing Flutter geometry');
  if (actions.length === 0) actions.push('arc segmentation inputs and masks');
  return `Radial chart findings by severity: ${topFindings}. Inspect ${actions.join(', ')}.`;
}

function drawCross(png: PNG, cx: number, cy: number, color: [number, number, number]) {
  for (let delta = -5; delta <= 5; delta++) {
    setPixel(png, Math.round(cx) + delta, Math.round(cy), color);
    setPixel(png, Math.round(cx), Math.round(cy) + delta, color);
  }
}

function drawCircle(png: PNG, cx: number, cy: number, radius: number, color: [number, number, number]) {
  for (let deg = 0; deg < 360; deg += 1) {
    const rad = deg * Math.PI / 180;
    setPixel(png, Math.round(cx + Math.cos(rad) * radius), Math.round(cy + Math.sin(rad) * radius), color);
  }
}

function writeMask(mask: PNG, outputPath: string) {
  return fs.writeFile(outputPath, PNG.sync.write(mask));
}

async function writeArtifacts(
  expected: AnalyzedChart,
  actual: AnalyzedChart,
  width: number,
  height: number,
  artifacts: RadialChartGeometryDiagnosticsResult['artifacts']
) {
  await writeMask(expected.mask, artifacts.expectedArcMask);
  await writeMask(actual.mask, artifacts.actualArcMask);

  const overlay = makeBlank(width, height);
  for (const point of expected.points) setPixel(overlay, point.x, point.y, [63, 91, 255], 180);
  for (const point of actual.points) setPixel(overlay, point.x, point.y, [236, 74, 121], 180);
  if (expected.metrics) {
    drawCross(overlay, expected.metrics.centerPx.x, expected.metrics.centerPx.y, [0, 80, 255]);
    drawCircle(overlay, expected.metrics.centerPx.x, expected.metrics.centerPx.y, expected.metrics.outerRadiusPx, [0, 80, 255]);
  }
  if (actual.metrics) {
    drawCross(overlay, actual.metrics.centerPx.x, actual.metrics.centerPx.y, [220, 0, 80]);
    drawCircle(overlay, actual.metrics.centerPx.x, actual.metrics.centerPx.y, actual.metrics.outerRadiusPx, [220, 0, 80]);
  }
  await fs.writeFile(artifacts.geometryOverlay, PNG.sync.write(overlay));

  const edge = makeBlank(360, Math.max(width, height), [255, 255, 255, 255]);
  const plot = (points: Point[], metrics: RadialChartGeometryMetrics | undefined, color: [number, number, number]) => {
    if (!metrics) return;
    for (const point of points) {
      const angle = Math.round(normalizeAngle360(Math.atan2(point.y - metrics.centerPx.y, point.x - metrics.centerPx.x) * 180 / Math.PI));
      const radius = Math.round(Math.sqrt((point.x - metrics.centerPx.x) ** 2 + (point.y - metrics.centerPx.y) ** 2));
      setPixel(edge, clamp(angle, 0, edge.width - 1), clamp(edge.height - 1 - radius, 0, edge.height - 1), color);
    }
  };
  plot(expected.points, expected.metrics, [63, 91, 255]);
  plot(actual.points, actual.metrics, [236, 74, 121]);
  await fs.writeFile(artifacts.edgeOverlay, PNG.sync.write(edge));

  await fs.writeFile(artifacts.polarSummary, JSON.stringify({
    expected: {
      confidence: expected.confidence,
      warnings: expected.warnings,
      pointCount: expected.points.length,
      metrics: expected.metrics
    },
    actual: {
      confidence: actual.confidence,
      warnings: actual.warnings,
      pointCount: actual.points.length,
      metrics: actual.metrics
    }
  }, null, 2));
}

export async function runRadialChartDiagnostics(input: RadialChartDiagnosticsInput): Promise<RadialChartGeometryDiagnosticsResult> {
  const artifacts = {
    geometryOverlay: path.join(input.outputDir, `${input.roiId}-geometry-overlay.png`),
    edgeOverlay: path.join(input.outputDir, `${input.roiId}-edge-overlay.png`),
    expectedArcMask: path.join(input.outputDir, `${input.roiId}-arc-mask-expected.png`),
    actualArcMask: path.join(input.outputDir, `${input.roiId}-arc-mask-actual.png`),
    polarSummary: path.join(input.outputDir, `${input.roiId}-polar-summary.json`)
  };

  try {
    const expectedPng = PNG.sync.read(await fs.readFile(input.expectedCropPath));
    const actualPng = PNG.sync.read(await fs.readFile(input.actualCropPath));
    const dynamicSubregions = input.config.maskDynamicSubregions ? input.dynamicSubregions ?? [] : [];
    const expected = analyzePng(expectedPng, input.config, dynamicSubregions);
    const actual = analyzePng(actualPng, input.config, dynamicSubregions);

    await writeArtifacts(expected, actual, expectedPng.width, expectedPng.height, artifacts);

    const warnings = [...expected.warnings.map((warning) => `Expected: ${warning}`), ...actual.warnings.map((warning) => `Actual: ${warning}`)];
    if (!expected.metrics || !actual.metrics) {
      const findings: RadialChartGeometryFinding[] = [{
        kind: 'insufficientSignal',
        severity: 'high',
        message: 'Radial chart geometry could not be estimated from one or both ROI crops.'
      }];
      return {
        type: 'radialChart',
        status: 'warning',
        confidence: 0,
        metrics: {
          expected: expected.metrics,
          actual: actual.metrics
        },
        findings,
        verdict: 'insufficientSignal',
        agentHint: buildAgentHint(findings),
        artifacts,
        warnings: warnings.length ? warnings : ['Radial chart geometry could not be estimated.']
      };
    }

    const findings = compareMetrics(expected.metrics, actual.metrics, input.config);
    const verdict = findings.length === 0
      ? 'geometryWithinTolerance'
      : findings.every((finding) => finding.kind === 'scaleOnlyMismatch')
        ? 'scaleOnlyMismatch'
        : 'relativeGeometryMismatch';
    const status = findings.some((finding) => finding.kind === 'missingArc') ? 'warning' : 'completed';
    const missingWarnings = findings
      .filter((finding) => finding.kind === 'missingArc')
      .map((finding) => `Expected ${finding.color ?? 'colored'} arc was not detected in actual radial chart segmentation.`);
    return {
      type: 'radialChart',
      status,
      confidence: round(Math.min(expected.confidence, actual.confidence), 2),
      metrics: {
        expected: expected.metrics,
        actual: actual.metrics
      },
      findings,
      verdict,
      agentHint: buildAgentHint(findings),
      artifacts,
      warnings: [...warnings, ...missingWarnings]
    };
  } catch (err: any) {
    return {
      type: 'radialChart',
      status: 'failed',
      confidence: 0,
      metrics: {},
      findings: [{
        kind: 'insufficientSignal',
        severity: 'high',
        message: 'Radial chart diagnostics failed before geometry could be estimated.'
      }],
      verdict: 'insufficientSignal',
      agentHint: 'Radial geometry diagnostics (color segmentation heuristic) failed. Inspect crop artifacts and diagnostic warnings before changing app code.',
      artifacts,
      warnings: [err?.message ?? String(err)]
    };
  }
}
