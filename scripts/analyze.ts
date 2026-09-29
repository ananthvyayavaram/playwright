#!/usr/bin/env node
// CLI wrapper for AI failure analysis.
// Reads Allure results or a Playwright JSON report and prints root cause reports.
//
// Usage:
//   npx tsx scripts/analyze.ts                            # reads allure-results/
//   npx tsx scripts/analyze.ts --run                      # runs tests first, then analyzes
//   npx tsx scripts/analyze.ts --report path/to/report.json
//   pfqa "analyze test failures"

import 'dotenv/config';
import { assertAuthConfigured } from '../src/ai/anthropic-client';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const PROJECT_ROOT = process.cwd();

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key  = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

function severityIcon(s: string): string {
  if (s === 'critical') return '🔴';
  if (s === 'high')     return '🟠';
  if (s === 'medium')   return '🟡';
  return '🟢';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertAuthConfigured();

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║              AI Failure Analyzer                         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const allureDir  = (args['allure']  as string) ?? path.join(PROJECT_ROOT, 'allure-results');
  const reportFile = (args['report']  as string) ?? path.join(PROJECT_ROOT, 'test-results', 'playwright-report.json');

  let reportPath: string | null = null;

  if (args['run']) {
    console.log('[Analyze] Running tests and collecting failures...');
    const result = spawnSync('npx', ['playwright', 'test', '--reporter=json'], {
      encoding: 'utf-8', stdio: ['inherit', 'pipe', 'inherit'],
    });
    if (result.stdout) {
      const start = result.stdout.indexOf('{');
      if (start !== -1) {
        mkdirSync(path.dirname(reportFile), { recursive: true });
        writeFileSync(reportFile, result.stdout.slice(start), 'utf-8');
        reportPath = reportFile;
      }
    }
    if (!reportPath) { console.log('No failures detected — all tests passed.'); return; }
  } else if (existsSync(allureDir)) {
    // Dynamic import so AI modules are only loaded when needed.
    const { analyzeAllureResults } = await import('../src/ai/failure-analyzer');
    console.log(`[Analyze] Reading Allure results from: ${path.relative(PROJECT_ROOT, allureDir)}`);
    const batchResult = await analyzeAllureResults(allureDir);
    return printBatchResults(batchResult);
  } else if (existsSync(reportFile)) {
    reportPath = reportFile;
  } else {
    console.log('\nNo test results found. Options:');
    console.log('  pfqa "analyze test failures" --run');
    console.log('  Run tests first, then re-run analyze.');
    process.exit(1);
  }

  if (reportPath) {
    const { analyzePlaywrightReport } = await import('../src/ai/failure-analyzer');
    const batchResult = await analyzePlaywrightReport(reportPath);
    printBatchResults(batchResult);
  }
}

function printBatchResults(batchResult: { analyzed: number; reports: Array<{ input: { testTitle: string; specFile?: string }; report: { rootCause: string; category: string; severity: string; likelyFlaky: boolean; suggestedFix: string; locatorToUpdate?: string; affectedFile?: string } | null }> }) {
  if (!batchResult || batchResult.analyzed === 0) {
    console.log('\n✓ No failures found in the test results.\n');
    return;
  }
  console.log(`\nAnalyzed ${batchResult.analyzed} failure(s):\n`);
  for (const { input, report } of batchResult.reports) {
    if (!report) { console.log(`  ⚠  ${input.testTitle}\n     [AI analysis unavailable]\n`); continue; }
    console.log(`${severityIcon(report.severity)} ${input.testTitle}`);
    console.log(`   Root cause:  ${report.rootCause}`);
    console.log(`   Category:    ${report.category}  |  Severity: ${report.severity}  |  Flaky: ${report.likelyFlaky}`);
    console.log(`   Fix:         ${report.suggestedFix}`);
    if (report.locatorToUpdate) console.log(`   Locator:     ${report.locatorToUpdate}`);
    if (input.specFile)         console.log(`   Spec:        ${input.specFile}`);
    console.log('');
  }
  console.log('  To auto-heal locator issues, run: pfqa heal\n');
}

main().catch(err => {
  console.error('\nFatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
