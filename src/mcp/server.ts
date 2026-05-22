import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { compareImages } from "../tools/compareImages";
import { runMobileUiDiff } from "../tools/runMobileUiDiff";
import { runScreenUiDiff } from "../tools/runScreenUiDiff";
import { captureAndroidScreenshot } from "../tools/captureAndroid";
import { captureIosSimulatorScreenshot } from "../tools/captureIosSimulator";

export const ignoreRegionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  reason: z.string().optional()
});

export const compareImagesSchema = z.object({
  expectedImage: z.string().min(1),
  actualImage: z.string().min(1),
  outputDir: z.string().min(1),
  threshold: z.number().min(0).max(1).optional(),
  pixelmatchThreshold: z.number().min(0).max(1).optional(),
  maxDiffPercent: z.number().min(0).max(1).optional(),
  maxRegions: z.number().int().positive().max(500).default(50),
  maxVlmRegions: z.number().int().nonnegative().max(50).default(10),
  includeVlmAnalysis: z.boolean().optional(),
  ignoreRegions: z.array(ignoreRegionSchema).optional()
});

export const captureAndroidSchema = z.object({
  outputPath: z.string().min(1),
  deviceId: z.string().regex(/^[a-zA-Z0-9.:_-]+$/).optional()
});

export const captureIosSchema = z.object({
  outputPath: z.string().min(1),
  simulator: z.string().regex(/^[a-zA-Z0-9.\-:_]+$/).optional()
});

export const runMobileUiDiffSchema = z.object({
  platform: z.enum(['android', 'ios', 'none']),
  expectedImage: z.string().min(1),
  actualImage: z.string().min(1).optional(),
  outputDir: z.string().min(1),
  threshold: z.number().min(0).max(1).optional(),
  pixelmatchThreshold: z.number().min(0).max(1).optional(),
  maxDiffPercent: z.number().min(0).max(1).optional(),
  maxRegions: z.number().int().positive().max(500).default(50),
  maxVlmRegions: z.number().int().nonnegative().max(50).default(10),
  includeVlmAnalysis: z.boolean().optional(),
  ignoreRegions: z.array(ignoreRegionSchema).optional()
});

export const runScreenUiDiffSchema = z.object({
  screen: z.string().min(1),
  configPath: z.string().min(1).optional(),
  runName: z.string().min(1).optional(),
  actualImage: z.string().min(1).optional(),
  platform: z.enum(['android', 'ios', 'none']).optional(),
  expectedImage: z.string().min(1).optional(),
  outputDir: z.string().min(1).optional(),
  pixelmatchThreshold: z.number().min(0).max(1).optional(),
  maxDiffPercent: z.number().min(0).max(1).optional(),
  maxRegions: z.number().int().positive().max(500).optional(),
  maxVlmRegions: z.number().int().nonnegative().max(50).optional(),
  includeVlmAnalysis: z.boolean().optional(),
  ignoreRegions: z.array(ignoreRegionSchema).optional()
});

export function createServer() {
  const server = new Server(
    { name: "mobile-ui-diff-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "compare_images",
          description: "Compare two existing images (expected + actual). Use this when both screenshot files already exist and no capture is needed.",
          inputSchema: {
            type: "object",
            properties: {
              expectedImage: { type: "string", minLength: 1, description: "Path to the expected design/mockup PNG." },
              actualImage: { type: "string", minLength: 1, description: "Path to the actual screenshot PNG." },
              outputDir: { type: "string", minLength: 1, description: "Directory where diff artifacts and region crops will be written." },
              threshold: { type: "number", minimum: 0, maximum: 1, default: 0.1, description: "Deprecated alias for pixelmatchThreshold. Used only when pixelmatchThreshold is omitted." },
              pixelmatchThreshold: { type: "number", minimum: 0, maximum: 1, default: 0.1, description: "Color sensitivity for pixel differences. Default: 0.1." },
              maxDiffPercent: { type: "number", minimum: 0, maximum: 1, default: 0.001, description: "Maximum differing-pixel ratio allowed before failing the report. Default: 0.001." },
              maxRegions: { type: "integer", minimum: 1, maximum: 500, default: 50, description: "Maximum number of diff regions to return, keeping the largest regions first. Default: 50." },
              maxVlmRegions: { type: "integer", minimum: 0, maximum: 50, default: 10, description: "Maximum number of returned regions to analyze with VLM. Default: 10." },
              includeVlmAnalysis: { type: "boolean", default: false, description: "Set true to ask local Ollama/VLM to explain each changed region. Requires Ollama or returns fallback statuses." },
              ignoreRegions: {
                type: "array",
                description: "Pixel regions to mask before comparison.",
                items: {
                  type: "object",
                  properties: {
                    x: { type: "integer", minimum: 0 },
                    y: { type: "integer", minimum: 0 },
                    width: { type: "integer", minimum: 1 },
                    height: { type: "integer", minimum: 1 },
                    reason: { type: "string", description: "Optional human-readable reason for masking this region." }
                  },
                  required: ["x", "y", "width", "height"]
                }
              }
            },
            required: ["expectedImage", "actualImage", "outputDir"]
          }
        },
        {
          name: "capture_android_screenshot",
          description: "Capture an Android screenshot via ADB. Use only when you need a screenshot artifact without comparison.",
          inputSchema: {
            type: "object",
            properties: {
              outputPath: { type: "string", minLength: 1, description: "Path where the captured Android screenshot will be written." },
              deviceId: { type: "string", pattern: "^[a-zA-Z0-9.:_-]+$", description: "Optional adb device ID, including TCP IDs like 192.168.1.50:5555." }
            },
            required: ["outputPath"]
          }
        },
        {
          name: "capture_ios_simulator_screenshot",
          description: "Capture an iOS Simulator screenshot via simctl. Use only when you need a screenshot artifact without comparison.",
          inputSchema: {
            type: "object",
            properties: {
              outputPath: { type: "string", minLength: 1, description: "Path where the captured iOS Simulator screenshot will be written." },
              simulator: { type: "string", pattern: "^[a-zA-Z0-9.\\-:_]+$", default: "booted", description: "Optional simctl simulator identifier. Default: booted." }
            },
            required: ["outputPath"]
          }
        },
        {
          name: "run_mobile_ui_diff",
          description: "Capture a fresh Android/iOS screenshot (or use an existing actualImage) and compare it to a mockup. For named screen profiles, prefer run_screen_ui_diff.",
          inputSchema: {
            type: "object",
            properties: {
              platform: { type: "string", enum: ["android", "ios", "none"] },
              expectedImage: { type: "string", minLength: 1, description: "Path to the expected design/mockup PNG." },
              actualImage: { type: "string", minLength: 1, description: "Optional path to an existing actual screenshot PNG. Required when platform is none." },
              outputDir: { type: "string", minLength: 1, description: "Directory where screenshots, diff artifacts, and region crops will be written." },
              threshold: { type: "number", minimum: 0, maximum: 1, default: 0.1, description: "Deprecated alias for pixelmatchThreshold. Used only when pixelmatchThreshold is omitted." },
              pixelmatchThreshold: { type: "number", minimum: 0, maximum: 1, default: 0.1, description: "Color sensitivity for pixel differences. Default: 0.1." },
              maxDiffPercent: { type: "number", minimum: 0, maximum: 1, default: 0.001, description: "Maximum differing-pixel ratio allowed before failing the report. Default: 0.001." },
              maxRegions: { type: "integer", minimum: 1, maximum: 500, default: 50, description: "Maximum number of diff regions to return, keeping the largest regions first. Default: 50." },
              maxVlmRegions: { type: "integer", minimum: 0, maximum: 50, default: 10, description: "Maximum number of returned regions to analyze with VLM. Default: 10." },
              includeVlmAnalysis: { type: "boolean", default: false, description: "Set true to ask local Ollama/VLM to explain each changed region. Requires Ollama or returns fallback statuses." },
              ignoreRegions: {
                type: "array",
                description: "Pixel regions to mask before comparison.",
                items: {
                  type: "object",
                  properties: {
                    x: { type: "integer", minimum: 0 },
                    y: { type: "integer", minimum: 0 },
                    width: { type: "integer", minimum: 1 },
                    height: { type: "integer", minimum: 1 },
                    reason: { type: "string", description: "Optional human-readable reason for masking this region." }
                  },
                  required: ["x", "y", "width", "height"]
                }
              }
            },
            required: ["platform", "expectedImage", "outputDir"]
          }
        },
        {
          name: "run_screen_ui_diff",
          description: "Run a comparison using a named screen profile from ui-diff.config.json, with optional overrides and run-to-run delta reporting.",
          inputSchema: {
            type: "object",
            properties: {
              screen: { type: "string", minLength: 1, description: "Screen name defined in ui-diff.config.json." },
              configPath: { type: "string", minLength: 1, description: "Optional path to ui-diff.config.json. Defaults to ./ui-diff.config.json." },
              runName: { type: "string", minLength: 1, description: "Optional run folder name. If set, output goes to outputDir/runName and delta compares to the previous run." },
              actualImage: { type: "string", minLength: 1, description: "Optional path to an existing actual screenshot PNG. When set, no capture is performed." },
              platform: { type: "string", enum: ["android", "ios", "none"], description: "Optional override for the screen profile platform." },
              expectedImage: { type: "string", minLength: 1, description: "Optional override for the expected design/mockup PNG." },
              outputDir: { type: "string", minLength: 1, description: "Optional override for the output directory." },
              pixelmatchThreshold: { type: "number", minimum: 0, maximum: 1, description: "Optional override for pixelmatch threshold." },
              maxDiffPercent: { type: "number", minimum: 0, maximum: 1, description: "Optional override for maximum diff percent." },
              maxRegions: { type: "integer", minimum: 1, maximum: 500, description: "Optional override for max diff regions." },
              maxVlmRegions: { type: "integer", minimum: 0, maximum: 50, description: "Optional override for max VLM regions." },
              includeVlmAnalysis: { type: "boolean", description: "Set true to ask local Ollama/VLM to explain each changed region. Requires Ollama or returns fallback statuses." },
              ignoreRegions: {
                type: "array",
                description: "Optional override for pixel regions to mask before comparison.",
                items: {
                  type: "object",
                  properties: {
                    x: { type: "integer", minimum: 0 },
                    y: { type: "integer", minimum: 0 },
                    width: { type: "integer", minimum: 1 },
                    height: { type: "integer", minimum: 1 },
                    reason: { type: "string", description: "Optional human-readable reason for masking this region." }
                  },
                  required: ["x", "y", "width", "height"]
                }
              }
            },
            required: ["screen"]
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      switch (request.params.name) {
        case "compare_images": {
          const args = compareImagesSchema.parse(request.params.arguments);
          const result = await compareImages(args as any);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "capture_android_screenshot": {
          const args = captureAndroidSchema.parse(request.params.arguments);
          const result = await captureAndroidScreenshot(args.outputPath, args.deviceId);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "capture_ios_simulator_screenshot": {
          const args = captureIosSchema.parse(request.params.arguments);
          const result = await captureIosSimulatorScreenshot(args.outputPath, args.simulator);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "run_mobile_ui_diff": {
          const args = runMobileUiDiffSchema.parse(request.params.arguments);
          const result = await runMobileUiDiff(args as any);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "run_screen_ui_diff": {
          const args = runScreenUiDiffSchema.parse(request.params.arguments);
          const result = await runScreenUiDiff(args as any);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }
    } catch (err: any) {
      return { 
        isError: true,
        content: [{ type: "text", text: err.stack || err.message || String(err) }] 
      };
    }
  });

  return server;
}

export async function runServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mobile-ui-diff-mcp running on stdio");
}
