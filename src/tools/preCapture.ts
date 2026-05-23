import { execFileAsync } from '../utils/exec';
import { PreCaptureResult, PreCaptureStep } from '../types';

const UNSAFE_COMMAND_PATTERN = /[&|;><`$()]/;

function validateAdbShellCommand(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('Unsafe preCapture command: command is empty.');
  }
  if (UNSAFE_COMMAND_PATTERN.test(trimmed)) {
    throw new Error(`Unsafe preCapture command: ${command}`);
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error('Unsafe preCapture command: command is empty.');
  }
  return tokens;
}

export async function runPreCaptureSteps(steps: PreCaptureStep[]): Promise<PreCaptureResult[]> {
  const results: PreCaptureResult[] = [];

  for (const step of steps) {
    if (step.type !== 'adbShell') {
      throw new Error(`Unsupported preCapture type: ${step.type}`);
    }

    const tokens = validateAdbShellCommand(step.command);
    try {
      await execFileAsync('adb', ['shell', ...tokens]);
      results.push({
        description: step.description,
        ok: true,
        command: step.command
      });
    } catch (error: any) {
      results.push({
        description: step.description,
        ok: false,
        command: step.command,
        error: error?.message ?? String(error)
      });
      throw new Error(`Failed preCapture step '${step.description}': ${error?.message ?? String(error)}`);
    }
  }

  return results;
}
