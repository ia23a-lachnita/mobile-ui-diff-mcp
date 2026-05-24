import fs from 'fs/promises';
import { z } from 'zod';
import { resolveAbsolutePath } from '../utils/fs';

export const ignoreRegionSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
  reason: z.string().optional(),
  type: z.enum(['system', 'data', 'dynamic']).optional(),
  coordinateSpace: z.enum(['expected', 'actual', 'normalized']).optional()
});

export const preCaptureSchema = z.object({
  type: z.literal('adbShell'),
  command: z.string().min(1),
  description: z.string().min(1)
}).or(z.object({
  type: z.literal('adbTapNormalized'),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  description: z.string().min(1)
}));

export const autoIgnoreSchema = z.object({
  enabled: z.boolean().optional(),
  screenshotOutOfBounds: z.boolean().optional(),
  systemBars: z.boolean().optional(),
  edgePanels: z.boolean().optional()
});

export const sizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive()
});

export const deviceProfileSchema = z.object({
  id: z.string().min(1),
  serial: z.string().min(1).optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  androidVersion: z.string().optional(),
  wmSize: sizeSchema.optional(),
  screenshotSize: sizeSchema.optional(),
  density: z.number().int().positive().optional(),
  systemUiEstimates: z.record(z.string(), ignoreRegionSchema).optional(),
  autoIgnoreRegions: z.array(ignoreRegionSchema).optional()
});

export const allowedDynamicSubregionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  coordinateSpace: z.enum(['roiNormalized', 'normalized', 'expected', 'actual']).optional(),
  box: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive()
  }),
  reason: z.string().min(1).optional()
});

export const regionOfInterestSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['component', 'zone']),
  critical: z.boolean().optional(),
  weight: z.number().positive().optional(),
  coordinateSpace: z.enum(['normalized', 'expected', 'actual']).optional(),
  box: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive()
  }),
  maxDiffPercent: z.number().min(0).max(1).optional(),
  allowedDynamicSubregions: z.array(allowedDynamicSubregionSchema).optional(),
  allowBroadDynamicSubregions: z.boolean().optional()
});

export const visualAssertionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('roiMaxDiffPercent'),
  roiId: z.string().min(1),
  maxDiffPercent: z.number().min(0).max(1),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  message: z.string().min(1)
});

export const floorDetectionSchema = z.object({
  enabled: z.boolean().optional(),
  deltaThreshold: z.number().min(0).optional(),
  consecutiveRuns: z.number().int().positive().optional()
});

export const hotspotDetectionSchema = z.object({
  enabled: z.boolean().optional(),
  maxHotspots: z.number().int().positive().max(50).optional(),
  minAreaPercent: z.number().min(0).max(1).optional(),
  minDiffDensity: z.number().min(0).max(1).optional()
});

export const vlmPolicySchema = z.enum(['disabled', 'optional', 'required', 'ask_user']);

export const vlmConfigSchema = z.object({
  provider: z.enum(['ollama']).optional(),
  baseUrl: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  fallbackModels: z.array(z.string().min(1)).optional(),
  keepAlive: z.string().min(1).optional(),
  preflight: z.boolean().optional(),
  require: z.boolean().optional(),
  autoPull: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional()
}).optional();

export const uiDiffScreenSchema = z.object({
  platform: z.enum(['android', 'ios', 'none']),
  expectedImage: z.string().min(1),
  outputDir: z.string().min(1),
  pixelmatchThreshold: z.number().min(0).max(1).optional(),
  maxDiffPercent: z.number().min(0).max(1).optional(),
  maxRegions: z.number().int().positive().max(500).optional(),
  maxVlmRegions: z.number().int().nonnegative().max(50).optional(),
  includeVlmAnalysis: z.boolean().optional(),
  requireVlmAnalysis: z.boolean().optional(),
  vlmPolicy: vlmPolicySchema.optional(),
  ignoreRegions: z.array(ignoreRegionSchema).optional(),
  dataRegions: z.array(ignoreRegionSchema).optional(),
  autoIgnore: autoIgnoreSchema.optional(),
  preCapture: z.array(preCaptureSchema).optional(),
  appContentBounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    coordinateSpace: z.enum(['normalized', 'expected', 'actual']).optional()
  }).optional(),
  regionsOfInterest: z.array(regionOfInterestSchema).optional(),
  visualAssertions: z.array(visualAssertionSchema).optional(),
  floorDetection: floorDetectionSchema.optional(),
  hotspotDetection: hotspotDetectionSchema.optional(),
  vlm: vlmConfigSchema
});

export const uiDiffConfigSchema = z.object({
  deviceProfiles: z.record(z.string(), deviceProfileSchema).optional(),
  autoIgnore: autoIgnoreSchema.optional(),
  screens: z.record(z.string(), uiDiffScreenSchema)
});

export type UiDiffConfig = z.infer<typeof uiDiffConfigSchema>;
export type UiDiffScreenProfile = z.infer<typeof uiDiffScreenSchema>;

export async function loadUiDiffConfig(configPath?: string): Promise<{ config: UiDiffConfig; configPath: string }> {
  const resolvedPath = resolveAbsolutePath(configPath ?? 'ui-diff.config.json');
  try {
    await fs.access(resolvedPath);
  } catch (err: any) {
    const label = configPath ? 'Config file' : 'ui-diff.config.json';
    throw new Error(`${label} not found at ${resolvedPath}`);
  }

  let parsed: unknown;
  try {
    const raw = await fs.readFile(resolvedPath, 'utf-8');
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Failed to parse ${resolvedPath}: ${err.message}`);
  }

  const config = uiDiffConfigSchema.parse(parsed);
  return { config, configPath: resolvedPath };
}
