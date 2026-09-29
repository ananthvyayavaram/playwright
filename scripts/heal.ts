#!/usr/bin/env node
// Heal failing tests one spec at a time.
//
// Default:         reads test-results/last-failed.json and heals each spec
// Path argument:   targets a specific spec file or folder
// --headed:        launch browser in headed mode during repair
//
// Usage:
//   npx tsx scripts/heal.ts                          # heal last-failed
//   npx tsx scripts/heal.ts tests/Login              # heal all in folder
//   npx tsx scripts/heal.ts tests/Login/login.test.ts
//   pfqa heal
//   pfqa heal tests/Login

import 'dotenv/config';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const cliArgs = process.argv.slice(2);
const headed  = cliArgs.includes('--headed') || cliArgs.includes('headed');
const target  = cliArgs.filter(a => !a.startsWith('--') && a !== 'headed')[0];

const lastFailedPath = path.join(process.cwd(), 'test-results', 'last-failed.json');

function findSpecsInFolder(folderPath: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(folderPath)) {
    const full = path.join(folderPath, entry);
    if (statSync(full).isDirectory()) results.push(...findSpecsInFolder(full));
    else if (/\.(test|spec)\.ts$/.test(entry)) results.push(full);
  }
  return results;
}

function resolveSpecs(): string[] {
  if (target) {
    const abs = path.resolve(target);
    if (!existsSync(abs)) { console.error(`[heal] Not found: ${target}`); process.exit(1); }
    return statSync(abs).isDirectory() ? findSpecsInFolder(abs) : [abs];
  }
  if (existsSync(lastFailedPath)) {
    try {
      const data  = JSON.parse(readFileSync(lastFailedPath, 'utf-8'));
      const specs = (data.specs ?? []).filter((s: string) => existsSync(s));
      if (specs.length > 0) return specs;
    } catch { /* fall through */ }
  }
  console.log('[heal] Nothing to heal — run your tests first, then `pfqa heal`.');
  process.exit(0);
}

const specs = resolveSpecs();
console.log(`\n[heal] Healing ${specs.length} spec(s):\n`);
specs.forEach(s => console.log(`  • ${path.relative(process.cwd(), s)}`));
console.log('');

const env: NodeJS.ProcessEnv = { ...process.env, AUTO_HEAL: '1', ...(headed ? { PW_HEADED: '1' } : {}) };
let healed = 0, failed = 0;

for (const spec of specs) {
  const rel = path.relative(process.cwd(), spec);
  console.log(`\n${'═'.repeat(60)}\n[heal] ${rel}\n${'═'.repeat(60)}`);
  const result = spawnSync('npx', ['playwright', 'test', spec], { stdio: 'inherit', env });
  if ((result.status ?? 1) === 0) { healed++; console.log(`\n  ✓ Healed: ${rel}`); }
  else                            { failed++; console.log(`\n  ✗ Could not heal: ${rel}`); }
}

console.log(`\n${'═'.repeat(60)}\n[heal] Done — ${healed} healed, ${failed} unresolved\n${'═'.repeat(60)}\n`);
process.exit(failed > 0 ? 1 : 0);
