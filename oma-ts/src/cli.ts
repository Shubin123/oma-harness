#!/usr/bin/env node
/**
 * OMA CLI - command-line entry point.
 *
 * Usage:
 *   oma run "your objective here"
 *   oma status
 *   oma gui
 *   oma web
 *   oma providers
 */

import { parseArgs } from 'node:util';

// ---- commands ----

async function cmdRun(args: string[]): Promise<void> {
  const objective = args[0];
  if (!objective) {
    console.error('Usage: oma run "your objective here" [--criteria JSON] [--resume TASK_ID]');
    process.exit(1);
  }

  let criteria: Record<string, unknown> | undefined;
  let resumeFrom: string | undefined;

  // parse optional flags after the objective
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--criteria' && args[i + 1]) {
      try {
        criteria = JSON.parse(args[i + 1]);
      } catch {
        console.error('Invalid JSON for --criteria');
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--resume' && args[i + 1]) {
      resumeFrom = args[i + 1];
      i++;
    }
  }

  const { OMA } = await import('./agent.js');
  const agent = OMA.fromEnv();

  const result = await agent.run({
    objective,
    criteria,
    resumeFrom,
  });

  console.log(`\nStatus: ${result.status}`);
  console.log(`Confidence: ${(result.confidence * 100).toFixed(0)}%`);
  console.log(`Attempts: ${result.attempts}`);
  console.log(`Tokens used: ${result.tokens_used}`);

  if (result.artifacts.final) {
    console.log(`\n--- Result ---`);
    console.log(result.artifacts.final);
  }

  if (result.context_for_next) {
    console.log(`\n--- Handoff ---`);
    console.log(result.context_for_next);
  }
}

async function cmdStatus(): Promise<void> {
  const { OMA } = await import('./agent.js');
  const agent = OMA.fromEnv();
  const status = agent.status();
  console.log(JSON.stringify(status, null, 2));
}

async function cmdProviders(): Promise<void> {
  const { ProviderRegistry } = await import('./providers/registry.js');
  const reg = ProviderRegistry.fromEnv();
  const names = reg.available();

  if (names.length === 0) {
    console.log('No providers configured. Set environment variables:');
    console.log('  OMA_CLAUDE_KEY, OMA_GEMINI_KEY, OMA_OPENAI_KEY,');
    console.log('  OMA_DEEPSEEK_KEY, OMA_GLM_KEY, OMA_KIMI_KEY');
    return;
  }

  console.log(`Configured providers (${names.length}):`);
  for (const name of names) {
    console.log(`  - ${name}`);
  }

  const chain = reg.fallbackChain();
  console.log(`\nFallback chain: ${chain.join(' -> ')}`);
}

async function cmdWeb(args: string[]): Promise<void> {
  let host = '127.0.0.1';
  let port = 8384;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host' && args[i + 1]) {
      host = args[i + 1];
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
  }

  const { runWeb } = await import('./gui/web.js');
  runWeb(host, port);
}

// ---- main ----

function printHelp(): void {
  console.log(`OMA - Open Multi Agent harness

Usage: oma <command> [options]

Commands:
  run <objective>     Run a task
    --criteria JSON   Success criteria (optional)
    --resume ID       Resume from a previous task ID

  status              Show agent status
  providers           List configured providers

  web                 Launch web dashboard
    --host HOST       Bind address (default: 127.0.0.1)
    --port PORT       Port number (default: 8384)

  help                Show this help message
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case 'run':
      await cmdRun(rest);
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'providers':
      await cmdProviders();
      break;
    case 'web':
      await cmdWeb(rest);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message ?? err);
  process.exit(1);
});
