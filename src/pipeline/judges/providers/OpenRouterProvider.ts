import fs from 'fs/promises';
import { IModelJudgeProvider } from '../IModelJudge';
import { Evidence, EvidenceBundle } from '../../types';
import { VALID_CHANGE_VECTORS } from '../../constants';

const EVIDENCE_JSON_SCHEMA = {
  name: 'evidence_response',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            claimId: { type: 'string' },
            subject: { type: 'string' },
            polarity: { type: 'string', enum: ['match', 'mismatch', 'uncertainty', 'error'] },
            claim: { type: 'string' },
            confidence: { type: 'number' },
            severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
            blocking: { type: 'boolean' },
            source: { type: 'string' },
            proposedChangeVector: { type: 'string' },
            expectedValue: {},
            actualValue: {}
          },
          required: ['claimId', 'subject', 'polarity', 'claim', 'confidence', 'severity', 'blocking'],
          additionalProperties: false
        }
      }
    },
    required: ['evidence'],
    additionalProperties: false
  }
};

export class OpenRouterProvider implements IModelJudgeProvider {
  readonly providerName = 'openrouter';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs: number = 45000,
    private readonly maxRetries: number = 1,
    private readonly retryOnParseError: boolean = true
  ) {}

  async analyze(bundle: EvidenceBundle, allEvidence: Evidence[]): Promise<Evidence[]> {
    const formatMeasurements = (m: Record<string, unknown> | undefined): string => {
      if (!m) return '';
      const parts: string[] = [];
      if (m.expectedNorm !== undefined) parts.push(`expected=${m.expectedNorm}`);
      if (m.actualNorm !== undefined) parts.push(`actual=${m.actualNorm}`);
      if (m.deltaNorm !== undefined) parts.push(`delta=${m.deltaNorm}`);
      if (m.verdict !== undefined) parts.push(`verdict=${m.verdict}`);
      if (m.status !== undefined) parts.push(`status=${m.status}`);
      return parts.length ? ` [${parts.join(', ')}]` : '';
    };

    const deterministicContext = (bundle.deterministicEvidence ?? [])
      .map((e) => `  • [${e.source}] ${e.claim} (conf:${e.confidence.toFixed(2)})${formatMeasurements(e.measurements as any)}`)
      .join('\n') || '  (none)';

    const ocrContext = (bundle.ocrEvidence ?? [])
      .map((e) => `  • ${e.claim} (conf:${e.confidence.toFixed(2)})`)
      .join('\n') || '  (none)';

    const refContext = (bundle.referenceEvidence ?? [])
      .map((e) => {
        const snippet = (e.measurements as any)?.snippet;
        const base = `  • [${(e.measurements as any)?.authorityLevel ?? 'ref'}] ${e.claim}`;
        return snippet ? `${base}\n    snippet: ${snippet.slice(0, 300)}` : base;
      })
      .join('\n') || '  (none)';

    const prompt = [
      'You are a visual quality judge for a mobile UI diff pipeline.',
      'You have been given structured evidence from deterministic analyzers, OCR, reference facts, and crop images.',
      'Your role is to emit structured evidence items (not final verdicts).',
      '',
      `ROI: ${bundle.roiId}`,
      '',
      'DETERMINISTIC GEOMETRY/PIXEL MEASUREMENTS:',
      deterministicContext,
      '',
      'OCR TEXT EVIDENCE:',
      ocrContext,
      '',
      'REFERENCE SOURCE FACTS:',
      refContext,
      '',
      'Analyze the provided images and emit evidence about:',
      '1. Visual mismatch type and severity (source: visualMismatchJudge)',
      '2. Geometry interpretation if radial chart is visible (source: geometryInterpretationJudge)',
      '3. Whether the diff is consistent with the reference facts above',
      '',
      'Return a JSON object with key "evidence": array of items, each with:',
      '  claimId (string), subject (string, use "roi:<roiId>"),',
      '  polarity ("match"|"mismatch"|"uncertainty"|"error"),',
      '  claim (string), confidence (0-1),',
      '  severity ("info"|"low"|"medium"|"high"|"critical"),',
      '  blocking (boolean — true only for confirmed mismatch that should fail the audit),',
      '  optionally: proposedChangeVector (e.g. "ring_stroke_width"), expectedValue, actualValue',
      '',
      'polarity rules:',
      '  match = layout/geometry/value matches expected. Do NOT set blocking:true.',
      '  mismatch = confirmed visual difference. May set blocking:true if high severity.',
      '  uncertainty = possible issue, insufficient evidence. blocking must be false.',
      '  error = provider/model error, not a visual claim.'
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

    return this.callWithRetry(messages, bundle.roiId);
  }

  private async callWithRetry(messages: any[], roiId: string, attempt = 0): Promise<Evidence[]> {
    let responseText = '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            response_format: { type: 'json_schema', json_schema: EVIDENCE_JSON_SCHEMA }
          }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenRouter API error ${response.status}: ${text}`);
      }

      const data = await response.json() as any;
      responseText = data?.choices?.[0]?.message?.content ?? '';
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError';
      return [{
        source: 'modelJudge',
        claimId: `openrouter-error-${roiId}`,
        subject: `roi:${roiId}`,
        claim: isTimeout
          ? `OpenRouter analysis timed out after ${this.timeoutMs}ms`
          : `OpenRouter analysis failed: ${err?.message ?? String(err)}`,
        confidence: 0,
        authority: 'model' as const,
        measurements: { error: err?.message ?? String(err) }
      }];
    }

    const VALID_POLARITY = new Set(['match', 'mismatch', 'uncertainty', 'error']);
    try {
      const parsed = JSON.parse(responseText);
      const items: any[] = Array.isArray(parsed) ? parsed : (parsed.evidence ?? parsed.items ?? []);
      if (!Array.isArray(items)) throw new Error('evidence is not an array');
      const evidence: Evidence[] = [];
      for (const item of items) {
        if (!item.claimId || !item.claim) continue;
        if (!item.polarity || !VALID_POLARITY.has(String(item.polarity))) {
          throw new Error(`item '${item.claimId}' has missing or invalid polarity: ${JSON.stringify(item.polarity)}`);
        }
        // polarity:'error' items are provider errors, not visual evidence
        if (item.polarity === 'error') continue;
        evidence.push({
          source: typeof item.source === 'string' && item.source ? item.source : 'modelJudge',
          claimId: `openrouter-${roiId}-${item.claimId}`,
          subject: item.subject ?? `roi:${roiId}`,
          claim: String(item.claim),
          confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.5,
          authority: 'model' as const,
          ...(item.polarity !== undefined ? { polarity: String(item.polarity) } as any : {}),
          ...(item.blocking !== undefined ? { blocking: Boolean(item.blocking) } as any : {}),
          ...(item.claimType !== undefined ? { claimType: String(item.claimType) } : {}),
          ...(item.expectedValue !== undefined ? { expectedValue: item.expectedValue as number | string } : {}),
          ...(item.actualValue !== undefined ? { actualValue: item.actualValue as number | string } : {}),
          ...(item.proposedChangeVector !== undefined && VALID_CHANGE_VECTORS.has(String(item.proposedChangeVector)) ? { proposedChangeVector: String(item.proposedChangeVector) } : {}),
          ...(item.unit !== undefined ? { unit: String(item.unit) } : {}),
          measurements: item.measurements
        });
      }
      return evidence;
    } catch (parseErr: any) {
      if (this.retryOnParseError && attempt < this.maxRetries) {
        return this.callWithRetry(messages, roiId, attempt + 1);
      }
      return [{
        source: 'modelJudge',
        claimId: `openrouter-parse-error-${roiId}`,
        subject: `roi:${roiId}`,
        claim: `OpenRouter returned unparseable response after ${attempt + 1} attempt(s): ${parseErr?.message ?? 'parse error'}`,
        confidence: 0,
        authority: 'model' as const,
        measurements: { error: 'parse_error_after_retry' }
      }];
    }
  }
}
