/** Logical coordinate rectangle in Flutter's coordinate space. */
export interface RectLogical {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Integer screenshot-pixel rectangle after DPR conversion and clamping. */
export interface RectPx {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InsetLogical {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface DeviceDto {
  screenshotWidthPx: number;
  screenshotHeightPx: number;
  devicePixelRatio: number;
  mediaQuerySizeLogical: { width: number; height: number };
  paddingLogical: InsetLogical;
  viewPaddingLogical: InsetLogical;
  viewInsetsLogical: InsetLogical;
}

export interface AnchorVisibility {
  visibleFraction: number;
  isOffscreen: boolean;
}

export interface AnchorDto {
  id: string;
  label?: string;
  rectLogical: RectLogical;
  visible: boolean;
  visibility: AnchorVisibility;
}

/** Stripped Flutter anchor dump DTO — no framework objects allowed. */
export interface FlutterAnchorDump {
  framework: 'flutter';
  screen: string;
  coordinateSpace: 'flutterLogical';
  coordinateOrigin: string;
  device: DeviceDto;
  anchors: AnchorDto[];
}

/** Result of parsing a Flutter anchor dump — includes resolved physical rects. */
export interface ParsedAnchorDump {
  dump: FlutterAnchorDump;
  /** Map from anchor ID to resolved physical pixel rect. */
  resolvedRects: Map<string, RectPx>;
  /** Map from anchor ID to AnchorDto for quick lookup. */
  anchorIndex: Map<string, AnchorDto>;
}

/** Mapping metadata recorded per resolved target in the report. */
export interface AnchorMappingMetadata {
  measurementBoxSource: 'flutter_anchor' | 'manual_fallback' | 'none';
  devicePixelRatio: number;
  coordinateOrigin: string;
  paddingPresent: boolean;
  viewPaddingPresent: boolean;
  viewInsetsPresent: boolean;
  insetsApplied: boolean;
  rectLogical: RectLogical;
  rectActualPx: RectPx;
}

// ─── Semantic Target Map ────────────────────────────────────────────────────

export type LocatorType = 'flutter_anchor';

export interface FlutterAnchorLocator {
  type: 'flutter_anchor';
  anchorId: string;
  required: boolean;
}

export type TargetLocator = FlutterAnchorLocator;

export type CriterionDomain =
  | 'text.content'
  | 'legibility.overlap'
  | 'legibility.contrast'
  | 'visual.layout'
  | string;

export interface TargetCriterion {
  id: string;
  domain: CriterionDomain;
  /** Hex colors that must not overlap the target. */
  avoidColors?: string[];
  minClearancePx?: number;
  maxOverlapPercent?: number;
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'warning';
}

export interface SemanticTarget {
  id: string;
  locator: TargetLocator;
  expectedText?: string;
  criteria: TargetCriterion[];
}

export interface SemanticTargetMap {
  version: string;
  screen: string;
  targets: SemanticTarget[];
}

// ─── Target Resolution Result ───────────────────────────────────────────────

export type TargetResolutionSource = 'flutter_anchor' | 'manual_fallback' | 'unresolved';

export interface ResolvedTarget {
  targetId: string;
  source: TargetResolutionSource;
  rect?: RectPx;
  mappingMetadata?: AnchorMappingMetadata;
  visible: boolean;
  visibleFraction: number;
  /** Set when anchor is in dump but hidden/offscreen. */
  targetNotVisible?: boolean;
  /** Set when anchor ID is not found in the dump. */
  anchorMissing?: boolean;
  /** Set when manual fallback is used. */
  manualFallbackWarning?: string;
}

export interface TargetResolutionSummary {
  totalTargets: number;
  resolvedViaFlutterAnchor: number;
  resolvedViaManualFallback: number;
  unresolved: number;
  notVisible: number;
  results: ResolvedTarget[];
}

// ─── Artifact readiness ──────────────────────────────────────────────────────

export type AnchorArtifactStatus =
  | 'ready'
  | 'anchor_artifact_timeout'
  | 'invalid_anchor_dump';

export interface AnchorArtifactResult {
  status: AnchorArtifactStatus;
  parsed?: ParsedAnchorDump;
  error?: string;
}
