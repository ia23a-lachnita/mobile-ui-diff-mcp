const fs = require('fs');

let content = fs.readFileSync('src/mcp/server.ts', 'utf8');

const s1 = `inputSchema: {
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
          }`;

const s2 = `inputSchema: {
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
          }`;

content = content.replace(/inputSchema:\s*\{\s*type:\s*"object",\s*properties:\s*\{\s*expectedImage[\s\S]*?required:\s*\["expectedImage",\s*"actualImage",\s*"outputDir"\]\s*\}/, s1);

content = content.replace(/inputSchema:\s*\{\s*type:\s*"object",\s*properties:\s*\{\s*platform[\s\S]*?required:\s*\["platform",\s*"expectedImage",\s*"outputDir"\]\s*\}/, s2);

fs.writeFileSync('src/mcp/server.ts', content);