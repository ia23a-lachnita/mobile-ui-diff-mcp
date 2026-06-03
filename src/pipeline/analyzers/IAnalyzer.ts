import { PNG } from 'pngjs';
import { RegionOfInterestConfig, IgnoreRegion } from '../../types';
import { CompareImagesInput } from '../../tools/compareImages';
import { AnalyzerStage, AnalyzerResult } from '../types';
import { EvidenceGraph } from '../EvidenceGraph';

export interface AnalyzerContext {
  runId: string;
  outputDir: string;
  configDir: string;
  roiDir: string;
  regionsDir: string;
  expectedImagePath: string;
  actualImagePath: string;
  expectedPng: PNG;
  actualPng: PNG;
  comparisonPng: PNG;
  actualSourceWidth: number;
  actualSourceHeight: number;
  regionsOfInterest: RegionOfInterestConfig[];
  ignoreRegions: IgnoreRegion[];
  config: CompareImagesInput;
}

export interface IAnalyzer {
  readonly name: string;
  readonly stage: AnalyzerStage;
  run(ctx: AnalyzerContext, graph: EvidenceGraph): Promise<AnalyzerResult>;
}
