import { VlmAnalysis } from '../types';
import fs from 'fs/promises';

export async function explainDiffUsingOllama(
  expectedCropPath: string,
  actualCropPath: string,
  diffCropPath: string
): Promise<VlmAnalysis> {
  const defaultResponse: VlmAnalysis = {
    type: "unknown",
    severity: "medium",
    description: "VLM response could not be parsed.",
    likelyFix: "Inspect the crop manually."
  };

  try {
    const expectedBase64 = (await fs.readFile(expectedCropPath)).toString('base64');
    const actualBase64 = (await fs.readFile(actualCropPath)).toString('base64');
    const diffBase64 = (await fs.readFile(diffCropPath)).toString('base64');

    const prompt = `You are comparing a mobile app implementation against a design mockup. You are given three images: expected crop, actual crop, and diff crop. Return JSON only with: type, severity, description, likelyFix. Be concrete. Prefer layout, spacing, color, text, font, icon, missing, extra, size, or unknown.`;

    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5vl:7b',
        messages: [
          {
            role: 'user',
            content: prompt,
            images: [expectedBase64, actualBase64, diffBase64]
          }
        ],
        stream: false,
        format: 'json'
      })
    });

    if (!response.ok) {
        console.warn(`Ollama request failed: ${response.status} ${response.statusText}`);
        return defaultResponse;
    }

    const data = await response.json();
    const content = data?.message?.content;
    if (!content) return defaultResponse;

    const parsed = JSON.parse(content);
    return {
      type: parsed.type || "unknown",
      severity: parsed.severity || "medium",
      description: parsed.description || "No description provided.",
      likelyFix: parsed.likelyFix || "Unknown fix."
    };
  } catch (error) {
    console.error("Failed to explain diff with Ollama:", error);
    return defaultResponse;
  }
}
