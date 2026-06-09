import { z } from 'zod';

const flutterAnchorLocatorSchema = z.object({
  type: z.literal('flutter_anchor'),
  anchorId: z.string().min(1),
  required: z.boolean()
});

const targetLocatorSchema = flutterAnchorLocatorSchema;

const targetCriterionSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  avoidColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
  minClearancePx: z.number().nonnegative().optional(),
  maxOverlapPercent: z.number().min(0).max(100).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'warning']).optional(),
  anchorDescription: z.string().optional(),
  mustContainText: z.array(z.string()).optional(),
  mustNotMatch: z.array(z.string()).optional()
});

const semanticTargetSchema = z.object({
  id: z.string().min(1),
  locator: targetLocatorSchema,
  expectedText: z.string().optional(),
  criteria: z.array(targetCriterionSchema)
});

export const semanticTargetMapSchema = z.object({
  version: z.string().min(1),
  screen: z.string().min(1),
  targets: z.array(semanticTargetSchema)
});

export type SemanticTargetMapInput = z.input<typeof semanticTargetMapSchema>;
export type SemanticTargetMapParsed = z.output<typeof semanticTargetMapSchema>;
