export interface IgnoreRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  reason?: string;
  type?: 'system' | 'data' | 'dynamic';
  coordinateSpace?: 'expected' | 'actual' | 'normalized';
}

export interface AdbShellPreCaptureStep {
  type: 'adbShell';
  command: string;
  description: string;
}

export interface AdbTapNormalizedPreCaptureStep {
  type: 'adbTapNormalized';
  x: number;
  y: number;
  description: string;
}

export type PreCaptureStep = AdbShellPreCaptureStep | AdbTapNormalizedPreCaptureStep;

export interface PreCaptureResult {
  description: string;
  ok: boolean;
  command: string;
  resolved?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  error?: string;
}

export interface BoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AllowedDynamicSubregionConfig {
  id: string;
  label?: string;
  coordinateSpace?: 'roiNormalized' | 'normalized' | 'expected' | 'actual';
  box: BoxLike;
  reason?: string;
}

export interface RegionOfInterestConfig {
  id: string;
  label: string;
  type: 'component' | 'zone';
  critical?: boolean;
  weight?: number;
  coordinateSpace?: 'normalized' | 'expected' | 'actual';
  box: BoxLike;
  maxDiffPercent?: number;
  allowedDynamicSubregions?: AllowedDynamicSubregionConfig[];
  allowBroadDynamicSubregions?: boolean;
  geometryDiagnostics?: GeometryDiagnosticsConfig;
}

export interface RadialChartGeometryDiagnosticsConfig {
  type: 'radialChart';
  enabled: boolean;
  maskDynamicSubregions?: boolean;
  colorHints?: string[];
  centerToleranceNorm?: number;
  radiusToleranceNorm?: number;
  angleToleranceDeg?: number;
  strokeToleranceNorm?: number;
}

export type GeometryDiagnosticsConfig = RadialChartGeometryDiagnosticsConfig;

export interface VisualAssertionConfig {
  id: string;
  type: 'roiMaxDiffPercent';
  roiId: string;
  maxDiffPercent: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
}

export interface FloorDetectionConfig {
  enabled?: boolean;
  deltaThreshold?: number;
  consecutiveRuns?: number;
}

export interface HotspotDetectionConfig {
  enabled?: boolean;
  maxHotspots?: number;
  minAreaPercent?: number;
  minDiffDensity?: number;
}

export interface AutoIgnoreConfig {
  enabled?: boolean;
  screenshotOutOfBounds?: boolean;
  systemBars?: boolean;
  edgePanels?: boolean;
}

export interface DeviceSize {
  width: number;
  height: number;
}

export interface SystemUiEstimates {
  statusBar?: IgnoreRegion;
  navigationBar?: IgnoreRegion;
  rightStrip?: IgnoreRegion;
  bottomStrip?: IgnoreRegion;
}

export interface DeviceProfile {
  id: string;
  serial?: string;
  manufacturer?: string;
  model?: string;
  androidVersion?: string;
  wmSize?: DeviceSize;
  screenshotSize?: DeviceSize;
  density?: number;
  systemUiEstimates?: SystemUiEstimates;
  autoIgnoreRegions?: IgnoreRegion[];
}

export interface ConfigSuggestion {
  kind: 'deviceProfile' | 'ignoreRegion' | 'dataRegion' | 'roiUpdate' | 'preCapture';
  confidence: number;
  reason: string;
  risk: string;
  suggestedPatch: Record<string, unknown>;
}

export type VlmPolicy = 'disabled' | 'optional' | 'required' | 'ask_user';

export type OutputMode = 'compact' | 'standard' | 'full';

export type VlmAnalysisStatus = 'disabled' | 'skipped' | 'pass' | 'unavailable' | 'error';

export interface RunTimings {
  totalMs: number;
  captureMs?: number;
  imageLoadMs?: number;
  pixelDiffMs?: number;
  roiQualityMs?: number;
  overlapLegibilityMs?: number;
  localVlmMs?: number;
  modelJudgesMs?: number;
  providers?: {
    openrouter?: { totalMs: number; attempts: number; timeoutMs: number };
    nvidia?: { totalMs: number; attempts: number; timeoutMs: number };
    ollama?: { totalMs: number; attempts: number; timeoutMs: number };
  };
  perAnalyzer?: Record<string, number>;
}

export type VlmUnavailableReason = 'resource_limited' | 'unreachable' | 'model_missing' | 'timeout' | 'unknown';

export interface VlmAvailability {
  requested: boolean;
  usable: boolean;
  selectedModel: string | null;
  reason?: VlmUnavailableReason;
  message?: string;
}

export interface ActionRequired {
  type:
    | 'vlm_unavailable'
    | 'invalid_capture'
    | 'model_judges_unavailable'
    | 'model_judges_failed'
    | 'invalid_overlap_target'
    | 'missing_flutter_anchor'
    | 'target_not_visible'
    | 'invalid_anchor_dump'
    | 'anchor_artifact_timeout'
    | 'invalid_target_map';
  severity: 'blocking';
  message: string;
  recommendedUserPrompt: string;
  suggestedFixes: string[];
}

export type VisualAuditStatus = 'pass' | 'pass_with_caveats' | 'fail' | 'not_run' | 'skipped_by_config' | 'unavailable' | 'error';
export type AcceptanceStatus = 'accepted' | 'rejected' | 'incomplete' | 'metric_only';

export interface VisualCaveat {
  id: string;
  source: string;
  subject: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'warning';
  blocking: boolean;
  message: string;
  confidence: number;
  measurements?: Record<string, number | string | boolean>;
  artifacts?: string[];
  proposedChangeVector?: string;
}

export interface RunDelta {
  previousRun: {
    name: string;
    reportPath: string;
    status: 'pass' | 'fail';
    diffPercent: number;
    diffPixels: number;
    regionCount: number;
  };
  currentRun: {
    name: string;
    reportPath: string;
    status: 'pass' | 'fail';
    diffPercent: number;
    diffPixels: number;
    regionCount: number;
  };
  diffPercentDelta: number;
  diffPixelsDelta: number;
  regionCountDelta: number;
  statusChanged: boolean;
  trend: 'improved' | 'worsened' | 'unchanged';
}

export interface QualityFailure {
  type: 'critical_roi_failed' | 'critical_visual_assertion_failed' | 'global_diff_failed' | 'excessive_dynamic_masking' | 'invalid_capture';
  roiId?: string;
  assertionId?: string;
  label?: string;
  diffPercent?: number;
  rawRoiDiffPercent?: number;
  structuralRoiDiffPercent?: number;
  dynamicMaskedPercentOfRoi?: number;
  maxDiffPercent?: number;
}

export interface PriorityFinding {
  priority: number;
  kind: string;
  label: string;
  message: string;
  artifactPaths: string[];
}

export interface VisualAssertionResult {
  id: string;
  status: 'pass' | 'fail';
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  actualDiffPercent?: number;
  metricUsed?: 'structuralRoiDiffPercent';
  rawRoiDiffPercent?: number;
  structuralRoiDiffPercent?: number;
  dynamicMaskedPercentOfRoi?: number;
  maxDiffPercent: number;
}

export interface AgentSummary {
  verdict: string;
  globalDiffPercent: number;
  qualityStatus: 'pass' | 'fail' | 'not_evaluated';
  topAction: string;
  canStopIterating: boolean;
}

export interface RegionOfInterestReport {
  id: string;
  label: string;
  type: 'component' | 'zone';
  critical: boolean;
  weight: number;
  box: BoxLike;
  status: 'pass' | 'fail';
  diffPixels: number;
  totalPixels: number;
  diffPercent: number;
  rawRoiDiffPercent: number;
  structuralRoiDiffPercent: number;
  dynamicMaskedPercentOfRoi: number;
  resolvedDynamicSubregions: Array<{
    id: string;
    label?: string;
    reason?: string;
    coordinateSpace: 'expected';
    box: BoxLike;
  }>;
  diffDensity: number;
  maxDiffPercent: number;
  intersectingRegionIds: string[];
  diagnostics: string[];
  geometryDiagnostics?: RadialChartGeometryDiagnosticsResult;
  weightedScore: number;
  artifacts: {
    expected: string;
    actual: string;
    diff: string;
    structuralDiff?: string;
    geometryOverlay?: string;
    edgeOverlay?: string;
    expectedArcMask?: string;
    actualArcMask?: string;
    polarSummary?: string;
  };
}

export type GeometryFindingSeverity = 'low' | 'medium' | 'high';

export interface RadialChartGeometryFinding {
  kind:
    | 'centerShift'
    | 'relativeRadiusMismatch'
    | 'strokeWidthMismatch'
    | 'ringGapMismatch'
    | 'angleMismatch'
    | 'sweepMismatch'
    | 'missingArc'
    | 'capMismatch'
    | 'haloOrTrackMismatch'
    | 'scaleOnlyMismatch'
    | 'insufficientSignal';
  severity: GeometryFindingSeverity;
  color?: string;
  message?: string;
  expectedNorm?: number;
  actualNorm?: number;
  deltaNorm?: number;
  dxNorm?: number;
  dyNorm?: number;
  deltaStartDeg?: number;
  deltaEndDeg?: number;
  deltaSweepDeg?: number;
}

export interface RadialChartArcMetrics {
  color: string;
  startAngleDeg: number;
  endAngleDeg: number;
  sweepDeg: number;
  meanRadiusPx: number;
  meanRadiusNorm: number;
  strokeWidthPx: number;
  strokeWidthNorm: number;
}

export interface RadialChartGeometryMetrics {
  centerPx: { x: number; y: number };
  centerNorm: { x: number; y: number };
  outerRadiusPx: number;
  outerRadiusNorm: number;
  innerRadiusPx: number;
  innerRadiusNorm: number;
  strokeWidthPx: number;
  strokeWidthNorm: number;
  ringGapPx: number;
  ringGapNorm: number;
  arcs: RadialChartArcMetrics[];
}

export interface RadialChartGeometryDiagnosticsResult {
  type: 'radialChart';
  status: 'completed' | 'warning' | 'failed';
  confidence: number;
  metrics: {
    expected?: RadialChartGeometryMetrics;
    actual?: RadialChartGeometryMetrics;
  };
  findings: RadialChartGeometryFinding[];
  verdict: 'geometryWithinTolerance' | 'scaleOnlyMismatch' | 'relativeGeometryMismatch' | 'insufficientSignal';
  agentHint: string;
  artifacts: {
    geometryOverlay: string;
    edgeOverlay: string;
    expectedArcMask: string;
    actualArcMask: string;
    polarSummary: string;
  };
  warnings: string[];
}

export interface FloorBlocker {
  type: 'critical_roi_failed' | 'critical_visual_assertion_failed' | 'quality_not_evaluated' | 'quality_failed';
  roiId?: string;
  assertionId?: string;
  label?: string;
  message?: string;
}

export interface VlmAnalysis {
  label?: string;
  type: "layout" | "spacing" | "color" | "text" | "font" | "icon" | "missing" | "extra" | "size" | "unknown";
  severity: "low" | "medium" | "high";
  description: string;
  likelyFix: string;
}

export interface VlmConfig {
  provider?: "ollama";
  baseUrl?: string;
  model?: string;
  fallbackModels?: string[];
  keepAlive?: string;
  preflight?: boolean;
  require?: boolean;
  autoPull?: boolean;
  timeoutMs?: number;
}

export interface VlmSummary {
  requested: boolean;
  required: boolean;
  provider: "ollama";
  baseUrl: string;
  selectedModel: string | null;
  fallbackUsed: boolean;
  healthStatus: "ok" | "warning" | "error";
  warnings: string[];
}

export interface RegionReport {
  id: string;
  box: { x: number; y: number; width: number; height: number };
  area: number;
  actionable?: boolean;
  classification?: "app" | "system" | "artifact";
  cropPaths: {
    expected: string;
    actual: string;
    diff: string;
  };
  analysisStatus: "skipped" | "ok" | "fallback" | "error";
  analysis: VlmAnalysis | null;
  fallbackLabel?: string;
  fallbackDescription?: string;
  intersectingRois?: string[];
}

export interface LocalHotspot {
  regionId: string;
  area: number;
  box: BoxLike;
  diffDensity: number;
  fallbackLabel: string;
  message: string;
}

export type ChangeVector =
  | 'seed_data' | 'fixture_plan'
  | 'ring_stroke_width' | 'ring_radius_size' | 'ring_gap'
  | 'ring_start_angle' | 'ring_sweep_mapping' | 'ring_center_alignment'
  | 'ring_glow_track'
  | 'component_layout' | 'card_spacing_padding'
  | 'text_style' | 'color_token'
  | 'thumbnail_gradient' | 'badge_style' | 'bottom_nav_padding'
  | 'expected_baseline' | 'roi_threshold' | 'device_profile'
  | 'dynamic_mask' | 'none';

export type ReasonCode =
  | 'SOURCE_AND_GEOMETRY_AGREE'
  | 'SOURCE_CONTRADICTION'
  | 'SCALE_ONLY_MISMATCH'
  | 'REFERENCE_CONFLICT'
  | 'INSUFFICIENT_CONFIDENCE'
  | 'MODEL_DISAGREEMENT'
  | 'NON_DETERMINISTIC_CAPTURE'
  | 'INVALID_CAPTURE'
  | 'QUALITY_GATE_PASS'
  | 'MASK_TOO_BROAD'
  | 'NO_SUPPORTING_EVIDENCE'
  | 'OUT_OF_SCOPE';

export interface AllowedChangeVector {
  vector: ChangeVector;
  scope?: string;
  reasonCode: ReasonCode;
  maxChanges?: number;
}

export interface BlockedChangeVector {
  vector: ChangeVector;
  reasonCode: ReasonCode;
}

export interface OverlapLegibilityRegionResult {
  id: string;
  roiId?: string;
  checked: boolean;
  status: 'pass' | 'caveat' | 'error' | 'skipped' | 'invalid_target';
  /** Whether the judge confirmed the configured box covers the intended UI element. */
  targetStatus?: 'matched' | 'not_matched' | 'ambiguous' | 'not_checked';
  /** Deterministic overlap/clearance outcome. Set to not_evaluated when targetStatus is not_matched or ambiguous. */
  measurementStatus?: 'pass' | 'caveat' | 'fail' | 'not_evaluated';
  /** Criterion-specific judge verdict on legibility and measurement credibility. */
  judgeAuditStatus?: 'pass' | 'caveat' | 'fail' | 'target_mismatch' | 'unavailable' | 'not_run';
  skipReason?: string;
  overlapPercent?: number;
  clearancePx?: number | null;
  nearestAvoidColorDistancePx?: number | null;
  coloredPixelCountInBox?: number;
  coloredPixelCountInClearanceBand?: number;
  pillTextMaskPixelCount?: number;
  macroRingArcPixelCount?: number;
  diagnosticLayers?: string[];
  minClearancePx?: number;
  artifactPath?: string | null;
  resolvedBox?: { x: number; y: number; width: number; height: number; coordinateSpace: string };
  roiBox?: { x: number; y: number; width: number; height: number };
  imageSize?: { width: number; height: number };
  /** Paths to criterion audit images used by the criterion judge. */
  criterionArtifacts?: {
    annotatedActualScreen?: string;
    expectedCrop?: string;
    actualCrop?: string;
  };
  /** Primary provider criterion result (set after Stage 2.5). */
  primaryCriterionResult?: CriterionJudgeResult;
  /** Reviewer provider criterion result (set after Stage 2.5 when reviewer is configured). */
  reviewerCriterionResult?: CriterionJudgeResult;
}

export interface OverlapLegibilitySummary {
  enabled: true;
  regions: OverlapLegibilityRegionResult[];
}

/** Target contract for a criterion audit — describes the intended element the configured box should cover. */
export interface CriterionTargetConfig {
  /** The exact text the target element should display (e.g. "980 kcal left"). */
  expectedText?: string;
  /** Human description of the anchor element (e.g. "rounded kcal-left pill below center number"). */
  anchorDescription?: string;
  /** Text strings that the targeted element must contain. If none visible, box may be wrong. */
  mustContainText?: string[];
  /** Text strings that must NOT be visible in the targeted element. Presence means wrong box. */
  mustNotMatch?: string[];
}

/** A criterion-focused judge audit packet for one overlap/legibility region. */
export interface CriterionAuditBundle {
  criterionId: string;
  /** Parent target ID — used to group multiple criteria for the same target into one batch call. */
  targetId?: string;
  criterionLabel: string;
  criterionDescription?: string;
  resolvedBox?: { x0: number; y0: number; x1: number; y1: number };
  deterministicSummary?: string;
  artifacts: {
    /** Full expected screen (design reference, original pixels). Judges compare against actual. */
    fullExpectedScreen?: string;
    /** Full actual screen (original pixels). Judges use this for full context. */
    fullActualScreen?: string;
    /** Full actual screen with the configured box highlighted in a bright magenta border. */
    annotatedActualScreen?: string;
    /** Generous-margin crop from the expected image (original pixels, no overlays). */
    expectedCrop?: string;
    /** Generous-margin crop from the actual image (original pixels, no overlays). */
    actualCrop?: string;
    /** Deterministic overlap/clearance diagnostic artifact — supporting evidence only. */
    diagnosticArtifact?: string;
  };
}

/** Result returned by the criterion judge for one overlap/legibility region. */
export interface CriterionJudgeResult {
  criterionId: string;
  targetStatus: 'matched' | 'not_matched' | 'ambiguous' | 'not_checked';
  measurementCredible?: boolean;
  judgeAuditStatus: 'pass' | 'caveat' | 'fail' | 'target_mismatch' | 'unavailable' | 'not_run';
  reasoning: string;
  confidence: number;
  /** True when this result was served from the in-memory judge cache (no provider call made). */
  fromCache?: boolean;
}

export interface CriterionJudgeSummaryEntry {
  criterionId: string;
  attempted: boolean;
  hadSuccess: boolean;
  errorCount: number;
  primaryTargetStatus?: CriterionJudgeResult['targetStatus'];
  reviewerTargetStatus?: CriterionJudgeResult['targetStatus'];
  finalTargetStatus: CriterionJudgeResult['targetStatus'];
  finalMeasurementStatus?: OverlapLegibilityRegionResult['measurementStatus'];
  finalJudgeAuditStatus: CriterionJudgeResult['judgeAuditStatus'];
  artifactPathsSent: string[];
}

export interface CriterionJudgesSummary {
  totalRegions: number;
  attempted: number;
  hadSuccess: boolean;
  errorCount: number;
  entries: CriterionJudgeSummaryEntry[];
}

export interface ModelJudgesProviderSummary {
  provider: string;
  model: string;
  status: 'success' | 'partial' | 'error' | 'skipped' | 'unavailable';
  evidenceCount: number;
  errorCount: number;
  hadSuccess: boolean;
  attempted: boolean;
  skippedReason?: string;
}

export interface ModelJudgesSummary {
  enabled: boolean;
  required: boolean;
  policy: string;
  primary?: ModelJudgesProviderSummary;
  reviewer?: ModelJudgesProviderSummary;
  failedRois: Array<{
    roiId: string;
    provider: string;
    providerRole?: 'primary' | 'reviewer';
    error: string;
    failureReason?: string;
    rawResponsePreview?: string;
    schemaErrorPreview?: string;
    lastFailureReason?: string;
    diagnosticIntegrity?: 'adapter_defect' | 'internal_missing_error_detail';
  }>;
}

export interface AgentActionContract {
  canEditApp: boolean;
  confidence: 'high' | 'medium' | 'low' | 'none';
  allowedChangeVectors: AllowedChangeVector[];
  blockedChangeVectors: BlockedChangeVector[];
  requiresUserDecision: boolean;
  reasonSummary?: string;
}

export interface DiffReport {
  status: "pass" | "fail";
  diffPixels: number;
  totalPixels: number;
  /** Raw fraction 0–1 (e.g. 0.0984 means 9.84% of pixels differ). */
  diffPercent: number;
  /** Machine-readable fraction — same value as diffPercent, explicit name. */
  diffFraction?: number;
  /** Human-readable percentage string (e.g. "9.84%"). */
  diffPercentHuman?: string;
  /** Raw fraction 0–1 threshold. */
  thresholdFraction?: number;
  /** Human-readable threshold string (e.g. "14.00%"). */
  thresholdPercentHuman?: string;
  pixelmatchThreshold: number;
  maxDiffPercent: number;
  regions: RegionReport[];
  delta?: RunDelta;
  artifacts: {
    expected: string;
    actual: string;
    diff: string;
    regionsDir: string;
  };
  preCapture?: PreCaptureResult[];
  regionsOfInterest?: RegionOfInterestReport[];
  qualityStatus?: "pass" | "fail" | "not_evaluated";
  qualityFailures?: QualityFailure[];
  qualityWarnings?: string[];
  priorityFindings?: PriorityFinding[];
  localHotspots?: LocalHotspot[];
  artifactRegions?: RegionReport[];
  actionableRegionCount?: number;
  visualAssertions?: VisualAssertionResult[];
  imageSizes?: {
    expected: DeviceSize;
    actualSource: DeviceSize;
    comparison: DeviceSize;
  };
  atFloor?: boolean | null;
  floorBlockedBy?: FloorBlocker[];
  floorReason?: string;
  maskedRegions?: IgnoreRegion[];
  autoMaskedRegions?: IgnoreRegion[];
  appliedDeviceProfile?: DeviceProfile | null;
  configSuggestions?: ConfigSuggestion[];
  agentSummary?: AgentSummary;
  agentActionContract?: AgentActionContract;
  suggestedMaxDiffPercent?: number | null;
  maxDiffPercentSuggestionBlockedBy?: string[];
  vlmPolicy?: VlmPolicy;
  vlmAvailability?: VlmAvailability;
  vlmAnalysisStatus?: VlmAnalysisStatus;
  actionRequired?: ActionRequired | null;
  visualAuditStatus?: VisualAuditStatus;
  acceptanceStatus?: AcceptanceStatus;
  timings?: RunTimings;
  visualCaveats?: VisualCaveat[];
  modelJudgesSummary?: ModelJudgesSummary;
  overlapLegibilitySummary?: OverlapLegibilitySummary;
  criterionJudgesSummary?: CriterionJudgesSummary;
  targetResolutionSummary?: import('./flutter/types').TargetResolutionSummary;
  measurementBoxSource?: 'flutter_anchor' | 'manual_fallback' | 'none';
  cacheSummary?: { attempted: number; cached: number; skipped: number; fresh?: number; persistedPath?: string; loadedFromDisk?: boolean; savedToDisk?: boolean };
  blockedModelFindings?: Array<{ claimId: string; reason: string; sourceFact?: string }>;
  warnings?: string[];
  reportJsonPath?: string;
  vlm?: VlmSummary;
  referenceContextSummary?: {
    factsLoaded: number;
    sourcesLoaded: number;
    missingFiles: string[];
    warnings: string[];
  };
}
