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

export interface RegionOfInterestConfig {
  id: string;
  label: string;
  type: 'component' | 'zone';
  critical?: boolean;
  weight?: number;
  coordinateSpace?: 'normalized' | 'expected' | 'actual';
  box: BoxLike;
  maxDiffPercent?: number;
}

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

export type VlmUnavailableReason = 'resource_limited' | 'unreachable' | 'model_missing' | 'timeout' | 'unknown';

export interface VlmAvailability {
  requested: boolean;
  usable: boolean;
  selectedModel: string | null;
  reason?: VlmUnavailableReason;
  message?: string;
}

export interface ActionRequired {
  type: 'vlm_unavailable';
  severity: 'blocking';
  message: string;
  recommendedUserPrompt: string;
  suggestedFixes: string[];
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
  type: 'critical_roi_failed' | 'critical_visual_assertion_failed' | 'global_diff_failed';
  roiId?: string;
  assertionId?: string;
  label?: string;
  diffPercent?: number;
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
  diffDensity: number;
  maxDiffPercent: number;
  intersectingRegionIds: string[];
  diagnostics: string[];
  weightedScore: number;
  artifacts: {
    expected: string;
    actual: string;
    diff: string;
  };
}

export interface FloorBlocker {
  type: 'critical_roi_failed' | 'critical_visual_assertion_failed' | 'quality_not_evaluated';
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

export interface DiffReport {
  status: "pass" | "fail";
  diffPixels: number;
  totalPixels: number;
  diffPercent: number;
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
  suggestedMaxDiffPercent?: number | null;
  maxDiffPercentSuggestionBlockedBy?: string[];
  vlmPolicy?: VlmPolicy;
  vlmAvailability?: VlmAvailability;
  actionRequired?: ActionRequired | null;
  warnings?: string[];
  vlm?: VlmSummary;
}
