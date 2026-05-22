export interface IgnoreRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  reason?: string;
}

export interface VlmAnalysis {
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
}

export interface DiffReport {
  status: "pass" | "fail";
  diffPixels: number;
  totalPixels: number;
  diffPercent: number;
  pixelmatchThreshold: number;
  maxDiffPercent: number;
  regions: RegionReport[];
  artifacts: {
    expected: string;
    actual: string;
    diff: string;
    regionsDir: string;
  };
  warnings?: string[];
  vlm?: VlmSummary;
}