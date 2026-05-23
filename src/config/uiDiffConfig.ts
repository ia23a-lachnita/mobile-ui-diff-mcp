import fs from 'fs/promises';
import { z } from 'zod';
import { resolveAbsolutePath } from '../utils/fs';

export const ignoreRegionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  reason: z.string().optional(),
  type: z.enum(['system', 'data', 'dynamic']).optional(),
  coordinateSpace: z.enum(['expected', 'actual', 'normalized']).optional()
});

export const preCaptureSchema = z.object({
  type: z.literal('adbShell'),
  command: z.string().min(1),
  description: z.string().min(1)
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
  maxDiffPercent: z.number().min(0).max(1).optional()
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
  ignoreRegions: z.array(ignoreRegionSchema).optional(),
  preCapture: z.array(preCaptureSchema).optional(),
  regionsOfInterest: z.array(regionOfInterestSchema).optional(),
  visualAssertions: z.array(visualAssertionSchema).optional(),
  floorDetection: floorDetectionSchema.optional(),
  vlm: vlmConfigSchema
});

export const uiDiffConfigSchema = z.object({
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
