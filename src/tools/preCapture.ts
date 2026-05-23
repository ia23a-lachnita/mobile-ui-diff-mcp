import { execFileAsync } from '../utils/exec';
import { DeviceSize, PreCaptureResult, PreCaptureStep } from '../types';

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

export async function runPreCaptureSteps(steps: PreCaptureStep[], context: { deviceSize?: DeviceSize; deviceId?: string } = {}): Promise<PreCaptureResult[]> {
  const results: PreCaptureResult[] = [];

  for (const step of steps) {
    let command: string;
    let resolved: PreCaptureResult['resolved'] | undefined;
    if (step.type === 'adbShell') {
      command = step.command;
    } else if (step.type === 'adbTapNormalized') {
      if (!context.deviceSize) {
        throw new Error(`Cannot resolve preCapture step '${step.description}': device size is unknown.`);
      }
      const x = Math.round(step.x * context.deviceSize.width);
      const y = Math.round(step.y * context.deviceSize.height);
      command = `input tap ${x} ${y}`;
      resolved = {
        x,
        y,
        width: context.deviceSize.width,
        height: context.deviceSize.height
      };
    } else {
      throw new Error(`Unsupported preCapture type: ${(step as { type?: string }).type}`);
    }

    const tokens = validateAdbShellCommand(command);
    try {
      const adbArgs = context.deviceId ? ['-s', context.deviceId, 'shell', ...tokens] : ['shell', ...tokens];
      await execFileAsync('adb', adbArgs);
      results.push({
        description: step.description,
        ok: true,
        command,
        resolved
      });
    } catch (error: any) {
      results.push({
        description: step.description,
        ok: false,
        command,
        resolved,
        error: error?.message ?? String(error)
      });
      throw new Error(`Failed preCapture step '${step.description}': ${error?.message ?? String(error)}`);
    }
  }

  return results;
}
