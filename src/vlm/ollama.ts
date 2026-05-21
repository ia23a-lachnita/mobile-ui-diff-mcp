import { VlmAnalysis } from '../types';
import fs from 'fs/promises';

export async function explainDiffUsingOllama(
  expectedCropPath: string,
  actualCropPath: string,
  diffCropPath: string
): Promise<{ analysis: VlmAnalysis | null, status: "ok" | "fallback" | "error" }> {
  const fallbackResponse = (msg: string): { analysis: VlmAnalysis, status: "fallback" } => ({
    status: "fallback",
    analysis: {
      type: 'unknown',
      severity: 'medium',
      description: msg,
      likelyFix: 'Inspect the crop manually.'
    }
  });

  const errorResponse = (msg: string): { analysis: VlmAnalysis, status: "error" } => ({
    status: "error",
    analysis: {
      type: 'unknown',
      severity: 'medium',
      description: msg,
      likelyFix: 'Inspect the crop manually.'
    }
  });

  try {
    const expectedBase64 = (await fs.readFile(expectedCropPath)).toString('base64');
    const actualBase64 = (await fs.readFile(actualCropPath)).toString('base64');
    const diffBase64 = (await fs.readFile(diffCropPath)).toString('base64');

    const prompt = `You are comparing a mobile app implementation against a design mockup. You are given three images: expected crop, actual crop, and diff crop. Return JSON only with: type, severity, description, likelyFix. Be concrete. Prefer layout, spacing, color, text, font, icon, missing, extra, size, or unknown.`;

    const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL || 'qwen2.5vl:7b';
    const timeoutMs = parseInt(process.env.VLM_TIMEOUT_MS || '60000', 10);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: prompt,
              images: [expectedBase64, actualBase64, diffBase64]
            }
          ],
          stream: false,
          format: 'json'
        }),
        signal: controller.signal as any
      });
    } catch (err: any) {
      if (err.name === 'AbortError' || err.type === 'aborted') {
        return fallbackResponse('VLM timeout exceeded.');
      }
      if (err.code === 'ECONNREFUSED' || err.message.includes('fetch failed') || err.message.includes('network')) {
        return fallbackResponse('Ollama unreachable. Is it running?');
      }
      return errorResponse(`Network error: ${err.message}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 404 && text.includes('model')) {
         return fallbackResponse('Ollama model missing. Pull it first.');
      }
      return errorResponse(`Ollama request failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    const content = data?.message?.content;
    if (!content) return errorResponse('VLM returned empty response.');

    try {
      const parsed = JSON.parse(content);
      return {
        status: "ok",
        analysis: {
          type: parsed.type || 'unknown',
          severity: parsed.severity || 'medium',
          description: parsed.description || 'No description provided.',
          likelyFix: parsed.likelyFix || 'Unknown fix.'
        }
      };
    } catch (e) {
      return fallbackResponse('Invalid JSON response from VLM.');
    }
  } catch (error: any) {
    console.error('Failed to explain diff with Ollama:', error);
    return errorResponse(`VLM error: ${error.message}`);
  }
}
