import fs from 'fs/promises';
import { IModelJudgeProvider } from '../IModelJudge';
import { Evidence, EvidenceBundle, ProviderDiagnostics, ProviderDiagnosticsAttempt } from '../../types';
import { CriterionAuditBundle, CriterionJudgeResult } from '../../../types';
import { VALID_CHANGE_VECTORS } from '../../constants';
import { EVIDENCE_JSON_SCHEMA } from './evidenceSchema';

const CRITERION_JUDGE_SCHEMA = {
  name: 'CriterionJudgeResult',
  strict: true,
  schema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['criterionId', 'targetStatus', 'judgeAuditStatus', 'reasoning', 'confidence'],
    properties: {
      criterionId: { type: 'string' },
      targetStatus: { type: 'string', enum: ['matched', 'not_matched', 'ambiguous'] },
      measurementCredible: { type: 'boolean' },
      judgeAuditStatus: { type: 'string', enum: ['pass', 'caveat', 'fail', 'target_mismatch'] },
      reasoning: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 }
    },
    additionalProperties: false
  }
};

const CRITERION_BATCH_JUDGE_SCHEMA = {
  name: 'CriterionBatchJudgeResult',
  strict: false,
  schema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          required: ['criterionId', 'targetStatus', 'judgeAuditStatus', 'reasoning', 'confidence'],
          properties: {
            criterionId: { type: 'string' },
            targetStatus: { type: 'string', enum: ['matched', 'not_matched', 'ambiguous'] },
            measurementCredible: { type: 'boolean' },
            judgeAuditStatus: { type: 'string', enum: ['pass', 'caveat', 'fail', 'target_mismatch'] },
            reasoning: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 }
          },
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  }
};

export class NvidiaProvider implements IModelJudgeProvider {
  readonly providerName = 'nvidia';

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
      'IMAGE ORDER: The images provided are in this order:',
      '  1. EXPECTED MOCKUP (design reference / what the UI should look like)',
      '  2. ACTUAL APP SCREENSHOT (what is currently rendered in the app)',
      'Compare ACTUAL against EXPECTED. Do NOT invert expected/actual.',
      '',
      'DETERMINISTIC GEOMETRY/PIXEL MEASUREMENTS:',
      deterministicContext,
      '',
      'OCR TEXT EVIDENCE:',
      ocrContext,
      '',
      'REFERENCE SOURCE FACTS (authoritative ground truth — do not contradict these):',
      refContext,
      '',
      'CRITICAL RULES:',
      '  • Reference source facts above are authoritative. If your visual reading seems to contradict a reference fact,',
      '    output polarity:"uncertainty", NOT a blocking mismatch.',
      '  • Do NOT report dynamic text values (dates, user-specific numbers, live data) as visual defects.',
      '  • Do NOT report that a data value "is displayed" as a visual defect unless it visually differs from the mockup.',
      '  • Do NOT emit blocking:true for geometry diagnostics (arc sweep, ring metrics) — those are informational.',
      '',
      'Return a JSON object with key "evidence": array of items, each with:',
      '  claimId (string), subject (use "roi:<roiId>"),',
      '  polarity ("match"|"mismatch"|"uncertainty"|"error"),',
      '  claim (string), confidence (0-1),',
      '  severity ("info"|"low"|"medium"|"high"|"critical"),',
      '  blocking (boolean — true only for confirmed visual defect visible in the images),',
      '  optionally: proposedChangeVector',
      '',
      'polarity rules:',
      '  match = layout/geometry/value matches expected. Do NOT set blocking:true.',
      '  mismatch = confirmed visual difference visible in images. May set blocking:true if high severity and no reference fact contradicts.',
      '  uncertainty = possible issue, insufficient evidence, or reference fact conflict. blocking must be false.',
      '  error = provider/model error, not a visual claim.'
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

    return this.callWithRetry(messages, bundle.roiId);
  }

  async analyzeCriterion(packet: CriterionAuditBundle): Promise<CriterionJudgeResult> {
    const { criterionId, criterionLabel, criterionDescription, deterministicSummary, artifacts } = packet;

    const prompt = [
      'You are a visual criterion judge for a mobile UI diff pipeline.',
      '',
      `CRITERION ID: ${criterionId}`,
      `CRITERION: ${criterionLabel}`,
      ...(criterionDescription ? ['', 'TARGET CONTRACT:', criterionDescription] : []),
      '',
      'YOUR TASK (execute in order):',
      '1. Look at the ANNOTATED ACTUAL SCREEN (image 3). Locate the highlighted box (drawn with a bright magenta/pink border).',
      `2. Determine whether the highlighted box actually covers the intended element: "${criterionLabel}".`,
      '   - Use the FULL EXPECTED SCREEN (image 1) and FULL ACTUAL SCREEN (image 2) to understand overall layout.',
      '   - Use the EXPECTED CROP (image 4) and ACTUAL CROP (image 5) for detail comparison.',
      '   - Use image 3 (ANNOTATED) to confirm exactly what element the box covers.',
      '   - If the box covers a WRONG element, set targetStatus: "not_matched" and judgeAuditStatus: "target_mismatch".',
      '   - If the box location is ambiguous, set targetStatus: "ambiguous".',
      '   - If the box correctly covers the intended element, set targetStatus: "matched".',
      '3. ONLY if targetStatus is "matched": evaluate legibility.',
      '   - Set judgeAuditStatus: "pass", "caveat", or "fail" as appropriate.',
      '   - Set measurementCredible: true/false based on whether the deterministic measurement appears credible.',
      '',
      'IMAGE ORDER:',
      '  1. FULL EXPECTED SCREEN (design reference — complete screenshot, no overlays)',
      '  2. FULL ACTUAL SCREEN (current app render — complete screenshot, original pixels)',
      '  3. ANNOTATED ACTUAL SCREEN (full actual with magenta box border — USE THIS to determine where the box points)',
      '  4. EXPECTED CROP (generous-margin crop from expected — original pixels, for detail reference)',
      '  5. ACTUAL CROP (generous-margin crop from actual — original pixels, for detail reference)',
      '  6. DIAGNOSTIC ARTIFACT (overlap overlay — supporting evidence only, may be omitted)',
      '',
      'DETERMINISTIC MEASUREMENT SUMMARY:',
      deterministicSummary ?? '  (none)',
      '',
      'CRITICAL RULES:',
      '  • Do NOT evaluate unrelated UI differences.',
      '  • The annotated actual screen (image 3) is the primary source for target validation.',
      '  • If you cannot clearly see the annotated screen, set targetStatus: "ambiguous".',
      '  • The TARGET CONTRACT above (if present) lists constraints: mustNotMatch strings appearing in the targeted element confirm a wrong box.',
    ].join('\n');

    const imagePaths = [
      artifacts.fullExpectedScreen,
      artifacts.fullActualScreen,
      artifacts.annotatedActualScreen,
      artifacts.expectedCrop,
      artifacts.actualCrop,
      artifacts.diagnosticArtifact
    ].filter(Boolean) as string[];

    let images: string[] = [];
    try {
      images = await Promise.all(
        imagePaths.map(async (p) => {
          try {
            const buf = await fs.readFile(p);
            return `data:image/png;base64,${buf.toString('base64')}`;
          } catch { return null; }
        })
      ).then((results) => results.filter(Boolean) as string[]);
    } catch { /* proceed text-only */ }

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

    return this.callCriterionWithRetry(messages, criterionId);
  }

  async analyzeCriteriaBatch(packets: CriterionAuditBundle[]): Promise<CriterionJudgeResult[]> {
    if (packets.length === 0) return [];
    if (packets.length === 1) return [await this.analyzeCriterion!(packets[0])];

    // Collect unique diagnostic artifacts; if >1 unique value, map each to its prompt image index
    const uniqueDiagnostics = [...new Set(
      packets.map(p => p.artifacts.diagnosticArtifact).filter((d): d is string => !!d)
    )];
    const sharedDiagnostic = uniqueDiagnostics.length === 1 ? uniqueDiagnostics[0] : null;
    const hasPerCriterionDiagnostics = uniqueDiagnostics.length > 1;

    const criteriaList = packets.map((p, i) => {
      const diagRef = (() => {
        if (sharedDiagnostic) return '   DIAGNOSTIC ARTIFACT: image 6 (shared)';
        if (hasPerCriterionDiagnostics && p.artifacts.diagnosticArtifact) {
          const imgIdx = 6 + uniqueDiagnostics.indexOf(p.artifacts.diagnosticArtifact);
          return `   DIAGNOSTIC ARTIFACT: image ${imgIdx}`;
        }
        return null;
      })();
      return [
        `${i + 1}. CRITERION ID: ${p.criterionId}`,
        `   LABEL: ${p.criterionLabel}`,
        ...(p.criterionDescription ? [`   TARGET CONTRACT: ${p.criterionDescription}`] : []),
        ...(p.deterministicSummary ? [`   DETERMINISTIC SUMMARY: ${p.deterministicSummary}`] : []),
        ...(diagRef ? [diagRef] : [])
      ].join('\n');
    }).join('\n\n');

    const imageOrderLines = [
      '  1. FULL EXPECTED SCREEN (design reference)',
      '  2. FULL ACTUAL SCREEN (current app render)',
      '  3. ANNOTATED ACTUAL SCREEN (full actual with magenta box border — USE THIS for target validation)',
      '  4. EXPECTED CROP (generous-margin crop from expected — for detail reference)',
      '  5. ACTUAL CROP (generous-margin crop from actual — for detail reference)',
    ];
    if (sharedDiagnostic) {
      imageOrderLines.push('  6. DIAGNOSTIC ARTIFACT (overlap overlay — shared across all criteria, may be omitted)');
    } else if (hasPerCriterionDiagnostics) {
      uniqueDiagnostics.forEach((_, idx) => {
        imageOrderLines.push(`  ${6 + idx}. DIAGNOSTIC ARTIFACT ${idx + 1} (per-criterion — see mapping above)`);
      });
    }

    const prompt = [
      'You are a visual criterion judge for a mobile UI diff pipeline.',
      'You are evaluating MULTIPLE CRITERIA for the SAME TARGET ELEMENT in one call.',
      'All criteria share the same highlighted box (same physical target element on screen).',
      '',
      'CRITERIA TO EVALUATE (evaluate each independently):',
      criteriaList,
      '',
      'YOUR TASK FOR EACH CRITERION (execute in order):',
      '1. Look at the ANNOTATED ACTUAL SCREEN (image 3). Locate the highlighted box (magenta/pink border).',
      '2. Determine whether the highlighted box covers the intended element for that criterion.',
      '   - targetStatus: "matched" / "not_matched" / "ambiguous"',
      '   - judgeAuditStatus: "target_mismatch" if not_matched; else "pass"/"caveat"/"fail" for legibility.',
      '3. Evaluate each criterion INDEPENDENTLY. Do not let one result influence another.',
      '4. Do NOT report issues unrelated to the specific criterion being evaluated.',
      '5. Validate the target BEFORE assessing legibility for each criterion.',
      '',
      'IMAGE ORDER:',
      ...imageOrderLines,
      '',
      'CRITICAL RULES:',
      '  • You MUST return exactly one result object per criterion ID listed above.',
      '  • Do NOT omit any criterion ID from the results array.',
      '  • Preserve the exact criterionId strings.',
      '  • Do NOT report issues unrelated to each specific criterion.',
    ].join('\n');

    const first = packets[0];
    const imagePaths = [
      first.artifacts.fullExpectedScreen,
      first.artifacts.fullActualScreen,
      first.artifacts.annotatedActualScreen,
      first.artifacts.expectedCrop,
      first.artifacts.actualCrop,
      ...(sharedDiagnostic ? [sharedDiagnostic] : uniqueDiagnostics)
    ].filter(Boolean) as string[];

    let images: string[] = [];
    try {
      images = await Promise.all(
        imagePaths.map(async (p) => {
          try {
            const buf = await fs.readFile(p);
            return `data:image/png;base64,${buf.toString('base64')}`;
          } catch { return null; }
        })
      ).then((r) => r.filter(Boolean) as string[]);
    } catch { /* proceed text-only */ }

    const messages: any[] = [{
      role: 'user',
      content: images.length > 0
        ? [{ type: 'text', text: prompt }, ...images.map((img) => ({ type: 'image_url', image_url: { url: img } }))]
        : prompt
    }];

    return this.callBatchCriterionWithRetry(messages, packets);
  }

  private async callBatchCriterionWithRetry(messages: any[], packets: CriterionAuditBundle[], attempt = 0): Promise<CriterionJudgeResult[]> {
    const criterionIds = packets.map((p) => p.criterionId);
    const unavailableResults = (): CriterionJudgeResult[] => packets.map((p) => ({
      criterionId: p.criterionId,
      targetStatus: 'ambiguous' as const,
      judgeAuditStatus: 'unavailable' as const,
      reasoning: 'Batch criterion judge failed or timed out',
      confidence: 0
    }));

    let responseText = '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages,
            response_format: { type: 'json_schema', json_schema: CRITERION_BATCH_JUDGE_SCHEMA }
          }),
          signal: controller.signal
        });
      } finally { clearTimeout(timer); }

      const rawBody = await response.text();
      if (!response.ok) {
        throw new Error(`NVIDIA API error ${response.status}: ${rawBody}`);
      }
      let data: any;
      try {
        data = JSON.parse(rawBody);
      } catch (jsonParseErr: any) {
        throw new Error(`NVIDIA response body is not valid JSON (HTTP ${response.status}): ${jsonParseErr?.message ?? 'parse error'}; body: ${rawBody.slice(0, 150)}`);
      }
      responseText = data?.choices?.[0]?.message?.content ?? '';
    } catch (err: any) {
      return packets.map((p) => ({
        criterionId: p.criterionId,
        targetStatus: 'ambiguous' as const,
        judgeAuditStatus: 'unavailable' as const,
        reasoning: err?.name === 'AbortError'
          ? `Batch criterion judge timed out after ${this.timeoutMs}ms`
          : `Batch criterion judge failed: ${err?.message ?? String(err)}`,
        confidence: 0
      }));
    }

    const VALID_TARGET = new Set(['matched', 'not_matched', 'ambiguous']);
    const VALID_AUDIT = new Set(['pass', 'caveat', 'fail', 'target_mismatch']);
    try {
      const parsed = JSON.parse(responseText);
      const items: any[] = Array.isArray(parsed.results) ? parsed.results : [];
      const resultMap = new Map<string, CriterionJudgeResult>();
      for (const item of items) {
        if (!item.criterionId || !criterionIds.includes(item.criterionId)) continue;
        if (!VALID_TARGET.has(item.targetStatus) || !VALID_AUDIT.has(item.judgeAuditStatus)) continue;
        resultMap.set(item.criterionId, {
          criterionId: item.criterionId,
          targetStatus: item.targetStatus,
          measurementCredible: typeof item.measurementCredible === 'boolean' ? item.measurementCredible : undefined,
          judgeAuditStatus: item.judgeAuditStatus,
          reasoning: typeof item.reasoning === 'string' ? item.reasoning : '',
          confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.5
        });
      }
      return packets.map((p) => resultMap.get(p.criterionId) ?? {
        criterionId: p.criterionId,
        targetStatus: 'ambiguous' as const,
        judgeAuditStatus: 'unavailable' as const,
        reasoning: 'Batch result missing for this criterion',
        confidence: 0
      });
    } catch (parseErr: any) {
      if (this.retryOnParseError && attempt < this.maxRetries) {
        return this.callBatchCriterionWithRetry(messages, packets, attempt + 1);
      }
      return unavailableResults();
    }
  }

  private async callCriterionWithRetry(messages: any[], criterionId: string, attempt = 0): Promise<CriterionJudgeResult> {
    let responseText = '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages,
            response_format: { type: 'json_schema', json_schema: CRITERION_JUDGE_SCHEMA }
          }),
          signal: controller.signal
        });
      } finally { clearTimeout(timer); }

      const rawBody = await response.text();
      if (!response.ok) {
        throw new Error(`NVIDIA API error ${response.status}: ${rawBody}`);
      }
      let data: any;
      try {
        data = JSON.parse(rawBody);
      } catch (jsonParseErr: any) {
        throw new Error(`NVIDIA response body is not valid JSON (HTTP ${response.status}): ${jsonParseErr?.message ?? 'parse error'}; body: ${rawBody.slice(0, 150)}`);
      }
      responseText = data?.choices?.[0]?.message?.content ?? '';
    } catch (err: any) {
      return {
        criterionId, targetStatus: 'ambiguous', judgeAuditStatus: 'unavailable',
        reasoning: err?.name === 'AbortError'
          ? `Criterion judge timed out after ${this.timeoutMs}ms`
          : `Criterion judge failed: ${err?.message ?? String(err)}`,
        confidence: 0
      };
    }

    const VALID_TARGET = new Set(['matched', 'not_matched', 'ambiguous']);
    const VALID_AUDIT = new Set(['pass', 'caveat', 'fail', 'target_mismatch']);
    try {
      const parsed = JSON.parse(responseText);
      if (!VALID_TARGET.has(parsed.targetStatus)) throw new Error(`Invalid targetStatus: ${parsed.targetStatus}`);
      if (!VALID_AUDIT.has(parsed.judgeAuditStatus)) throw new Error(`Invalid judgeAuditStatus: ${parsed.judgeAuditStatus}`);
      return {
        criterionId: parsed.criterionId ?? criterionId,
        targetStatus: parsed.targetStatus,
        measurementCredible: typeof parsed.measurementCredible === 'boolean' ? parsed.measurementCredible : undefined,
        judgeAuditStatus: parsed.judgeAuditStatus,
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
        confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5
      };
    } catch (parseErr: any) {
      if (this.retryOnParseError && attempt < this.maxRetries) {
        return this.callCriterionWithRetry(messages, criterionId, attempt + 1);
      }
      return {
        criterionId, targetStatus: 'ambiguous', judgeAuditStatus: 'unavailable',
        reasoning: `Criterion judge returned unparseable response: ${parseErr?.message ?? 'parse error'}`,
        confidence: 0
      };
    }
  }

  private async callWithRetry(
    messages: any[],
    roiId: string,
    attempt = 0,
    priorRetryFailures: Array<{ attempt: number; failureReason: string; detail?: string }> = []
  ): Promise<Evidence[]> {
    let responseText = '';
    let httpStatus: number | undefined;
    let httpStatusText: string | undefined;
    let responseBodyPreview: string | undefined;

    const baseDiagnostics = (finalAttempt: ProviderDiagnosticsAttempt): ProviderDiagnostics => ({
      provider: 'nvidia',
      model: this.model,
      roiId,
      attemptCount: attempt + 1,
      finalAttempt,
      ...(priorRetryFailures.length > 0 ? { retryFailures: priorRetryFailures } : {})
    });

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
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

      httpStatus = response.status;
      httpStatusText = response.statusText;
      const rawBody = await response.text();
      responseBodyPreview = rawBody.slice(0, 500);

      if (!response.ok) {
        throw new Error(`NVIDIA API error ${response.status}: ${rawBody}`);
      }
      let data: any;
      try {
        data = JSON.parse(rawBody);
      } catch (jsonParseErr: any) {
        throw new Error(`NVIDIA response body is not valid JSON (HTTP ${response.status}): ${jsonParseErr?.message ?? 'parse error'}; body: ${rawBody.slice(0, 150)}`);
      }
      responseText = data?.choices?.[0]?.message?.content ?? '';
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError';
      const message = err?.message ?? String(err);
      const isHttpError = /^NVIDIA API error \d+/.test(message);
      const failureReason = isTimeout ? 'timeout' : isHttpError ? 'provider_http_error' : 'provider_request_failed';
      return [{
        source: 'modelJudge',
        claimId: `nvidia-error-${failureReason}-${roiId}`,
        subject: `roi:${roiId}`,
        claim: isTimeout
          ? `NVIDIA analysis timed out after ${this.timeoutMs}ms`
          : `NVIDIA analysis failed: ${message}`,
        confidence: 0,
        authority: 'model' as const,
        polarity: 'error' as any,
        measurements: {
          error: message,
          failureReason,
          rawResponsePreview: (responseBodyPreview ?? message).slice(0, 200)
        },
        providerDiagnostics: baseDiagnostics({
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          ...(httpStatusText !== undefined ? { httpStatusText } : {}),
          ...(responseBodyPreview ? { responseBodyPreview } : {}),
          errorName: err?.name ?? 'Error',
          errorMessage: message,
          ...(isTimeout ? { timeoutMs: this.timeoutMs } : {})
        })
      } as Evidence];
    }

    const VALID_POLARITY = new Set(['match', 'mismatch', 'uncertainty', 'error']);
    const rawPreview = responseText.length > 0 ? responseText.slice(0, 200) : '<empty_response>';
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
          claimId: `nvidia-${roiId}-${item.claimId}`,
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
      const schemaErrorPreview = parseErr?.message ?? 'parse error';
      if (this.retryOnParseError && attempt < this.maxRetries) {
        const retryFailure = { attempt: attempt + 1, failureReason: 'schema_parse_error', detail: schemaErrorPreview.slice(0, 100) };
        return this.callWithRetry(messages, roiId, attempt + 1, [...priorRetryFailures, retryFailure]);
      }
      const exhausted = this.retryOnParseError && this.maxRetries > 0 && attempt >= this.maxRetries;
      const parseFailureReason = exhausted ? 'retry_exhausted' : 'schema_parse_error';
      return [{
        source: 'modelJudge',
        claimId: `nvidia-parse-error-${parseFailureReason}-${roiId}`,
        subject: `roi:${roiId}`,
        claim: `NVIDIA returned unparseable response after ${attempt + 1} attempt(s): ${schemaErrorPreview}`,
        confidence: 0,
        authority: 'model' as const,
        polarity: 'error' as any,
        measurements: {
          error: parseFailureReason,
          failureReason: parseFailureReason,
          rawResponsePreview: rawPreview
        },
        providerDiagnostics: baseDiagnostics({
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          ...(httpStatusText !== undefined ? { httpStatusText } : {}),
          contentPreview: responseText.slice(0, 200),
          schemaError: schemaErrorPreview,
          ...(priorRetryFailures.length > 0 ? {} : {})
        })
      } as Evidence];
    }
  }
}
