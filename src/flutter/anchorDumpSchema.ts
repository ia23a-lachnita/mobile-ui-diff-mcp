import { z } from 'zod';

const insetLogicalSchema = z.object({
  top: z.number(),
  left: z.number(),
  right: z.number(),
  bottom: z.number()
});

const deviceDtoSchema = z.object({
  screenshotWidthPx: z.number().int().positive(),
  screenshotHeightPx: z.number().int().positive(),
  devicePixelRatio: z.number().positive(),
  mediaQuerySizeLogical: z.object({
    width: z.number().positive(),
    height: z.number().positive()
  }),
  paddingLogical: insetLogicalSchema,
  viewPaddingLogical: insetLogicalSchema,
  viewInsetsLogical: insetLogicalSchema
});

const anchorVisibilitySchema = z.object({
  visibleFraction: z.number().min(0).max(1),
  isOffscreen: z.boolean()
});

const rectLogicalSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
});

const anchorDtoSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  rectLogical: rectLogicalSchema,
  visible: z.boolean(),
  visibility: anchorVisibilitySchema
}).strict();

/**
 * Strict schema for the Flutter anchor dump DTO.
 * Rejects framework objects, missing coordinate metadata, or extra root-level
 * fields that suggest a raw framework serialization slipped through.
 */
export const flutterAnchorDumpSchema = z.object({
  framework: z.literal('flutter'),
  screen: z.string().min(1),
  coordinateSpace: z.literal('flutterLogical'),
  coordinateOrigin: z.string().min(1),
  device: deviceDtoSchema,
  anchors: z.array(anchorDtoSchema)
}).strict();

export type FlutterAnchorDumpInput = z.input<typeof flutterAnchorDumpSchema>;
export type FlutterAnchorDumpParsed = z.output<typeof flutterAnchorDumpSchema>;
