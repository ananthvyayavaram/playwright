#!/usr/bin/env node
// CLI wrapper for manually running AI locator repair on a single failing spec.
//
// Usage:
//   npx tsx scripts/repair.ts --spec tests/Login/login.test.ts --url https://yourapp.com
//   npx tsx scripts/repair.ts --spec <path> --url <url> --error "locator not found" --headed

import 'dotenv/config';
import { assertAuthConfigured } from '../src/ai/anthropic-client';
import fs from 'fs/promises';
import path from 'path';

function parseArgs(argv: string[]): { flags: Record<string, string | boolean>; poms: string[] } {
  const flags: Record<string, string | boolean> = {};
  const poms: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key  = arg.slice(2);
    const next = argv[i + 1];
    if (key === 'pom') { if (next && !next.startsWith('--')) { poms.push(next); i++; } }
    else if (!next || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { flags, poms };
}

async function main() {
  const { flags: args, poms } = parseArgs(process.argv.slice(2));

  if (!args['spec'] || !args['url']) {
    console.error('Usage: npx tsx scripts/repair.ts --spec <path> --url <url> [options]\n');
    console.error('Options:');
    console.error('  --pom <path>   POM file to include in repair context (repeatable)');
    console.error('  --error        Inline error message');
    console.error('  --error-file   Path to file with error output');
    console.error('  --headed       Run browser in headed mode');
    console.error('  --model        Model to use (default: claude-sonnet-5)');
    process.exit(1);
  }

  assertAuthConfigured();

  let errorOutput = '';
  if (args['error']) {
    errorOutput = args['error'] as string;
  } else if (args['error-file']) {
    errorOutput = await fs.readFile(args['error-file'] as string, 'utf-8').catch(() => '');
  }

  // Dynamic import so the AI module tree is only loaded when needed.
  const { repairFlow } = await import('../src/ai/repair-flow');

  const result = await repairFlow({
    specPath:    args['spec'] as string,
    url:         args['url']  as string,
    errorOutput,
    pomPaths:    poms,
    headless:    !args['headed'],
    model:       (args['model'] as string) || 'claude-sonnet-5',
    verbose:     true,
  }).catch(err => {
    console.error('\nRepair failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });

  if (result.fixed) {
    console.log('\n✓ Repair complete!');
    console.log(`  Spec: ${result.specPath}`);
    for (const f of result.fixedFiles) console.log(`  Fixed: ${f.path}`);
    console.log(`\nVerify: npx playwright test ${result.specPath}`);
  } else {
    console.error('\n✗ Repair failed — could not produce a fixed file.');
    console.error('  Try --headed to see what the browser is doing.');
    process.exit(1);
  }
}

main();
