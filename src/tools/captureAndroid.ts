import { execAsync } from '../utils/exec';
import { resolveAbsolutePath } from '../utils/fs';

export async function captureAndroidScreenshot(outputPath: string, deviceId?: string): Promise<{ outputPath: string }> {
  try {
    const absPath = resolveAbsolutePath(outputPath);
    const deviceSpecifier = deviceId ? `-s ${deviceId}` : '';
    
    // Some devices might require intermediate format or saving locally then pulling,
    // but `exec-out` directly works well for most modern ones.
    await execAsync(`adb ${deviceSpecifier} exec-out screencap -p > "${absPath}"`);
    return { outputPath: absPath };
  } catch (err: any) {
    throw new Error(`Failed to capture Android screenshot: ${err.message}`);
  }
}
