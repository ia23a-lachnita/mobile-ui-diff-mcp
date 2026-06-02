import fs from 'fs/promises';
import { IModelJudgeProvider } from '../IModelJudge';
import { Evidence, EvidenceBundle } from '../../types';

export class NvidiaProvider implements IModelJudgeProvider {
  readonly providerName = 'nvidia';

  constructor(private readonly apiKey: string, private readonly model: string) {}

  async analyze(bundle: EvidenceBundle, allEvidence: Evidence[]): Promise<Evidence[]> {
    const evidence: Evidence[] = [];

    const formatMeasurements = (m: Record<string, unknown> | undefined): string => {
      if (!m) return '';
      const parts: string[] = [];
      if (m.expectedNorm !== undefined) parts.push(`expected=${m.expectedNorm}`);
      if (m.actualNorm !== undefined) parts.push(`actual=${m.actualNorm}`);
      if (m.deltaNorm !== undefined) parts.push(`delta=${m.deltaNorm}`);
      if (m.verdict !== undefined) parts.push(`verdict=${m.verdict}`);
      return parts.length ? ` [${parts.join(', ')}]` : '';
    };

    const deterministicContext = (bundle.deterministicEvidence ?? [])
      .map((e) => `  • [${e.source}] ${e.claim} (conf:${e.confidence.toFixed(2)})${formatMeasurements(e.measurements as any)}`)
      .join('\n') || '  (none)';

    const ocrContext = (bundle.ocrEvidence ?? [])
      .map((e) => `  • ${e.claim} (conf:${e.confidence.toFixed(2)})`)
      .join('\n') || '  (none)';

    const refContext = (bundle.referenceEvidence ?? [])
      .map((e) => `  • [${(e.measurements as any)?.authorityLevel ?? 'ref'}] ${e.claim}`)
      .join('\n') || '  (none)';

    const prompt = [
      'You are an adversarial reviewer for a mobile UI diff pipeline.',
      'Challenge or confirm the deterministic evidence below. Emit counter-evidence or corroboration.',
      '',
      `ROI: ${bundle.roiId}`,
      '',
      'DETERMINISTIC GEOMETRY/PIXEL MEASUREMENTS:',
      deterministicContext,
      '',
      'OCR TEXT EVIDENCE:',
      ocrContext,
      '',
      'REFERENCE SOURCE FACTS (ground truth):',
      refContext,
      '',
      'Return a JSON object with key "evidence": array of items, each with:',
      '  claimId, subject (use "roi:<roiId>"), claim, confidence (0-1), authority="model",',
      '  optionally: proposedChangeVector, expectedValue, actualValue'
    ].join('\n');

    let images: string[] = [];
    try {
      const imagePaths = [bundle.artifacts.expectedCrop, bundle.artifacts.actualCrop].filter(Boolean) as string[];
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
      // proceed without images
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
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          messages
        })
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`NVIDIA API error ${response.status}: ${text}`);
      }

      const data = await response.json() as any;
      responseText = data?.choices?.[0]?.message?.content ?? '';
    } catch (err: any) {
      return [{
        source: 'modelJudge',
        claimId: `nvidia-error-${bundle.roiId}`,
        subject: `roi:${bundle.roiId}`,
        claim: `NVIDIA analysis failed: ${err?.message ?? String(err)}`,
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
          claimId: `nvidia-${bundle.roiId}-${item.claimId}`,
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
        claimId: `nvidia-parse-error-${bundle.roiId}`,
        subject: `roi:${bundle.roiId}`,
        claim: 'NVIDIA returned unparseable response',
        confidence: 0,
        authority: 'model' as const
      });
    }

    return evidence;
  }
}
