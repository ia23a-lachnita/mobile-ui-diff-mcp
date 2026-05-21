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

export interface RegionReport {
  id: string;
  box: { x: number; y: number; width: number; height: number };
  area: number;
  cropPaths: {
    expected: string;
    actual: string;
    diff: string;
  };
  analysisStatus: "analyzed" | "skipped";
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
}