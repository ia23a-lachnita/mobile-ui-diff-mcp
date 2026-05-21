import { execAsync } from '../utils/exec';
import { resolveAbsolutePath } from '../utils/fs';

export async function captureIosSimulatorScreenshot(outputPath: string, simulator: string = 'booted'): Promise<{ outputPath: string }> {
  try {
    const absPath = resolveAbsolutePath(outputPath);
    await execAsync(`xcrun simctl io ${simulator} screenshot "${absPath}"`);
    return { outputPath: absPath };
  } catch (err: any) {
    throw new Error(`Failed to capture iOS simulator screenshot: ${err.message}`);
  }
}
