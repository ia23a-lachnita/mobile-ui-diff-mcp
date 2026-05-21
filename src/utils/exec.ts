import { execFile, spawn } from "child_process";
import { promisify } from "util";

export const execFileAsync = promisify(execFile);

export function spawnAndPipe(command: string, args: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const outStream = fs.createWriteStream(outputPath);
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    
    proc.stdout.pipe(outStream);
    
    outStream.on('error', (err: any) => {
      proc.kill();
      reject(err);
    });

    proc.on('close', (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`Command ${command} exited with code ${code}`));
    });

    proc.on('error', (err: any) => {
      reject(err);
    });
  });
}