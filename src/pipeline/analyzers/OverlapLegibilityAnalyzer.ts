import { IAnalyzer, AnalyzerContext } from './IAnalyzer';
import { AnalyzerResult } from '../types';
import { EvidenceGraph } from '../EvidenceGraph';

export class OverlapLegibilityAnalyzer implements IAnalyzer {
  readonly name = 'OverlapLegibilityAnalyzer';
  readonly stage = 'stage1_deterministic' as const;

  async run(_ctx: AnalyzerContext, _graph: EvidenceGraph): Promise<AnalyzerResult> {
    const start = Date.now();
    // Stub — requires OCR text boxes + arc masks from Stage 1 (not yet stable)
    return {
      analyzerName: this.name,
      stage: this.stage,
      evidence: [],
      warnings: [],
      durationMs: Date.now() - start
    };
  }
}
