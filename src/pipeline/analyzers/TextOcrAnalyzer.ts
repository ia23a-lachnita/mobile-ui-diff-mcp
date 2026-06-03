import { IAnalyzer, AnalyzerContext } from './IAnalyzer';
import { AnalyzerResult } from '../types';
import { EvidenceGraph } from '../EvidenceGraph';

export class TextOcrAnalyzer implements IAnalyzer {
  readonly name = 'TextOcrAnalyzer';
  readonly stage = 'stage1_deterministic' as const;

  async run(_ctx: AnalyzerContext, _graph: EvidenceGraph): Promise<AnalyzerResult> {
    const start = Date.now();
    // Stub — emits no evidence
    return {
      analyzerName: this.name,
      stage: this.stage,
      evidence: [],
      warnings: [],
      durationMs: Date.now() - start
    };
  }
}
