import fs from 'fs/promises';
import path from 'path';
import { IAnalyzer, AnalyzerContext } from './IAnalyzer';
import { AnalyzerResult, Evidence } from '../types';
import { EvidenceGraph } from '../EvidenceGraph';
import { ReferenceContextConfig } from '../ConflictResolver';

export interface ReferenceContextSummary {
  factsLoaded: number;
  sourcesLoaded: number;
  missingFiles: string[];
  warnings: string[];
}

export class ReferenceContextAnalyzer implements IAnalyzer {
  readonly name = 'ReferenceContextAnalyzer';
  readonly stage = 'stage1_deterministic' as const;

  constructor(private readonly referenceContext?: ReferenceContextConfig) {}

  async run(ctx: AnalyzerContext, graph: EvidenceGraph): Promise<AnalyzerResult & { referenceContextSummary?: ReferenceContextSummary }> {
    const start = Date.now();
    const evidence: Evidence[] = [];
    const warnings: string[] = [];
    const missingFiles: string[] = [];

    if (!this.referenceContext?.enabled) {
      return {
        analyzerName: this.name,
        stage: this.stage,
        evidence: [],
        warnings: [],
        durationMs: Date.now() - start,
        referenceContextSummary: { factsLoaded: 0, sourcesLoaded: 0, missingFiles: [], warnings: [] }
      };
    }

    // Load inline facts into EvidenceGraph as high-authority source evidence
    const facts = this.referenceContext.facts ?? [];
    for (const fact of facts) {
      const authorityLevel = fact.authority ?? 'high';
      const confidence = authorityLevel === 'high' ? 1.0 : authorityLevel === 'medium' ? 0.7 : 0.4;
      const e: Evidence = {
        source: 'referenceContext',
        claimId: `ref-fact-${fact.id}`,
        subject: fact.subject,
        claim: fact.claim,
        confidence,
        authority: 'source',
        measurements: {
          factId: fact.id,
          authorityLevel,
          ...(fact.blocksChangeVectors ? { blocksChangeVectors: fact.blocksChangeVectors.join(',') } : {}),
          ...(fact.blocksClaimsMatching ? { blocksClaimsMatching: fact.blocksClaimsMatching.join('|||') } : {})
        },
        ...(fact.claimType !== undefined ? { claimType: fact.claimType } : {}),
        ...(fact.expectedValue !== undefined ? { expectedValue: fact.expectedValue } : {}),
        ...(fact.actualValue !== undefined ? { actualValue: fact.actualValue } : {}),
        ...(fact.unit !== undefined ? { unit: fact.unit } : {}),
        ...(fact.proposedChangeVector !== undefined ? { proposedChangeVector: fact.proposedChangeVector } : {})
      };
      evidence.push(e);
      graph.add(e);
    }

    // Load source files — read snippet + metadata, emit as source evidence
    let sourcesLoaded = 0;
    const sources = this.referenceContext.sources ?? [];
    for (const source of sources) {
      const resolvedPath = path.isAbsolute(source.path)
        ? source.path
        : path.resolve(ctx.configDir, source.path);

      let snippet = '';
      let fileExists = false;
      try {
        const content = await fs.readFile(resolvedPath, 'utf-8');
        fileExists = true;
        // Take up to 2000 chars as a snippet
        snippet = content.length > 2000 ? content.slice(0, 2000) + '\n[...truncated]' : content;
        sourcesLoaded++;
      } catch {
        missingFiles.push(source.path);
        warnings.push(`ReferenceContextAnalyzer: source file '${source.path}' not found (id: ${source.id})`);
      }

      const authorityLevel = source.authority ?? 'medium';
      const confidence = authorityLevel === 'high' ? 1.0 : authorityLevel === 'medium' ? 0.7 : 0.4;

      const e: Evidence = {
        source: 'referenceContext',
        claimId: `ref-source-${source.id}`,
        subject: 'global',
        claim: fileExists
          ? `Reference source '${source.id}' (${source.type}): ${source.description ?? source.path}`
          : `Reference source '${source.id}' (${source.type}): file not found at '${source.path}'`,
        confidence: fileExists ? confidence : 0,
        authority: 'source',
        measurements: {
          sourceId: source.id,
          sourceType: source.type,
          sourcePath: source.path,
          authorityLevel,
          fileExists,
          ...(snippet ? { snippet } : {})
        }
      };
      evidence.push(e);
      graph.add(e);
    }

    const summary: ReferenceContextSummary = {
      factsLoaded: facts.length,
      sourcesLoaded,
      missingFiles,
      warnings
    };

    return {
      analyzerName: this.name,
      stage: this.stage,
      evidence,
      warnings,
      durationMs: Date.now() - start,
      referenceContextSummary: summary
    };
  }
}
