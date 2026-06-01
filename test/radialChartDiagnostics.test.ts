import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PNG } from 'pngjs';
import fs from 'fs/promises';
import path from 'path';
import { compareImages } from '../src/tools/compareImages';
import { compareImagesSchema } from '../src/mcp/server';

const testDir = path.join(__dirname, 'tmp-radial-diagnostics');
const width = 160;
const height = 120;
const roi = { x: 0, y: 0, width, height };
const blue: [number, number, number] = [63, 91, 255];

beforeAll(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
  await fs.mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

function setPixel(png: PNG, x: number, y: number, color: [number, number, number]) {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx] = color[0];
  png.data[idx + 1] = color[1];
  png.data[idx + 2] = color[2];
  png.data[idx + 3] = 255;
}

function fill(png: PNG, color: [number, number, number]) {
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      setPixel(png, x, y, color);
    }
  }
}

function normalizeAngle(deg: number) {
  return ((deg % 360) + 360) % 360;
}

function drawArc(
  png: PNG,
  cx: number,
  cy: number,
  radius: number,
  strokeWidth: number,
  startDeg: number,
  sweepDeg: number,
  color: [number, number, number] = blue
) {
  const outer = radius + strokeWidth / 2;
  const inner = radius - strokeWidth / 2;
  const start = normalizeAngle(startDeg);
  for (let y = Math.floor(cy - outer - 1); y <= Math.ceil(cy + outer + 1); y++) {
    for (let x = Math.floor(cx - outer - 1); x <= Math.ceil(cx + outer + 1); x++) {
      const distance = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (distance < inner || distance > outer) continue;
      const angle = normalizeAngle(Math.atan2(y - cy, x - cx) * 180 / Math.PI);
      const relative = normalizeAngle(angle - start);
      if (relative <= sweepDeg) setPixel(png, x, y, color);
    }
  }
}

function drawCenterNoise(png: PNG) {
  for (let y = 48; y < 70; y++) {
    for (let x = 58; x < 102; x++) {
      if ((x + y) % 3 === 0) setPixel(png, x, y, [236, 74, 121]);
    }
  }
}

async function createChartImage(
  name: string,
  chart?: Partial<{ cx: number; cy: number; radius: number; stroke: number; start: number; sweep: number; centerNoise: boolean }>
) {
  const file = path.join(testDir, `${name}.png`);
  const png = new PNG({ width, height });
  fill(png, [255, 255, 255]);
  if (chart) {
    drawArc(
      png,
      chart.cx ?? 80,
      chart.cy ?? 60,
      chart.radius ?? 42,
      chart.stroke ?? 10,
      chart.start ?? -90,
      chart.sweep ?? 220
    );
    if (chart.centerNoise) drawCenterNoise(png);
  }
  await fs.writeFile(file, PNG.sync.write(png));
  return file;
}

function radialRoi(geometryOverrides: Record<string, unknown> = {}, roiOverrides: Record<string, unknown> = {}) {
  return {
    id: 'macro-ring-hero',
    label: 'Macro ring hero',
    type: 'component',
    box: roi,
    maxDiffPercent: 1,
    geometryDiagnostics: {
      type: 'radialChart',
      enabled: true,
      maskDynamicSubregions: true,
      colorHints: ['#3F5BFF'],
      centerToleranceNorm: 0.025,
      radiusToleranceNorm: 0.02,
      strokeToleranceNorm: 0.015,
      angleToleranceDeg: 6,
      ...geometryOverrides
    },
    ...roiOverrides
  };
}

async function compareCharts(
  name: string,
  expectedChart?: Parameters<typeof createChartImage>[1],
  actualChart?: Parameters<typeof createChartImage>[1],
  geometryOverrides: Record<string, unknown> = {},
  roiOverrides: Record<string, unknown> = {}
) {
  const expectedImage = await createChartImage(`${name}-expected`, expectedChart);
  const actualImage = await createChartImage(`${name}-actual`, actualChart);
  const result = await compareImages({
    expectedImage,
    actualImage,
    outputDir: path.join(testDir, `out-${name}`),
    maxDiffPercent: 1,
    regionsOfInterest: [radialRoi(geometryOverrides, roiOverrides)]
  } as any);
  const roiReport = result.regionsOfInterest?.[0] as any;
  return { result, roiReport, diagnostic: roiReport.geometryDiagnostics };
}

describe('radial chart geometry diagnostics', () => {
  it('accepts radial geometry diagnostics in the MCP schema', () => {
    const parsed = compareImagesSchema.parse({
      expectedImage: 'expected.png',
      actualImage: 'actual.png',
      outputDir: 'out',
      regionsOfInterest: [radialRoi()]
    });

    expect(parsed.regionsOfInterest?.[0].geometryDiagnostics).toMatchObject({
      type: 'radialChart',
      enabled: true,
      colorHints: ['#3F5BFF']
    });
  });

  it('completes without major findings for identical radial charts', async () => {
    const { diagnostic } = await compareCharts('identical', {}, {});

    expect(diagnostic.status).toBe('completed');
    expect(diagnostic.verdict).toBe('geometryWithinTolerance');
    expect(diagnostic.metrics.expected.outerRadiusNorm).toBeGreaterThan(0);
    expect(diagnostic.metrics.actual.outerRadiusNorm).toBeGreaterThan(0);
    expect(diagnostic.findings).toEqual([]);
  });

  it('reports normalized center shift with the expected sign', async () => {
    const { diagnostic } = await compareCharts('center-shift', {}, { cx: 88, cy: 66 });
    const finding = diagnostic.findings.find((item: any) => item.kind === 'centerShift');

    expect(finding).toBeTruthy();
    expect(finding.dxNorm).toBeGreaterThan(0);
    expect(finding.dyNorm).toBeGreaterThan(0);
  });

  it('reports a plausible relative radius mismatch', async () => {
    const { diagnostic } = await compareCharts('radius-mismatch', {}, { radius: 35 });
    const finding = diagnostic.findings.find((item: any) => item.kind === 'relativeRadiusMismatch');

    expect(finding).toBeTruthy();
    expect(finding.deltaNorm).toBeLessThan(0);
    expect(Math.abs(finding.deltaNorm)).toBeGreaterThan(0.02);
  });

  it('reports stroke width mismatch', async () => {
    const { diagnostic } = await compareCharts('stroke-mismatch', {}, { stroke: 18 });

    expect(diagnostic.findings.some((item: any) => item.kind === 'strokeWidthMismatch')).toBe(true);
  });

  it('reports angle mismatch for a rotated arc', async () => {
    const { diagnostic } = await compareCharts('angle-mismatch', {}, { start: -75 });
    const finding = diagnostic.findings.find((item: any) => item.kind === 'angleMismatch');

    expect(finding).toBeTruthy();
    expect(Math.abs(finding.deltaStartDeg)).toBeGreaterThanOrEqual(10);
  });

  it('reports sweep mismatch for a longer arc', async () => {
    const { diagnostic } = await compareCharts('sweep-mismatch', {}, { sweep: 250 });
    const finding = diagnostic.findings.find((item: any) => item.kind === 'sweepMismatch');

    expect(finding).toBeTruthy();
    expect(finding.deltaSweepDeg).toBeGreaterThan(20);
  });

  it('distinguishes small pixel-only drift from relative geometry mismatch', async () => {
    const { diagnostic } = await compareCharts('scale-only', {}, { radius: 44 }, {
      radiusToleranceNorm: 0.05
    });

    expect(diagnostic.verdict).toBe('scaleOnlyMismatch');
    expect(diagnostic.findings.some((item: any) => item.kind === 'scaleOnlyMismatch')).toBe(true);
  });

  it('masks dynamic center pixels before estimating ring geometry', async () => {
    const { diagnostic } = await compareCharts('dynamic-mask', { centerNoise: true }, { centerNoise: true }, {
      maskDynamicSubregions: true
    }, {
      allowedDynamicSubregions: [{
        id: 'center-noise',
        coordinateSpace: 'roiNormalized',
        box: { x: 0.35, y: 0.38, width: 0.30, height: 0.25 },
        reason: 'Dynamic center text'
      }]
    });

    expect(diagnostic.status).toBe('completed');
    expect(diagnostic.findings).toEqual([]);
  });

  it('fails safely when no arc signal exists', async () => {
    const { diagnostic, result } = await compareCharts('blank', undefined, undefined);

    expect(['warning', 'failed']).toContain(diagnostic.status);
    expect(diagnostic.verdict).toBe('insufficientSignal');
    expect(diagnostic.findings.some((item: any) => item.kind === 'insufficientSignal')).toBe(true);
    expect(result.regionsOfInterest?.[0]).toBeTruthy();
  });

  it('persists geometry diagnostics and artifact paths in report.json', async () => {
    const { result, roiReport, diagnostic } = await compareCharts('persistence', {}, { radius: 35 });
    const persisted = JSON.parse(await fs.readFile(path.join(testDir, 'out-persistence', 'report.json'), 'utf-8'));

    expect(persisted).toEqual(result);
    expect(persisted.regionsOfInterest[0].geometryDiagnostics).toEqual(diagnostic);
    await expect(fs.stat(diagnostic.artifacts.geometryOverlay)).resolves.toBeDefined();
    await expect(fs.stat(diagnostic.artifacts.edgeOverlay)).resolves.toBeDefined();
    await expect(fs.stat(diagnostic.artifacts.expectedArcMask)).resolves.toBeDefined();
    await expect(fs.stat(diagnostic.artifacts.actualArcMask)).resolves.toBeDefined();
    await expect(fs.stat(diagnostic.artifacts.polarSummary)).resolves.toBeDefined();
    expect(roiReport.artifacts.geometryOverlay).toBe(diagnostic.artifacts.geometryOverlay);
  });

  it('leaves ROIs without geometryDiagnostics backward compatible', async () => {
    const expectedImage = await createChartImage('compat-expected', {});
    const actualImage = await createChartImage('compat-actual', { radius: 35 });
    const result = await compareImages({
      expectedImage,
      actualImage,
      outputDir: path.join(testDir, 'out-compat'),
      maxDiffPercent: 1,
      regionsOfInterest: [{
        id: 'macro-ring-hero',
        label: 'Macro ring hero',
        type: 'component',
        box: roi,
        maxDiffPercent: 1
      }]
    } as any);

    expect((result.regionsOfInterest?.[0] as any).geometryDiagnostics).toBeUndefined();
  });
});
