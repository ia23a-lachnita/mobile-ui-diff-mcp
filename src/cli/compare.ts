import { Command, InvalidArgumentError } from 'commander';
import { compareImages } from '../tools/compareImages';

const program = new Command();

function parseJsonOption(name: string) {
  return (value: string) => {
    try {
      return JSON.parse(value);
    } catch (err: any) {
      throw new InvalidArgumentError(`Invalid JSON for --${name}: ${err.message}`);
    }
  };
}

function parseIgnoreRegions(value: string) {
  try {
    return JSON.parse(value);
  } catch (err: any) {
    throw new InvalidArgumentError(`Invalid JSON for --ignoreRegions: ${err.message}`);
  }
}

function parseVlmPolicy(value: string) {
  if (['disabled', 'optional', 'required', 'ask_user'].includes(value)) {
    return value;
  }
  throw new InvalidArgumentError('--vlmPolicy must be one of disabled, optional, required, ask_user');
}

program
  .requiredOption('--expected <path>', 'Expected mockup PNG')
  .requiredOption('--actual <path>', 'Actual implementation PNG')
  .requiredOption('--out <path>', 'Output directory')
  .option('--threshold <number>', 'Legacy Pixelmatch threshold', parseFloat, 0.1)
  .option('--pixelmatchThreshold <number>', 'Pixelmatch threshold', parseFloat, 0.1)
  .option('--maxDiffPercent <number>', 'Max diff percent', parseFloat, 0.001)
  .option('--maxRegions <number>', 'Maximum number of diff regions', (value) => Number.parseInt(value, 10), 50)
  .option('--maxVlmRegions <number>', 'Maximum number of VLM regions', (value) => Number.parseInt(value, 10), 10)
  .option('--ignoreRegions <json>', 'JSON string array of regions to ignore', parseIgnoreRegions)
  .option('--dataRegions <json>', 'JSON string array of dynamic data regions to mask globally', parseJsonOption('dataRegions'))
  .option('--regionsOfInterest <json>', 'JSON string array of ROI configs, including allowedDynamicSubregions', parseJsonOption('regionsOfInterest'))
  .option('--visualAssertions <json>', 'JSON string array of visual assertions', parseJsonOption('visualAssertions'))
  .option('--vlmPolicy <policy>', 'VLM availability policy: disabled, optional, required, or ask_user', parseVlmPolicy)
  .option('--vlm', 'Include VLM Analysis via Ollama')
  .action(async (options) => {
    try {
      const report = await compareImages({
        expectedImage: options.expected,
        actualImage: options.actual,
        outputDir: options.out,
        pixelmatchThreshold: options.pixelmatchThreshold ?? options.threshold,
        maxDiffPercent: options.maxDiffPercent,
        maxRegions: options.maxRegions,
        maxVlmRegions: options.maxVlmRegions,
        ignoreRegions: options.ignoreRegions,
        dataRegions: options.dataRegions,
        regionsOfInterest: options.regionsOfInterest,
        visualAssertions: options.visualAssertions,
        vlmPolicy: options.vlmPolicy,
        includeVlmAnalysis: options.vlm
      });
      console.log(JSON.stringify(report, null, 2));
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  });

program.parse();
