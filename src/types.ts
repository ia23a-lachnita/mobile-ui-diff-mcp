export interface IgnoreRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  reason?: string;
  type?: 'system' | 'data' | 'dynamic';
  coordinateSpace?: 'expected' | 'actual' | 'normalized';
}

export interface PreCaptureStep {
  type: 'adbShell';
  command: string;
  description: string;
}

export interface PreCaptureResult {
  description: string;
  ok: boolean;
  command: string;
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
  qualityStatus: 'pass' | 'fail';
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
  type: 'critical_roi_failed' | 'critical_visual_assertion_failed';
  roiId?: string;
  assertionId?: string;
  label?: string;
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
  qualityStatus?: "pass" | "fail";
  qualityFailures?: QualityFailure[];
  priorityFindings?: PriorityFinding[];
  visualAssertions?: VisualAssertionResult[];
  atFloor?: boolean | null;
  floorBlockedBy?: FloorBlocker[];
  floorReason?: string;
  maskedRegions?: IgnoreRegion[];
  agentSummary?: AgentSummary;
  suggestedMaxDiffPercent?: number | null;
  maxDiffPercentSuggestionBlockedBy?: string[];
  warnings?: string[];
  vlm?: VlmSummary;
}