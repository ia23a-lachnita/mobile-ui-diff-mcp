import { Command } from 'commander';
import { compareImages } from '../tools/compareImages';

const program = new Command();

program
  .requiredOption('--expected <path>', 'Expected mockup PNG')
  .requiredOption('--actual <path>', 'Actual implementation PNG')
  .requiredOption('--out <path>', 'Output directory')
  .option('--threshold <number>', 'Legacy Pixelmatch threshold', parseFloat, 0.1)
  .option('--pixelmatchThreshold <number>', 'Pixelmatch threshold', parseFloat, 0.1)
  .option('--maxDiffPercent <number>', 'Max diff percent', parseFloat, 0.001)
  .option('--maxRegions <number>', 'Maximum number of diff regions', parseInt, 50)
  .option('--maxVlmRegions <number>', 'Maximum number of VLM regions', parseInt, 10)
  .option('--ignoreRegions <json>', 'JSON string array of regions to ignore', JSON.parse)
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
        includeVlmAnalysis: options.vlm
      });
      console.log(JSON.stringify(report, null, 2));
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  });

program.parse();
