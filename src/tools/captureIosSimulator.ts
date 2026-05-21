import * as path from 'path';
import { execFileAsync } from '../utils/exec';
import { resolveAbsolutePath, ensureDir } from '../utils/fs';

export async function captureIosSimulatorScreenshot(outputPath: string, simulator: string = 'booted'): Promise<{ outputPath: string }> {
  try {
    const absPath = resolveAbsolutePath(outputPath);
    await ensureDir(path.dirname(absPath));
    
    if (!simulator || simulator.trim() === '') {
       simulator = 'booted';
    }
    if (!/^[a-zA-Z0-9.\-:_]+$/.test(simulator)) {
      throw new Error(`Invalid simulator identifier format`);
    }
    
    await execFileAsync('xcrun', ['simctl', 'io', simulator, 'screenshot', absPath]);
    return { outputPath: absPath };
  } catch (err: any) {
    throw new Error(`Failed to capture iOS simulator screenshot: ${err.message}`);
  }
}
