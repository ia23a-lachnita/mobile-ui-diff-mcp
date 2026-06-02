import fs from 'fs/promises';
import { IModelJudgeProvider } from '../IModelJudge';
import { Evidence, EvidenceBundle } from '../../types';

export class OpenRouterProvider implements IModelJudgeProvider {
  readonly providerName = 'openrouter';

  constructor(private readonly apiKey: string, private readonly model: string) {}

  async analyze(bundle: EvidenceBundle, allEvidence: Evidence[]): Promise<Evidence[]> {
    const evidence: Evidence[] = [];

    // Build context from deterministic findings
    const deterministicContext = allEvidence
      .filter((e) => bundle.deterministicFindings.includes(e.claimId))
      .map((e) => `- [${e.source}] ${e.claim} (confidence: ${e.confidence})`)
      .join('\n');

    const prompt = [
      'You are a visual quality judge for a mobile UI diff pipeline.',
      'You have been given evidence from deterministic analyzers and crop images.',
      'Your role is to emit structured evidence items (not final verdicts).',
      'Context from deterministic analyzers:',
      deterministicContext || '(none)',
      '',
      'Analyze the provided images and emit evidence about:',
      '1. Visual mismatch type and severity (visualMismatchJudge)',
      '2. Geometry interpretation if radial chart present (geometryInterpretationJudge)',
      '',
      'Return JSON array of evidence items with fields: claimId, subject, claim, confidence (0-1), authority="model"',
      `ROI: ${bundle.roiId}`
    ].join('\n');

    // Load images
    let images: string[] = [];
    try {
      const imagePaths = [bundle.artifacts.expectedCrop, bundle.artifacts.actualCrop, bundle.artifacts.structuralDiff].filter(Boolean) as string[];
      images = await Promise.all(
        imagePaths.map(async (p) => {
          try {
            const buf = await fs.readFile(p);
            return `data:image/png;base64,${buf.toString('base64')}`;
          } catch {
            return null;
          }
        })
      ).then((results) => results.filter(Boolean) as string[]);
    } catch {
      // If images unavailable, proceed with text-only
    }

    const messages: any[] = [
      {
        role: 'user',
        content: images.length > 0
          ? [
              { type: 'text', text: prompt },
              ...images.map((img) => ({ type: 'image_url', image_url: { url: img } }))
            ]
          : prompt
      }
    ];

    let responseText = '';
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenRouter API error ${response.status}: ${text}`);
      }

      const data = await response.json() as any;
      responseText = data?.choices?.[0]?.message?.content ?? '';
    } catch (err: any) {
      return [{
        source: 'modelJudge',
        claimId: `openrouter-error-${bundle.roiId}`,
        subject: `roi:${bundle.roiId}`,
        claim: `OpenRouter analysis failed: ${err?.message ?? String(err)}`,
        confidence: 0,
        authority: 'model' as const,
        measurements: { error: err?.message ?? String(err) }
      }];
    }

    try {
      const parsed = JSON.parse(responseText);
      const items: any[] = Array.isArray(parsed) ? parsed : (parsed.evidence ?? parsed.items ?? []);
      for (const item of items) {
        if (!item.claimId || !item.claim) continue;
        evidence.push({
          source: 'modelJudge',
          claimId: `openrouter-${bundle.roiId}-${item.claimId}`,
          subject: item.subject ?? `roi:${bundle.roiId}`,
          claim: String(item.claim),
          confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.5,
          authority: 'model' as const,
          measurements: item.measurements
        });
      }
    } catch {
      evidence.push({
        source: 'modelJudge',
        claimId: `openrouter-parse-error-${bundle.roiId}`,
        subject: `roi:${bundle.roiId}`,
        claim: 'OpenRouter returned unparseable response',
        confidence: 0,
        authority: 'model' as const
      });
    }

    return evidence;
  }
}
