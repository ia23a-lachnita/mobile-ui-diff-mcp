import fs from 'fs/promises';
import { z } from 'zod';
import { resolveAbsolutePath } from '../utils/fs';

export const ignoreRegionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  reason: z.string().optional()
});

export const uiDiffScreenSchema = z.object({
  platform: z.enum(['android', 'ios', 'none']),
  expectedImage: z.string().min(1),
  outputDir: z.string().min(1),
  pixelmatchThreshold: z.number().min(0).max(1).optional(),
  maxDiffPercent: z.number().min(0).max(1).optional(),
  maxRegions: z.number().int().positive().max(500).optional(),
  maxVlmRegions: z.number().int().nonnegative().max(50).optional(),
  includeVlmAnalysis: z.boolean().optional(),
  ignoreRegions: z.array(ignoreRegionSchema).optional()
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
