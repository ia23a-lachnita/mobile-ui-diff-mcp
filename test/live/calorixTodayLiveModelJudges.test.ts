/**
 * Live model judge integration test — Calorix Today screen.
 *
 * OPT-IN ONLY. Not included in `npm test`. No mocking of any kind.
 * Calls real OpenRouter and NVIDIA providers through the real MCP core.
 * Does not start the MCP server or use the JSON-RPC transport.
 *
 * Required env vars:
 *   RUN_LIVE_MODEL_TESTS=1
 *   OPENROUTER_API_KEY=<key>
 *   NVIDIA_API_KEY=<key>
 *
 * Optional env vars:
 *   CALORIX_DIR=<absolute path>  (default: sibling ../calorix of this project)
 *
 * Run:
 *   RUN_LIVE_MODEL_TESTS=1 OPENROUTER_API_KEY=... NVIDIA_API_KEY=... npm run test:live:calorix
 *
 * What this validates:
 *   1. Pipeline reaches model judges (no early-exit on anchor/config/screenshot errors)
 *   2. today.kcalLeftPill resolves via flutter_anchor — not manual fallback
 *   3. Deterministic kcal-left pill criterion runs (legibility.overlap domain)
 *   4. Real provider error rows carry non-empty, non-sentinel failureReason/rawResponsePreview
 *   5. Required primary failure blocks acceptance; reviewer success cannot override it
 *   6. Successful primary run is logged for diagnosis
 *
 * A live summary JSON is written to:
 *   .ui-diff-live/calorix-today/<timestamp>/live-summary.json
 */

import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { runScreenUiDiff } from '../../src/tools/runScreenUiDiff';

// ── Opt-in gate ──────────────────────────────────────────────────────────────

const LIVE_ENABLED = process.env.RUN_LIVE_MODEL_TESTS === '1';

// ── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_DIR = path.resolve(__dirname, '../..');
const CALORIX_DIR = process.env.CALORIX_DIR
  ? path.resolve(process.env.CALORIX_DIR)
  : path.resolve(__dirname, '../../../calorix');

function calorixPath(...parts: string[]): string {
  return path.join(CALORIX_DIR, ...parts);
}

const REQUIRED_ARTIFACTS: Array<{ relPath: string; fix: string }> = [
  {
    relPath: 'ui-diff.config.json',
    fix: 'Committed asset — run `git status` in the calorix repo.'
  },
  {
    relPath: 'docs/mockups/image/dark/single/Today.png',
    fix: 'Committed asset — run `git status` in the calorix repo.'
  },
  {
    relPath: 'docs/ui-diff/target-maps/today-anchor-target-map.json',
    fix: 'Committed asset — run `git status` in the calorix repo.'
  },
  {
    relPath: '.ui-diff/today/current/actual.png',
    fix: 'Run the Calorix ui-diff capture workflow to produce a fresh actual.png screenshot.'
  },
  {
    relPath: '.ui-diff/today/current/flutter-anchors.json',
    fix: 'Launch Calorix on a device/emulator and run the Flutter anchor export, then copy to .ui-diff/today/current/.'
  },
  {
    relPath: '.ui-diff/today/current/flutter-anchors.done',
    fix: 'The flutter-anchors.done sentinel is missing. Re-run the Flutter anchor export workflow.'
  }
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function getBranchSha(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: PROJECT_DIR, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE_ENABLED)('calorixTodayLiveModelJudges', () => {
  beforeAll(async () => {
    const missingKeys: string[] = [];
    if (!process.env.OPENROUTER_API_KEY) missingKeys.push('OPENROUTER_API_KEY');
    if (!process.env.NVIDIA_API_KEY) missingKeys.push('NVIDIA_API_KEY');
    if (missingKeys.length > 0) {
      throw new Error(
        `Missing API keys: ${missingKeys.join(', ')}\n` +
        `Re-run with: ${missingKeys.map((k) => `${k}=<key>`).join(' ')} RUN_LIVE_MODEL_TESTS=1 npm run test:live:calorix`
      );
    }

    try {
      await fs.access(CALORIX_DIR);
    } catch {
      throw new Error(
        `Calorix repo not found at: ${CALORIX_DIR}\n` +
        `Clone it as a sibling of this project, or set CALORIX_DIR=<absolute-path>`
      );
    }

    const missing: Array<{ fullPath: string; fix: string }> = [];
    for (const { relPath, fix } of REQUIRED_ARTIFACTS) {
      try {
        await fs.access(calorixPath(relPath));
      } catch {
        missing.push({ fullPath: calorixPath(relPath), fix });
      }
    }
    if (missing.length > 0) {
      const detail = missing
        .map((m) => `  MISSING: ${m.fullPath}\n  FIX:     ${m.fix}`)
        .join('\n\n');
      throw new Error(`Required Calorix artifacts missing:\n\n${detail}`);
    }
  });

  it('real providers produce a structurally valid, diagnosable report', { timeout: 300_000 }, async () => {
    const startMs = Date.now();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const liveOutputDir = path.join(PROJECT_DIR, '.ui-diff-live', 'calorix-today', timestamp);
    await fs.mkdir(liveOutputDir, { recursive: true });

    console.log('\n=== CALORIX TODAY LIVE MODEL JUDGE TEST ===');
    console.log(`CALORIX_DIR:  ${CALORIX_DIR}`);
    console.log(`Output dir:   ${liveOutputDir}`);
    console.log(`Primary:      openrouter / qwen/qwen3-vl-235b-a22b-instruct`);
    console.log(`Reviewer:     nvidia / nvidia/nemotron-nano-12b-v2-vl`);

    // ── Run the real pipeline core — no MCP protocol, no mocking ────────────
    const report = await runScreenUiDiff({
      screen: 'today',
      configPath: calorixPath('ui-diff.config.json'),
      actualImage: calorixPath('.ui-diff/today/current/actual.png'),
      expectedImage: calorixPath('docs/mockups/image/dark/single/Today.png'),
      platform: 'none',
      preCapture: [],
      includeVlmAnalysis: false,
      vlmPolicy: 'disabled',
      requireVlmAnalysis: false,
      outputDir: liveOutputDir,
      flutterAnchorsPath: calorixPath('.ui-diff/today/current'),
      targetMapPath: calorixPath('docs/ui-diff/target-maps/today-anchor-target-map.json'),
      runName: `live-${timestamp}`,
      modelJudges: {
        enabled: true,
        required: true,
        policy: 'always_audit',
        primary: { provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' },
        reviewer: { provider: 'nvidia', model: 'nvidia/nemotron-nano-12b-v2-vl' },
        requireConsensusForCodeHints: true,
        allowEditSuggestionsOnPass: false,
        timeoutMs: 45000,
        maxRetries: 1,
        retryOnParseError: true
      },
      visualAuditMode: 'visual_parity'
    });

    const elapsedMs = Date.now() - startMs;

    // ── Write live summary ───────────────────────────────────────────────────
    const summary = {
      timestamp,
      branchSha: getBranchSha(),
      calorixDir: CALORIX_DIR,
      artifacts: {
        config: calorixPath('ui-diff.config.json'),
        actualImage: calorixPath('.ui-diff/today/current/actual.png'),
        expectedImage: calorixPath('docs/mockups/image/dark/single/Today.png'),
        flutterAnchors: calorixPath('.ui-diff/today/current/flutter-anchors.json'),
        targetMap: calorixPath('docs/ui-diff/target-maps/today-anchor-target-map.json')
      },
      providers: {
        primary: 'openrouter/qwen/qwen3-vl-235b-a22b-instruct',
        reviewer: 'nvidia/nemotron-nano-12b-v2-vl'
      },
      visualAuditStatus: report.visualAuditStatus,
      acceptanceStatus: report.acceptanceStatus,
      actionRequired: report.actionRequired,
      targetResolutionSummary: report.targetResolutionSummary,
      failedRois: report.modelJudgesSummary?.failedRois,
      modelJudgesSummary: report.modelJudgesSummary,
      overlapLegibilitySummary: report.overlapLegibilitySummary,
      criterionAuditBundles: (report as any).criterionAuditBundles,
      judgeProviderErrors: (report as any).judgeProviderErrors,
      elapsedMs
    };

    const summaryPath = path.join(liveOutputDir, 'live-summary.json');
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');

    console.log(`\nvisualAuditStatus:  ${report.visualAuditStatus}`);
    console.log(`acceptanceStatus:   ${report.acceptanceStatus}`);
    console.log(`actionRequired:     ${JSON.stringify(report.actionRequired)}`);
    console.log(`elapsedMs:          ${elapsedMs}`);
    console.log(`Live summary:       ${summaryPath}`);

    // ── Assertion 1: Pipeline reached model judges ───────────────────────────
    // If any of these are undefined, the pipeline exited before running judges
    // (invalid config, missing screenshot, missing anchor dump, etc.)
    expect(
      report.modelJudgesSummary,
      'modelJudgesSummary must be present — pipeline must have reached model judges'
    ).toBeDefined();

    expect(
      report.modelJudgesSummary!.required,
      'modelJudges.required must be true as configured'
    ).toBe(true);

    const primary = report.modelJudgesSummary!.primary;
    expect(primary, 'primary provider summary must be present in modelJudgesSummary').toBeDefined();

    // ── Assertion 2: Flutter anchor path works ───────────────────────────────
    expect(
      report.targetResolutionSummary?.resolvedViaFlutterAnchor,
      'today.kcalLeftPill must resolve via flutter_anchor (not manual fallback)'
    ).toBeGreaterThanOrEqual(1);

    expect(
      report.targetResolutionSummary?.resolvedViaManualFallback,
      'resolvedViaManualFallback must be 0 — no target should fall back to manual ROI box'
    ).toBe(0);

    expect(
      report.measurementBoxSource,
      'measurementBoxSource must be flutter_anchor'
    ).toBe('flutter_anchor');

    // ── Assertion 3: Deterministic pill criterion ran ────────────────────────
    const legibilityRegion = report.overlapLegibilitySummary?.regions.find(
      (r) => r.id === 'today.kcalLeftPill.legibility'
    );

    expect(
      legibilityRegion,
      'today.kcalLeftPill.legibility must appear in overlapLegibilitySummary — criterion must have run'
    ).toBeDefined();

    expect(
      legibilityRegion!.targetStatus,
      'pill criterion targetStatus must be matched (flutter anchor resolved successfully)'
    ).toBe('matched');

    // coloredPixelCountInBox is the live report field for pill-region pixel count
    expect(
      (legibilityRegion as any).coloredPixelCountInBox,
      'coloredPixelCountInBox must be > 0 — pill box is non-trivial in real screenshot'
    ).toBeGreaterThan(0);

    // overlapPercent and nearestAvoidColorDistancePx confirm the clearance/overlap
    // domain ran (not a text-only criterion)
    expect(
      typeof (legibilityRegion as any).overlapPercent,
      'overlapPercent must be present — confirms legibility.overlap domain ran'
    ).toBe('number');

    expect(
      typeof (legibilityRegion as any).nearestAvoidColorDistancePx,
      'nearestAvoidColorDistancePx must be present — confirms avoid-color clearance check ran'
    ).toBe('number');

    // ── Assertion 4: Provider errors must carry concrete, non-sentinel diagnostics ──
    const VALID_CONCRETE_FAILURE_REASONS = new Set([
      'provider_http_error',
      'timeout',
      'network_error',
      'empty_response_body',
      'provider_response_missing_content',
      'empty_response',
      'invalid_json',
      'schema_parse_error',
      'retry_exhausted',
      'provider_returned_empty_evidence',
      'all_evidence_items_dropped_by_validation',
      'provider_error',
      'provider_exception'
    ]);

    const failedRois = report.modelJudgesSummary?.failedRois ?? [];

    for (const error of failedRois) {
      const loc = `failedRoi[${error.roiId}/${error.provider}]`;

      // ── failureReason: must be present and concrete ──────────────────────
      expect(error.failureReason, `${loc}: failureReason must be non-empty`).toBeTruthy();

      expect(
        error.failureReason,
        `${loc}: failureReason must not be the 'provider_adapter_returned_empty_array' diagnostic-loss sentinel`
      ).not.toBe('provider_adapter_returned_empty_array');

      expect(
        error.failureReason,
        `${loc}: failureReason must not be 'internal_adapter_diagnostic_loss' — indicates an adapter bug, not a real provider error`
      ).not.toBe('internal_adapter_diagnostic_loss');

      expect(
        error.failureReason,
        `${loc}: failureReason must not be 'unknown_empty_failure'`
      ).not.toBe('unknown_empty_failure');

      expect(
        VALID_CONCRETE_FAILURE_REASONS.has(error.failureReason ?? ''),
        `${loc}: failureReason '${error.failureReason}' is not a recognised concrete failure category`
      ).toBe(true);

      // ── rawResponsePreview: must be real content, never a sentinel ───────
      expect(error.rawResponsePreview, `${loc}: rawResponsePreview must be present`).toBeTruthy();
      expect(error.rawResponsePreview, `${loc}: rawResponsePreview must not be ''`).not.toBe('');
      expect(error.rawResponsePreview, `${loc}: must not contain <missing_error_detail>`).not.toBe('<missing_error_detail>');
      expect(error.rawResponsePreview, `${loc}: must not contain <provider_adapter_returned_empty_array>`).not.toBe('<provider_adapter_returned_empty_array>');
      expect(error.rawResponsePreview, `${loc}: must not contain <internal_adapter_diagnostic_loss>`).toSatisfy(
        (v: string | undefined) => !v?.startsWith('<internal_adapter_diagnostic_loss')
      );

      // ── diagnosticIntegrity: must not flag adapter_defect ────────────────
      expect(
        (error as any).diagnosticIntegrity,
        `${loc}: diagnosticIntegrity must not be 'adapter_defect'`
      ).not.toBe('adapter_defect');

      // ── providerDiagnostics: must be present and contain identity + error detail ──
      const diag = (error as any).providerDiagnostics;
      expect(diag, `${loc}: providerDiagnostics must be present`).toBeDefined();

      if (diag) {
        expect(diag.provider, `${loc}: providerDiagnostics.provider must match row`).toBe(error.provider);
        expect(diag.roiId, `${loc}: providerDiagnostics.roiId must be present`).toBeTruthy();
        expect(typeof diag.attemptCount, `${loc}: providerDiagnostics.attemptCount must be a number`).toBe('number');
        expect(diag.finalAttempt, `${loc}: providerDiagnostics.finalAttempt must be present`).toBeDefined();

        // Must carry at least one of: HTTP status, error name/message, or content preview
        const fa = diag.finalAttempt ?? {};
        const hasHttpContext = fa.httpStatus !== undefined || fa.httpStatusText !== undefined;
        const hasErrorContext = fa.errorName !== undefined || fa.errorMessage !== undefined;
        const hasContentContext = fa.contentPreview !== undefined || fa.responseBodyPreview !== undefined || fa.envelopePreview !== undefined;
        expect(
          hasHttpContext || hasErrorContext || hasContentContext,
          `${loc}: providerDiagnostics.finalAttempt must contain at least one of httpStatus/httpStatusText, errorName/errorMessage, or contentPreview/responseBodyPreview/envelopePreview`
        ).toBe(true);

        if (diag.model !== undefined) {
          expect(typeof diag.model, `${loc}: providerDiagnostics.model must be a string`).toBe('string');
        }

        // Log for diagnosis
        console.log(`\n  ${loc} providerDiagnostics:`);
        console.log(`    failureReason: ${error.failureReason}`);
        console.log(`    attemptCount:  ${diag.attemptCount}`);
        if (fa.httpStatus !== undefined) console.log(`    httpStatus:    ${fa.httpStatus} ${fa.httpStatusText ?? ''}`);
        if (fa.errorMessage) console.log(`    errorMessage:  ${String(fa.errorMessage).slice(0, 120)}`);
        if (fa.responseBodyPreview) console.log(`    bodyPreview:   ${String(fa.responseBodyPreview).slice(0, 120)}`);
        if (fa.validationDropReasons?.length) console.log(`    dropReasons:   ${fa.validationDropReasons.slice(0, 2).join('; ')}`);
        if (diag.retryFailures?.length) console.log(`    retryFailures: ${diag.retryFailures.length}`);
      }
    }

    // ── Assertion 5: Required primary failure must block acceptance ──────────
    const primaryFailed = (primary?.errorCount ?? 0) > 0;

    if (primaryFailed) {
      console.log(`\nPrimary had ${primary!.errorCount} error(s). Verifying blocking behavior.`);
      const openrouterFailed = failedRois.filter((r) => r.provider === 'openrouter');
      for (const r of openrouterFailed) {
        console.log(`  ${r.roiId}: reason=${r.failureReason} | preview=${String(r.rawResponsePreview).slice(0, 100)}`);
      }

      expect(
        report.acceptanceStatus,
        'required primary failure must block acceptance (acceptanceStatus must not be accepted)'
      ).not.toBe('accepted');

      expect(
        report.visualAuditStatus,
        'required primary failure must not yield visualAuditStatus=pass'
      ).not.toBe('pass');

      expect(
        report.actionRequired?.type,
        'actionRequired.type must be model_judges_failed when required primary fails'
      ).toBe('model_judges_failed');

      // Reviewer success must not override a required primary failure
      const reviewer = report.modelJudgesSummary?.reviewer;
      if (reviewer?.attempted) {
        expect(
          report.visualAuditStatus,
          'reviewer success must not flip visualAuditStatus to pass when primary is required and failed'
        ).not.toBe('pass');

        expect(
          report.acceptanceStatus,
          'reviewer success must not flip acceptanceStatus to accepted when primary is required and failed'
        ).not.toBe('accepted');
      }
    }

    // ── Assertion 6: Log primary result ─────────────────────────────────────
    const primarySucceeded = !primaryFailed && (primary?.evidenceCount ?? 0) > 0;
    if (primarySucceeded) {
      console.log('\n=== PRIMARY PROVIDER SUCCEEDED ===');
      console.log(`status:            ${primary!.status}`);
      console.log(`evidenceCount:     ${primary!.evidenceCount}`);
      console.log(`provider:          ${primary!.provider}`);
      console.log(`model:             ${primary!.model}`);
      console.log(`visualAuditStatus: ${report.visualAuditStatus}`);
      console.log(`acceptanceStatus:  ${report.acceptanceStatus}`);
    }

    // ── Assertion 7: Required primary judge must produce usable evidence ──────
    // This assertion is the acceptance gate. The test must fail unless the real
    // OpenRouter primary judge returns structured evidence for each required ROI.
    // Diagnostics improvements alone must not make this pass.
    expect(
      primary!.provider,
      'primary provider must be openrouter'
    ).toBe('openrouter');

    expect(
      primary!.model,
      'primary model must be qwen/qwen3-vl-235b-a22b-instruct'
    ).toBe('qwen/qwen3-vl-235b-a22b-instruct');

    expect(
      primary!.attempted,
      'primary provider must have been attempted'
    ).toBe(true);

    expect(
      primary!.status,
      'primary OpenRouter judge must succeed — provider_returned_empty_evidence is not acceptable'
    ).toBe('success');

    expect(
      primary!.hadSuccess,
      'primary.hadSuccess must be true'
    ).toBe(true);

    expect(
      primary!.evidenceCount,
      'primary evidenceCount must be > 0 — model must emit at least one evidence item per ROI'
    ).toBeGreaterThan(0);

    expect(
      primary!.errorCount,
      'primary errorCount must be 0 — no ROI may remain with provider_returned_empty_evidence or any other failure'
    ).toBe(0);

    // ── Assertion 8: Each required Calorix audit item must have evidence ──────
    const REQUIRED_ROIS = ['macro-ring-hero', 'macro-rows', 'meal-cards', 'global'] as const;
    const openrouterFailedRoiIds = new Set(
      failedRois.filter((r) => r.provider === 'openrouter').map((r) => r.roiId)
    );

    for (const requiredRoi of REQUIRED_ROIS) {
      expect(
        openrouterFailedRoiIds.has(requiredRoi),
        `required ROI '${requiredRoi}' must not appear in OpenRouter failedRois — it must have usable structured evidence`
      ).toBe(false);
    }

    // ── Assertion 9: Positive check — each required ROI must appear in successfulRoiIds ──
    // Guards against a future false green where a required ROI is silently skipped
    // (not failed, not succeeded — just never processed) rather than explicitly failed.
    const successfulRoiIds = new Set(primary!.successfulRoiIds ?? []);
    for (const requiredRoi of REQUIRED_ROIS) {
      expect(
        successfulRoiIds.has(requiredRoi),
        `required ROI '${requiredRoi}' must appear in primary.successfulRoiIds — at least one non-error evidence item with subject "roi:${requiredRoi}" must exist`
      ).toBe(true);
    }
  });
});
