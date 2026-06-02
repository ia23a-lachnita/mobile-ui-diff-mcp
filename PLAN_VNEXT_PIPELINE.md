# vNext Evidence Pipeline — Implementation Plan

## Current State Summary

The codebase has a flat pipeline: `runScreenUiDiff → runMobileUiDiff → compareImages`.
`compareImages` runs all analysis inline — pixel diff, ROI quality, radial geometry, and VLM analysis — with no staging or ordering guarantees. VLM can run before deterministic evidence exists.

### Existing source map
```
src/
  types.ts                        — all shared types
  config/uiDiffConfig.ts          — zod schema + config loader
  image/
    diff.ts                       — pixel diff
    load.ts                       — image loading/resize
    mask.ts                       — ignore region masking
    crops.ts                      — ROI cropping
    regions.ts                    — hotspot region detection
    radialChartDiagnostics.ts     — radial chart geometry analyzer
  tools/
    compareImages.ts              — flat pipeline (to be refactored into staged pipeline)
    runMobileUiDiff.ts            — capture + delegate to compareImages
    runScreenUiDiff.ts            — config-aware orchestration, device detection
    preCapture.ts                 — pre-capture steps
    androidDevice.ts              — device info/profiles
    captureAndroid.ts             — ADB screenshot
    captureIosSimulator.ts        — iOS screenshot
    discoverStableRegions.ts      — stable region detection
  vlm/ollama.ts                   — current VLM/ollama client (to be adapted into ModelJudgeAnalyzer)
  mcp/server.ts                   — MCP server registration
  index.ts                        — entry point
```

---

## Target Architecture

```
runScreenUiDiff (config + device layer — unchanged interface)
  ↓
RunOrchestrator (new)
  ↓
ArtifactBuilder (new — formerly part of compareImages setup)
  ↓
Stage 1: Deterministic Analyzers (parallel, new interface wrapping existing code)
  InvalidCaptureAnalyzer
  PixelDiffAnalyzer
  RoiQualityAnalyzer
  DynamicMaskAnalyzer
  RadialGeometryAnalyzer
  ColorSamplerAnalyzer       (stub — can emit no evidence)
  TextOcrAnalyzer            (stub — can emit no evidence)
  OverlapLegibilityAnalyzer  (stub — can emit no evidence)
  ↓
EvidenceGraph (typed evidence store)
  ↓
Stage 1.5: EvidenceBundleBuilder (per-ROI bundles)
  ↓
Stage 2: ModelJudgeAnalyzer (policy-controlled, OpenRouter first)
  ↓
ConflictResolver (authority rules)
  ↓
VerdictEngine → AgentActionContract (strict enums)
  ↓
DiffReport (backward-compatible output)
```

---

## New Directory Layout

```
src/
  pipeline/
    types.ts              — Evidence, EvidenceGraph, AnalyzerStage, EvidenceBundle, AnalyzerResult
    RunOrchestrator.ts    — top-level staged executor
    ArtifactBuilder.ts    — image loading, normalization, crop dir setup
    EvidenceGraph.ts      — typed evidence store
    EvidenceBundleBuilder.ts — per-ROI bundle builder (Stage 1.5)
    ConflictResolver.ts   — authority rules
    VerdictEngine.ts      — qualityStatus + AgentActionContract
    analyzers/
      IAnalyzer.ts        — Analyzer interface
      InvalidCaptureAnalyzer.ts
      PixelDiffAnalyzer.ts
      RoiQualityAnalyzer.ts
      DynamicMaskAnalyzer.ts
      RadialGeometryAnalyzer.ts
      ColorSamplerAnalyzer.ts   (stub)
      TextOcrAnalyzer.ts        (stub)
      OverlapLegibilityAnalyzer.ts (stub)
    judges/
      IModelJudge.ts
      ModelJudgeAnalyzer.ts     — orchestrates primary + reviewer model
      providers/
        OpenRouterProvider.ts
        NvidiaProvider.ts
  config/
    uiDiffConfig.ts       — extend with referenceContext + modelJudges schemas
  types.ts                — extend with AgentActionContract, ChangeVector, ReasonCode
```

---

## Step 1 — Architecture Skeleton (no behavior change)

### 1a. New types in `src/types.ts`

Add:

```typescript
export type ChangeVector =
  | 'seed_data' | 'fixture_plan'
  | 'ring_stroke_width' | 'ring_radius_size' | 'ring_gap'
  | 'ring_start_angle' | 'ring_sweep_mapping' | 'ring_center_alignment'
  | 'ring_glow_track'
  | 'component_layout' | 'card_spacing_padding'
  | 'text_style' | 'color_token'
  | 'thumbnail_gradient' | 'badge_style' | 'bottom_nav_padding'
  | 'expected_baseline' | 'roi_threshold' | 'device_profile'
  | 'dynamic_mask' | 'none';

export type ReasonCode =
  | 'SOURCE_AND_GEOMETRY_AGREE'
  | 'SOURCE_CONTRADICTION'
  | 'SCALE_ONLY_MISMATCH'
  | 'REFERENCE_CONFLICT'
  | 'INSUFFICIENT_CONFIDENCE'
  | 'MODEL_DISAGREEMENT'
  | 'NON_DETERMINISTIC_CAPTURE'
  | 'INVALID_CAPTURE'
  | 'QUALITY_GATE_PASS'
  | 'MASK_TOO_BROAD'
  | 'NO_SUPPORTING_EVIDENCE'
  | 'OUT_OF_SCOPE';

export interface AllowedChangeVector {
  vector: ChangeVector;
  scope?: string;
  reasonCode: ReasonCode;
  maxChanges?: number;
}

export interface BlockedChangeVector {
  vector: ChangeVector;
  reasonCode: ReasonCode;
}

export interface AgentActionContract {
  canEditApp: boolean;
  confidence: 'high' | 'medium' | 'low' | 'none';
  allowedChangeVectors: AllowedChangeVector[];
  blockedChangeVectors: BlockedChangeVector[];
  requiresUserDecision: boolean;
  reasonSummary?: string;
}
```

Extend `DiffReport` with `agentActionContract?: AgentActionContract`.

### 1b. Pipeline types in `src/pipeline/types.ts`

```typescript
export type AnalyzerStage = 'stage1_deterministic' | 'stage1_5_bundle' | 'stage2_model' | 'stage3_conflict' | 'stage4_verdict';

export interface Evidence {
  source: string;          // e.g. 'radialGeometry', 'pixelDiff', 'modelJudge'
  claimId: string;
  subject: string;         // e.g. 'roi:macro-ring-hero', 'global'
  claim: string;
  confidence: number;      // 0–1
  authority: 'deterministic' | 'source' | 'model' | 'user';
  measurements?: Record<string, number | string | boolean>;
  blocked?: boolean;       // set by ConflictResolver
  blockReason?: ReasonCode;
}

export interface EvidenceBundle {
  roiId: string;
  artifacts: {
    expectedCrop?: string;
    actualCrop?: string;
    structuralDiff?: string;
    geometryOverlay?: string;
  };
  deterministicFindings: string[];  // claimIds from stage 1
  ocrFindings: string[];
  referenceFacts: string[];
}

export interface AnalyzerResult {
  analyzerName: string;
  stage: AnalyzerStage;
  evidence: Evidence[];
  warnings: string[];
  durationMs: number;
}
```

### 1c. `IAnalyzer` interface in `src/pipeline/analyzers/IAnalyzer.ts`

```typescript
export interface AnalyzerContext {
  runId: string;
  outputDir: string;
  expectedImagePath: string;
  actualImagePath: string;
  expectedPng: PNG;
  actualPng: PNG;
  comparisonPng: PNG;       // actual resized to match expected
  regionsOfInterest: RegionOfInterestConfig[];
  ignoreRegions: IgnoreRegion[];
  config: CompareImagesInput;
}

export interface IAnalyzer {
  readonly name: string;
  readonly stage: AnalyzerStage;
  run(ctx: AnalyzerContext, graph: EvidenceGraph): Promise<AnalyzerResult>;
}
```

### 1d. `EvidenceGraph` in `src/pipeline/EvidenceGraph.ts`

```typescript
export class EvidenceGraph {
  private items: Evidence[] = [];
  add(evidence: Evidence): void;
  getBySource(source: string): Evidence[];
  getBySubject(subject: string): Evidence[];
  getAll(): Evidence[];
  block(claimId: string, reason: ReasonCode): void;
}
```

### 1e. Wrap existing analyzers

Move logic from `compareImages.ts` into analyzer classes:

| Existing code | New analyzer class |
|---|---|
| Pixel diff + region detection | `PixelDiffAnalyzer` |
| ROI quality evaluation | `RoiQualityAnalyzer` |
| Dynamic mask analysis | `DynamicMaskAnalyzer` |
| `runRadialChartDiagnostics` | `RadialGeometryAnalyzer` |
| Invalid capture detection | `InvalidCaptureAnalyzer` |
| Ollama VLM analysis | `ModelJudgeAnalyzer` (Stage 2) |
| — | `ColorSamplerAnalyzer` (stub) |
| — | `TextOcrAnalyzer` (stub) |
| — | `OverlapLegibilityAnalyzer` (stub) |

Each analyzer wraps its existing logic and emits typed `Evidence` items.

### 1f. `RunOrchestrator` in `src/pipeline/RunOrchestrator.ts`

Replaces `compareImages.ts` as the top-level pipeline:

```typescript
export async function runPipeline(input: CompareImagesInput): Promise<DiffReport> {
  const artifacts = await new ArtifactBuilder().build(input);
  const graph = new EvidenceGraph();

  // Stage 1 — run deterministic analyzers in parallel
  const stage1Analyzers: IAnalyzer[] = [
    new InvalidCaptureAnalyzer(),
    new PixelDiffAnalyzer(),
    new RoiQualityAnalyzer(),
    new DynamicMaskAnalyzer(),
    new RadialGeometryAnalyzer(),
    new ColorSamplerAnalyzer(),
    new TextOcrAnalyzer(),
    new OverlapLegibilityAnalyzer(),
  ];
  await Promise.all(stage1Analyzers.map(a => a.run(ctx, graph)));

  // Stage 1.5 — build evidence bundles
  const bundles = await new EvidenceBundleBuilder().build(ctx, graph);

  // Stage 2 — model judges (policy-controlled)
  if (modelJudgesEnabled(input)) {
    const judge = new ModelJudgeAnalyzer(input.modelJudges);
    await judge.run(ctx, graph, bundles);
  }

  // Stage 3 — conflict resolver
  await new ConflictResolver(input.referenceContext).resolve(graph);

  // Stage 4 — verdict
  return new VerdictEngine().build(ctx, graph, input);
}
```

`compareImages.ts` becomes a thin shim calling `runPipeline` so existing callers are unaffected.

---

## Step 2 — Staged Execution Enforcement

Key rule: `ModelJudgeAnalyzer.run()` accepts `EvidenceBundle[]` as a required parameter — it cannot be called without them. This is enforced by the type system.

```typescript
// ModelJudgeAnalyzer signature
async run(
  ctx: AnalyzerContext,
  graph: EvidenceGraph,
  bundles: EvidenceBundle[]  // REQUIRED — proves stage 1.5 completed
): Promise<AnalyzerResult>
```

---

## Step 3 — `referenceContext` Config

### Config schema additions to `uiDiffConfig.ts`

```typescript
export const referenceSourceSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['source', 'html', 'tokens', 'fixture', 'notes', 'screenshot']),
  path: z.string().min(1),
  authority: z.enum(['high', 'medium', 'low']).default('high'),
  description: z.string().optional()
});

export const referenceFactSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  claim: z.string().min(1),
  authority: z.enum(['high', 'medium', 'low']).default('high')
});

export const referenceContextSchema = z.object({
  enabled: z.boolean().default(false),
  sources: z.array(referenceSourceSchema).optional(),
  facts: z.array(referenceFactSchema).optional()
}).optional();
```

Add to `uiDiffScreenSchema` and `uiDiffConfigSchema`.

### `referenceContext` loading

- Missing source files → emit warning, continue (never throw)
- Facts are loaded as high-authority `Evidence` with `authority: 'source'`
- Source file content is attached to the evidence bundle as text

---

## Step 4 — `ConflictResolver` Authority Rules

Authority order (highest → lowest):
1. `referenceContext` explicit facts (`authority: 'source'`)
2. Deterministic measurements (`authority: 'deterministic'`)
3. Screenshot-observed evidence
4. Model-judge findings (`authority: 'model'`)
5. Raw pixel diff score

### Hard rules

```
if referenceContext matches mockup normalized visual ratio AND actual differs only in absolute pixels:
  → classify SCALE_ONLY_MISMATCH
  → block all app code change vectors

if referenceContext and mockup disagree:
  → classify REFERENCE_CONFLICT
  → block all app code change vectors
  → set requiresUserDecision: true

if referenceContext and mockup agree AND actual normalized geometry differs:
  → classify RELATIVE_GEOMETRY_MISMATCH
  → allow only specific matching change vector (e.g. ring_stroke_width)

if model finding is contradicted by referenceContext fact:
  → block model finding (evidence.blocked = true, blockReason = 'SOURCE_CONTRADICTION')

if model finding is contradicted by deterministic measurement:
  → downgrade model finding confidence, add warning
```

---

## Step 5 — `modelJudges` Config

### Config schema additions

```typescript
export const modelJudgesProviderSchema = z.object({
  provider: z.enum(['openrouter', 'nvidia']),
  model: z.string().min(1)
});

export const modelJudgesPolicySchema = z.enum([
  'disabled',
  'on_failed_quality',
  'on_failed_quality_or_uncertain_root_cause',
  'always'
]);

export const modelJudgesSchema = z.object({
  enabled: z.boolean().default(false),
  policy: modelJudgesPolicySchema.optional(),
  primary: modelJudgesProviderSchema.optional(),
  reviewer: modelJudgesProviderSchema.optional(),
  requireConsensusForCodeHints: z.boolean().optional()
}).optional();
```

### `OpenRouterProvider`

```typescript
export class OpenRouterProvider implements IModelJudgeProvider {
  constructor(private apiKey: string, private model: string) {}
  async analyze(bundle: EvidenceBundle): Promise<Evidence[]>;
}
```

- API key from env `OPENROUTER_API_KEY` or config (not hardcoded)
- No API key + `enabled: false` → skip silently
- No API key + `enabled: true`, policy not required → warning
- No API key + `enabled: true`, policy required → `actionRequired` in output

### Model judge scoped roles

Judges must not issue final verdicts. They emit `Evidence` items:
- `visualMismatchJudge` — visual difference analysis
- `geometryInterpretationJudge` — geometry interpretation
- `sourceAwareReviewer` — cross-references reference facts
- `adversarialReviewer` — challenges other evidence

---

## Step 6 — `OverlapLegibilityAnalyzer`

Requires: OCR text boxes + arc masks from Stage 1.

```typescript
// Evidence output example
{
  source: 'overlapLegibility',
  claimId: 'kcal-left-pill-overlap-risk',
  subject: 'roi:macro-ring-hero',
  claim: 'Text box overlaps high-saturation arc pixels',
  confidence: 0.7,
  authority: 'deterministic',
  measurements: {
    textBoxOverlapWithArcMaskPercent: 7.8,
    contrastRatio: 3.1
  }
}
```

Implement after OCR/text-box and arc-mask APIs are stable in Stage 1.

---

## Step 7 — `VerdictEngine` + `AgentActionContract`

```typescript
export class VerdictEngine {
  build(ctx: AnalyzerContext, graph: EvidenceGraph, input: CompareImagesInput): DiffReport {
    // derives qualityStatus, agentSummary, agentActionContract
    // maps evidence to allowed/blocked change vectors with reason codes
  }
}
```

Output always includes `agentActionContract` with strict enum values.
Free-form `agentSummary` is still produced for human readability.

---

## Config Schema — Full Picture

### Default package config

```json
{
  "modelJudges": { "enabled": false },
  "referenceContext": { "enabled": false }
}
```

### Calorix example config

```json
{
  "referenceContext": {
    "enabled": true,
    "sources": [
      {
        "id": "today-jsx",
        "type": "source",
        "path": "docs/mockups/source/Today.jsx",
        "authority": "high",
        "description": "Today mockup JSX source"
      }
    ],
    "facts": [
      {
        "id": "today-ring-stroke",
        "subject": "macro-ring",
        "claim": "BigMacroRing stroke is 10",
        "authority": "high"
      }
    ]
  },
  "modelJudges": {
    "enabled": true,
    "policy": "on_failed_quality_or_uncertain_root_cause",
    "primary": {
      "provider": "openrouter",
      "model": "qwen/qwen3-vl-32b-instruct"
    },
    "reviewer": {
      "provider": "nvidia",
      "model": "nvidia/nemotron-nano-12b-v2-vl:free"
    },
    "requireConsensusForCodeHints": true
  }
}
```

---

## Backward Compatibility

- `compareImages.ts` public interface is preserved (shim calling `runPipeline`)
- `runMobileUiDiff.ts` unchanged
- `runScreenUiDiff.ts` unchanged (passes through new config fields when present)
- `DiffReport` is extended (additive only, no removed fields)
- Existing tests must continue to pass

---

## Required Tests

### Stage ordering

```typescript
test('model judge cannot run before stage 1 evidence exists', async () => {
  // ModelJudgeAnalyzer.run requires EvidenceBundle[] parameter
  // Calling it with empty bundles before deterministic analyzers throws or skips
});
```

### referenceContext

```typescript
test('referenceContext loads facts as high-authority evidence', async () => { ... });
test('missing referenceContext source file emits warning, does not throw', async () => { ... });
```

### Conflict resolver

```typescript
test('model finding contradicted by source fact is blocked', async () => { ... });
test('scale-only mismatch blocks all app code change vectors', async () => { ... });
test('reference conflict sets requiresUserDecision', async () => { ... });
```

### AgentActionContract

```typescript
test('agentActionContract uses ChangeVector and ReasonCode enums', async () => { ... });
test('blocked vectors never appear in allowedChangeVectors', async () => { ... });
```

### ModelJudges

```typescript
test('disabled model judges do not require API key', async () => { ... });
test('required model judges produce actionRequired when no API key', async () => { ... });
```

### Regression

```typescript
test('compare/run_screen behavior produces backward-compatible DiffReport', async () => { ... });
```

---

## API Keys (from api-keys.txt)

- NVIDIA: env `NVIDIA_API_KEY`
- OpenRouter: env `OPENROUTER_API_KEY`

Never hardcode keys. Providers read from environment at runtime.

---

## Build & Verification

```bash
npm run build   # tsc must succeed with 0 errors
npm test        # all existing + new tests pass
```

---

## Implementation Order

1. Add `AgentActionContract`, `ChangeVector`, `ReasonCode` types to `src/types.ts`
2. Create `src/pipeline/types.ts` — Evidence, EvidenceBundle, AnalyzerStage, AnalyzerResult
3. Create `src/pipeline/EvidenceGraph.ts`
4. Create `src/pipeline/analyzers/IAnalyzer.ts`
5. Create `src/pipeline/ArtifactBuilder.ts` — extract image setup from `compareImages.ts`
6. Create analyzer wrappers: InvalidCapture, PixelDiff, RoiQuality, DynamicMask, RadialGeometry, stubs for Color/OCR/Overlap
7. Create `src/pipeline/EvidenceBundleBuilder.ts`
8. Create `src/pipeline/judges/` — IModelJudge, OpenRouterProvider, NvidiaProvider, ModelJudgeAnalyzer
9. Create `src/pipeline/ConflictResolver.ts`
10. Create `src/pipeline/VerdictEngine.ts`
11. Create `src/pipeline/RunOrchestrator.ts`
12. Refactor `compareImages.ts` to shim → `runPipeline`
13. Extend config schema with `referenceContext` + `modelJudges`
14. Write all required tests
15. `npm run build && npm test`
16. Commit, push, Gemini review

---

## Docs to Write

- `docs/architecture.md` — pipeline overview with staged diagram
- `docs/referenceContext.md` — what it is, how to configure, what's optional
- `docs/modelJudges.md` — policies, providers, API key setup
- `docs/evidencePriority.md` — authority order and conflict rules
- `docs/agentActionContract.md` — enum reference, machine-readable contract
- `docs/examples/calorix-config.json` — full Calorix-style example
