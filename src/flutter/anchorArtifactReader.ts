import fs from 'fs/promises';
import path from 'path';
import { parseFlutterAnchorDump } from './anchorDumpParser';
import type { AnchorArtifactResult, ParsedAnchorDump } from './types';

export interface AnchorArtifactReaderOptions {
  /**
   * Path to the Flutter anchor artifact. Accepts either:
   *   - A directory containing flutter-anchors.json (and optionally flutter-anchors.done)
   *   - A direct path to the flutter-anchors.json file itself
   */
  artifactDir: string;
  /** Total wait budget in ms (default: 15000) */
  timeoutMs?: number;
  /** Poll interval in ms (default: 200) */
  pollIntervalMs?: number;
  /** Min stable polls before accepting (default: 2) */
  stablePollCount?: number;
  /** Minimum visibility fraction to consider an anchor visible (default: 0.01) */
  visibilityThreshold?: number;
}

const JSON_FILE = 'flutter-anchors.json';
const DONE_FILE = 'flutter-anchors.done';

async function fileSize(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return null;
  }
}

async function doneFileExists(artifactDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(artifactDir, DONE_FILE));
    return true;
  } catch {
    return false;
  }
}

async function tryParseJson(filePath: string): Promise<unknown | null> {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Wait for a Flutter anchor artifact to be ready, then parse and validate it.
 *
 * Protocol:
 *   1. Poll until flutter-anchors.done exists OR file is stable across stablePollCount polls.
 *   2. Require file exists with size > 0.
 *   3. Require JSON parse succeeds.
 *   4. Require schema validates.
 *
 * Returns anchor_artifact_timeout on timeout, invalid_anchor_dump on bad content.
 */
export async function waitForAnchorArtifact(opts: AnchorArtifactReaderOptions): Promise<AnchorArtifactResult> {
  const {
    artifactDir,
    timeoutMs = 15000,
    pollIntervalMs = 200,
    stablePollCount = 2
  } = opts;

  // Support direct file path as well as directory.
  let jsonPath: string;
  let baseDir: string;
  try {
    const stat = await fs.stat(artifactDir);
    if (stat.isFile()) {
      jsonPath = artifactDir;
      baseDir = path.dirname(artifactDir);
    } else {
      jsonPath = path.join(artifactDir, JSON_FILE);
      baseDir = artifactDir;
    }
  } catch {
    // Path does not exist yet — assume directory, polling will wait for file to appear.
    jsonPath = path.join(artifactDir, JSON_FILE);
    baseDir = artifactDir;
  }

  // Direct file path: parse immediately without polling.
  if (jsonPath === artifactDir) {
    return attemptParse(jsonPath);
  }

  const deadline = Date.now() + timeoutMs;

  let consecutiveStable = 0;
  let lastSize: number | null = null;

  while (Date.now() < deadline) {
    const done = await doneFileExists(baseDir);
    const size = await fileSize(jsonPath);

    if (done && size !== null && size > 0) {
      // Done flag present and file has content — proceed immediately.
      return attemptParse(jsonPath);
    }

    if (size !== null && size > 0) {
      if (size === lastSize) {
        consecutiveStable++;
        if (consecutiveStable >= stablePollCount) {
          // File is stable without a done flag — attempt parse.
          return attemptParse(jsonPath);
        }
      } else {
        consecutiveStable = 1;
      }
      lastSize = size;
    } else {
      consecutiveStable = 0;
      lastSize = null;
    }

    await sleep(pollIntervalMs);
  }

  return {
    status: 'anchor_artifact_timeout',
    error: `Timed out after ${timeoutMs}ms waiting for ${JSON_FILE} in ${baseDir}`
  };
}

async function attemptParse(jsonPath: string): Promise<AnchorArtifactResult> {
  const raw = await tryParseJson(jsonPath);
  if (raw === null) {
    return {
      status: 'invalid_anchor_dump',
      error: `Failed to parse JSON from ${jsonPath}`
    };
  }

  const result = parseFlutterAnchorDump(raw);
  if (!result.ok) {
    return {
      status: 'invalid_anchor_dump',
      error: result.message
    };
  }

  return { status: 'ready', parsed: result.data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
