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
import { IS_WINDOWS } from './platformCompat.js';

// ---- commands ----

async function cmdRun(args: string[]): Promise<void> {
  const objective = args[0];
  if (!objective) {
    console.error('Usage: oma run "your objective here" [--criteria JSON] [--resume TASK_ID]');
    process.exit(1);
  }

  let criteria: Record<string, unknown> | undefined;
  let resumeFrom: string | undefined;
  let forceProvider: string | undefined;
  let forceTier: string | undefined;
  let offline = false;

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
    } else if (args[i] === '--provider' && args[i + 1]) {
      forceProvider = args[i + 1].toLowerCase();
      i++;
    } else if (args[i] === '--tier' && args[i + 1]) {
      forceTier = args[i + 1].toLowerCase();
      i++;
    } else if (args[i] === '--offline') {
      offline = true;
    }
  }

  const { OMA } = await import('./agent.js');
  const agent = OMA.load();

  if (offline) {
    agent.config.provider_chain = [];
  } else if (forceProvider) {
    agent.config.provider_chain = [forceProvider];
  } else if (forceTier) {
    agent.router.strategy = 'tiered';
    const tierProviders = agent.router.tiers?.[forceTier];
    if (tierProviders?.length) {
      agent.config.provider_chain = [...tierProviders];
    }
  }

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
  const agent = OMA.load();
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

async function cmdStart(args: string[]): Promise<void> {
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

  const { AuthManager } = await import('./providers/auth.js');
  const mgr = new AuthManager();
  const stored = mgr.status();
  const loggedIn = Object.keys(stored).filter(k => stored[k]?.status === 'logged_in');

  console.log('='.repeat(70));
  console.log('           OMA - Open Multi Agent System Running (Node)');
  console.log('='.repeat(70));
  console.log(`  * Web GUI Dashboard:  http://${host}:${port}`);
  console.log(`  * REST API Status:    http://${host}:${port}/api/status`);
  if (loggedIn.length > 0) {
    console.log(`  * Active Providers:   ${loggedIn.join(', ')}`);
  } else {
    console.log('  * Active Providers:   None yet (connect in Web Dashboard or via \'oma auth add\')');
  }
  const info = mgr.storageInfo();
  console.log(`  * Local Vault:        ${info.file} (mode: ${info.mode || '0600'})`);
  console.log('-'.repeat(70));
  console.log('Ready to process tasks and workflows. Press Ctrl+C to stop.\n');

  const { runWeb } = await import('./gui/web.js');
  runWeb(host, port);
}

async function cmdAuth(args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';
  const { AuthManager } = await import('./providers/auth.js');
  const mgr = new AuthManager();

  if (sub === 'add') {
    const provider = args[1]?.toLowerCase();
    const key = args[2];
    if (!provider || !key) {
      console.error('Usage: oma auth add <provider> <key_or_token> [--type auto|cookie|token|api_key] [--email email] [--plan plan]');
      process.exit(1);
    }
    let authType = 'auto';
    let email: string | undefined;
    let plan: string | undefined;
    for (let i = 3; i < args.length; i++) {
      if (args[i] === '--type' && args[i + 1]) { authType = args[i + 1]; i++; }
      else if (args[i] === '--email' && args[i + 1]) { email = args[i + 1]; i++; }
      else if (args[i] === '--plan' && args[i + 1]) { plan = args[i + 1]; i++; }
    }
    const cred = mgr.storeCredential(provider, key, { authType, email, plan });
    console.log(`Stored ${provider} credential securely (auth_type: ${cred.auth_type}).`);

  } else if (sub === 'remove') {
    const provider = args[1]?.toLowerCase();
    if (!provider) {
      console.error('Usage: oma auth remove <provider>');
      process.exit(1);
    }
    mgr.logout(provider);
    console.log(`Removed credential for ${provider}.`);

  } else if (sub === 'verify') {
    const provider = args[1]?.toLowerCase();
    const providersToTest = provider ? [provider] : Object.keys(mgr.store.allProviders());
    if (providersToTest.length === 0) {
      console.log('No stored credentials to verify.');
      return;
    }
    const { verifyToken: vToken } = await import('./gui/web.js');
    for (const p of providersToTest) {
      const cred = mgr.getCredential(p);
      if (!cred) {
        console.log(`  ${p}: No credential stored.`);
        continue;
      }
      const [ok, detail] = await vToken(p, cred.value);
      const icon = ok ? 'OK' : 'FAILED';
      console.log(`  ${p}: ${icon} (${detail})`);
    }

  } else if (sub === 'flush') {
    let provider: string | undefined;
    let includeMemory = false;

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--provider' && args[i + 1]) { provider = args[i + 1].toLowerCase(); i++; }
      else if (args[i] === '--include-memory') includeMemory = true;
    }

    if (provider) {
      mgr.logout(provider);
      console.log(`Flushed credential for ${provider}.`);
    } else {
      const res = mgr.flush(includeMemory);
      console.log(`Securely flushed ${res.flushedCredentialsCount} credentials from ${res.credentialsFile}.`);
      if (res.memoryFilesRemoved > 0) {
        console.log(`Removed ${res.memoryFilesRemoved} persistent task memory files.`);
      }
    }

  } else if (sub === 'info') {
    const info = mgr.storageInfo() as Record<string, unknown>;
    console.log('OMA Safe Storage Information:');
    console.log(`  Credentials File:    ${info.credentials_file}`);
    console.log(`  Directory:           ${info.credentials_dir}`);
    console.log(`  File Exists:         ${info.file_exists}`);
    if (info.file_exists) {
      console.log(`  File Size:           ${info.size_bytes} bytes`);
      const fileNote = IS_WINDOWS ? '' : ' (owner-only: rw-------)';
      const dirNote = IS_WINDOWS ? '' : ' (owner-only: rwx------)';
      console.log(`  File Mode:           ${info.file_permissions}${fileNote}`);
      console.log(`  Directory Mode:      ${info.dir_permissions}${dirNote}`);
    }
    console.log(`  Encryption:          ${info.encryption}`);
    console.log(`  Stored Providers:    ${info.provider_count}`);
    const providers = (info.providers ?? {}) as Record<string, Record<string, unknown>>;
    for (const [p, pinfo] of Object.entries(providers)) {
      const exp = pinfo.is_expired ? ' (EXPIRED)' : '';
      const email = pinfo.email ? ` email=${pinfo.email}` : '';
      const plan = pinfo.plan ? ` plan=${pinfo.plan}` : '';
      console.log(`    - ${p}: type=${pinfo.auth_type}${email}${plan} [${pinfo.masked_value}]${exp}`);
    }
    console.log('\nHow to delete:');
    console.log('  - Single provider:   oma auth remove <provider>');
    console.log('  - All credentials:   oma auth flush --all');
    console.log('  - All + Task memory: oma auth flush --all --include-memory');
    console.log(IS_WINDOWS
      ? `  - Manual purge:      del "${info.credentials_file}" && rmdir /s /q .oma_memory`
      : '  - Manual purge:      rm -f ~/.oma/credentials.json && rm -rf .oma_memory/');

  } else if (sub === 'status' || sub === 'list') {
    const st = mgr.status();
    console.log('OMA Stored Credentials:');
    for (const [name, info] of Object.entries(st)) {
      const statusText = (info as Record<string, unknown>).status ?? 'unknown';
      const cred = mgr.getCredential(name);
      const extra: string[] = [];
      if ((info as Record<string, unknown>).email) extra.push(`email=${(info as Record<string, unknown>).email}`);
      if ((info as Record<string, unknown>).plan) extra.push(`plan=${(info as Record<string, unknown>).plan}`);
      if (cred) extra.push(`type=${cred.auth_type}`);
      const extraStr = extra.length > 0 ? ` (${extra.join(', ')})` : '';
      console.log(`  - ${name}: ${statusText}${extraStr}`);
    }
  } else {
    console.error(`Unknown auth command: ${sub}`);
    process.exit(1);
  }
}

async function cmdMemory(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const { PersistentMemory } = await import('./automation/memory.js');
  const mem = new PersistentMemory('.oma_memory');

  if (sub === 'list') {
    const tasks = mem.listTasks();
    if (tasks.length === 0) {
      console.log('No tasks stored in persistent memory (.oma_memory).');
    } else {
      console.log(`Stored tasks in .oma_memory (${tasks.length}):`);
      for (const t of tasks.sort()) {
        console.log(`  - ${t}`);
      }
    }
  } else if (sub === 'flush') {
    let taskId: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--task-id' && args[i + 1]) { taskId = args[i + 1]; i++; }
    }
    const count = mem.flush(taskId);
    if (taskId) {
      console.log(`Flushed task '${taskId}' from memory.`);
    } else {
      console.log(`Flushed ${count} task memory files from .oma_memory.`);
    }
  }
}

async function cmdDemo(): Promise<void> {
  console.log('='.repeat(70));
  console.log('            OMA - Open Multi Agent Onboarding Demo');
  console.log('='.repeat(70));
  console.log('\nWelcome to OMA! This interactive walkthrough demonstrates how OMA');
  console.log('coordinates multiple AI subscriptions and API keys with autonomous self-healing.\n');

  console.log('[1/5] Core Architecture:');
  console.log('  * Zero-markup side-channel: connects to personal subscription sessions');
  console.log('    (Claude, ChatGPT, Gemini) or standard API keys (DeepSeek, GLM, Kimi).');
  console.log('  * Encrypted vault: credentials stored locally in ~/.oma/credentials.json');
  console.log('    with owner-only (0600) file permissions.');

  console.log('\n[2/5] Initializing Provider Registry & Router:');
  const { Router } = await import('./core/router.js');
  const router = new Router({ strategy: 'auto' });
  console.log(`  * Active routing strategy: '${router.strategy}'`);
  const candidates = ['claude', 'gemini', 'deepseek'];
  const chosen = router.select(candidates);
  console.log(`  * Selected primary provider: ${chosen}`);

  console.log('\n[3/5] Testing Resilience & Circuit Breaker:');
  const { CircuitBreaker } = await import('./core/router.js');
  const cb = new CircuitBreaker({
    failure_threshold: 3,
    degradation_pct: 0.5,
    recovery_timeout_s: 0.1,
    backoff_multiplier: 1.5,
    max_backoff_multiplier: 5,
  });
  console.log('  * Simulating upstream rate-limit error on primary provider...');
  cb.recordFailure(true);
  console.log(`  * CircuitBreaker state: ${cb.state.toUpperCase()} (tripped on errors)`);
  const fallback = candidates.filter(c => c !== chosen)[0];
  console.log(`  * Router dynamic failover to next provider: ${fallback}`);
  cb.state = 'half_open';
  cb.recordSuccess();
  console.log(`  * Self-healing probe succeeded -> Breaker restored: ${cb.state.toUpperCase()}`);

  console.log('\n[4/5] Testing Output Sanitizer:');
  const { Sanitizer } = await import('./core/sanitize.js');
  const sanitizer = new Sanitizer();
  const rawSample = "Anthropic's Claude generated this solution.\nVerified architecture \u2014 latency reduced: \u2018optimal\u2019.";
  const cleanSample = sanitizer.run(rawSample);
  console.log(`  * Raw input:\n    ${rawSample.replace(/\n/g, '\n    ')}`);
  console.log(`  * Sanitized:\n    ${cleanSample.replace(/\n/g, '\n    ')}`);
  console.log('  * Stripped provider fingerprints, straightened curly quotes, normalized em dashes.');

  console.log('\n[5/5] Autonomous RALPH Execution (Simulated):');
  console.log("  * Objective: 'Generate resilient multi-provider routing schema'");
  console.log("  * Criteria: {'throughput': 'high', 'resilience': true}");
  console.log('  * [REASON] Iteration 1: Decomposing criteria and planning execution...');
  console.log('  * [ACT]    Attempt 1 via Claude -> candidate draft (confidence: 0.68)');
  console.log('  * [LEARN]  Confidence 0.68 < threshold 0.85 -> Extracting failure notes...');
  console.log('  * [PLAN]   Rotating provider preference to Gemini for iteration 2...');
  console.log('  * [REASON] Iteration 2: Applying lessons learned from iteration 1...');
  console.log('  * [ACT]    Attempt 2 via Gemini -> refined solution (confidence: 0.94)');
  console.log('  * [LEARN]  Confidence 0.94 >= threshold 0.85 -> Criteria gates PASSED!');
  console.log('  * [HANDOFF] Final verified artifact stored in memory.');

  console.log('\n' + '='.repeat(70));
  console.log('Onboarding Demo Complete!');
  console.log('\nNext steps to get started:');
  console.log('  * Web Dashboard:  oma web           (graphical UI with workflow studio)');
  console.log('  * Add Credential: oma auth add <provider> <key_or_session>');
  console.log('  * Verify Stored:  oma auth verify');
  console.log('  * Run Task:       oma run "your objective here"');
  console.log('='.repeat(70));
}

// ---- main ----

function printHelp(): void {
  console.log(`OMA - Open Multi Agent harness

Usage: oma <command> [options]

Commands:
  run <objective>     Run a task
    --criteria JSON   Success criteria (optional)
    --resume ID       Resume from a previous task ID
    --provider NAME   Force specific provider (e.g. gemini, deepseek, jev)
    --tier TIER       Use specific routing tier (t1, t2, t3)
    --offline         Force offline self-healing simulation mode

  status              Show agent status
  providers           List configured providers

  auth <subcommand>   Manage authentication credentials
    add <p> <key>     Add/update provider credential
    remove <p>        Remove provider credential
    flush             Securely wipe stored credentials
    info              Show storage paths, permissions, and security
    status            List stored credentials

  memory <subcommand> Manage persistent task memory
    list              List stored tasks
    flush             Flush persistent task memory

  web                 Launch web dashboard
    --host HOST       Bind address (default: 127.0.0.1)
    --port PORT       Port number (default: 8384)

  start               Start the whole OMA system (server + dashboard)
    --host HOST       Bind address (default: 127.0.0.1)
    --port PORT       Port number (default: 8384)

  demo                Run interactive onboarding demo
  help                Show this help message

Tip: New to OMA? Run 'oma demo' for a guided tour, or 'oma start' to launch the whole system.
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
    case 'auth':
      await cmdAuth(rest);
      break;
    case 'memory':
      await cmdMemory(rest);
      break;
    case 'web':
      await cmdWeb(rest);
      break;
    case 'start':
      await cmdStart(rest);
      break;
    case 'demo':
      await cmdDemo();
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
