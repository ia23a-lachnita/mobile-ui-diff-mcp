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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    switch (request.params.name) {
      case "compare_images": {
        const args = request.params.arguments as any;
        const result = await compareImages({
          expectedImage: args.expectedImage,
          actualImage: args.actualImage,
          outputDir: args.outputDir,
          threshold: args.threshold,
          includeVlmAnalysis: args.includeVlmAnalysis,
          ignoreRegions: args.ignoreRegions
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "capture_android_screenshot": {
        const args = request.params.arguments as any;
        const result = await captureAndroidScreenshot(args.outputPath, args.deviceId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "capture_ios_simulator_screenshot": {
        const args = request.params.arguments as any;
        const result = await captureIosSimulatorScreenshot(args.outputPath, args.simulator);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "run_mobile_ui_diff": {
        const args = request.params.arguments as any;
        const result = await runMobileUiDiff({
          platform: args.platform,
          expectedImage: args.expectedImage,
          actualImage: args.actualImage,
          outputDir: args.outputDir,
          threshold: args.threshold,
          includeVlmAnalysis: args.includeVlmAnalysis,
          ignoreRegions: args.ignoreRegions
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
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