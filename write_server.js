const fs = require('fs');
fs.writeFileSync('src/mcp/server.ts', `import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { compareImages } from "../tools/compareImages";
import { runMobileUiDiff } from "../tools/runMobileUiDiff";
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
  maxRegions: z.number().int().positive().max(500).default(50).optional(),
  maxVlmRegions: z.number().int().nonnegative().max(50).default(10).optional(),
  includeVlmAnalysis: z.boolean().optional(),
  ignoreRegions: z.array(ignoreRegionSchema).optional()
});

export const captureAndroidSchema = z.object({
  outputPath: z.string().min(1),
  deviceId: z.string().regex(/^[a-zA-Z0-9_.-]+$/).optional()
});

export const captureIosSchema = z.object({
  outputPath: z.string().min(1),
  simulator: z.string().regex(/^[a-zA-Z0-9_.-]+$/).optional()
});

export const runMobileUiDiffSchema = z.object({
  platform: z.enum(['android', 'ios', 'none']),
  expectedImage: z.string().min(1),
  actualImage: z.string().min(1).optional(),
  outputDir: z.string().min(1),
  threshold: z.number().min(0).max(1).optional(),
  pixelmatchThreshold: z.number().min(0).max(1).optional(),
  maxDiffPercent: z.number().min(0).max(1).optional(),
  maxRegions: z.number().int().positive().max(500).default(50).optional(),
  maxVlmRegions: z.number().int().nonnegative().max(50).default(10).optional(),
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
          description: "Compare a mobile app screenshot against a design mockup, returning diff metrics and detected regions optionally analyzed by a local VLM.",
          inputSchema: {
            type: "object",
            properties: {
              expectedImage: { type: "string" },
              actualImage: { type: "string" },
              outputDir: { type: "string" },
              threshold: { type: "number", description: "Deprecated alias for pixelmatchThreshold." },
              pixelmatchThreshold: { type: "number", description: "Color sensitivity for pixel differences (0-1)." },
              maxDiffPercent: { type: "number", description: "Percentage of different pixels allowed before failing the test (0-1)." },
              maxRegions: { type: "number", description: "Maximum number of diff regions to return. Keeps the largest ones. Default 50." },
              maxVlmRegions: { type: "number", description: "Maximum number of regions to analyze with VLM. Default 10." },
              includeVlmAnalysis: { type: "boolean", description: "Whether to run Ollama on diff regions." },
              ignoreRegions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    x: { type: "number" },
                    y: { type: "number" },
                    width: { type: "number" },
                    height: { type: "number" },
                    reason: { type: "string" }
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
          description: "Capture an Android screenshot via ADB",
          inputSchema: {
            type: "object",
            properties: {
              outputPath: { type: "string" },
              deviceId: { type: "string" }
            },
            required: ["outputPath"]
          }
        },
        {
          name: "capture_ios_simulator_screenshot",
          description: "Capture an iOS Simulator screenshot via simctl",
          inputSchema: {
            type: "object",
            properties: {
              outputPath: { type: "string" },
              simulator: { type: "string" }
            },
            required: ["outputPath"]
          }
        },
        {
          name: "run_mobile_ui_diff",
          description: "High level tool to optionally capture a screenshot and then compare it to the mockup in one step.",
          inputSchema: {
            type: "object",
            properties: {
              platform: { type: "string", enum: ["android", "ios", "none"] },
              expectedImage: { type: "string" },
              actualImage: { type: "string" },
              outputDir: { type: "string" },
              threshold: { type: "number", description: "Deprecated alias for pixelmatchThreshold." },
              pixelmatchThreshold: { type: "number", description: "Color sensitivity for pixel differences (0-1)." },
              maxDiffPercent: { type: "number", description: "Percentage of different pixels allowed before failing the test (0-1)." },
              maxRegions: { type: "number", description: "Maximum number of diff regions to return. Keeps the largest ones. Default 50." },
              maxVlmRegions: { type: "number", description: "Maximum number of regions to analyze with VLM. Default 10." },
              includeVlmAnalysis: { type: "boolean", description: "Whether to run Ollama on diff regions." },
              ignoreRegions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    x: { type: "number" },
                    y: { type: "number" },
                    width: { type: "number" },
                    height: { type: "number" },
                    reason: { type: "string" }
                  },
                  required: ["x", "y", "width", "height"]
                }
              }
            },
            required: ["platform", "expectedImage", "outputDir"]
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
        default:
          throw new Error(\`Unknown tool: \${request.params.name}\`);
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
`);