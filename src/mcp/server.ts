import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { compareImages } from "../tools/compareImages";
import { runMobileUiDiff } from "../tools/runMobileUiDiff";
import { captureAndroidScreenshot } from "../tools/captureAndroid";
import { captureIosSimulatorScreenshot } from "../tools/captureIosSimulator";

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
              threshold: { type: "number" },
              includeVlmAnalysis: { type: "boolean" },
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
              threshold: { type: "number" },
              includeVlmAnalysis: { type: "boolean" },
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

const ignoreRegionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  reason: z.string().optional()
});

const compareImagesSchema = z.object({
  expectedImage: z.string(),
  actualImage: z.string(),
  outputDir: z.string(),
  threshold: z.number().optional(),
  pixelmatchThreshold: z.number().optional(),
  maxDiffPercent: z.number().optional(),
  maxRegions: z.number().optional(),
  maxVlmRegions: z.number().optional(),
  includeVlmAnalysis: z.boolean().optional(),
  ignoreRegions: z.array(ignoreRegionSchema).optional()
});

const captureAndroidSchema = z.object({
  outputPath: z.string(),
  deviceId: z.string().optional()
});

const captureIosSchema = z.object({
  outputPath: z.string(),
  simulator: z.string().optional()
});

const runMobileUiDiffSchema = z.object({
  platform: z.enum(['android', 'ios', 'none']),
  expectedImage: z.string(),
  actualImage: z.string().optional(),
  outputDir: z.string(),
  threshold: z.number().optional(),
  pixelmatchThreshold: z.number().optional(),
  maxDiffPercent: z.number().optional(),
  maxRegions: z.number().optional(),
  maxVlmRegions: z.number().optional(),
  includeVlmAnalysis: z.boolean().optional(),
  ignoreRegions: z.array(ignoreRegionSchema).optional()
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