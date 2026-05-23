# mobile-ui-diff-mcp

An MCP server that helps AI agents compare mobile app screenshots against design mockups. The tool captures or accepts screenshots, compares expected vs actual images, detects changed regions, optionally asks a local VLM (Ollama) to explain the visual differences, and returns a structured JSON report.

## Security Note

**SECURITY WARNING:** This local MCP server executes shell commands (adb, xcrun) and interacts with your local file system. It can read and write files arbitrarily. Only run this inside trusted environments. Ensure that any AI agent using these tools is supervised or given safe paths (e.g. outputting to an artifacts directory).

## Prerequisites

- **Android:** Requires the Android SDK (specifically adb) installed and available in your PATH.
- **iOS Simulator:** Requires macOS with Xcode installed (xcrun simctl must be available).
- **Ollama (Optional):** For VLM analysis, Ollama defaults to `http://localhost:11434` with `qwen2.5vl:7b` downloaded (`ollama run qwen2.5vl:7b`). Override with `OLLAMA_BASE_URL` and `OLLAMA_MODEL` when needed.

## Features
- **Screenshot Capture:** Uses adb for Android and simctl for iOS Simulator.
- **Image Comparison:** Uses pixelmatch for generating precise layout differences.
- **Region Detection:** Groups mismatches into logical UI regions using connected component analysis. Keeps the largest `maxRegions`.
- **VLM Explanation:** Identifies root causes (e.g., layout, spacing, missing icons) by streaming bounding box crops to a local VLM.
- **Local Quality Gates:** Adds region/component scoring, critical ROI checks, visual assertions, floor detection, and agent-friendly summaries.

## Configuration (Environment Variables)

When starting the MCP server or running queries, you can configure the VLM connection:
- `OLLAMA_BASE_URL`: Custom URL for Ollama (default: `http://localhost:11434`)
- `OLLAMA_MODEL`: The model to use for analysis (default: `qwen2.5vl:7b`)
- `VLM_TIMEOUT_MS`: Max time to wait for a VLM response in milliseconds (default: `60000`)

## VLM health and Ollama setup

- Start Ollama:
  ```sh
  ollama serve
  ```
- Pull a model:
  ```sh
  ollama pull qwen2.5vl:7b
  ```
- Check health via MCP:
  ```json
  { "name": "vlm_health", "arguments": { "provider": "ollama" } }
  ```
- `/api/tags` lists installed models and `/api/ps` lists running/loaded models.
- `requireVlmAnalysis` fails early if VLM analysis is requested but no model can load.
- `fallbackModels` lets a screen profile try smaller models if the primary fails.
- Large VLMs may fail to load on limited VRAM/RAM; try smaller models or free resources.

## Installation & Build

```sh
npm install
npm run build
```

## CLI Usage

You can run the comparison from the command line:

```sh
npm run compare -- --expected examples/mockups/login.png --actual examples/actual/login.png --out artifacts/login \
  --pixelmatchThreshold 0.1 \
  --maxDiffPercent 0.001 \
  --maxRegions 50 \
  --maxVlmRegions 10 \
  --ignoreRegions '[{"x":0,"y":0,"width":390,"height":48}]' \
  --vlm
```

## Connecting to Claude Code or other MCP hosts

Update your MCP config (e.g., `~/.claude/claude_mcp.json` or your project settings):

```json
{
  "mcpServers": {
    "mobile-ui-diff": {
      "command": "node",
      "args": ["/absolute/path/to/mobile-ui-diff-mcp/dist/index.js"]
    }
  }
}
```

## Sample Claude Code Prompt

```text
Check the latest changes on the Android simulator compared to my design file. 
Use run_mobile_ui_diff with platform "android" to capture a screenshot, expectedImage "design/home.png", and outputDir "artifacts/test". Set maxDiffPercent to 0.05 and pixelmatchThreshold to 0.15. Return a summary of the differences.
```

## Which tool should Claude Code use?

| Goal | Recommended tool | Notes |
| --- | --- | --- |
| Compare two existing images | `compare_images` | Best when you already have both expected and actual PNG files. |
| Capture + compare in one step | `run_mobile_ui_diff` | Takes a fresh screenshot unless `actualImage` is supplied. If `actualImage` already exists, prefer `compare_images`. |
| Compare using a named screen profile | `run_screen_ui_diff` | Uses `ui-diff.config.json` profiles and preserves run history + deltas. |
| Capture only (no comparison) | `capture_android_screenshot` / `capture_ios_simulator_screenshot` | Use when you only need the raw screenshot artifact. |

## Mobile Automation Workflow

### 1. iOS Simulator example
Claude Code can call:
```json
{
  "name": "run_mobile_ui_diff",
  "arguments": {
    "platform": "ios",
    "expectedImage": "/path/to/design/screens/home.png",
    "outputDir": "/path/to/artifacts/mismatch-1",
    "pixelmatchThreshold": 0.1,
    "maxDiffPercent": 0.05
  }
}
```

### 2. Android Device example
```json
{
  "name": "run_mobile_ui_diff",
  "arguments": {
    "platform": "android",
    "expectedImage": "/path/to/design/screens/home.png",
    "outputDir": "/path/to/artifacts/mismatch-2",
    "pixelmatchThreshold": 0.1,
    "maxDiffPercent": 0.05
  }
}
```

## Screen Profiles (ui-diff.config.json)

Create `ui-diff.config.json` in your working directory to define reusable screen profiles:

```json
{
  "screens": {
    "today": {
      "platform": "android",
      "expectedImage": "docs/mockups/image/light/single/Today.png",
      "outputDir": ".ui-diff/today",
      "pixelmatchThreshold": 0.1,
      "maxDiffPercent": 0.01,
      "maxRegions": 20,
      "maxVlmRegions": 8,
      "includeVlmAnalysis": true,
      "preCapture": [
        {
          "type": "adbShell",
          "command": "input tap 108 2280",
          "description": "Switch to Today tab"
        }
      ],
      "regionsOfInterest": [
        {
          "id": "macro-ring",
          "label": "Macro ring chart",
          "type": "component",
          "critical": true,
          "weight": 10,
          "coordinateSpace": "normalized",
          "box": { "x": 0.20, "y": 0.17, "width": 0.60, "height": 0.29 },
          "maxDiffPercent": 0.06
        }
      ],
      "visualAssertions": [
        {
          "id": "macro-ring-local-diff",
          "type": "roiMaxDiffPercent",
          "roiId": "macro-ring",
          "maxDiffPercent": 0.06,
          "severity": "critical",
          "message": "Macro ring chart is visually too different from mockup."
        }
      ],
      "floorDetection": {
        "enabled": true,
        "deltaThreshold": 0.0001,
        "consecutiveRuns": 2
      },
      "vlm": {
        "provider": "ollama",
        "model": "qwen2.5vl:7b",
        "fallbackModels": ["llava:7b", "moondream:latest"],
        "keepAlive": "10m",
        "preflight": true,
        "require": false,
        "autoPull": false,
        "timeoutMs": 30000
      },
      "ignoreRegions": [
        {
          "x": 0,
          "y": 0,
          "width": 1080,
          "height": 80,
          "reason": "status bar",
          "type": "system",
          "coordinateSpace": "actual"
        }
      ]
    }
  }
}
```

Then run a profile with optional overrides and run-to-run delta reporting:

```json
{
  "name": "run_screen_ui_diff",
  "arguments": {
    "screen": "today",
    "runName": "run-003",
    "pixelmatchThreshold": 0.12
  }
}
```

`preCapture` v1 is intentionally narrow: only `adbShell` is supported, and commands are split into argv tokens before execution. Shell metacharacters such as `&`, `|`, `;`, `>`, `<`, `` ` ``, `$`, `(`, and `)` are rejected.

### Auto-run folders

If `runName` is omitted, the tool scans `outputDir` for existing `run-###` folders and creates the next one (`run-001`, `run-002`, ...). Profile runs always write to `outputDir/run-###`, and deltas compare against the nearest lower-numbered run.

## Parameters & Thresholds

- **pixelmatchThreshold** (formerly `threshold`): Sensitivity of the pixel comparison (`0` to `1`). Lower means more sensitive to color shifts. Default: `0.1`.
- **maxDiffPercent**: The maximum percentage of differing pixels (from `0.0` to `1.0`) allowed for the report status to be marked as `pass`. Default: `0.001` (`0.1%`).
- **maxRegions**: Maximum number of diff regions to return. Filters by keeping the regions with the largest area first. Default: `50` (Max: `500`).
- **maxVlmRegions**: Maximum number of regions to send to Ollama for feedback. Default: `10` (Max: `50`).
- **requireVlmAnalysis**: When true, fail early if VLM analysis is requested but no model can be loaded.

### Quality Gates

- `status` is still the global pixel-diff result.
- `qualityStatus` is the local visual-quality gate. It fails if any critical ROI or critical visual assertion fails, even when global diff is at floor.
- `priorityFindings` ranks the most important problems first so agents do not have to infer importance from a long region list.
- `agentSummary` gives a natural-language verdict and a `canStopIterating` flag.
- `suggestedMaxDiffPercent` is only emitted when global diff is failing, the report is at floor, and no critical ROI or critical assertion failed. If a critical local gate fails, the suggestion is blocked.
- `atFloor` only becomes true when floor detection has enough history and no critical local gate is failing.

### Coordinate Spaces

- `normalized`: `x`/`y`/`width`/`height` are `0..1` relative to the normalized comparison canvas.
- `expected`: coordinates are in expected/mockup image pixels.
- `actual`: coordinates are in actual screenshot pixels before normalization.

### ROI and Assertions

- `regionsOfInterest` defines component zones that get their own diff metrics and crops under `regions-of-interest/`.
- Critical ROIs can fail the report even when the global diff looks stable.
- `visualAssertions` currently supports `roiMaxDiffPercent` and can be extended later.

### Floor Detection

- Default config: `{ "enabled": true, "deltaThreshold": 0.0001, "consecutiveRuns": 2 }`
- Floor detection is blocked when a critical ROI or critical visual assertion fails.
- When floor detection is blocked, the report includes `floorBlockedBy` and a `floorReason`.

### Masks

- `ignoreRegions` still masks pixels before diffing.
- `type: "system"` is for OS chrome, `type: "data"` is for live fixture mismatches, and `type: "dynamic"` is for loading/timestamps/ads/etc.
- Data masks behave like ignore regions for diffing, but they are also listed in `maskedRegions`.
- If a data mask overlaps a critical ROI, the report emits a warning so it cannot hide a broken component silently.

### Fallback Labels

- When VLM is disabled or unavailable, each changed region still gets a `fallbackLabel` and `fallbackDescription`.
- If a changed region intersects a configured ROI, the ROI label is used.
- Otherwise geometry heuristics label the region as top/status/header, bottom navigation/chrome, side/edge, main content, or generic content.

## Ignore Regions
You can send `ignoreRegions` to mask system UI elements that change frequently, like the status bar or notch:

When mockup and device screenshots differ in dimensions, use `coordinateSpace:'actual'` for device screenshot coordinates or `coordinateSpace:'normalized'` for proportional regions.

```json
{
  "ignoreRegions": [
    { "x": 0, "y": 0, "width": 390, "height": 48, "reason": "status bar", "type": "system", "coordinateSpace": "actual" },
    { "x": 130, "y": 830, "width": 130, "height": 14, "reason": "home indicator", "type": "system", "coordinateSpace": "actual" }
  ]
}
```

## Analysis Status Values
For each returned region, `analysisStatus` describes the state of the VLM feedback:
- `"skipped"`: VLM analysis was disabled or the region exceeded `maxVlmRegions`.
- `"ok"`: VLM successfully returned an explanation.
- `"fallback"`: VLM was unreachable, timed out, missing the proper model, or returned invalid JSON, so a synthetic fallback description is provided.
- `"error"`: A system error prevented the analysis from completing.

## Limitations
- Only standard PNG files are fully supported.
- Requires your own adb setup for Android or macOS Xcode tools simulator.
- Defaults to Ollama at localhost:11434 using qwen2.5vl:7b, but can be overridden with OLLAMA_BASE_URL and OLLAMA_MODEL.
- This tool is not a full navigation framework. It can run limited preCapture hooks, such as safe adbShell taps, before capture. Complex multi-step navigation flows should still be handled outside the tool.
