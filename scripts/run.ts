#!/usr/bin/env node
// Entry point for the natural language runner.
// Interprets a plain-English phrase and executes the matching Playwright command.
// No quotes needed: `pfqa run login tests headed` works as-is.

import 'dotenv/config';
import { interpretPhrase, printAvailableTests, type NlContext } from '../src/ai/nl-runner';
import { RUN_MARKER_FILE } from '../src/utils/globalSetup';
import { spawnSync } from 'child_process';
import { rmSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

const PROJECT_ROOT     = process.cwd();
const TESTS_ROOT       = path.resolve(PROJECT_ROOT, 'tests');
const GENERATED_DIR    = path.resolve(PROJECT_ROOT, 'tests/generated');
const REQUIREMENTS_DIR = path.resolve(PROJECT_ROOT, 'requirements');

const context: NlContext = {
  projectRoot:      PROJECT_ROOT,
  testsRootDir:     TESTS_ROOT,
  generatedSpecDir: GENERATED_DIR,
  requirementsDir:  REQUIREMENTS_DIR,
};

function banner(text: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(` ${text}`);
  console.log(`${'─'.repeat(60)}`);
}

function runSpawnSync(cmd: string, args: string[], extraEnv: Record<string, string> = {}): number {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  return result.status ?? 1;
}

function cleanAllureResults() {
  const results = path.join(PROJECT_ROOT, 'allure-results');
  const report  = path.join(PROJECT_ROOT, 'allure-report');
  try {
    rmSync(results, { recursive: true, force: true });
    mkdirSync(results, { recursive: true });
    rmSync(report,  { recursive: true, force: true });
  } catch { /* non-fatal */ }
}

function printAllureResultsSummary() {
  const resultsDir = path.join(PROJECT_ROOT, 'allure-results');
  let files: string[] = [];
  try { files = readdirSync(resultsDir).filter(f => f.endsWith('-result.json')); } catch { return; }
  if (!files.length) { console.log('\n  No test results found in allure-results/\n'); return; }

  const STATUS_ICON: Record<string, string> = { passed: '✓', failed: '✗', broken: '✗', skipped: '-', unknown: '?' };
  const results = files.map(f => {
    try {
      const d = JSON.parse(readFileSync(path.join(resultsDir, f), 'utf-8')) as { name?: string; status?: string };
      return { name: d.name ?? f, status: d.status ?? 'unknown' };
    } catch { return null; }
  }).filter(Boolean) as Array<{ name: string; status: string }>;

  const counts = { passed: 0, failed: 0, skipped: 0, broken: 0 };
  for (const r of results) if (r.status in counts) (counts as Record<string, number>)[r.status]++;
  const total = results.length;
  console.log(`\n  Results: ${total} test(s)  (${counts.passed} passed  ${counts.failed + counts.broken} failed  ${counts.skipped} skipped)`);
  for (const r of results) console.log(`  ${STATUS_ICON[r.status] ?? '?'} ${r.name}`);
  console.log('');
}

function buildRunEnv(pwFlags: string[], testEnv?: string): Record<string, string> {
  const env: Record<string, string> = {
    test_env:  testEnv ?? process.env.test_env ?? 'qa',
    AUTO_HEAL: '',
  };
  if (pwFlags.includes('--headed')) env.PW_HEADED = '1';
  return env;
}

async function main() {
  const phrase = process.argv.slice(2).join(' ').trim();

  if (!phrase) {
    console.log('\nAI-Powered Test Runner');
    console.log('─'.repeat(56));
    console.log('Usage: pfqa "<natural language command>"\n');
    await printAvailableTests(context);
    process.exit(0);
  }

  console.log(`\n[Runner] Interpreting: "${phrase}"`);

  const action = await interpretPhrase(phrase, context).catch(err => {
    console.error('[Runner] Failed to interpret phrase:', err instanceof Error ? err.message : err);
    process.exit(1);
  });

  console.log(`[Runner] Intent: ${action.type} — ${action.explanation}`);

  switch (action.type) {

    case 'run': {
      const runEnv = buildRunEnv(action.pwFlags, action.testEnv);

      if (action.runFailed) {
        const lastRunFile = path.join(PROJECT_ROOT, 'test-results', '.last-run.json');
        if (!existsSync(lastRunFile)) {
          console.error('\n[Runner] No previous run data found. Run tests first, then retry.\n');
          process.exit(1);
        }
        cleanAllureResults();
        banner(`Re-running failed tests from last run  [env: ${runEnv.test_env}]`);
        process.exit(runSpawnSync('npx', ['playwright', 'test', '--last-failed', ...action.pwFlags], runEnv));
      }

      cleanAllureResults();
      const args = ['playwright', 'test'];
      if (!action.grep && !action.specs.length) {
        banner(`Running all tests  [env: ${runEnv.test_env}]`);
        args.push(...action.pwFlags);
        process.exit(runSpawnSync('npx', args, runEnv));
      }
      if (action.specs.length) {
        const relSpecs = action.specs.map(s => path.relative(PROJECT_ROOT, s));
        banner(`Running ${action.specs.length} spec(s)  [env: ${runEnv.test_env}]`);
        relSpecs.forEach(s => console.log(`  ✓ ${s}`));
        args.push(...action.specs);
      } else {
        banner(`Running tests matching: ${action.grep}  [env: ${runEnv.test_env}]`);
      }
      if (action.grep) args.push(`--grep=${action.grep}`);
      args.push(...action.pwFlags);
      process.exit(runSpawnSync('npx', args, runEnv));
    }

    case 'flow': {
      const rel = path.relative(PROJECT_ROOT, action.mdPath);
      banner(`Flow: generate → run from ${rel}`);
      const args = ['tsx', 'scripts/flow.ts', action.mdPath];
      if (action.options.regen)   args.push('--regen');
      if (action.options.headed)  args.push('--headed');
      if (action.options.genOnly) args.push('--gen-only');
      if (action.options.runOnly) args.push('--run-only');
      process.exit(runSpawnSync('npx', args));
    }

    case 'heal': {
      banner('Auto-Heal: run tests and repair failures');
      const lastFailedPath = path.join(PROJECT_ROOT, 'test-results', 'last-failed.json');
      let failedSpecs: string[] = [];
      try {
        const data = JSON.parse(readFileSync(lastFailedPath, 'utf-8'));
        failedSpecs = (data.specs ?? []).filter((s: string) => s);
      } catch { /* no last-failed.json */ }

      if (!action.grep && !failedSpecs.length) {
        console.log('\n[Runner] No failed specs found. Run tests first, then `pfqa heal`.\n');
        process.exit(0);
      }

      cleanAllureResults();
      const args = ['playwright', 'test'];
      if (failedSpecs.length && !action.grep) args.push(...failedSpecs);
      else if (action.grep) args.push(`--grep=${action.grep}`);
      if (action.headed) args.push('--headed');
      process.exit(runSpawnSync('npx', args, { ...buildRunEnv(action.headed ? ['--headed'] : []), AUTO_HEAL: '1' }));
    }

    case 'report': {
      banner('Generating Shareable Allure Report');
      const markerPath = path.join(PROJECT_ROOT, RUN_MARKER_FILE);
      if (!existsSync(markerPath)) {
        console.error('\n  No test results found. Run tests first:\n\n    pfqa run login tests\n');
        process.exit(1);
      }
      printAllureResultsSummary();
      const genExit = runSpawnSync('npm', ['run', 'report:share']);
      if (genExit !== 0) process.exit(genExit);
      console.log('\n  Report ready: allure-report-share/index.html\n');
      if (action.open) process.exit(runSpawnSync('open', ['allure-report-share/index.html']));
      process.exit(0);
    }

    case 'studio': {
      banner('Playwright UI Studio');
      console.log('  Opening interactive test runner…\n');
      process.exit(runSpawnSync('npx', ['playwright', 'test', '--ui']));
    }

    case 'analyze': {
      banner('Failure Analysis');
      process.exit(runSpawnSync('npx', ['tsx', 'scripts/analyze.ts']));
    }

    case 'list': {
      await printAvailableTests(context);
      process.exit(0);
    }

    default: {
      const u = action as { type: 'unknown'; explanation: string; suggestion: string };
      console.error(`\n[Runner] ${u.explanation}`);
      if (u.suggestion) console.log(`  Tip: ${u.suggestion}`);
      await printAvailableTests(context);
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('\nFatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
