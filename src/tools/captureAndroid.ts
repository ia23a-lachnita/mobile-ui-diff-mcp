import * as path from 'path';
import { spawnAndPipe } from '../utils/exec';
import { resolveAbsolutePath, ensureDir } from '../utils/fs';

export async function captureAndroidScreenshot(outputPath: string, deviceId?: string): Promise<{ outputPath: string }> {
  try {
    const absPath = resolveAbsolutePath(outputPath);
    await ensureDir(path.dirname(absPath));
    
    if (deviceId && !/^[a-zA-Z0-9.:_-]+$/.test(deviceId)) {
      throw new Error(`Invalid deviceId format`);
    }
    
    const args = deviceId ? ['-s', deviceId, 'exec-out', 'screencap', '-p'] : ['exec-out', 'screencap', '-p'];
    
    await spawnAndPipe('adb', args, absPath);
    return { outputPath: absPath };
  } catch (err: any) {
    throw new Error(`Failed to capture Android screenshot: ${err.message}`);
  }
}
