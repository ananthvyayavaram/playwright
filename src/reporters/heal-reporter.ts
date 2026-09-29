// Playwright reporter that:
//   1. Tracks all test results and writes test-results/run-summary.txt
//   2. Writes test-results/last-failed.json so `pfqa heal` knows what to repair
//   3. When AUTO_HEAL=1, triggers AI locator repair after the run
//
// AUTO_HEAL is NOT set during normal runs — only when you explicitly run `pfqa heal`.
import 'dotenv/config';
import type {
  Reporter, FullConfig, FullResult,
  Suite, TestCase, TestResult,
} from '@playwright/test/reporter';
import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

interface HealReporterOptions {
  headed?:      boolean;
  maxAttempts?: number;
  model?:       string;
  analyze?:     boolean;
  verify?:      boolean;
}

interface FailureRecord {
  specPath:     string;
  testTitle:    string;
  errorMessage: string;
  errorStack:   string;
}

interface TestRecord {
  title:  string;
  status: string;
  file:   string;
  error?: string;
}

class HealReporter implements Reporter {
  private failures:    FailureRecord[] = [];
  private allTests:    TestRecord[]    = [];
  private options:     Required<HealReporterOptions>;
  private projectRoot: string;
  private startTime:   number = Date.now();

  constructor(options: HealReporterOptions = {}) {
    this.options = {
      headed:      options.headed      ?? false,
      maxAttempts: options.maxAttempts ?? 3,
      model:       options.model       ?? 'claude-sonnet-5',
      analyze:     options.analyze     ?? true,
      verify:      options.verify      ?? true,
    };
    this.projectRoot = process.cwd();
  }

  onBegin(_config: FullConfig, _suite: Suite): void {
    this.startTime = Date.now();
    if (process.env.AUTO_HEAL === '1') {
      console.log('[HealReporter] Auto-heal enabled — failures will be repaired after the run.');
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.allTests.push({
      title:  test.title,
      status: result.status,
      file:   path.relative(this.projectRoot, test.location.file),
      error:  result.error?.message,
    });

    if (['passed', 'skipped'].includes(result.status)) return;
    if (!['failed', 'timedOut', 'interrupted'].includes(result.status)) return;

    this.failures.push({
      specPath:     test.location.file,
      testTitle:    test.title,
      errorMessage: result.error?.message ?? '',
      errorStack:   result.error?.stack   ?? '',
    });
  }

  async onEnd(result: FullResult): Promise<void> {
    await this.writeRunSummary(result.status);

    const failingSpecs   = [...new Set(this.failures.map(f => f.specPath))].filter(Boolean);
    const lastFailedPath = path.join(this.projectRoot, 'test-results', 'last-failed.json');
    await fs.mkdir(path.dirname(lastFailedPath), { recursive: true });
    await fs.writeFile(
      lastFailedPath,
      JSON.stringify({ specs: failingSpecs, timestamp: new Date().toISOString() }, null, 2),
      'utf-8',
    );

    if (this.failures.length === 0) return;

    if (process.env.AUTO_HEAL !== '1') {
      console.log(`[HealReporter] ${this.failures.length} failure(s) — run "pfqa heal" to auto-repair.\n`);
      return;
    }

    // Auto-heal path — repair each failing spec using the AI repair flow.
    console.log(`\n[HealReporter] ${this.failures.length} failure(s) detected. Starting auto-heal...\n`);

    let { assertAuthConfigured } = await import('../ai/anthropic-client');
    try { assertAuthConfigured(); } catch (err) {
      console.log(`[HealReporter] No AI credentials — skipping auto-heal. ${(err as Error).message}`);
      return;
    }

    const { repairFlow } = await import('../ai/repair-flow');
    const healResults: Array<{ spec: string; passed: boolean }> = [];

    for (const specPath of failingSpecs) {
      const primary  = this.failures.find(f => f.specPath === specPath)!;
      const relSpec  = path.relative(this.projectRoot, specPath);
      const url      = this.extractUrl(specPath);

      console.log(`\n[HealReporter] ═══ Healing: ${relSpec} ═══`);
      if (!url) {
        console.warn(`  ⚠  No URL found in spec — skipping (add BASE_URL to .env).`);
        healResults.push({ spec: relSpec, passed: false });
        continue;
      }

      const result = await repairFlow({
        specPath,
        url,
        errorOutput: `${primary.errorMessage}\n${primary.errorStack}`,
        pomPaths:    this.extractPomPaths(specPath),
        headless:    !this.options.headed,
        model:       this.options.model,
        verbose:     true,
      }).catch(err => {
        console.error(`  [Repair error] ${err instanceof Error ? err.message : err}`);
        return null;
      });

      if (!result?.fixed) {
        console.log(`  ✗ Could not auto-heal ${relSpec}`);
        healResults.push({ spec: relSpec, passed: false });
        continue;
      }

      if (this.options.verify) {
        const { status } = spawnSync('npx', ['playwright', 'test', specPath], {
          stdio: 'inherit',
          env:   { ...process.env, SKIP_AUTO_HEAL: '1' },
        });
        const passed = (status ?? 1) === 0;
        console.log(passed ? `  ✓ Verified!` : `  ✗ Still failing after fix.`);
        healResults.push({ spec: relSpec, passed });
      } else {
        healResults.push({ spec: relSpec, passed: true });
      }
    }

    console.log('\n[HealReporter] ═══ Auto-Heal Summary ═══');
    for (const r of healResults) {
      console.log(`  ${r.passed ? '✓' : '✗'} ${path.basename(r.spec)}`);
    }
    const allPassed = healResults.every(r => r.passed);
    console.log(allPassed ? '\n  ✓ All failures were auto-healed.\n' : '\n  ✗ Some tests could not be healed.\n');
  }

  private async writeRunSummary(overallStatus: string): Promise<void> {
    const passed  = this.allTests.filter(t => t.status === 'passed').length;
    const failed  = this.allTests.filter(t => ['failed', 'timedOut'].includes(t.status)).length;
    const skipped = this.allTests.filter(t => t.status === 'skipped').length;
    const total   = this.allTests.length;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    const lines = [
      `Run Summary  ${new Date().toISOString()}`,
      '─'.repeat(60),
      `Status:   ${overallStatus.toUpperCase()}`,
      `Duration: ${elapsed}s`,
      `Total:    ${total}   Passed: ${passed}   Failed: ${failed}   Skipped: ${skipped}`,
      '',
    ];

    if (failed > 0) {
      lines.push('Failed tests:');
      for (const t of this.allTests.filter(t => ['failed', 'timedOut'].includes(t.status))) {
        lines.push(`  ✗ ${t.title}`);
        lines.push(`    file: ${t.file}`);
        if (t.error) lines.push(`    error: ${t.error.split('\n')[0].slice(0, 200)}`);
      }
      lines.push('');
    }

    const summaryPath = path.join(this.projectRoot, 'test-results', 'run-summary.txt');
    await fs.mkdir(path.dirname(summaryPath), { recursive: true });
    await fs.writeFile(summaryPath, lines.join('\n'), 'utf-8');
    console.log(`\n[HealReporter] Run summary: test-results/run-summary.txt  (${passed}✓ ${failed}✗ ${skipped} skipped)\n`);
  }

  private extractUrl(specPath: string): string | null {
    try {
      const content = require('fs').readFileSync(specPath, 'utf-8') as string;
      const m = content.match(/goto\(['"`](https?:\/\/[^'"`]+)['"`]/);
      if (m) return m[1];
    } catch { /* ignore */ }
    return process.env.BASE_URL ?? null;
  }

  private extractPomPaths(specPath: string): string[] {
    const specDir = path.dirname(path.resolve(specPath));
    const paths: string[] = [];
    try {
      const content = require('fs').readFileSync(specPath, 'utf-8') as string;
      for (const m of content.matchAll(/from\s+['"]([^'"]+)['"];?/g)) {
        const imp = m[1];
        if (!imp.startsWith('.')) continue;
        const resolved = path.resolve(specDir, imp.replace(/\.js$/, '.ts'));
        if (require('fs').existsSync(resolved) && !paths.includes(resolved)) paths.push(resolved);
      }
    } catch { /* ignore */ }
    return paths;
  }
}

export default HealReporter;
