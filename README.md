# mobile-ui-diff-mcp

An MCP server that helps Claude Code compare mobile app screenshots against design mockups. The tool captures or accepts screenshots, compares expected vs actual images, detects changed regions, optionally asks a local VLM (Ollama) to explain the visual differences, and returns a structured JSON report.

## Features
- Screenshot Capture: Uses `adb` for Android and `simctl` for iOS Simulator.
- Image Comparison: Uses `pixelmatch` for generating precise layout differences.
- Region Detection: Groups mismatches into logical UI regions using connected component analysis.
- VLM Explanation: Identifies root causes (e.g. layout, spacing, missing icons) by streaming bounding box crops to `qwen2.5vl:7b` via Ollama.

## Installation

```sh
npm install
npm run build
```

## Running Locally (CLI)

```sh
npm run compare -- --expected examples/mockups/login.png --actual examples/actual/login.png --out artifacts/login
```

Add `--vlm` to include local text generation analysis on differences if Ollama is running.

## Connecting to Claude Code

Update your Claude Code MCP config (e.g., `~/.claude/claude_mcp.json` or your project settings):

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

## Mobile Automation Workflow

1. Use iOS Simulator:
Claude Code can call:
```json
{
  "name": "run_mobile_ui_diff",
  "arguments": {
    "platform": "ios",
    "expectedImage": "design/screens/home.png",
    "outputDir": "artifacts/mismatch-1"
  }
}
```

2. Use Android Device:
```json
{
  "name": "run_mobile_ui_diff",
  "arguments": {
    "platform": "android",
    "expectedImage": "design/screens/home.png",
    "outputDir": "artifacts/mismatch-2"
  }
}
```

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

## Limitations
- Only standard PNG files are fully supported.
- Requires your own adb setup for Android or macOS Xcode tools simulator.
- Requires Ollama running on `localhost:11434` with `qwen2.5vl:7b` pulled for VLM feedback.
- Only meant to compare static screens; not a navigation or test script framework.
