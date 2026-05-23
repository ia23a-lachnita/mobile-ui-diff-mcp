import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { compareImages } from "../tools/compareImages";
import { runMobileUiDiff } from "../tools/runMobileUiDiff";
import { runScreenUiDiff } from "../tools/runScreenUiDiff";
import { captureAndroidScreenshot } from "../tools/captureAndroid";
import { captureIosSimulatorScreenshot } from "../tools/captureIosSimulator";
import { calibrateAndroidDevice } from "../tools/androidDevice";
import { discoverStableRegions } from "../tools/discoverStableRegions";
import { checkOllamaHealth } from "../vlm/ollama";

export const ignoreRegionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  reason: z.string().optional(),
  type: z.enum(['system', 'data', 'dynamic']).optional(),
  coordinateSpace: z.enum(['expected', 'actual', 'normalized']).optional()
});

export const preCaptureSchema = z.object({
  type: z.literal('adbShell'),
  command: z.string().min(1),
  description: z.string().min(1)
}).or(z.object({
  type: z.literal('adbTapNormalized'),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  description: z.string().min(1)
}));

export const autoIgnoreSchema = z.object({
  enabled: z.boolean().optional(),
  screenshotOutOfBounds: z.boolean().optional(),
  systemBars: z.boolean().optional(),
  edgePanels: z.boolean().optional()
});

export const regionOfInterestSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['component', 'zone']),
  critical: z.boolean().optional(),
  weight: z.number().positive().optional(),
  coordinateSpace: z.enum(['normalized', 'expected', 'actual']).optional(),
  box: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive()
  }),
  maxDiffPercent: z.number().min(0).max(1).optional()
});

export const visualAssertionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('roiMaxDiffPercent'),
  roiId: z.string().min(1),
  maxDiffPercent: z.number().min(0).max(1),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  message: z.string().min(1)
});

export const floorDetectionSchema = z.object({
  enabled: z.boolean().optional(),
  deltaThreshold: z.number().min(0).optional(),
  consecutiveRuns: z.number().int().positive().optional()
});

export const hotspotDetectionSchema = z.object({
  enabled: z.boolean().optional(),
  maxHotspots: z.number().int().positive().max(50).optional(),
  minAreaPercent: z.number().min(0).max(1).optional(),
  minDiffDensity: z.number().min(0).max(1).optional()
});

export const vlmPolicySchema = z.enum(['disabled', 'optional', 'required', 'ask_user']);

export const vlmConfigSchema = z.object({
  provider: z.enum(['ollama']).optional(),
  baseUrl: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  fallbackModels: z.array(z.string().min(1)).optional(),
  keepAlive: z.string().min(1).optional(),
  preflight: z.boolean().optional(),
  require: z.boolean().optional(),
  autoPull: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional()
}).optional();

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
  requireVlmAnalysis: z.boolean().optional(),
  vlmPolicy: vlmPolicySchema.optional(),
  ignoreRegions: z.array(ignoreRegionSchema).optional(),
  dataRegions: z.array(ignoreRegionSchema).optional(),
  regionsOfInterest: z.array(regionOfInterestSchema).optional(),
  visualAssertions: z.array(visualAssertionSchema).optional(),
  floorDetection: floorDetectionSchema.optional(),
  hotspotDetection: hotspotDetectionSchema.optional(),
  previousReport: z.any().optional(),
  runDelta: z.any().optional()
}).strict();

export const captureAndroidSchema = z.object({
  outputPath: z.string().min(1),
  deviceId: z.string().regex(/^[a-zA-Z0-9.:_-]+$/).optional()
});

export const calibrateAndroidDeviceSchema = z.object({
  deviceId: z.string().regex(/^[a-zA-Z0-9.:_-]+$/).optional(),
  outputDir: z.string().min(1).optional()
});

export const discoverStableRegionsSchema = z.object({
  screenNames: z.array(z.string().min(1)).min(1),
  configPath: z.string().min(1).optional(),
  outputDir: z.string().min(1)
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
  requireVlmAnalysis: z.boolean().optional(),
  vlmPolicy: vlmPolicySchema.optional(),
  ignoreRegions: z.array(ignoreRegionSchema).optional(),
  dataRegions: z.array(ignoreRegionSchema).optional(),
  autoMaskedRegions: z.array(ignoreRegionSchema).optional(),
  preCapture: z.array(preCaptureSchema).optional(),
  deviceId: z.string().regex(/^[a-zA-Z0-9.:_-]+$/).optional(),
  regionsOfInterest: z.array(regionOfInterestSchema).optional(),
  visualAssertions: z.array(visualAssertionSchema).optional(),
  floorDetection: floorDetectionSchema.optional(),
  hotspotDetection: hotspotDetectionSchema.optional(),
  previousReport: z.any().optional(),
  runDelta: z.any().optional()
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
  requireVlmAnalysis: z.boolean().optional(),
  vlmPolicy: vlmPolicySchema.optional(),
  vlm: vlmConfigSchema,
  ignoreRegions: z.array(ignoreRegionSchema).optional(),
  dataRegions: z.array(ignoreRegionSchema).optional(),
  autoIgnore: autoIgnoreSchema.optional(),
  preCapture: z.array(preCaptureSchema).optional(),
  deviceId: z.string().regex(/^[a-zA-Z0-9.:_-]+$/).optional(),
  appContentBounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    coordinateSpace: z.enum(['normalized', 'expected', 'actual']).optional()
  }).optional(),
  regionsOfInterest: z.array(regionOfInterestSchema).optional(),
  visualAssertions: z.array(visualAssertionSchema).optional(),
  floorDetection: floorDetectionSchema.optional(),
  hotspotDetection: hotspotDetectionSchema.optional()
});

export const vlmHealthSchema = z.object({
  provider: z.enum(['ollama']).default('ollama'),
  baseUrl: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  fallbackModels: z.array(z.string().min(1)).optional(),
  checkLoad: z.boolean().default(true),
  keepAlive: z.string().min(1).default('10m'),
  timeoutMs: z.number().int().positive().default(30000)
});

export function getToolList() {
  return [
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
          requireVlmAnalysis: { type: "boolean", default: false, description: "When true, fail early if VLM analysis is requested but no model can be loaded." },
          vlmPolicy: { type: "string", enum: ["disabled", "optional", "required", "ask_user"], description: "Controls VLM availability behavior. Defaults to disabled when includeVlmAnalysis is false, required when requireVlmAnalysis is true, otherwise ask_user when VLM is requested." },
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
                reason: { type: "string", description: "Optional human-readable reason for masking this region." },
                type: { type: "string", enum: ["system", "data", "dynamic"], description: "Mask category. system for OS chrome, data for live fixture mismatches, dynamic for loading/timestamps/ads." },
                coordinateSpace: { type: "string", enum: ["expected", "actual", "normalized"], description: "Coordinate space used for x/y/width/height. Default: expected." }
              },
              required: ["x", "y", "width", "height"]
            }
          },
          regionsOfInterest: {
            type: "array",
            description: "Component or zone regions scored separately from global diff.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                label: { type: "string", minLength: 1 },
                type: { type: "string", enum: ["component", "zone"] },
                critical: { type: "boolean" },
                weight: { type: "number", minimum: 0 },
                coordinateSpace: { type: "string", enum: ["normalized", "expected", "actual"] },
                box: {
                  type: "object",
                  properties: {
                    x: { type: "number" },
                    y: { type: "number" },
                    width: { type: "number", exclusiveMinimum: 0 },
                    height: { type: "number", exclusiveMinimum: 0 }
                  },
                  required: ["x", "y", "width", "height"]
                },
                maxDiffPercent: { type: "number", minimum: 0, maximum: 1 }
              },
              required: ["id", "label", "type", "box"]
            }
          },
          visualAssertions: {
            type: "array",
            description: "Configurable visual assertions applied to ROI metrics.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                type: { type: "string", enum: ["roiMaxDiffPercent"] },
                roiId: { type: "string", minLength: 1 },
                maxDiffPercent: { type: "number", minimum: 0, maximum: 1 },
                severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
                message: { type: "string", minLength: 1 }
              },
              required: ["id", "type", "roiId", "maxDiffPercent", "severity", "message"]
            }
          },
          floorDetection: {
            type: "object",
            description: "Floor detection based on consecutive stable deltas.",
            properties: {
              enabled: { type: "boolean", default: true },
              deltaThreshold: { type: "number", minimum: 0, default: 0.0001 },
              consecutiveRuns: { type: "integer", minimum: 1, default: 2 }
            }
          },
          hotspotDetection: {
            type: "object",
            description: "Local hotspot reporting for large changed regions even when no ROI is configured.",
            properties: {
              enabled: { type: "boolean", default: true },
              maxHotspots: { type: "integer", minimum: 1, maximum: 50, default: 3 },
              minAreaPercent: { type: "number", minimum: 0, maximum: 1, default: 0.02 },
              minDiffDensity: { type: "number", minimum: 0, maximum: 1, default: 0.10 }
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
      name: "calibrate_android_device",
      description: "Collect adb device metadata, wm size/density, screencap dimensions, system UI estimates, and non-mutating device profile suggestions.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string", pattern: "^[a-zA-Z0-9.:_-]+$", description: "Optional adb device ID, including TCP IDs like 192.168.1.50:5555." },
          outputDir: { type: "string", minLength: 1, description: "Optional directory for the calibration screenshot. Defaults to a temp directory." }
        }
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
      description: "Capture a fresh Android/iOS screenshot (or use an existing actualImage) and compare it to a mockup. If actualImage already exists, prefer compare_images. For named screen profiles, prefer run_screen_ui_diff.",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "none"] },
          expectedImage: { type: "string", minLength: 1, description: "Path to the expected design/mockup PNG." },
          actualImage: { type: "string", minLength: 1, description: "Optional path to an existing actual screenshot PNG. When using an existing actual screenshot, compare_images is preferred unless profile/run metadata is needed. Required when platform is none." },
          outputDir: { type: "string", minLength: 1, description: "Directory where screenshots, diff artifacts, and region crops will be written." },
          deviceId: { type: "string", pattern: "^[a-zA-Z0-9.:_-]+$", description: "Optional adb device ID for Android capture and preCapture commands." },
          threshold: { type: "number", minimum: 0, maximum: 1, default: 0.1, description: "Deprecated alias for pixelmatchThreshold. Used only when pixelmatchThreshold is omitted." },
          pixelmatchThreshold: { type: "number", minimum: 0, maximum: 1, default: 0.1, description: "Color sensitivity for pixel differences. Default: 0.1." },
          maxDiffPercent: { type: "number", minimum: 0, maximum: 1, default: 0.001, description: "Maximum differing-pixel ratio allowed before failing the report. Default: 0.001." },
          maxRegions: { type: "integer", minimum: 1, maximum: 500, default: 50, description: "Maximum number of diff regions to return, keeping the largest regions first. Default: 50." },
          maxVlmRegions: { type: "integer", minimum: 0, maximum: 50, default: 10, description: "Maximum number of returned regions to analyze with VLM. Default: 10." },
          includeVlmAnalysis: { type: "boolean", default: false, description: "Set true to ask local Ollama/VLM to explain each changed region. Requires Ollama or returns fallback statuses." },
          requireVlmAnalysis: { type: "boolean", default: false, description: "When true, fail early if VLM analysis is requested but no model can be loaded." },
          vlmPolicy: { type: "string", enum: ["disabled", "optional", "required", "ask_user"], description: "Controls VLM availability behavior. Defaults to disabled when includeVlmAnalysis is false, required when requireVlmAnalysis is true, otherwise ask_user when VLM is requested." },
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
                reason: { type: "string", description: "Optional human-readable reason for masking this region." },
                type: { type: "string", enum: ["system", "data", "dynamic"], description: "Mask category. system for OS chrome, data for live fixture mismatches, dynamic for loading/timestamps/ads." },
                coordinateSpace: { type: "string", enum: ["expected", "actual", "normalized"], description: "Coordinate space used for x/y/width/height. Default: expected." }
              },
              required: ["x", "y", "width", "height"]
            }
          },
          preCapture: {
            type: "array",
            description: "Safe device navigation steps to run before capture when actualImage is omitted.",
            items: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["adbShell"] },
                    command: { type: "string", minLength: 1 },
                    description: { type: "string", minLength: 1 }
                  },
                  required: ["type", "command", "description"]
                },
                {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["adbTapNormalized"] },
                    x: { type: "number", minimum: 0, maximum: 1 },
                    y: { type: "number", minimum: 0, maximum: 1 },
                    description: { type: "string", minLength: 1 }
                  },
                  required: ["type", "x", "y", "description"]
                }
              ]
            }
          },
          autoMaskedRegions: {
            type: "array",
            description: "Generated masks to apply and list separately as autoMaskedRegions in the report. Prefer run_screen_ui_diff with autoIgnore/deviceProfiles.",
            items: {
              type: "object",
              properties: {
                x: { type: "integer", minimum: 0 },
                y: { type: "integer", minimum: 0 },
                width: { type: "integer", minimum: 1 },
                height: { type: "integer", minimum: 1 },
                reason: { type: "string" },
                type: { type: "string", enum: ["system", "data", "dynamic"] },
                coordinateSpace: { type: "string", enum: ["expected", "actual", "normalized"] }
              },
              required: ["x", "y", "width", "height"]
            }
          },
          dataRegions: {
            type: "array",
            description: "Dynamic data regions to mask as type:data while still warning on critical ROI overlap.",
            items: {
              type: "object",
              properties: {
                x: { type: "integer", minimum: 0 },
                y: { type: "integer", minimum: 0 },
                width: { type: "integer", minimum: 1 },
                height: { type: "integer", minimum: 1 },
                reason: { type: "string" },
                type: { type: "string", enum: ["system", "data", "dynamic"] },
                coordinateSpace: { type: "string", enum: ["expected", "actual", "normalized"] }
              },
              required: ["x", "y", "width", "height"]
            }
          },
          regionsOfInterest: {
            type: "array",
            description: "Component or zone regions scored separately from global diff.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                label: { type: "string", minLength: 1 },
                type: { type: "string", enum: ["component", "zone"] },
                critical: { type: "boolean" },
                weight: { type: "number", minimum: 0 },
                coordinateSpace: { type: "string", enum: ["normalized", "expected", "actual"] },
                box: {
                  type: "object",
                  properties: {
                    x: { type: "number" },
                    y: { type: "number" },
                    width: { type: "number", exclusiveMinimum: 0 },
                    height: { type: "number", exclusiveMinimum: 0 }
                  },
                  required: ["x", "y", "width", "height"]
                },
                maxDiffPercent: { type: "number", minimum: 0, maximum: 1 }
              },
              required: ["id", "label", "type", "box"]
            }
          },
          visualAssertions: {
            type: "array",
            description: "Configurable visual assertions applied to ROI metrics.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                type: { type: "string", enum: ["roiMaxDiffPercent"] },
                roiId: { type: "string", minLength: 1 },
                maxDiffPercent: { type: "number", minimum: 0, maximum: 1 },
                severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
                message: { type: "string", minLength: 1 }
              },
              required: ["id", "type", "roiId", "maxDiffPercent", "severity", "message"]
            }
          },
          floorDetection: {
            type: "object",
            description: "Floor detection based on consecutive stable deltas.",
            properties: {
              enabled: { type: "boolean", default: true },
              deltaThreshold: { type: "number", minimum: 0, default: 0.0001 },
              consecutiveRuns: { type: "integer", minimum: 1, default: 2 }
            }
          },
          hotspotDetection: {
            type: "object",
            description: "Local hotspot reporting for large changed regions even when no ROI is configured.",
            properties: {
              enabled: { type: "boolean", default: true },
              maxHotspots: { type: "integer", minimum: 1, maximum: 50, default: 3 },
              minAreaPercent: { type: "number", minimum: 0, maximum: 1, default: 0.02 },
              minDiffDensity: { type: "number", minimum: 0, maximum: 1, default: 0.10 }
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
          runName: { type: "string", minLength: 1, description: "Optional run folder name. If omitted, an auto-incremented folder (run-001, run-002, …) is created. Output always goes to outputDir/runName and delta is computed when a previous run exists." },
          actualImage: { type: "string", minLength: 1, description: "Optional path to an existing actual screenshot PNG. When using an existing actual screenshot, compare_images is preferred unless profile/run metadata is needed." },
          platform: { type: "string", enum: ["android", "ios", "none"], description: "Optional override for the screen profile platform." },
          expectedImage: { type: "string", minLength: 1, description: "Optional override for the expected design/mockup PNG." },
          outputDir: { type: "string", minLength: 1, description: "Optional override for the output directory." },
          deviceId: { type: "string", pattern: "^[a-zA-Z0-9.:_-]+$", description: "Optional adb device ID for Android profile matching, capture, and normalized preCapture taps." },
          pixelmatchThreshold: { type: "number", minimum: 0, maximum: 1, description: "Optional override for pixelmatch threshold." },
          maxDiffPercent: { type: "number", minimum: 0, maximum: 1, description: "Optional override for maximum diff percent." },
          maxRegions: { type: "integer", minimum: 1, maximum: 500, description: "Optional override for max diff regions." },
          maxVlmRegions: { type: "integer", minimum: 0, maximum: 50, description: "Optional override for max VLM regions." },
          includeVlmAnalysis: { type: "boolean", description: "Set true to ask local Ollama/VLM to explain each changed region. Requires Ollama or returns fallback statuses." },
          requireVlmAnalysis: { type: "boolean", description: "When true, fail early if VLM analysis is requested but no model can be loaded." },
          vlmPolicy: { type: "string", enum: ["disabled", "optional", "required", "ask_user"], description: "Optional VLM availability policy override. Defaults to disabled when includeVlmAnalysis is false, required when requireVlmAnalysis is true, otherwise ask_user when VLM is requested." },
          autoIgnore: {
            type: "object",
            description: "Controls runtime-generated masks. Generated masks are reported as autoMaskedRegions and are not written to config.",
            properties: {
              enabled: { type: "boolean" },
              screenshotOutOfBounds: { type: "boolean" },
              systemBars: { type: "boolean" },
              edgePanels: { type: "boolean" }
            }
          },
          appContentBounds: {
            type: "object",
            description: "Optional app-owned content bounds used for stale/system artifact suggestions.",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number", exclusiveMinimum: 0 },
              height: { type: "number", exclusiveMinimum: 0 },
              coordinateSpace: { type: "string", enum: ["normalized", "expected", "actual"] }
            },
            required: ["x", "y", "width", "height"]
          },
          preCapture: {
            type: "array",
            description: "Optional preCapture override. Safe navigation steps run before capture when actualImage is omitted.",
            items: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["adbShell"] },
                    command: { type: "string", minLength: 1 },
                    description: { type: "string", minLength: 1 }
                  },
                  required: ["type", "command", "description"]
                },
                {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["adbTapNormalized"] },
                    x: { type: "number", minimum: 0, maximum: 1 },
                    y: { type: "number", minimum: 0, maximum: 1 },
                    description: { type: "string", minLength: 1 }
                  },
                  required: ["type", "x", "y", "description"]
                }
              ]
            }
          },
          regionsOfInterest: {
            type: "array",
            description: "Optional ROI override. Component or zone regions scored separately from global diff.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                label: { type: "string", minLength: 1 },
                type: { type: "string", enum: ["component", "zone"] },
                critical: { type: "boolean" },
                weight: { type: "number", minimum: 0 },
                coordinateSpace: { type: "string", enum: ["normalized", "expected", "actual"] },
                box: {
                  type: "object",
                  properties: {
                    x: { type: "number" },
                    y: { type: "number" },
                    width: { type: "number", exclusiveMinimum: 0 },
                    height: { type: "number", exclusiveMinimum: 0 }
                  },
                  required: ["x", "y", "width", "height"]
                },
                maxDiffPercent: { type: "number", minimum: 0, maximum: 1 }
              },
              required: ["id", "label", "type", "box"]
            }
          },
          visualAssertions: {
            type: "array",
            description: "Optional visual assertion override.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                type: { type: "string", enum: ["roiMaxDiffPercent"] },
                roiId: { type: "string", minLength: 1 },
                maxDiffPercent: { type: "number", minimum: 0, maximum: 1 },
                severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
                message: { type: "string", minLength: 1 }
              },
              required: ["id", "type", "roiId", "maxDiffPercent", "severity", "message"]
            }
          },
          floorDetection: {
            type: "object",
            description: "Optional floor detection override.",
            properties: {
              enabled: { type: "boolean", default: true },
              deltaThreshold: { type: "number", minimum: 0, default: 0.0001 },
              consecutiveRuns: { type: "integer", minimum: 1, default: 2 }
            }
          },
          hotspotDetection: {
            type: "object",
            description: "Optional local hotspot reporting override.",
            properties: {
              enabled: { type: "boolean", default: true },
              maxHotspots: { type: "integer", minimum: 1, maximum: 50, default: 3 },
              minAreaPercent: { type: "number", minimum: 0, maximum: 1, default: 0.02 },
              minDiffDensity: { type: "number", minimum: 0, maximum: 1, default: 0.10 }
            }
          },
          vlm: {
            type: "object",
            description: "Optional VLM overrides for this run.",
            properties: {
              provider: { type: "string", enum: ["ollama"] },
              baseUrl: { type: "string", minLength: 1 },
              model: { type: "string", minLength: 1 },
              fallbackModels: { type: "array", items: { type: "string", minLength: 1 } },
              keepAlive: { type: "string", minLength: 1 },
              preflight: { type: "boolean" },
              require: { type: "boolean" },
              autoPull: { type: "boolean" },
              timeoutMs: { type: "integer", minimum: 1 }
            }
          },
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
                reason: { type: "string", description: "Optional human-readable reason for masking this region." },
                type: { type: "string", enum: ["system", "data", "dynamic"], description: "Mask category. system for OS chrome, data for live fixture mismatches, dynamic for loading/timestamps/ads." },
                coordinateSpace: { type: "string", enum: ["expected", "actual", "normalized"], description: "Coordinate space used for x/y/width/height. Use coordinateSpace:\"actual\" for device screenshot coordinates. Use coordinateSpace:\"normalized\" for proportional masks. Default is \"expected\"." }
              },
              required: ["x", "y", "width", "height"]
            }
          },
          dataRegions: {
            type: "array",
            description: "Optional dynamic data regions to mask as type:data while still warning on critical ROI overlap.",
            items: {
              type: "object",
              properties: {
                x: { type: "integer", minimum: 0 },
                y: { type: "integer", minimum: 0 },
                width: { type: "integer", minimum: 1 },
                height: { type: "integer", minimum: 1 },
                reason: { type: "string" },
                type: { type: "string", enum: ["system", "data", "dynamic"] },
                coordinateSpace: { type: "string", enum: ["expected", "actual", "normalized"] }
              },
              required: ["x", "y", "width", "height"]
            }
          }
        },
        required: ["screen"]
      }
    },
    {
      name: "discover_stable_regions",
      description: "Run named screen profiles and return non-mutating suggestions for stable/system chrome masks. Suggestions include confidence, risk, reason, and tab/FAB impact warnings.",
      inputSchema: {
        type: "object",
        properties: {
          screenNames: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, description: "Screen names defined in ui-diff.config.json." },
          configPath: { type: "string", minLength: 1, description: "Optional path to ui-diff.config.json. Defaults to ./ui-diff.config.json." },
          outputDir: { type: "string", minLength: 1, description: "Directory where discovery run artifacts are written." }
        },
        required: ["screenNames", "outputDir"]
      }
    },
    {
      name: "vlm_health",
      description: "Check Ollama VLM health, installed/running models, and optionally warm a model.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["ollama"], default: "ollama" },
          baseUrl: { type: "string", minLength: 1, description: "Optional Ollama base URL. Defaults to OLLAMA_BASE_URL or http://localhost:11434." },
          model: { type: "string", minLength: 1, description: "Optional model name. Defaults to OLLAMA_MODEL or qwen2.5vl:7b." },
          fallbackModels: { type: "array", items: { type: "string", minLength: 1 }, description: "Optional list of fallback models to check." },
          checkLoad: { type: "boolean", default: true, description: "When true, attempt to warm the selected model." },
          keepAlive: { type: "string", minLength: 1, default: "10m", description: "Keep-alive duration passed to Ollama warmup." },
          timeoutMs: { type: "integer", minimum: 1, default: 30000, description: "Timeout in milliseconds for health checks." }
        }
      }
    }
  ];
}

export function createServer() {
  const server = new Server(
    { name: "mobile-ui-diff-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: getToolList()
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      switch (request.params.name) {
        case "compare_images": {
          const args = compareImagesSchema.parse(request.params.arguments);
          const result = await compareImages(args);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "capture_android_screenshot": {
          const args = captureAndroidSchema.parse(request.params.arguments);
          const result = await captureAndroidScreenshot(args.outputPath, args.deviceId);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "calibrate_android_device": {
          const args = calibrateAndroidDeviceSchema.parse(request.params.arguments);
          const result = await calibrateAndroidDevice(args);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "capture_ios_simulator_screenshot": {
          const args = captureIosSchema.parse(request.params.arguments);
          const result = await captureIosSimulatorScreenshot(args.outputPath, args.simulator);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "run_mobile_ui_diff": {
          const args = runMobileUiDiffSchema.parse(request.params.arguments);
          const result = await runMobileUiDiff(args);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "run_screen_ui_diff": {
          const args = runScreenUiDiffSchema.parse(request.params.arguments);
          const result = await runScreenUiDiff(args);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "discover_stable_regions": {
          const args = discoverStableRegionsSchema.parse(request.params.arguments);
          const result = await discoverStableRegions(args);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "vlm_health": {
          const args = vlmHealthSchema.parse(request.params.arguments);
          const result = await checkOllamaHealth(args);
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
