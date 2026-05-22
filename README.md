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
        { "x": 0, "y": 0, "width": 1080, "height": 80, "reason": "status bar" }
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

### Auto-run folders

If `runName` is omitted, the tool scans `outputDir` for existing `run-###` folders and creates the next one (`run-001`, `run-002`, ...). Profile runs always write to `outputDir/run-###`, and deltas compare against the nearest lower-numbered run.

## Parameters & Thresholds

- **pixelmatchThreshold** (formerly `threshold`): Sensitivity of the pixel comparison (`0` to `1`). Lower means more sensitive to color shifts. Default: `0.1`.
- **maxDiffPercent**: The maximum percentage of differing pixels (from `0.0` to `1.0`) allowed for the report status to be marked as `pass`. Default: `0.001` (`0.1%`).
- **maxRegions**: Maximum number of diff regions to return. Filters by keeping the regions with the largest area first. Default: `50` (Max: `500`).
- **maxVlmRegions**: Maximum number of regions to send to Ollama for feedback. Default: `10` (Max: `50`).
- **requireVlmAnalysis**: When true, fail early if VLM analysis is requested but no model can be loaded.

## Ignore Regions
You can send `ignoreRegions` to mask system UI elements that change frequently, like the status bar or notch:
```json
{
  "ignoreRegions": [
    { "x": 0, "y": 0, "width": 390, "height": 48, "reason": "status bar" },
    { "x": 130, "y": 830, "width": 130, "height": 14, "reason": "home indicator" }
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
- **Static Screenshots Only:** This tool compares static screenshots and does not navigate app flows. It expects the app to already be perfectly positioned on the correct screen.
