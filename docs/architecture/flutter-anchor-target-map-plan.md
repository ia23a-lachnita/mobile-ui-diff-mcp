# Flutter Anchor Target Map — Architecture Plan

## Context and Motivation

### Problems being solved

**run-054 false pass** — the criterion audit used hand-tuned ROI crop boxes expressed as phone-specific `x/y/w/h` pixel coordinates. On a different device, or after a layout shift, those boxes silently pointed at the wrong element and judges passed because the evidence was coherent within itself but unrelated to the intended target.

**run-057 invalid_target behavior** — invalid target detection fired after judge calls, giving the wrong error code and leaving results in an ambiguous state. The fix was correct but exposed the underlying problem: manual ROI boxes cannot reliably identify semantic targets across devices.

**Decision to move away from hand-tuned ROI boxes** — phone-specific `x/y/w/h` coordinates in config create a permanent maintenance problem. Every layout change, every new device, every resolution change requires config edits. The config should express *what* to validate, not *where on this specific phone*.

---

## New Architecture

### Core principle

Target config stores **semantic target IDs and criteria**, not fixed pixel coordinates.

```
OLD: { box: { x: 124, y: 440, width: 160, height: 48 } }   ← phone-specific, fragile
NEW: { locator: { type: "flutter_anchor", anchorId: "today.kcalLeftPill" } }  ← semantic, portable
```

### Flutter Anchors as primary locator

Flutter anchors are exported at test/integration-test time from the running app. They contain:
- The widget's logical coordinate rect (Flutter's coordinate space)
- Device pixel ratio
- MediaQuery metadata (padding, viewPadding, viewInsets, screen size)
- Visibility fraction and offscreen status

The MCP converts logical rects to integer screenshot pixels at validation time using the current device's DPR and screenshot dimensions.

---

## Artifact Protocol

### File sequence (Flutter side)

```
.ui-diff/today/current/flutter-anchors.tmp.json  ← write full JSON here first
                                                  ← fsync/flush
→ rename to flutter-anchors.json                 ← atomic rename
→ write flutter-anchors.done                     ← completion signal
.ui-diff/today/current/actual.png                ← screenshot
```

### MCP wait behavior

The MCP must NOT read `flutter-anchors.json` immediately. It must wait until:

1. `flutter-anchors.done` exists **OR** file is stable across two polls
2. `flutter-anchors.json` exists
3. File size > 0
4. File size is stable across two polls (if no `.done` flag)
5. JSON parses successfully
6. Schema validates successfully

**Failure modes:**

| Condition | Error code |
|-----------|-----------|
| Timeout before done/stable | `anchor_artifact_timeout` |
| Stable file but invalid JSON | `invalid_anchor_dump` |
| Stable file but schema fails | `invalid_anchor_dump` |

Never crash with a raw JSON parse exception.

---

## Strict Flutter Anchor Dump DTO

### Required fields (MCP rejects dump if any missing)

```typescript
{
  framework: "flutter",           // must be exactly "flutter"
  screen: string,                 // screen/route name
  coordinateSpace: "flutterLogical",
  coordinateOrigin: string,       // e.g. "topLeft"
  device: {
    screenshotWidthPx: number,
    screenshotHeightPx: number,
    devicePixelRatio: number,
    mediaQuerySizeLogical: { width: number, height: number },
    paddingLogical: { top: number, left: number, right: number, bottom: number },
    viewPaddingLogical: { top: number, left: number, right: number, bottom: number },
    viewInsetsLogical: { top: number, left: number, right: number, bottom: number }
  },
  anchors: Array<{
    id: string,
    label?: string,
    rectLogical: { x: number, y: number, width: number, height: number },
    visible: boolean,
    visibility: { visibleFraction: number, isOffscreen: boolean }
  }>
}
```

### What the MCP must NOT accept

- Recursive widget tree objects (`children`, `element`, `renderObject`)
- Framework objects (`BuildContext`, `RenderBox`, `MediaQueryData` serialized as full objects)
- Missing `devicePixelRatio`
- Missing `paddingLogical`, `viewPaddingLogical`, `viewInsetsLogical`
- Missing `coordinateOrigin`
- Missing `visible` on any anchor
- Extra fields at root that look like framework dumps (strict mode)

---

## Coordinate Conversion

### Rule: floor-left / ceil-right → clamp to screenshot bounds

```typescript
function logicalToPhysicalPx(rect: RectLogical, dpr: number, screenshotW: number, screenshotH: number): RectPx {
  const x     = Math.floor(rect.x * dpr);
  const y     = Math.floor(rect.y * dpr);
  const right = Math.ceil((rect.x + rect.width) * dpr);
  const bot   = Math.ceil((rect.y + rect.height) * dpr);

  const cx    = clamp(x,     0, screenshotW - 1);
  const cy    = clamp(y,     0, screenshotH - 1);
  const cr    = clamp(right, cx + 1, screenshotW);
  const cb    = clamp(bot,   cy + 1, screenshotH);

  return { x: cx, y: cy, width: Math.max(1, cr - cx), height: Math.max(1, cb - cy) };
}
```

**Why floor-left / ceil-right** — for image crop boxes, plain `round()` can shrink the box and clip edge pixels. Floor-left / ceil-right preserves full coverage.

**No image library receives floats.** All values passed to `sharp` / `pngjs` crop operations must be integers.

### Mapping metadata recorded in report

```typescript
{
  measurementBoxSource: "flutter_anchor",
  devicePixelRatio: number,
  coordinateOrigin: string,
  paddingPresent: boolean,
  viewPaddingPresent: boolean,
  viewInsetsPresent: boolean,
  insetsApplied: boolean,
  rectLogical: { x, y, width, height },
  rectActualPx: { x, y, width, height }
}
```

---

## Semantic Target Map

### Schema (per target)

```json
{
  "id": "today.kcalLeftPill",
  "locator": {
    "type": "flutter_anchor",
    "anchorId": "today.kcalLeftPill",
    "required": true
  },
  "expectedText": "980 kcal left",
  "criteria": [
    {
      "id": "today.kcalLeftPill.text",
      "domain": "text.content"
    },
    {
      "id": "today.kcalLeftPill.legibility",
      "domain": "legibility.overlap",
      "avoidColors": ["#1FCC74"],
      "minClearancePx": 4,
      "maxOverlapPercent": 1.0,
      "severity": "warning"
    }
  ]
}
```

### Target resolution priority

1. **Current Flutter anchor rect** (preferred, device-specific, current-run)
2. **Generated target map resolved locator** (if valid anchor not present)
3. **Visual locator** (future / explicit mode only — out of scope for v1)
4. **Manual fallback** (only if explicitly enabled, always noisy in report)

---

## Visibility / Offscreen Handling

If `anchor.visible === false` OR `anchor.visibility.visibleFraction < threshold`:
- Do NOT run deterministic visual measurement
- Report `measurementStatus: "not_evaluated"`
- Report `targetNotVisible: true`
- `agentActionContract.canEditApp: false` unless another independent valid action exists

---

## Manual Fallback

Manual boxes may only be used as emergency fallback when explicitly configured.

When manual fallback is active, the report MUST include:
- `measurementBoxSource: "manual_fallback"`
- A visible warning that visual parity requires human review
- This warning must NOT be suppressed in compact output

---

## Judge Batching and Cache

### Cache key includes ALL of

- `provider` + `model`
- `promptVersion`
- `targetId`
- `criterionIds` (sorted)
- `actualImageHash` (full screenshot hash)
- `actualCropHash` (target crop hash)
- `anchorRectHash`
- `expectedImageHash`
- `sourceFactsHash`
- `deterministicMeasurementHash`
- `targetMapVersion`

### Cache behavior

| Condition | Action |
|-----------|--------|
| Unchanged crop + rect + prompt + source + model | Skip VLM call, inherit previous result |
| Report entry | `judgeAuditStatus: "cached"`, `inheritedFromRun: <run id>` |

### Cache invalidation triggers

- Target pixels change
- Anchor rect changes
- Criteria change
- Source facts change
- Prompt or schema version changes
- Provider or model changes

---

## Discovery / Config Generation Workflow

When invoked with discovery mode:

1. Load expected mockup image
2. Load actual screenshot (if supplied)
3. Load mockup source (if supplied)
4. Load Flutter anchor dump (if supplied)
5. Validate anchor dump
6. **Generate / propose** semantic target map
7. Generate annotated review artifacts (anchor overlay on actual)
8. Generate missing-anchor summary (anchors in dump not in target map, targets in map with no anchor)
9. Generate source-facts proposal (if source parsing available)

**LLM role in discovery**: May propose target IDs and criteria. Must NOT author authoritative rectangle coordinates. Rectangle coordinates come from anchor dump only.

---

## Updated Validation Pipeline

`runScreenUiDiff` / `runMobileUiDiff` accepts new optional inputs:

```typescript
{
  targetMapPath?: string;      // path to semantic target map JSON
  flutterAnchorsPath?: string; // path to anchor dump JSON (or .done sentinel dir)
}
```

Pipeline additions:

1. **Stage 0.5** — Wait for anchor artifact (if `flutterAnchorsPath` set)
2. **Stage 1** — Resolve target IDs to current Flutter anchor rects
3. **Stage 1 deterministic** — Run overlap/legibility on resolved rects (not manual boxes)
4. **Stage 1.5** — Build criterion judge packets from resolved targets
5. **Stage 2** — Judge calls (batched, cache-checked first)
6. **Stage 3** — Reconcile
7. **Stage 4** — Verdict

New report fields:
- `targetResolutionSummary` — per-target: source, resolved rect, visible, status
- `criterionResults` — per-criterion: deterministic + judge results
- `cacheSummary` — attempted vs cached vs skipped calls
- `measurementBoxSource` — `flutter_anchor` | `manual_fallback` | `none`

---

## Hard Rules

1. No phone-specific target rectangles in config.
2. Flutter anchors are the primary locator for Flutter.
3. Anchor dump must include DPR, MediaQuery.padding, MediaQuery.viewPadding, MediaQuery.viewInsets, screenshot dimensions, coordinateOrigin, and visibility.
4. Anchor JSON must be a stripped DTO only. Do not serialize Flutter framework objects.
5. MCP must wait for a done/stable/parseable anchor artifact before reading it.
6. MCP must convert logical rects to integer screenshot pixels using floor-left/ceil-right, then clamp.
7. MCP must reject missing/invalid coordinate metadata.
8. MCP must detect offscreen/scrolled-out anchors and skip measurement.
9. Judge calls must be batched and cached by image/rect/prompt/source/model hashes.
10. Start implementation with coordinate/artifact/device tests before wiring judges.

---

## Implementation Order

### Phase 1 — Schema, parser, coordinate math, artifact reader (tests first)

1. `src/flutter/types.ts` — Flutter anchor dump types and semantic target map types
2. `src/flutter/anchorDumpSchema.ts` — Zod schema, strict validation
3. `src/flutter/anchorDumpParser.ts` — Parse + validate + convert to physical px
4. `src/flutter/anchorArtifactReader.ts` — Robust wait/poll with done-flag and stability

Tests: schema validation, coordinate math, DPR trap, artifact race condition, device A/B proof, visibility

### Phase 2 — Semantic target map and target resolver

5. `src/flutter/semanticTargetMap.ts` — Target map types + Zod schema
6. `src/flutter/targetResolver.ts` — Resolve target ID → anchor rect

Tests: device A/B, visibility skip, missing anchor → `not_evaluated`

### Phase 3 — Judge batching and cache

7. `src/flutter/judgeCache.ts` — Cache key computation, in-memory cache

Tests: batching, cache hit/miss, invalidation triggers

### Phase 4 — Discovery workflow

8. `src/flutter/discoveryWorkflow.ts` — Target map generation from anchor dump + mockup

Tests: Calorix Today fixture, missing anchor suggestion, LLM mock (criteria, not rects)

### Phase 5 — Pipeline integration

9. Update `runScreenUiDiff` to consume `targetMapPath` + `flutterAnchorsPath`
10. Wire `OverlapLegibilityAnalyzer` to use resolved Flutter anchor rects
11. Wire criterion judge packets to resolved targets
12. Update report schema with new fields

Tests: integration test — runScreenUiDiff with anchor dump, `measurementBoxSource: flutter_anchor`

---

## Test Architecture

All tests:
- No live API calls (no real OpenRouter/NVIDIA)
- No real Android device required
- No reference to deleted `Today_1080.png`
- Fixtures use in-memory PNG buffers or small generated images
- Device A/B fixtures are JSON only (two anchor dump files with different DPRs)

### Test groups

| Group | File | Coverage |
|-------|------|----------|
| Anchor dump schema | `flutterAnchorDumpSchema.test.ts` | valid/invalid dump variants |
| Coordinate mapping | `flutterCoordinateMapping.test.ts` | DPR 3.0, DPR 2.75, clamp, floor-left/ceil-right |
| Artifact reader | `flutterAnchorArtifactReader.test.ts` | tmp/done/timeout/invalid race conditions |
| Device A/B proof | `flutterDeviceAB.test.ts` | same config, two devices, different rects |
| Visibility/scroll | `flutterVisibility.test.ts` | offscreen/visible fraction threshold |
| Judge cache | `flutterJudgeCache.test.ts` | hit/miss/invalidation |
| Discovery | `flutterDiscovery.test.ts` | target map generation, missing anchor suggestion |
| Pipeline integration | `run057FlutterAnchorValidation.integration.test.ts` | full pipeline with anchors |

---

## Preserved Behaviors

The following must not regress:
- Invalid capture short-circuits before judges (run-051)
- Required judges cannot silently skip in `visual_parity` mode (run-051)
- Explicit `metric_only` skip is allowed
- Source/reference context filtering still works (run-052)
- run-052 coordinate bug remains fixed
- run-054 `invalid_target` behavior remains fixed
- Compact `reportJsonPath` output remains available
- Legacy/local VLM remains disabled unless explicitly configured
