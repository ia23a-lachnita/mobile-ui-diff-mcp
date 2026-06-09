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

// Accepts the Calorix visibility DTO shape (offscreen/clippedByViewport/covered/notes)
// and the legacy isOffscreen field for backward compat. visibleFraction is the only required field.
// Unknown fields are stripped (not passed through) to prevent raw framework objects from propagating.
const anchorVisibilitySchema = z.object({
  visibleFraction: z.number().min(0).max(1),
  // Calorix canonical fields
  offscreen: z.boolean().optional(),
  clippedByViewport: z.boolean().optional(),
  covered: z.boolean().optional(),
  notes: z.array(z.string()).optional(),
  // Legacy backward-compat field (Calorix emits offscreen, not isOffscreen)
  isOffscreen: z.boolean().optional()
});

const rectLogicalSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
});

// Unknown anchor-level fields are stripped (not passed through) to prevent raw framework
// objects (renderObject, context, widget, etc.) from propagating into the parsed result.
// Calorix may emit extra diagnostic fields — they are safely discarded here.
const anchorDtoSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  rectLogical: rectLogicalSchema,
  visible: z.boolean(),
  visibility: anchorVisibilitySchema
});

/**
 * Schema for the Flutter anchor dump DTO.
 * Root level stays strict to reject raw framework serializations.
 * Anchor entries are passthrough to accept Calorix's extended DTO shape.
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
